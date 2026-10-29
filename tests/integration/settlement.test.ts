import request from 'supertest';
import { app } from '../../src/index';
import db from '../../src/db/connection';
import { ReasonCode } from '../../src/types/reasonCodes';
import { auditLogRepository } from '../../src/db/repositories/auditLogRepository';
import { settlementRepository } from '../../src/db/repositories/settlementRepository';

/**
 * Phase 1a settlement, end to end through HTTP (contract section 4).
 *
 * Worked example: 10.00 EUR (stake_minor 1000) on a 3-leg combo at
 * 2.10 x 1.90 x 2.50 = 9.975 with a 20% locked boost returns 99.75 EUR
 * (total_return_minor "9975", an exact decimal string) and pays a 19.95 EUR
 * bonus (bonus_minor 1995).
 * The profile minimums are 2 selections, combined odds 5.0, selection odds 1.2.
 */

const API_KEY = 'test-api-key';
const LOCKED_BOOST = 0.2;
const TICKET = [
  { id: 'a', odds: 2.1 },
  { id: 'b', odds: 1.9 },
  { id: 'c', odds: 2.5 },
];

type Leg = { selection_id: string; result: 'WON' | 'LOST' | 'PUSH' | 'CANCELLED' };
type Selection = Record<string, unknown> & { id: string; odds: number };

function auth(req: request.Test): request.Test {
  return req.set('X-API-Key', API_KEY);
}

async function createProfile(overrides: Record<string, unknown> = {}): Promise<string> {
  const res = await auth(request(app).post('/api/profiles')).send({
    brand_id: 'brand-a',
    name: 'Settlement Profile',
    min_selections: 2,
    min_combined_odds: 5.0,
    min_selection_odds: 1.2,
    min_boost_pct: 0.05,
    max_boost_pct: 0.5,
    ride_duration_seconds: 3600,
    max_bonus_minor: { EUR: 50_000 },
    reward_validity_seconds: 86_400,
    ...overrides,
  });
  expect(res.status).toBe(201);
  return res.body.id as string;
}

async function grant(userId: string, profileId: string): Promise<string> {
  const res = await auth(request(app).post('/api/rewards')).send({ user_id: userId, profile_version_id: profileId });
  expect(res.status).toBe(201);
  return res.body.id as string;
}

function optIn(rewardId: string, userId: string, betId: string, selections: Selection[] = TICKET, stakeMinor = 1000) {
  return auth(request(app).post(`/api/rewards/${rewardId}/opt-in`)).send({
    user_id: userId, bet_id: betId, stake_minor: stakeMinor, currency: 'EUR', ticket: { selections },
  });
}

/** Freezes the evaluation clock inside the pre-crash window of a reward's ride. */
async function freezeClockAtLivePoint(rewardId: string): Promise<void> {
  const row = await db('user_rewards').where({ id: rewardId }).first();
  const math = JSON.parse(row.ticket_snapshot).rideMath;
  const liveMs = Date.parse(math.startTime) + Math.floor(math.rideDurationSeconds * math.crashPct * 1000 * 0.4);
  jest.spyOn(Date, 'now').mockReturnValue(liveMs);
}

interface LockedBet {
  rewardId: string;
  userId: string;
  lockId: string;
  profileId: string;
}

/**
 * Grants, opts in and locks a bet, then pins the locked boost to 20% so the
 * money is deterministic (the ride value itself is seed-dependent).
 */
async function lockedBet(
  betId: string,
  options: { profile?: Record<string, unknown>; selections?: Selection[]; stakeMinor?: number; userId?: string } = {}
): Promise<LockedBet> {
  const profileId = await createProfile(options.profile);
  const userId = options.userId ?? `${betId}-user`;
  const rewardId = await grant(userId, profileId);
  const opted = await optIn(rewardId, userId, betId, options.selections, options.stakeMinor);
  expect(opted.status).toBe(200);
  await freezeClockAtLivePoint(rewardId);
  const lock = await auth(request(app).post('/api/boost/lock')).send({ user_id: userId, reward_id: rewardId, bet_id: betId });
  expect(lock.status).toBe(201);
  jest.restoreAllMocks();
  await db('bet_boost_locks').where({ id: lock.body.lock_id }).update({ locked_boost_pct: LOCKED_BOOST });
  return { rewardId, userId, lockId: lock.body.lock_id, profileId };
}

function legs(results: Record<string, Leg['result']>): Leg[] {
  return Object.entries(results).map(([selection_id, result]) => ({ selection_id, result }));
}

function settle(betId: string, body: Record<string, unknown>, brandId = 'brand-a') {
  return auth(request(app).post('/api/settlement')).send({ brand_id: brandId, bet_id: betId, ...body });
}

function resettle(betId: string, body: Record<string, unknown>, reason = 'Result corrected by the feed', brandId = 'brand-a') {
  return auth(request(app).post('/api/settlement/resettle')).send({ brand_id: brandId, bet_id: betId, reason, ...body });
}

function getSettlement(betId: string, brandId = 'brand-a') {
  return auth(request(app).get(`/api/settlement/${encodeURIComponent(betId)}?brand_id=${brandId}`));
}

const ALL_WON = { outcome: 'SETTLED', legs: legs({ a: 'WON', b: 'WON', c: 'WON' }) };

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

