import request from 'supertest';
import { app } from '../../src/index';
import db from '../../src/db/connection';
import { ReasonCode } from '../../src/types/reasonCodes';
import { generateSeed } from '../../src/computations';
import { boostQuoteService } from '../../src/services/boostQuoteService';
import { auditLogRepository } from '../../src/db/repositories/auditLogRepository';
import { rideDefinitionRepository } from '../../src/db/repositories/rideDefinitionRepository';
import { rewardProfileRepository } from '../../src/db/repositories/rewardProfileRepository';
import { userRewardRepository } from '../../src/db/repositories/userRewardRepository';
import { settlementRepository } from '../../src/db/repositories/settlementRepository';
import { betBoostLockRepository } from '../../src/db/repositories/betBoostLockRepository';
import type { RideMathSnapshot } from '../../src/services/rideMathSnapshot';

const API_KEY = 'test-api-key';
const SELECTIONS = [
  { id: 's1', odds: 2.0 },
  { id: 's2', odds: 2.5 },
  { id: 's3', odds: 1.8 },
];

type RideMode = 'WAVES' | 'LINEAR';

async function createProfile(rideMode: RideMode = 'WAVES'): Promise<string> {
  const res = await request(app)
    .post('/api/profiles')
    .set('X-API-Key', API_KEY)
    .send({
      name: `Integrity ${rideMode}`,
      min_selections: 3,
      min_combined_odds: 3.0,
      min_selection_odds: 1.2,
      min_boost_pct: 0.05,
      max_boost_pct: 0.5,
      ride_mode: rideMode,
      ride_duration_seconds: 15,
    });
  expect(res.status).toBe(201);
  return res.body.id;
}

async function grant(userId: string, profileId: string): Promise<request.Response> {
  const res = await request(app)
    .post('/api/rewards')
    .set('X-API-Key', API_KEY)
    .send({ user_id: userId, profile_version_id: profileId });
  expect(res.status).toBe(201);
  return res;
}

function optIn(rewardId: string, userId: string, betId: string) {
  return request(app)
    .post(`/api/rewards/${rewardId}/opt-in`)
    .set('X-API-Key', API_KEY)
    .send({ user_id: userId, bet_id: betId, ticket: { selections: SELECTIONS } });
}

function lock(rewardId: string, userId: string, betId: string) {
  return request(app)
    .post('/api/boost/lock')
    .set('X-API-Key', API_KEY)
    .send({ user_id: userId, reward_id: rewardId, bet_id: betId });
}

function quote(rewardId: string, userId: string, betId: string) {
  return request(app)
    .post('/api/boost/quote')
    .set('X-API-Key', API_KEY)
    .send({ user_id: userId, reward_id: rewardId, bet_id: betId });
}

function settle(betId: string, outcome: string, winnings: number) {
  return request(app)
    .post('/api/settlement')
    .set('X-API-Key', API_KEY)
    .send({ bet_id: betId, outcome, winnings });
}

async function rideMath(rewardId: string): Promise<RideMathSnapshot> {
  const row = await db('user_rewards').where({ id: rewardId }).first();
  return JSON.parse(row.ticket_snapshot).rideMath as RideMathSnapshot;
}

async function rewardRow(rewardId: string) {
  return db('user_rewards').where({ id: rewardId }).first();
}

/**
 * Holds every caller of `method` until `parties` callers have arrived, so that
 * concurrent requests all pass their read-only pre-checks before any of them writes.
 */
function holdUntilAllArrive<T extends object, K extends keyof T>(target: T, method: K, parties: number): void {
  const real = (target[method] as unknown as (...args: unknown[]) => Promise<unknown>).bind(target);
  let arrived = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  jest.spyOn(target, method as never).mockImplementation((async (...args: unknown[]) => {
    const result = await real(...args);
    arrived += 1;
    if (arrived >= parties) release();
    await gate;
    return result;
  }) as never);
}

/** Freezes the evaluation clock at a fraction of the pre-crash window. */
function freezeClockAtLivePoint(math: RideMathSnapshot): number {
  const startMs = Date.parse(math.startTime);
  const liveMs = startMs + Math.floor(math.rideDurationSeconds * math.crashPct * 1000 * 0.4);
  jest.spyOn(Date, 'now').mockReturnValue(liveMs);
  return liveMs;
}