describe('Phase 1a settlement', () => {
  beforeAll(async () => {
    await db.migrate.latest();
  });

  afterAll(async () => {
    await db.destroy();
  });

  beforeEach(async () => {
    jest.restoreAllMocks();
    await db('bet_settlements').del();
    await db('bet_boost_locks').del();
    await db('ride_definitions').del();
    await db('user_rewards').del();
    await db('reward_profile_versions').del();
    await db('audit_logs').del();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('bet results end to end (grant -> opt-in -> lock -> settle)', () => {
    it.each([
      ['every leg WON', ALL_WON, { bet_result: 'WON', total_return_minor: '9975', bonus_minor: 1995, minimums_met: null }],
      // PUSH pays 1.00 and is not a reason to re-check the minimums.
      ['one leg PUSH', { outcome: 'SETTLED', legs: legs({ a: 'WON', b: 'PUSH', c: 'WON' }) },
        { bet_result: 'WON', total_return_minor: '5250', bonus_minor: 1050, minimums_met: null }],
      ['every leg PUSH', { outcome: 'SETTLED', legs: legs({ a: 'PUSH', b: 'PUSH', c: 'PUSH' }) },
        { bet_result: 'PUSHED', total_return_minor: '1000', bonus_minor: 0, minimums_met: null }],
      // 2.10 x 2.50 = 5.25 still meets 2 selections / 5.0 combined odds.
      ['a CANCELLED leg that keeps the minimums', { outcome: 'SETTLED', legs: legs({ a: 'WON', b: 'CANCELLED', c: 'WON' }) },
        { bet_result: 'WON', total_return_minor: '5250', bonus_minor: 1050, minimums_met: true }],
      // 2.10 x 1.90 = 3.99 is below the 5.0 combined-odds minimum.
      ['a CANCELLED leg that breaks the minimums', { outcome: 'SETTLED', legs: legs({ a: 'WON', b: 'WON', c: 'CANCELLED' }) },
        { bet_result: 'WON_NO_BONUS', total_return_minor: '3990', bonus_minor: 0, minimums_met: false }],
      // The pushed leg counts at its ORIGINAL odds in the re-check: 2.10 x 2.50 = 5.25.
      ['PUSH plus CANCELLED, minimums kept at original push odds', { outcome: 'SETTLED', legs: legs({ a: 'WON', b: 'CANCELLED', c: 'PUSH' }) },
        { bet_result: 'WON', total_return_minor: '2100', bonus_minor: 420, minimums_met: true }],
      ['PUSH plus CANCELLED, minimums broken', { outcome: 'SETTLED', legs: legs({ a: 'WON', b: 'PUSH', c: 'CANCELLED' }) },
        { bet_result: 'WON_NO_BONUS', total_return_minor: '2100', bonus_minor: 0, minimums_met: false }],
      ['any leg LOST', { outcome: 'SETTLED', legs: legs({ a: 'WON', b: 'LOST', c: 'CANCELLED' }) },
        { bet_result: 'LOST', total_return_minor: '0', bonus_minor: 0, minimums_met: null }],
      ['CASHOUT', { outcome: 'CASHOUT' },
        { bet_result: 'CASHED_OUT', total_return_minor: null, bonus_minor: 0, minimums_met: null }],
    ])('%s', async (_label, body, expected) => {
      const bet = await lockedBet('result-bet');
      const res = await settle('result-bet', body);
      expect(res.status).toBe(201);
      expect(res.body).toEqual({
        settlement_id: expect.any(String),
        brand_id: 'brand-a',
        bet_id: 'result-bet',
        lock_id: bet.lockId,
        revision: 1,
        outcome: body.outcome,
        legs: 'legs' in body ? [...(body.legs as Leg[])].sort((x, y) => x.selection_id.localeCompare(y.selection_id)) : null,
        currency: 'EUR',
        stake_minor: 1000,
        locked_boost_pct: LOCKED_BOOST,
        bonus_cap_minor: 50_000,
        cap_applied: false,
        replacement_reward_id: null,
        replacement_status: null,
        reason: null,
        previous_bonus_minor: null,
        bonus_delta_minor: null,
        settled_at: expect.any(String),
        ...expected,
      });

      // No token returned, nothing else created; one audit row for the settlement.
      expect(await db('user_rewards')).toHaveLength(1);
      expect((await db('user_rewards').where({ id: bet.rewardId }).first()).status).toBe('USED');
      const audit = await db('audit_logs').where({ action: 'SETTLE' });
      expect(audit).toHaveLength(1);
      expect(JSON.parse(audit[0].payload)).toMatchObject({
        betResult: expected.bet_result, bonusMinor: expected.bonus_minor, rewardId: bet.rewardId,
      });
    });

    it.each([
      ['outcome CANCELLED', { outcome: 'CANCELLED' }],
      ['every leg CANCELLED', { outcome: 'SETTLED', legs: legs({ a: 'CANCELLED', b: 'CANCELLED', c: 'CANCELLED' }) }],
    ])('%s returns the token as a replacement reward', async (_label, body) => {
      const bet = await lockedBet('cancel-bet');
      const original = await db('user_rewards').where({ id: bet.rewardId }).first();

      const res = await settle('cancel-bet', body);
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({
        bet_result: 'CANCELLED', total_return_minor: null, bonus_minor: 0, cap_applied: false,
        minimums_met: null, replacement_status: 'ISSUED',
      });

      const replacement = await db('user_rewards').where({ id: res.body.replacement_reward_id }).first();
      expect(replacement).toMatchObject({
        status: 'GRANTED',
        brand_id: 'brand-a',
        user_id: bet.userId,
        profile_version_id: bet.profileId,
        replaces_reward_id: bet.rewardId,
        valid_until: original.valid_until,
        bet_id: null,
      });
      expect(replacement.seed).toMatch(/^[0-9a-f]{64}$/);
      expect(replacement.seed).not.toBe(original.seed);
      // The original reward stays USED.
      expect((await db('user_rewards').where({ id: bet.rewardId }).first()).status).toBe('USED');
      const grantAudit = await db('audit_logs').where({ action: 'GRANT_REPLACEMENT', entity_id: replacement.id });
      expect(grantAudit).toHaveLength(1);
      expect(JSON.parse(grantAudit[0].payload)).toMatchObject({
        replacesRewardId: bet.rewardId, settlementId: res.body.settlement_id, betId: 'cancel-bet', trigger: 'SETTLE',
      });

      // The replacement is a normal token: the player can use it on a new bet.
      const reuse = await optIn(replacement.id, bet.userId, 'next-bet');
      expect(reuse.status).toBe(200);
      const read = await auth(request(app).get(`/api/rewards/${replacement.id}`));
      expect(read.body.replaces_reward_id).toBe(bet.rewardId);
    });

    it('does not issue a replacement once the original validity has passed', async () => {
      const bet = await lockedBet('late-cancel-bet');
      await db('user_rewards').where({ id: bet.rewardId }).update({ valid_until: new Date(Date.now() - 1_000).toISOString() });

      const res = await settle('late-cancel-bet', { outcome: 'CANCELLED' });
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({
        bet_result: 'CANCELLED', replacement_reward_id: null, replacement_status: 'NOT_ISSUED_EXPIRED',
      });
      expect(await db('user_rewards')).toHaveLength(1);
      expect(await db('audit_logs').where({ action: 'GRANT_REPLACEMENT' })).toHaveLength(0);
    });

    it('issues a replacement without validity for a legacy reward without validity', async () => {
      const bet = await lockedBet('legacy-cancel-bet');
      await db('user_rewards').where({ id: bet.rewardId }).update({ valid_until: null });
      const res = await settle('legacy-cancel-bet', { outcome: 'CANCELLED' });
      expect(res.body.replacement_status).toBe('ISSUED');
      expect((await db('user_rewards').where({ id: res.body.replacement_reward_id }).first()).valid_until).toBeNull();
    });

    it('settles every stored bet leg (excluded, ineligible, SGP composite) but never an SGP_LEG', async () => {
      const selections: Selection[] = [
        ...TICKET,
        { id: 'x', odds: 3.0, eligible: false, ineligible_reason: 'MANUAL_EXCLUDE' },
        { id: 'low', odds: 1.1 },
        { id: 'g', odds: 2.0, selection_type: 'SGP_COMPOSITE', sgp_group_id: 'g1' },
        { id: 'g-leg-1', odds: 1.4, selection_type: 'SGP_LEG', sgp_group_id: 'g1' },
      ];
      await lockedBet('full-ticket-bet', { selections });
      const all = legs({ a: 'WON', b: 'WON', c: 'WON', x: 'WON', low: 'WON', g: 'WON' });

      const missing = await settle('full-ticket-bet', { outcome: 'SETTLED', legs: legs({ a: 'WON', b: 'WON', c: 'WON' }) });
      expect(missing.status).toBe(400);
      expect(missing.body.details.map((d: { code: string; selection_id: string }) => `${d.code}:${d.selection_id}`).sort())
        .toEqual(['MISSING_LEG:g', 'MISSING_LEG:low', 'MISSING_LEG:x']);

      const withSgpLeg = await settle('full-ticket-bet', {
        outcome: 'SETTLED', legs: [...all, { selection_id: 'g-leg-1', result: 'WON' }],
      });
      expect(withSgpLeg.status).toBe(400);
      expect(withSgpLeg.body.details).toEqual([expect.objectContaining({ code: 'SGP_LEG_NOT_A_BET_LEG', selection_id: 'g-leg-1' })]);

      const res = await settle('full-ticket-bet', { outcome: 'SETTLED', legs: all });
      expect(res.status).toBe(201);
      // Every bet leg pays its odds: 9.975 x 3.0 x 1.1 x 2.0 = 65.835.
      expect(res.body).toMatchObject({ bet_result: 'WON', total_return_minor: '65835', bonus_minor: 13_167 });
    });
  });

  describe('large tickets (owner decision: any accepted ticket settles; max payout is the sportsbook\'s job)', () => {
    // 100 legs at the per-selection maximum of 10,000 on the maximum 1e12 stake:
    // the total return is 1e12 x 10,000^100 = 10^412 minor units, far beyond 2^53 and 64 bits.
    const HUGE_TICKET = Array.from({ length: 100 }, (_, i) => ({ id: `leg-${String(i).padStart(3, '0')}`, odds: 10_000 }));
    const STAKE = 1_000_000_000_000;
    const CAP = 50_000;
    const allLegs = (overrides: Record<string, Leg['result']> = {}): Leg[] =>
      HUGE_TICKET.map((selection) => ({ selection_id: selection.id, result: overrides[selection.id] ?? 'WON' }));
    const exact = (zeros: number) => `1${'0'.repeat(zeros)}`;

    /** Opt-in, quote and lock on the huge ticket, all over HTTP; then pins the boost to 20%. */
    async function lockHugeTicket(betId: string): Promise<LockedBet> {
      const profileId = await createProfile({ max_bonus_minor: { EUR: CAP } });
      const userId = `${betId}-user`;
      const rewardId = await grant(userId, profileId);
      const opted = await optIn(rewardId, userId, betId, HUGE_TICKET, STAKE);
      expect(opted.status).toBe(200);
      await freezeClockAtLivePoint(rewardId);
      const quote = await auth(request(app).post('/api/boost/quote')).send({ user_id: userId, reward_id: rewardId, bet_id: betId });
      expect(quote.status).toBe(200);
      expect(quote.body).toMatchObject({ eligible: true, qualifying_selection_count: 100 });
      const lock = await auth(request(app).post('/api/boost/lock')).send({ user_id: userId, reward_id: rewardId, bet_id: betId });
      expect(lock.status).toBe(201);
      jest.restoreAllMocks();
      await db('bet_boost_locks').where({ id: lock.body.lock_id }).update({ locked_boost_pct: LOCKED_BOOST });
      return { rewardId, userId, lockId: lock.body.lock_id, profileId };
    }

    it('settles WON with the exact total return as a string and the bonus at the cap, then resettles WON -> LOST -> WON', async () => {
      const bet = await lockHugeTicket('huge-bet');

      const won = await settle('huge-bet', { outcome: 'SETTLED', legs: allLegs() });
      expect(won.status).toBe(201);
      expect(won.body).toMatchObject({
        revision: 1, bet_result: 'WON', stake_minor: STAKE, total_return_minor: exact(412),
        bonus_minor: CAP, bonus_cap_minor: CAP, cap_applied: true, minimums_met: null,
      });
      expect((await getSettlement('huge-bet')).body).toMatchObject({ revision: 1, total_return_minor: exact(412), bonus_minor: CAP });
      const replay = await settle('huge-bet', { outcome: 'SETTLED', legs: allLegs() });
      expect(replay.status).toBe(201);
      expect(replay.body.settlement_id).toBe(won.body.settlement_id);

      const lost = await resettle('huge-bet', { outcome: 'SETTLED', legs: allLegs({ 'leg-050': 'LOST' }) }, 'Leg 50 lost');
      expect(lost.status).toBe(201);
      expect(lost.body).toMatchObject({
        revision: 2, bet_result: 'LOST', total_return_minor: '0', bonus_minor: 0, cap_applied: false,
        previous_bonus_minor: CAP, bonus_delta_minor: -CAP,
      });

      const rewon = await resettle('huge-bet', { outcome: 'SETTLED', legs: allLegs() }, 'Leg 50 corrected to won');
      expect(rewon.status).toBe(201);
      expect(rewon.body).toMatchObject({
        revision: 3, bet_result: 'WON', total_return_minor: exact(412), bonus_minor: CAP, cap_applied: true,
        previous_bonus_minor: 0, bonus_delta_minor: CAP,
      });
      expect((await getSettlement('huge-bet')).body).toMatchObject({ revision: 3, total_return_minor: exact(412) });

      // Every revision is stored exactly, as text.
      const rows = await db('bet_settlements').where({ lock_id: bet.lockId }).orderBy('revision', 'asc');
      expect(rows.map((row) => row.total_return_minor)).toEqual([exact(412), '0', exact(412)]);
      const audit = (await db('audit_logs').whereIn('action', ['SETTLE', 'RESETTLE']))
        .map((row) => JSON.parse(row.payload) as { revision: number; totalReturnMinor: string })
        .sort((x, y) => x.revision - y.revision);
      expect(audit.map((payload) => payload.totalReturnMinor)).toEqual([exact(412), '0', exact(412)]);
    });

    it('settles a PUSH plus a CANCELLED leg on the huge ticket: exact return on 98 legs, minimums kept, bonus capped', async () => {
      await lockHugeTicket('huge-void-bet');
      const res = await settle('huge-void-bet', {
        outcome: 'SETTLED', legs: allLegs({ 'leg-000': 'PUSH', 'leg-099': 'CANCELLED' }),
      });
      expect(res.status).toBe(201);
      // 1e12 x 10,000^98 = 10^404; 99 non-cancelled legs at original odds meet 2 selections / 5.0.
      expect(res.body).toMatchObject({
        bet_result: 'WON', total_return_minor: exact(404), bonus_minor: CAP, cap_applied: true, minimums_met: true,
      });
    });
  });

  describe('bonus cap', () => {
    it('caps the bonus at the snapshotted cap and reports cap_applied', async () => {
      await lockedBet('cap-bet', { profile: { max_bonus_minor: { EUR: 1500 } } });
      const res = await settle('cap-bet', ALL_WON);
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ bonus_minor: 1500, bonus_cap_minor: 1500, cap_applied: true, total_return_minor: '9975' });
    });

    it('does not report cap_applied when the bonus equals the cap', async () => {
      await lockedBet('cap-equal-bet', { profile: { max_bonus_minor: { EUR: 1995 } } });
      const res = await settle('cap-equal-bet', ALL_WON);
      expect(res.body).toMatchObject({ bonus_minor: 1995, cap_applied: false });
    });

    it('uses the cap frozen at opt-in, not a later profile edit', async () => {
      const bet = await lockedBet('cap-frozen-bet', { profile: { max_bonus_minor: { EUR: 1500 } } });
      const update = await auth(request(app).put(`/api/profiles/${bet.profileId}`)).send({ max_bonus_minor: { EUR: 100 } });
      expect(update.status).toBe(200);
      const res = await settle('cap-frozen-bet', ALL_WON);
      expect(res.body).toMatchObject({ bonus_minor: 1500, bonus_cap_minor: 1500 });
    });
  });

  describe('idempotent replay and conflicts', () => {
    it('replays an identical normalized payload and rejects a different one with 409', async () => {
      await lockedBet('replay-bet');
      const first = await settle('replay-bet', ALL_WON);
      expect(first.status).toBe(201);

      const reordered = await settle('replay-bet', { outcome: 'SETTLED', legs: [...ALL_WON.legs].reverse() });
      expect(reordered.status).toBe(201);
      expect(reordered.body).toEqual(first.body);

      for (const body of [
        { outcome: 'SETTLED', legs: legs({ a: 'WON', b: 'LOST', c: 'WON' }) },
        { outcome: 'CASHOUT' },
        { outcome: 'CANCELLED' },
      ]) {
        const conflicting = await settle('replay-bet', body);
        expect(conflicting.status).toBe(409);
        expect(conflicting.body.code).toBe(ReasonCode.BET_ALREADY_SETTLED);
      }
      expect(await db('bet_settlements')).toHaveLength(1);
      expect(await db('audit_logs').where({ action: 'SETTLE' })).toHaveLength(1);
    });

    it('validates the payload even when the bet is already settled', async () => {
      await lockedBet('replay-invalid-bet');
      expect((await settle('replay-invalid-bet', ALL_WON)).status).toBe(201);
      const invalid = await settle('replay-invalid-bet', { outcome: 'SETTLED', legs: legs({ a: 'WON' }) });
      expect(invalid.status).toBe(400);
    });
  });

  describe('resettlement', () => {
    it('creates revision n+1 with the bonus delta, marks it current and replays identical corrections', async () => {
      const bet = await lockedBet('resettle-bet');
      const first = await settle('resettle-bet', ALL_WON);
      expect(first.body.bonus_minor).toBe(1995);

      // A leg is later voided: 2.10 x 2.50 still meets the minimums.
      const correction = { outcome: 'SETTLED', legs: legs({ a: 'WON', b: 'CANCELLED', c: 'WON' }) };
      const second = await resettle('resettle-bet', correction, 'Leg b voided by the feed');
      expect(second.status).toBe(201);
      expect(second.body).toMatchObject({
        lock_id: bet.lockId,
        revision: 2,
        bet_result: 'WON',
        total_return_minor: '5250',
        bonus_minor: 1050,
        minimums_met: true,
        reason: 'Leg b voided by the feed',
        previous_bonus_minor: 1995,
        bonus_delta_minor: -945,
      });
      expect(second.body.settlement_id).not.toBe(first.body.settlement_id);

      const current = await getSettlement('resettle-bet');
      expect(current.status).toBe(200);
      expect(current.body).toEqual(second.body);

      const rows = await db('bet_settlements').orderBy('revision');
      expect(rows.map((row: { revision: number; is_current: number }) => [row.revision, Boolean(row.is_current)]))
        .toEqual([[1, false], [2, true]]);
      const audit = await db('audit_logs').where({ action: 'RESETTLE' });
      expect(audit).toHaveLength(1);
      expect(JSON.parse(audit[0].payload)).toMatchObject({
        reason: 'Leg b voided by the feed', previousRevision: 1, previousBonusMinor: 1995, bonusDeltaMinor: -945,
      });

      // Revision n+1 with an identical payload is a replay (the reason text is not compared).
      const again = await resettle('resettle-bet', { outcome: 'SETTLED', legs: [...correction.legs].reverse() }, 'retry');
      expect(again.status).toBe(201);
      expect(again.body).toEqual(second.body);
      // POST /settlement with the current payload replays too; the superseded one conflicts.
      expect((await settle('resettle-bet', correction)).body).toEqual(second.body);
      expect((await settle('resettle-bet', ALL_WON)).status).toBe(409);
      expect(await db('bet_settlements')).toHaveLength(2);

      // A further correction back to all WON is revision 3.
      const third = await resettle('resettle-bet', ALL_WON);
      expect(third.body).toMatchObject({ revision: 3, bonus_minor: 1995, previous_bonus_minor: 1050, bonus_delta_minor: 945 });
    });

    it('replays revision 1 when the correction equals it', async () => {
      await lockedBet('resettle-same-bet');
      const first = await settle('resettle-same-bet', ALL_WON);
      const same = await resettle('resettle-same-bet', ALL_WON);
      expect(same.status).toBe(201);
      expect(same.body).toEqual(first.body);
      expect(await db('bet_settlements')).toHaveLength(1);
    });

    it('returns 404 for an unsettled bet, 404 for an unknown lock and 400 without a reason', async () => {
      await lockedBet('resettle-unsettled-bet');
      const unsettled = await resettle('resettle-unsettled-bet', ALL_WON);
      expect(unsettled.status).toBe(404);
      expect(unsettled.body.code).toBe(ReasonCode.SETTLEMENT_NOT_FOUND);

      const unknown = await resettle('no-such-bet', ALL_WON);
      expect(unknown.status).toBe(404);
      expect(unknown.body.code).toBe(ReasonCode.LOCK_NOT_FOUND);

      const noReason = await auth(request(app).post('/api/settlement/resettle'))
        .send({ brand_id: 'brand-a', bet_id: 'resettle-unsettled-bet', ...ALL_WON });
      expect(noReason.status).toBe(400);
      expect(noReason.body.details).toEqual([expect.objectContaining({ path: 'reason' })]);
    });

    it('revokes a still-GRANTED replacement when a cancelled bet is resettled, and issues a new one when cancelled again', async () => {
      const bet = await lockedBet('revoke-bet');
      const cancelled = await settle('revoke-bet', { outcome: 'CANCELLED' });
      const replacementId = cancelled.body.replacement_reward_id as string;
      expect(replacementId).toBeTruthy();

      const lost = await resettle('revoke-bet', { outcome: 'SETTLED', legs: legs({ a: 'LOST', b: 'WON', c: 'WON' }) });
      expect(lost.status).toBe(201);
      expect(lost.body).toMatchObject({
        revision: 2, bet_result: 'LOST', replacement_reward_id: null, replacement_status: null,
        previous_bonus_minor: 0, bonus_delta_minor: 0,
      });
      expect((await db('user_rewards').where({ id: replacementId }).first()).status).toBe('EXPIRED');
      const revokeAudit = await db('audit_logs').where({ action: 'EXPIRE', entity_id: replacementId });
      expect(revokeAudit).toHaveLength(1);
      expect(JSON.parse(revokeAudit[0].payload)).toMatchObject({
        reason: 'REVOKED_BY_RESETTLEMENT', previousStatus: 'GRANTED', settlementId: lost.body.settlement_id,
      });
      expect(JSON.parse((await db('audit_logs').where({ action: 'RESETTLE' }).first()).payload).revokedRewardId)
        .toBe(replacementId);
      // The revoked token cannot be used.
      expect((await optIn(replacementId, bet.userId, 'revoked-use')).body.code).toBe(ReasonCode.REWARD_EXPIRED);

      const cancelledAgain = await resettle('revoke-bet', { outcome: 'CANCELLED' });
      expect(cancelledAgain.body).toMatchObject({ revision: 3, replacement_status: 'ISSUED' });
      expect(cancelledAgain.body.replacement_reward_id).not.toBe(replacementId);
      const grants = await db('audit_logs').where({ action: 'GRANT_REPLACEMENT' });
      expect(grants.map((row: { payload: string }) => JSON.parse(row.payload).trigger).sort()).toEqual(['RESETTLE', 'SETTLE']);
    });

    it('keeps the same replacement when a cancelled bet stays cancelled', async () => {
      await lockedBet('still-cancelled-bet');
      const cancelled = await settle('still-cancelled-bet', { outcome: 'CANCELLED' });
      const allLegsCancelled = await resettle('still-cancelled-bet', {
        outcome: 'SETTLED', legs: legs({ a: 'CANCELLED', b: 'CANCELLED', c: 'CANCELLED' }),
      });
      expect(allLegsCancelled.body).toMatchObject({
        revision: 2, bet_result: 'CANCELLED', replacement_reward_id: cancelled.body.replacement_reward_id,
      });
      expect(await db('user_rewards')).toHaveLength(2);
      expect((await db('user_rewards').where({ id: cancelled.body.replacement_reward_id }).first()).status).toBe('GRANTED');
    });

    it('returns 409 REPLACEMENT_ALREADY_USED and changes nothing when the replacement was used', async () => {
      const bet = await lockedBet('used-replacement-bet');
      const cancelled = await settle('used-replacement-bet', { outcome: 'CANCELLED' });
      const replacementId = cancelled.body.replacement_reward_id as string;
      expect((await optIn(replacementId, bet.userId, 'replacement-ride')).status).toBe(200);
      const auditBefore = await db('audit_logs').count('* as c').first();

      const res = await resettle('used-replacement-bet', ALL_WON);
      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({
        code: ReasonCode.REPLACEMENT_ALREADY_USED,
        details: { replacement_reward_id: replacementId },
      });

      const rows = await db('bet_settlements');
      expect(rows).toHaveLength(1);
      expect(Boolean(rows[0].is_current)).toBe(true);
      expect((await db('user_rewards').where({ id: replacementId }).first()).status).toBe('ENTERED');
      expect(await db('audit_logs').count('* as c').first()).toEqual(auditBefore);
      expect((await getSettlement('used-replacement-bet')).body).toEqual(cancelled.body);
    });

    it('needs nothing to revoke when no replacement was issued', async () => {
      const bet = await lockedBet('nothing-issued-bet');
      await db('user_rewards').where({ id: bet.rewardId }).update({ valid_until: new Date(Date.now() - 1_000).toISOString() });
      await settle('nothing-issued-bet', { outcome: 'CANCELLED' });
      const res = await resettle('nothing-issued-bet', { outcome: 'CASHOUT' });
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ revision: 2, bet_result: 'CASHED_OUT' });
      // Back to CANCELLED: the validity is still over, so again nothing is issued.
      const again = await resettle('nothing-issued-bet', { outcome: 'CANCELLED' });
      expect(again.body).toMatchObject({ revision: 3, replacement_status: 'NOT_ISSUED_EXPIRED' });
    });
  });

  describe('concurrency (never 500)', () => {
    it('two identical settles: one row, one replay', async () => {
      await lockedBet('race-same-bet');
      holdUntilAllArrive(settlementRepository, 'findCurrentByLockId', 2);
      const inserts = jest.spyOn(settlementRepository, 'create');

      const responses = await Promise.all([
        settle('race-same-bet', ALL_WON),
        settle('race-same-bet', ALL_WON),
      ]);
      expect(inserts).toHaveBeenCalledTimes(2);
      expect(responses.map((r) => r.status)).toEqual([201, 201]);
      expect(responses[0].body).toEqual(responses[1].body);
      expect(await db('bet_settlements')).toHaveLength(1);
      expect(await db('audit_logs').where({ action: 'SETTLE' })).toHaveLength(1);
    });

    it('two identical cancels issue exactly one replacement', async () => {
      await lockedBet('race-cancel-bet');
      holdUntilAllArrive(settlementRepository, 'findCurrentByLockId', 2);

      const responses = await Promise.all([
        settle('race-cancel-bet', { outcome: 'CANCELLED' }),
        settle('race-cancel-bet', { outcome: 'CANCELLED' }),
      ]);
      expect(responses.map((r) => r.status)).toEqual([201, 201]);
      expect(responses[0].body.replacement_reward_id).toBe(responses[1].body.replacement_reward_id);
      expect(await db('user_rewards').whereNotNull('replaces_reward_id')).toHaveLength(1);
      expect(await db('audit_logs').where({ action: 'GRANT_REPLACEMENT' })).toHaveLength(1);
    });

    it('two different settles: one wins, the other gets 409', async () => {
      await lockedBet('race-conflict-bet');
      holdUntilAllArrive(settlementRepository, 'findCurrentByLockId', 2);

      const responses = await Promise.all([
        settle('race-conflict-bet', ALL_WON),
        settle('race-conflict-bet', { outcome: 'CANCELLED' }),
      ]);
      expect(responses.map((r) => r.status).sort()).toEqual([201, 409]);
      expect(responses.find((r) => r.status === 409)!.body.code).toBe(ReasonCode.BET_ALREADY_SETTLED);
      const winner = responses.find((r) => r.status === 201)!.body;
      expect(await db('bet_settlements')).toHaveLength(1);
      // Only the winner's replacement (if it was the cancel) exists.
      expect(await db('user_rewards').whereNotNull('replaces_reward_id'))
        .toHaveLength(winner.bet_result === 'CANCELLED' ? 1 : 0);
    });

    it('two different resettles: one revision n+1, the other 409', async () => {
      await lockedBet('race-resettle-bet');
      await settle('race-resettle-bet', ALL_WON);
      holdUntilAllArrive(settlementRepository, 'findCurrentByLockId', 2);

      const responses = await Promise.all([
        resettle('race-resettle-bet', { outcome: 'CASHOUT' }),
        resettle('race-resettle-bet', { outcome: 'SETTLED', legs: legs({ a: 'LOST', b: 'WON', c: 'WON' }) }),
      ]);
      expect(responses.map((r) => r.status).sort()).toEqual([201, 409]);
      expect(responses.find((r) => r.status === 409)!.body.code).toBe(ReasonCode.BET_ALREADY_SETTLED);
      const rows = await db('bet_settlements').orderBy('revision');
      expect(rows.map((row: { revision: number; is_current: number }) => [row.revision, Boolean(row.is_current)]))
        .toEqual([[1, false], [2, true]]);
    });

    it('two identical resettles: one revision n+1 and one replay', async () => {
      await lockedBet('race-resettle-same-bet');
      await settle('race-resettle-same-bet', ALL_WON);
      holdUntilAllArrive(settlementRepository, 'findCurrentByLockId', 2);

      const responses = await Promise.all([
        resettle('race-resettle-same-bet', { outcome: 'CASHOUT' }),
        resettle('race-resettle-same-bet', { outcome: 'CASHOUT' }),
      ]);
      expect(responses.map((r) => r.status)).toEqual([201, 201]);
      expect(responses[0].body).toEqual(responses[1].body);
      expect(await db('bet_settlements')).toHaveLength(2);
      expect(await db('audit_logs').where({ action: 'RESETTLE' })).toHaveLength(1);
    });

    it('rolls back the revision, replacement and audit together when a write fails', async () => {
      await lockedBet('rollback-bet');
      const realAppend = auditLogRepository.append.bind(auditLogRepository);
      // The replacement's GRANT_REPLACEMENT row is written, then the SETTLE row fails.
      jest.spyOn(auditLogRepository, 'append')
        .mockImplementationOnce(realAppend)
        .mockRejectedValueOnce(new Error('injected audit failure'));
      const failed = await settle('rollback-bet', { outcome: 'CANCELLED' });
      expect(failed.status).toBe(500);
      expect(await db('bet_settlements')).toHaveLength(0);
      expect(await db('user_rewards').whereNotNull('replaces_reward_id')).toHaveLength(0);
      expect(await db('audit_logs').whereIn('action', ['SETTLE', 'GRANT_REPLACEMENT'])).toHaveLength(0);

      jest.restoreAllMocks();
      const retried = await settle('rollback-bet', { outcome: 'CANCELLED' });
      expect(retried.status).toBe(201);
      expect(await db('user_rewards').whereNotNull('replaces_reward_id')).toHaveLength(1);
    });
  });

  describe('brand scoping', () => {
    it('locks and settles the same bet_id in two brands independently', async () => {
      const betA = await lockedBet('shared-bet', { profile: { brand_id: 'brand-a' }, userId: 'player' });
      const betB = await lockedBet('shared-bet', { profile: { brand_id: 'brand-b' }, userId: 'player' });
      expect(betA.lockId).not.toBe(betB.lockId);

      const lockA = await auth(request(app).get('/api/boost/lock/shared-bet?brand_id=brand-a'));
      const lockB = await auth(request(app).get('/api/boost/lock/shared-bet?brand_id=brand-b'));
      expect([lockA.body.lock_id, lockB.body.lock_id]).toEqual([betA.lockId, betB.lockId]);

      const settledA = await settle('shared-bet', ALL_WON, 'brand-a');
      const settledB = await settle('shared-bet', { outcome: 'CASHOUT' }, 'brand-b');
      expect(settledA.body).toMatchObject({ brand_id: 'brand-a', lock_id: betA.lockId, bet_result: 'WON' });
      expect(settledB.body).toMatchObject({ brand_id: 'brand-b', lock_id: betB.lockId, bet_result: 'CASHED_OUT' });

      expect((await getSettlement('shared-bet', 'brand-a')).body).toEqual(settledA.body);
      expect((await getSettlement('shared-bet', 'brand-b')).body).toEqual(settledB.body);
      const otherBrand = await getSettlement('shared-bet', 'brand-c');
      expect(otherBrand.status).toBe(404);
      expect(otherBrand.body.code).toBe(ReasonCode.SETTLEMENT_NOT_FOUND);
      const unknownBrandSettle = await settle('shared-bet', ALL_WON, 'brand-c');
      expect(unknownBrandSettle.status).toBe(404);
      expect(unknownBrandSettle.body.code).toBe(ReasonCode.LOCK_NOT_FOUND);
    });

    it('requires a valid brand_id on GET', async () => {
      for (const path of ['/api/settlement/some-bet', '/api/settlement/some-bet?brand_id=no%20good']) {
        const res = await auth(request(app).get(path));
        expect(res.status).toBe(400);
        expect(res.body.code).toBe(ReasonCode.VALIDATION_ERROR);
      }
    });
  });

  describe('errors', () => {
    it('returns 400 VALIDATION_ERROR with the leg problems in details', async () => {
      await lockedBet('invalid-legs-bet');
      const res = await settle('invalid-legs-bet', {
        outcome: 'SETTLED',
        legs: [
          { selection_id: 'a', result: 'WON' },
          { selection_id: 'a', result: 'LOST' },
          { selection_id: 'zzz', result: 'WON' },
        ],
      });
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ code: ReasonCode.VALIDATION_ERROR, message: 'Settlement legs do not match the stored ticket' });
      expect(res.body.details.map((d: { code: string; selection_id: string }) => `${d.code}:${d.selection_id}`).sort()).toEqual([
        'DUPLICATE_LEG:a', 'MISSING_LEG:b', 'MISSING_LEG:c', 'UNKNOWN_SELECTION:zzz',
      ]);

      const legsOnCashout = await settle('invalid-legs-bet', { outcome: 'CASHOUT', legs: ALL_WON.legs });
      expect(legsOnCashout.status).toBe(400);
      expect(legsOnCashout.body.details).toEqual([expect.objectContaining({ path: 'legs' })]);
      const noLegs = await settle('invalid-legs-bet', { outcome: 'SETTLED' });
      expect(noLegs.status).toBe(400);
      expect(await db('bet_settlements')).toHaveLength(0);
    });

    it('returns 404 LOCK_NOT_FOUND for a bet that was opted in but never locked', async () => {
      const profileId = await createProfile();
      const rewardId = await grant('no-lock-user', profileId);
      expect((await optIn(rewardId, 'no-lock-user', 'no-lock-bet')).status).toBe(200);
      const res = await settle('no-lock-bet', { outcome: 'CASHOUT' });
      expect(res.status).toBe(404);
      expect(res.body.code).toBe(ReasonCode.LOCK_NOT_FOUND);
    });

    it('returns 422 SETTLEMENT_UNAVAILABLE when stored odds exceed 6 decimals, writing nothing', async () => {
      const bet = await lockedBet('bad-odds-bet');
      const row = await db('user_rewards').where({ id: bet.rewardId }).first();
      const snapshot = JSON.parse(row.ticket_snapshot);
      snapshot.selections[0].odds = 2.1234567;
      await db('user_rewards').where({ id: bet.rewardId }).update({ ticket_snapshot: JSON.stringify(snapshot) });
      const auditBefore = await db('audit_logs').count('* as c').first();

      const res = await settle('bad-odds-bet', ALL_WON);
      expect(res.status).toBe(422);
      expect(res.body.code).toBe(ReasonCode.SETTLEMENT_UNAVAILABLE);
      expect(res.body.details).toBeUndefined();
      expect(await db('bet_settlements')).toHaveLength(0);
      expect(await db('audit_logs').count('* as c').first()).toEqual(auditBefore);
    });

    it('returns 422 SETTLEMENT_UNAVAILABLE for a reward locked without a money snapshot', async () => {
      const bet = await lockedBet('legacy-money-bet');
      await db('user_rewards').where({ id: bet.rewardId }).update({ stake_minor: null, currency: null, bonus_cap_minor: null });
      const res = await settle('legacy-money-bet', ALL_WON);
      expect(res.status).toBe(422);
      expect(res.body.code).toBe(ReasonCode.SETTLEMENT_UNAVAILABLE);
      expect(res.body.message).toMatch(/no stake, currency and bonus cap snapshot/);
      expect(await db('bet_settlements')).toHaveLength(0);
    });
  });
});