describe('Phase 0 fairness and money-path integrity', () => {
  beforeAll(async () => {
    await db.migrate.latest();
  });

  afterAll(async () => {
    await db.destroy();
  });

  beforeEach(async () => {
    await db('settlement_records').del();
    await db('bet_boost_locks').del();
    await db('ride_definitions').del();
    await db('user_rewards').del();
    await db('audit_logs').del();
    await db('reward_profile_versions').del();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('fairness: no future information while a ride is live', () => {
    it.each<RideMode>(['WAVES', 'LINEAR'])(
      '%s: live quote hides theoretical_max_boost_pct while lock and terminal quotes keep it',
      async (mode) => {
        const profileId = await createProfile(mode);

        // Live ride: public quote withholds the per-ride maximum.
        const liveReward = (await grant('fair-user', profileId)).body.id;
        expect((await optIn(liveReward, 'fair-user', `fair-bet-${mode}`)).status).toBe(200);
        const liveMath = await rideMath(liveReward);
        freezeClockAtLivePoint(liveMath);

        const liveQuote = await quote(liveReward, 'fair-user', `fair-bet-${mode}`);
        expect(liveQuote.status).toBe(200);
        expect(liveQuote.body.eligible).toBe(true);
        expect(liveQuote.body.reason_code).toBe(ReasonCode.ELIGIBLE);
        expect(liveQuote.body.current_boost_pct).toBeGreaterThan(0);
        expect(liveQuote.body).toHaveProperty('theoretical_max_boost_pct', null);
        expect(liveQuote.body.ride_end_at_offset_seconds).toBeNull();
        expect(liveQuote.body.ride_crash_at_offset_seconds).toBeNull();
        expect(liveQuote.body.ride_path).toBeUndefined();

        // The internal authoritative quote is unchanged (math frozen): only the public view is redacted.
        const internal = (await boostQuoteService.getQuote({
          userId: 'fair-user', rewardId: liveReward, betId: `fair-bet-${mode}`,
        })).data!;
        expect(internal.theoretical_max_boost_pct).toBeGreaterThan(0);
        expect({ ...internal, theoretical_max_boost_pct: null }).toEqual(liveQuote.body);

        // Lock (post-decision) still reports the real maximum, equal to the internal value.
        const locked = await lock(liveReward, 'fair-user', `fair-bet-${mode}`);
        expect(locked.status).toBe(201);
        expect(locked.body.locked_boost_pct).toBe(liveQuote.body.current_boost_pct);
        expect(locked.body.theoretical_max_boost_pct).toBe(internal.theoretical_max_boost_pct);
        jest.restoreAllMocks();

        // Terminal ride: the quote keeps the real value for the end-of-ride reveal.
        const endedReward = (await grant('fair-user-2', profileId)).body.id;
        expect((await optIn(endedReward, 'fair-user-2', `fair-end-${mode}`)).status).toBe(200);
        const endedMath = await rideMath(endedReward);
        jest.spyOn(Date, 'now').mockReturnValue(Date.parse(endedMath.endTime));
        const terminal = await quote(endedReward, 'fair-user-2', `fair-end-${mode}`);
        expect(terminal.status).toBe(200);
        expect(terminal.body.eligible).toBe(false);
        expect([ReasonCode.RIDE_CRASHED, ReasonCode.RIDE_ENDED]).toContain(terminal.body.reason_code);
        expect(terminal.body.theoretical_max_boost_pct).toBeGreaterThan(0);
      }
    );

    it('returns no end_time and no seed while a reward is GRANTED or ENTERED', async () => {
      const profileId = await createProfile();
      const grantRes = await grant('timing-user', profileId);
      const rewardId = grantRes.body.id;
      const { seed } = await rewardRow(rewardId);

      const assertHidden = (body: unknown) => {
        const text = JSON.stringify(body);
        expect(text).not.toContain(seed);
        expect(text).not.toMatch(/"seed"/);
      };

      expect(grantRes.body.status).toBe('GRANTED');
      expect(grantRes.body).toHaveProperty('end_time', null);
      assertHidden(grantRes.body);

      const granted = await request(app).get(`/api/rewards/${rewardId}`).set('X-API-Key', API_KEY);
      expect(granted.body.end_time).toBeNull();
      assertHidden(granted.body);

      const optInRes = await optIn(rewardId, 'timing-user', 'timing-bet');
      expect(optInRes.status).toBe(200);
      expect(optInRes.body.status).toBe('ENTERED');
      expect(optInRes.body).toHaveProperty('end_time', null);
      assertHidden(optInRes.body);

      const entered = await request(app).get(`/api/rewards/${rewardId}`).set('X-API-Key', API_KEY);
      expect(entered.body.status).toBe('ENTERED');
      expect(entered.body.end_time).toBeNull();
      assertHidden(entered.body);

      const list = await request(app).get('/api/rewards/user/timing-user').set('X-API-Key', API_KEY);
      expect(list.body.rewards).toHaveLength(1);
      expect(list.body.rewards[0].end_time).toBeNull();
      assertHidden(list.body);

      const active = await request(app).get('/api/rewards/user/timing-user/active').set('X-API-Key', API_KEY);
      expect(active.body.active_reward.status).toBe('ENTERED');
      expect(active.body.active_reward.end_time).toBeNull();
      assertHidden(active.body);

      freezeClockAtLivePoint(await rideMath(rewardId));
      const liveQuote = await quote(rewardId, 'timing-user', 'timing-bet');
      assertHidden(liveQuote.body);
      const locked = await lock(rewardId, 'timing-user', 'timing-bet');
      expect(locked.status).toBe(201);
      assertHidden(locked.body);
      jest.restoreAllMocks();

      // Once used, the ride is over and its end time may be shown.
      const used = await request(app).get(`/api/rewards/${rewardId}`).set('X-API-Key', API_KEY);
      expect(used.body.status).toBe('USED');
      expect(typeof used.body.end_time).toBe('string');
      assertHidden(used.body);
      const lockRead = await request(app).get('/api/boost/lock/timing-bet').set('X-API-Key', API_KEY);
      assertHidden(lockRead.body);
    });

    it('generates a random 32-byte hex seed that is not derivable from public IDs', async () => {
      const profileId = await createProfile();
      const first = (await grant('seed-user', profileId)).body.id;
      const second = (await grant('seed-user', profileId)).body.id;
      const rows = await db('user_rewards').whereIn('id', [first, second]);

      expect(rows).toHaveLength(2);
      for (const row of rows) {
        expect(row.seed).toMatch(/^[0-9a-f]{64}$/);
        expect(row.seed).not.toBe(generateSeed(row.id, row.user_id, row.profile_version_id));
      }
      expect(rows[0].seed).not.toBe(rows[1].seed);

      // Grant is a single insert: the stored end time is derived from the stored seed.
      const audit = await db('audit_logs').where({ entity_id: first, action: 'GRANT' });
      expect(audit).toHaveLength(1);
      expect(JSON.parse(audit[0].payload).seed).toBe(rows.find((r) => r.id === first).seed);
    });
  });

  describe('bet binding at opt-in', () => {
    it('rejects a bet already bound to a different reward with 409 BET_ALREADY_BOUND (any status)', async () => {
      const profileId = await createProfile();
      const rewardA = (await grant('bind-user', profileId)).body.id;
      const rewardB = (await grant('bind-user', profileId)).body.id;
      const rewardC = (await grant('other-user', profileId)).body.id;

      expect((await optIn(rewardA, 'bind-user', 'shared-bet')).status).toBe(200);

      const second = await optIn(rewardB, 'bind-user', 'shared-bet');
      expect(second.status).toBe(409);
      expect(second.body.code).toBe(ReasonCode.BET_ALREADY_BOUND);
      const otherUser = await optIn(rewardC, 'other-user', 'shared-bet');
      expect(otherUser.status).toBe(409);
      expect(otherUser.body.code).toBe(ReasonCode.BET_ALREADY_BOUND);

      // The rejected opt-in left no trace: still GRANTED, unbound, no checkpoints, no audit.
      const rowB = await rewardRow(rewardB);
      expect(rowB.status).toBe('GRANTED');
      expect(rowB.bet_id).toBeNull();
      expect(rowB.ticket_snapshot).toBeNull();
      expect(await db('ride_definitions').where({ reward_id: rewardB })).toHaveLength(0);
      expect(await db('audit_logs').where({ entity_id: rewardB, action: 'OPT_IN' })).toHaveLength(0);

      // Re-opting the same reward keeps its existing behaviour.
      const again = await optIn(rewardA, 'bind-user', 'shared-bet');
      expect(again.status).toBe(409);
      expect(again.body.code).toBe(ReasonCode.ALREADY_OPTED_IN);

      // Still rejected once the first reward is USED.
      freezeClockAtLivePoint(await rideMath(rewardA));
      expect((await lock(rewardA, 'bind-user', 'shared-bet')).status).toBe(201);
      jest.restoreAllMocks();
      const afterUse = await optIn(rewardB, 'bind-user', 'shared-bet');
      expect(afterUse.status).toBe(409);
      expect(afterUse.body.code).toBe(ReasonCode.BET_ALREADY_BOUND);

      // A fresh bet on the other reward still works.
      expect((await optIn(rewardB, 'bind-user', 'fresh-bet')).status).toBe(200);
    });

    it('concurrent opt-ins on one reward: one success and one 409 ALREADY_OPTED_IN, never 500', async () => {
      const profileId = await createProfile();
      const rewardId = (await grant('race-user', profileId)).body.id;
      // Both requests see GRANTED before either claims it.
      holdUntilAllArrive(rewardProfileRepository, 'findById', 2);
      const claim = jest.spyOn(userRewardRepository, 'updateStatus');

      const responses = await Promise.all([
        optIn(rewardId, 'race-user', 'race-bet'),
        optIn(rewardId, 'race-user', 'race-bet'),
      ]);
      expect(claim.mock.calls.filter((call) => call[3]?.fromStatus === 'GRANTED')).toHaveLength(2);
      const statuses = responses.map((r) => r.status).sort();
      expect(statuses).toEqual([200, 409]);
      expect(responses.find((r) => r.status === 409)!.body.code).toBe(ReasonCode.ALREADY_OPTED_IN);

      const math = await rideMath(rewardId);
      expect(await db('ride_definitions').where({ reward_id: rewardId })).toHaveLength(math.checkpoints!.length);
      expect(await db('audit_logs').where({ entity_id: rewardId, action: 'OPT_IN' })).toHaveLength(1);
    });

    it('concurrent opt-ins of one bet on two rewards: one success and one 409 BET_ALREADY_BOUND', async () => {
      const profileId = await createProfile();
      const rewardA = (await grant('race-user', profileId)).body.id;
      const rewardB = (await grant('race-user', profileId)).body.id;
      holdUntilAllArrive(rewardProfileRepository, 'findById', 2);

      const responses = await Promise.all([
        optIn(rewardA, 'race-user', 'race-shared-bet'),
        optIn(rewardB, 'race-user', 'race-shared-bet'),
      ]);
      expect(responses.map((r) => r.status).sort()).toEqual([200, 409]);
      expect(responses.find((r) => r.status === 409)!.body.code).toBe(ReasonCode.BET_ALREADY_BOUND);
      expect(await db('user_rewards').where({ bet_id: 'race-shared-bet' })).toHaveLength(1);
    });

    it('rolls back a failed opt-in so the reward stays usable', async () => {
      const profileId = await createProfile();
      const rewardId = (await grant('rollback-user', profileId)).body.id;

      jest.spyOn(rideDefinitionRepository, 'createMany').mockRejectedValueOnce(new Error('injected failure'));
      const failed = await optIn(rewardId, 'rollback-user', 'rollback-bet');
      expect(failed.status).toBe(500);
      expect(failed.body.code).toBe(ReasonCode.INTERNAL_ERROR);

      const row = await rewardRow(rewardId);
      expect(row.status).toBe('GRANTED');
      expect(row.bet_id).toBeNull();
      expect(row.opted_in_at).toBeNull();

      expect((await optIn(rewardId, 'rollback-user', 'rollback-bet')).status).toBe(200);
    });
  });

  describe('lock idempotency and atomicity', () => {
    it('replays a lock only to the same reward and its owner; other combinations get 409', async () => {
      const profileId = await createProfile();
      const aliceReward = (await grant('alice', profileId)).body.id;
      const bobReward = (await grant('bob', profileId)).body.id;
      expect((await optIn(aliceReward, 'alice', 'alice-bet')).status).toBe(200);
      expect((await optIn(bobReward, 'bob', 'bob-bet')).status).toBe(200);

      freezeClockAtLivePoint(await rideMath(aliceReward));
      const aliceLock = await lock(aliceReward, 'alice', 'alice-bet');
      expect(aliceLock.status).toBe(201);

      // Cross-user: Bob names Alice's reward and bet.
      const crossUser = await lock(aliceReward, 'bob', 'alice-bet');
      expect(crossUser.status).toBe(409);
      expect(crossUser.body.code).toBe(ReasonCode.BET_ALREADY_LOCKED);
      expect(crossUser.body).not.toHaveProperty('lock_id');
      expect(JSON.stringify(crossUser.body)).not.toContain(aliceLock.body.lock_id);

      // Cross-reward: Bob's own reward with Alice's bet.
      const crossReward = await lock(bobReward, 'bob', 'alice-bet');
      expect(crossReward.status).toBe(409);
      expect(crossReward.body.code).toBe(ReasonCode.BET_ALREADY_LOCKED);

      // Invented reward ID with Alice's bet.
      const invented = await lock('00000000-0000-4000-8000-000000000000', 'alice', 'alice-bet');
      expect(invented.status).toBe(409);
      expect(invented.body.code).toBe(ReasonCode.BET_ALREADY_LOCKED);

      // The genuine replay still returns the original lock.
      const replay = await lock(aliceReward, 'alice', 'alice-bet');
      expect(replay.status).toBe(201);
      expect(replay.body).toEqual(aliceLock.body);
      expect(await db('bet_boost_locks')).toHaveLength(1);
      expect((await rewardRow(bobReward)).status).toBe('ENTERED');
    });

    it('rolls back the lock insert and USED transition when a later write fails', async () => {
      const profileId = await createProfile();
      const rewardId = (await grant('atomic-user', profileId)).body.id;
      expect((await optIn(rewardId, 'atomic-user', 'atomic-bet')).status).toBe(200);
      freezeClockAtLivePoint(await rideMath(rewardId));

      const realAppend = auditLogRepository.append;
      jest.spyOn(auditLogRepository, 'append').mockImplementation(async (input, tx) => {
        if (input.action === 'LOCK') throw new Error('injected audit failure');
        return realAppend(input, tx);
      });

      const failed = await lock(rewardId, 'atomic-user', 'atomic-bet');
      expect(failed.status).toBe(500);
      expect(failed.body.code).toBe(ReasonCode.INTERNAL_ERROR);
      expect(await db('bet_boost_locks').where({ bet_id: 'atomic-bet' })).toHaveLength(0);
      expect((await rewardRow(rewardId)).status).toBe('ENTERED');
      expect(await db('audit_logs').where({ action: 'LOCK' })).toHaveLength(0);

      jest.mocked(auditLogRepository.append).mockRestore();
      const retried = await lock(rewardId, 'atomic-user', 'atomic-bet');
      expect(retried.status).toBe(201);
      expect((await rewardRow(rewardId)).status).toBe('USED');
      expect(await db('audit_logs').where({ action: 'LOCK' })).toHaveLength(1);
    });
  });

  describe('grant atomicity', () => {
    it('does not keep a reward whose audit row failed', async () => {
      const profileId = await createProfile();
      jest.spyOn(auditLogRepository, 'append').mockRejectedValueOnce(new Error('injected audit failure'));

      const res = await request(app)
        .post('/api/rewards')
        .set('X-API-Key', API_KEY)
        .send({ user_id: 'grant-user', profile_version_id: profileId });
      expect(res.status).toBe(500);
      expect(await db('user_rewards').where({ user_id: 'grant-user' })).toHaveLength(0);
    });
  });

  describe('settlement replay and bounds', () => {
    async function lockedBet(betId: string): Promise<void> {
      const profileId = await createProfile();
      const rewardId = (await grant(`${betId}-user`, profileId)).body.id;
      expect((await optIn(rewardId, `${betId}-user`, betId)).status).toBe(200);
      freezeClockAtLivePoint(await rideMath(rewardId));
      expect((await lock(rewardId, `${betId}-user`, betId)).status).toBe(201);
      jest.restoreAllMocks();
    }

    it('returns the existing record for an identical replay and 409 for a conflicting one', async () => {
      await lockedBet('replay-bet');
      const first = await settle('replay-bet', 'WIN', 100);
      expect(first.status).toBe(201);

      const identical = await settle('replay-bet', 'WIN', 100);
      expect(identical.status).toBe(201);
      expect(identical.body).toEqual(first.body);

      // Equal after the stored 4-dp rounding.
      const rounded = await settle('replay-bet', 'WIN', 100.00004);
      expect(rounded.status).toBe(201);
      expect(rounded.body.settlement_id).toBe(first.body.settlement_id);

      for (const [outcome, winnings] of [['WIN', 100.0001], ['WIN', 90], ['LOSS', 100], ['LOSS', 0]] as const) {
        const conflicting = await settle('replay-bet', outcome, winnings);
        expect(conflicting.status).toBe(409);
        expect(conflicting.body.code).toBe(ReasonCode.BET_ALREADY_SETTLED);
      }

      const rows = await db('settlement_records').where({ bet_id: 'replay-bet' });
      expect(rows).toHaveLength(1);
      expect(rows[0].outcome).toBe('WIN');
      expect(Number(rows[0].winnings)).toBe(100);
    });

    it('concurrent settlements never return 500 and keep one record', async () => {
      await lockedBet('race-settle-bet');
      await lockedBet('race-conflict-bet');

      // Both requests see "not settled" before either inserts, so one hits the unique key.
      holdUntilAllArrive(betBoostLockRepository, 'findByBetId', 2);
      const inserts = jest.spyOn(settlementRepository, 'create');
      const same = await Promise.all([
        settle('race-settle-bet', 'WIN', 50),
        settle('race-settle-bet', 'WIN', 50),
      ]);
      expect(inserts).toHaveBeenCalledTimes(2);
      expect(same.map((r) => r.status)).toEqual([201, 201]);
      expect(same[0].body.settlement_id).toBe(same[1].body.settlement_id);
      expect(await db('settlement_records').where({ bet_id: 'race-settle-bet' })).toHaveLength(1);
      jest.restoreAllMocks();

      holdUntilAllArrive(betBoostLockRepository, 'findByBetId', 2);
      const conflictInserts = jest.spyOn(settlementRepository, 'create');
      const conflicting = await Promise.all([
        settle('race-conflict-bet', 'WIN', 50),
        settle('race-conflict-bet', 'LOSS', 0),
      ]);
      expect(conflictInserts).toHaveBeenCalledTimes(2);
      expect(conflicting.map((r) => r.status).sort()).toEqual([201, 409]);
      expect(conflicting.find((r) => r.status === 409)!.body.code).toBe(ReasonCode.BET_ALREADY_SETTLED);
      expect(await db('settlement_records').where({ bet_id: 'race-conflict-bet' })).toHaveLength(1);
    });

    it('rolls back a settlement whose audit row failed', async () => {
      await lockedBet('settle-rollback-bet');
      jest.spyOn(auditLogRepository, 'append').mockRejectedValueOnce(new Error('injected audit failure'));
      const failed = await settle('settle-rollback-bet', 'WIN', 10);
      expect(failed.status).toBe(500);
      expect(await db('settlement_records').where({ bet_id: 'settle-rollback-bet' })).toHaveLength(0);
      expect((await settle('settle-rollback-bet', 'WIN', 10)).status).toBe(201);
    });

    it.each([
      ['Infinity (1e309 in JSON)', '{"bet_id":"bound-bet","outcome":"WIN","winnings":1e309}'],
      ['1e300', '{"bet_id":"bound-bet","outcome":"WIN","winnings":1e300}'],
      ['above the interim bound', '{"bet_id":"bound-bet","outcome":"WIN","winnings":1000000000.01}'],
      ['negative', '{"bet_id":"bound-bet","outcome":"WIN","winnings":-1}'],
    ])('rejects winnings %s with 400', async (_label, body) => {
      const res = await request(app)
        .post('/api/settlement')
        .set('X-API-Key', API_KEY)
        .set('Content-Type', 'application/json')
        .send(body);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe(ReasonCode.VALIDATION_ERROR);
      expect(await db('settlement_records')).toHaveLength(0);
    });

    it('accepts winnings at the interim bound', async () => {
      await lockedBet('max-winnings-bet');
      const res = await settle('max-winnings-bet', 'WIN', 1_000_000_000);
      expect(res.status).toBe(201);
      expect(res.body.winnings).toBe(1_000_000_000);
    });
  });
});
