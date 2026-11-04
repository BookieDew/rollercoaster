import request from 'supertest';
import { app } from '../../src/index';
import db from '../../src/db/connection';
import { runInTransaction, executorFor } from '../../src/db/repositories/transaction';
import { betBoostLockRepository } from '../../src/db/repositories/betBoostLockRepository';
import { rewardProfileRepository } from '../../src/db/repositories/rewardProfileRepository';
import { userRewardRepository } from '../../src/db/repositories/userRewardRepository';
import { settlementRepository } from '../../src/db/repositories/settlementRepository';
import { liveMomentMs } from '../helpers/v4Rides';
import { createIsolatedKnex, isPg, parseJsonColumn } from '../helpers/testDb';

/**
 * Phase 2a: behaviour that must be identical on SQLite and PostgreSQL (timestamp format, real concurrent
 * transactions), plus checks that only make sense on PostgreSQL (column types, full migration cycle,
 * timestamptz conversion). The PostgreSQL-only block is skipped on SQLite and runs in `npm run test:pg`.
 */

const API_KEY = 'test-api-key';
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const TICKET = [{ id: 'a', odds: 2.1 }, { id: 'b', odds: 1.9 }, { id: 'c', odds: 2.5 }];
const ALL_WON = {
  outcome: 'SETTLED',
  legs: [{ selection_id: 'a', result: 'WON' }, { selection_id: 'b', result: 'WON' }, { selection_id: 'c', result: 'WON' }],
};
const LOST_ONE = {
  outcome: 'SETTLED',
  legs: [{ selection_id: 'a', result: 'LOST' }, { selection_id: 'b', result: 'WON' }, { selection_id: 'c', result: 'WON' }],
};

const auth = (req: request.Test): request.Test => req.set('X-API-Key', API_KEY);

async function createProfile(): Promise<string> {
  const res = await auth(request(app).post('/api/profiles')).send({
    brand_id: 'brand-a', name: 'Postgres Profile', min_selections: 2, min_combined_odds: 5.0,
    min_selection_odds: 1.2, min_boost_pct: 0.05, max_boost_pct: 0.5, ride_duration_seconds: 3600,
    max_bonus_minor: { EUR: 50_000 }, reward_validity_seconds: 86_400,
  });
  expect(res.status).toBe(201);
  return res.body.id as string;
}

async function grant(userId: string, profileId: string) {
  const res = await auth(request(app).post('/api/rewards')).send({ user_id: userId, profile_version_id: profileId });
  expect(res.status).toBe(201);
  return res.body as { id: string; valid_until: string; created_at: string; updated_at: string; start_time: string };
}

const optIn = (rewardId: string, userId: string, betId: string) =>
  auth(request(app).post(`/api/rewards/${rewardId}/opt-in`)).send({
    user_id: userId, bet_id: betId, stake_minor: 1000, currency: 'EUR', ticket: { selections: TICKET },
  });

const lockRequest = (rewardId: string, userId: string, betId: string) =>
  auth(request(app).post('/api/boost/lock')).send({ user_id: userId, reward_id: rewardId, bet_id: betId });

const settle = (betId: string, body: Record<string, unknown>) =>
  auth(request(app).post('/api/settlement')).send({ brand_id: 'brand-a', bet_id: betId, ...body });

const resettle = (betId: string, body: Record<string, unknown>) =>
  auth(request(app).post('/api/settlement/resettle')).send({
    brand_id: 'brand-a', bet_id: betId, reason: 'Result corrected by the feed', ...body,
  });

async function enteredRide(betId: string): Promise<{ rewardId: string; userId: string; profileId: string }> {
  const profileId = await createProfile();
  const userId = `${betId}-user`;
  const { id: rewardId } = await grant(userId, profileId);
  expect((await optIn(rewardId, userId, betId)).status).toBe(200);
  return { rewardId, userId, profileId };
}

async function freezeAtLivePoint(rewardId: string): Promise<void> {
  const row = await db('user_rewards').where({ id: rewardId }).first();
  jest.spyOn(Date, 'now').mockReturnValue(liveMomentMs(parseJsonColumn(row.ticket_snapshot).rideMath));
}

async function lockedBet(betId: string) {
  const ride = await enteredRide(betId);
  await freezeAtLivePoint(ride.rewardId);
  const lock = await lockRequest(ride.rewardId, ride.userId, betId);
  expect(lock.status).toBe(201);
  jest.restoreAllMocks();
  await db('bet_boost_locks').where({ id: lock.body.lock_id }).update({ locked_boost_pct: 0.2 });
  return { ...ride, lockId: lock.body.lock_id as string };
}

/** Holds every caller of `method` until `parties` callers arrived: all pass their read-only checks before any writes. */
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

describe('Phase 2a: Postgres foundation', () => {
  beforeAll(async () => {
    await db.migrate.latest();
  });

  afterAll(async () => {
    await db.destroy();
  });

  beforeEach(async () => {
    for (const table of ['bet_settlements', 'bet_boost_locks', 'ride_definitions', 'user_rewards', 'audit_logs',
      'reward_profile_versions']) {
      await db(table).del();
    }
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('timestamps over HTTP (identical format and instants on SQLite and PostgreSQL)', () => {
    it('returns ISO-8601 UTC strings that are the instants the service wrote', async () => {
      const before = Date.now();
      const profileId = await createProfile();
      const granted = await grant('ts-user', profileId);
      const after = Date.now();

      for (const field of [granted.created_at, granted.updated_at, granted.start_time, granted.valid_until]) {
        expect(field).toMatch(ISO_UTC);
      }
      // created_at is "now", valid_until is now + 86 400 s: a zone-less column read in a UTC+2 process would be 2 h off.
      expect(Date.parse(granted.created_at)).toBeGreaterThanOrEqual(before - 1000);
      expect(Date.parse(granted.created_at)).toBeLessThanOrEqual(after + 1000);
      expect(Date.parse(granted.valid_until) - Date.parse(granted.created_at)).toBeGreaterThan(86_300_000);
      expect(Date.parse(granted.valid_until) - Date.parse(granted.created_at)).toBeLessThan(86_500_000);

      const read = await auth(request(app).get(`/api/rewards/${granted.id}?user_id=ts-user`));
      expect(read.status).toBe(200);
      expect(read.body).toMatchObject({
        created_at: granted.created_at, updated_at: granted.updated_at, valid_until: granted.valid_until,
      });
    });

    it('keeps ride timing, lock and settlement timestamps in the same format', async () => {
      const bet = await lockedBet('ts-bet');
      const reward = await auth(request(app).get(`/api/rewards/${bet.rewardId}?user_id=${bet.userId}`));
      expect(reward.body.start_time).toMatch(ISO_UTC);
      expect(reward.body.opted_in_at).toMatch(ISO_UTC);
      // The ride is USED after the lock, so its end time is public and is the instant the frozen snapshot holds.
      const row = await db('user_rewards').where({ id: bet.rewardId }).first();
      const math = parseJsonColumn(row.ticket_snapshot).rideMath as { startTime: string; endTime: string };
      expect(new Date(row.end_time).toISOString()).toBe(math.endTime);
      expect(reward.body.start_time).toBe(math.startTime);
      expect(reward.body.end_time).toBe(math.endTime);

      const lock = await auth(request(app).get('/api/boost/lock/ts-bet?brand_id=brand-a'));
      expect(lock.status).toBe(200);
      expect(lock.body.locked_at).toMatch(ISO_UTC);
      expect(Math.abs(Date.now() - Date.parse(lock.body.locked_at))).toBeLessThan(60_000);

      const settled = await settle('ts-bet', ALL_WON);
      expect(settled.status).toBe(201);
      const read = await auth(request(app).get('/api/settlement/ts-bet?brand_id=brand-a'));
      expect(read.status).toBe(200);
      expect(JSON.stringify(read.body)).not.toMatch(/\d{4}-\d{2}-\d{2} \d{2}:/);
      for (const value of Object.values(read.body).filter((v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v))) {
        expect(value).toMatch(ISO_UTC);
      }
    });
  });

  describe('real concurrent transactions (the same assertions on both databases)', () => {
    it('single-use lock: two concurrent locks of one bet create exactly one lock, one USED, one audit row', async () => {
      const ride = await enteredRide('single-use-bet');
      await freezeAtLivePoint(ride.rewardId);
      holdUntilAllArrive(betBoostLockRepository, 'findByBetId', 2);
      const creates = jest.spyOn(betBoostLockRepository, 'create');

      const responses = await Promise.all([
        lockRequest(ride.rewardId, ride.userId, 'single-use-bet'),
        lockRequest(ride.rewardId, ride.userId, 'single-use-bet'),
      ]);
      expect(creates).toHaveBeenCalledTimes(2);
      expect(responses.map((r) => r.status)).toEqual([201, 201]);
      expect(responses[0].body.lock_id).toBe(responses[1].body.lock_id);
      expect(await db('bet_boost_locks').where({ reward_id: ride.rewardId })).toHaveLength(1);
      expect((await db('user_rewards').where({ id: ride.rewardId }).first()).status).toBe('USED');
      expect(await db('audit_logs').where({ entity_type: 'bet_boost_lock', action: 'LOCK' })).toHaveLength(1);
    });

    async function cancelledBet(name: string) {
      const bet = await lockedBet(name);
      const cancelled = await settle(name, { outcome: 'CANCELLED' });
      expect(cancelled.status).toBe(201);
      return { ...bet, name, replacementId: cancelled.body.replacement_reward_id as string };
    }

    async function expectRevoked(bet: Awaited<ReturnType<typeof cancelledBet>>, resettled: request.Response, entered: request.Response) {
      const replacement = await db('user_rewards').where({ id: bet.replacementId }).first();
      expect(replacement.status).toBe('EXPIRED');
      expect(replacement.bet_id).toBeNull();
      expect(resettled.status).toBe(201);
      expect(entered.status).not.toBe(200);
      expect(await db('bet_settlements').where({ bet_id: bet.name })).toHaveLength(2);
      expect(await db('audit_logs').where({ entity_id: bet.replacementId, action: 'EXPIRE' })).toHaveLength(1);
    }

    async function expectEntered(bet: Awaited<ReturnType<typeof cancelledBet>>, resettled: request.Response, entered: request.Response) {
      const replacement = await db('user_rewards').where({ id: bet.replacementId }).first();
      expect(replacement.status).toBe('ENTERED');
      expect(entered.status).toBe(200);
      // The ride started first: the revocation is refused and the settlement stays at revision 1.
      expect(resettled.status).toBe(409);
      expect(await db('bet_settlements').where({ bet_id: bet.name })).toHaveLength(1);
      expect(await db('audit_logs').where({ entity_id: bet.replacementId, action: 'EXPIRE' })).toHaveLength(0);
    }

    it('revoke vs opt-in, opt-in first: the replacement is entered and the resettle is refused with 409', async () => {
      const bet = await cancelledBet('revoke-first-in');
      const entered = await optIn(bet.replacementId, bet.userId, 'revoke-first-in-new');
      const resettled = await resettle('revoke-first-in', LOST_ONE);
      await expectEntered(bet, resettled, entered);
    });

    it('revoke vs opt-in, resettle first: the replacement is revoked and the opt-in is rejected', async () => {
      const bet = await cancelledBet('revoke-first-out');
      const resettled = await resettle('revoke-first-out', LOST_ONE);
      const entered = await optIn(bet.replacementId, bet.userId, 'revoke-first-out-new');
      await expectRevoked(bet, resettled, entered);
    });

    it('revoke vs opt-in, truly concurrent (both held past their reads): exactly one of the two orderings results', async () => {
      for (let i = 0; i < 4; i += 1) {
        const bet = await cancelledBet(`revoke-race-${i}`);
        holdUntilAllArrive(userRewardRepository, 'findById', 2);
        const [resettled, entered] = await Promise.all([
          resettle(bet.name, LOST_ONE),
          optIn(bet.replacementId, bet.userId, `${bet.name}-new`),
        ]);
        jest.restoreAllMocks();
        expect([resettled.status, entered.status]).not.toContain(500);
        const replacement = await db('user_rewards').where({ id: bet.replacementId }).first();
        if (replacement.status === 'ENTERED') {
          await expectEntered(bet, resettled, entered);
        } else {
          await expectRevoked(bet, resettled, entered);
        }
      }
    });

    it('settlement revisions: concurrent different resettles give one revision n+1, the other a 409', async () => {
      await lockedBet('revision-race');
      expect((await settle('revision-race', ALL_WON)).status).toBe(201);
      holdUntilAllArrive(settlementRepository, 'findCurrentByLockId', 2);

      const responses = await Promise.all([
        resettle('revision-race', { outcome: 'CASHOUT' }),
        resettle('revision-race', LOST_ONE),
      ]);
      expect(responses.map((r) => r.status).sort()).toEqual([201, 409]);
      const rows = await db('bet_settlements').where({ bet_id: 'revision-race' }).orderBy('revision');
      expect(rows.map((row: { revision: number | string; is_current: unknown }) =>
        [Number(row.revision), Boolean(row.is_current)])).toEqual([[1, false], [2, true]]);
    });

    it('idempotency: concurrent identical opt-ins end with exactly one ride start', async () => {
      const profileId = await createProfile();
      const { id: rewardId } = await grant('idem-user', profileId);
      holdUntilAllArrive(rewardProfileRepository, 'findById', 2);
      const responses = await Promise.all([
        optIn(rewardId, 'idem-user', 'idem-bet'),
        optIn(rewardId, 'idem-user', 'idem-bet'),
      ]);
      expect(responses.map((r) => r.status).sort()).toEqual([200, 409]);
      expect(await db('audit_logs').where({ entity_id: rewardId, action: 'OPT_IN' })).toHaveLength(1);
    });
  });

  (isPg ? describe : describe.skip)('PostgreSQL only', () => {
    it('relies on READ COMMITTED: the default isolation of every application transaction', async () => {
      const level = await runInTransaction(async (tx) => {
        const q = await executorFor(tx);
        const result = await q.raw('SHOW transaction_isolation') as { rows: Array<{ transaction_isolation: string }> };
        return result.rows[0].transaction_isolation;
      });
      expect(level).toBe('read committed');
    });

    it('reads bigint, double and decimal columns back with exact values', async () => {
      const profile = await rewardProfileRepository.create({
        brandId: 'brand-a', maxBonusMinor: { EUR: Number.MAX_SAFE_INTEGER, USD: 1 }, rewardValiditySeconds: null,
        name: 'Types', minSelections: 3, minCombinedOdds: 7.1234, minSelectionOdds: 1.2,
        minBoostPct: 0.05, maxBoostPct: 1, rideDurationSeconds: 300,
      } as never);
      expect(profile.minCombinedOdds).toBe(7.1234);
      expect(profile.minSelectionOdds).toBe(1.2);
      expect(profile.maxBonusMinor).toEqual({ EUR: Number.MAX_SAFE_INTEGER, USD: 1 });

      const reward = await userRewardRepository.create({
        brandId: 'brand-a', userId: 'types-user', profileVersionId: profile.id,
        startTime: new Date().toISOString(), endTime: new Date().toISOString(), seed: 's',
      } as never);
      const started = await userRewardRepository.updateRideStart(
        reward.id, reward.startTime, reward.endTime, 'types-bet', { rideMath: { version: 4 } }, undefined,
        { stakeMinor: 1_000_000_000_000, currency: 'EUR', bonusCapMinor: Number.MAX_SAFE_INTEGER }
      );
      expect(started?.stakeMinor).toBe(1_000_000_000_000);
      expect(started?.bonusCapMinor).toBe(Number.MAX_SAFE_INTEGER);
      const raw = await db('user_rewards').where({ id: reward.id }).first();
      expect(typeof raw.stake_minor).toBe('string');

      for (const odds of [4.2, 1_000_000.5, 1e15, Number.MAX_VALUE]) {
        // One lock per reward (single-use), so every odds value gets its own reward.
        const own = await userRewardRepository.create({
          brandId: 'brand-a', userId: `odds-user-${odds}`, profileVersionId: profile.id,
          startTime: reward.startTime, endTime: reward.endTime, seed: 's',
        } as never);
        const lock = await betBoostLockRepository.create({
          brandId: 'brand-a', betId: `odds-${odds}`, rewardId: own.id, lockedBoostPct: 0.123456,
          qualifyingSelections: 3, qualifyingOdds: odds, ticketStrength: 0.654321, snapshot: {} as never,
        });
        expect(lock.qualifyingOdds).toBe(odds);
        const read = await betBoostLockRepository.findById(lock.id);
        expect(read?.qualifyingOdds).toBe(odds);
        expect(read?.lockedBoostPct).toBe(0.123456);
        expect(read?.ticketStrength).toBe(0.654321);
      }
    });

    it('runs every migration up from empty, rolls all of them back to zero and applies them again', async () => {
      const { knex, cleanup } = await createIsolatedKnex();
      try {
        const [, first] = await knex.migrate.latest();
        expect(first).toHaveLength(18);
        const [, again] = await knex.migrate.latest();
        expect(again).toEqual([]);

        await knex.migrate.rollback(undefined, true);
        const tables = await knex.raw(
          "SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema() AND table_type = 'BASE TABLE'"
        ) as { rows: Array<{ table_name: string }> };
        expect(tables.rows.map((row) => row.table_name).filter((name) => !name.startsWith('knex_'))).toEqual([]);

        const [, second] = await knex.migrate.latest();
        expect(second).toHaveLength(18);
      } finally {
        await cleanup();
      }
    });

    it('016 widens qualifying_odds to double precision on PostgreSQL and 016 down narrows it again', async () => {
      const { knex, cleanup } = await createIsolatedKnex();
      const typeOf = async () => {
        const result = await knex.raw(
          `SELECT data_type FROM information_schema.columns
            WHERE table_schema = current_schema() AND table_name = 'bet_boost_locks' AND column_name = 'qualifying_odds'`
        ) as { rows: Array<{ data_type: string }> };
        return result.rows[0].data_type;
      };
      try {
        for (let i = 0; i < 15; i += 1) await knex.migrate.up();
        expect(await typeOf()).toBe('numeric');
        await knex.migrate.up();
        expect(await typeOf()).toBe('double precision');
        await knex.migrate.up(); // 017
        await knex.migrate.down(); // 017
        await knex.migrate.down(); // 016
        expect(await typeOf()).toBe('numeric');
      } finally {
        await cleanup();
      }
    });

    it('017 converts zone-less timestamp columns to timestamptz reading clock values as UTC, and down reverses exactly that', async () => {
      const { knex, cleanup } = await createIsolatedKnex();
      const columnTypes = async () => {
        const result = await knex.raw(
          `SELECT c.table_name, c.column_name, c.data_type
             FROM information_schema.columns c
             JOIN information_schema.tables t USING (table_schema, table_name)
            WHERE c.table_schema = current_schema() AND t.table_type = 'BASE TABLE'
              AND c.table_name NOT LIKE 'knex\\_%' AND c.data_type LIKE 'timestamp%'
            ORDER BY c.table_name, c.column_name`
        ) as { rows: Array<{ table_name: string; column_name: string; data_type: string }> };
        return result.rows;
      };
      const typeSet = async () => new Set((await columnTypes()).map((c) => c.data_type));
      try {
        for (let i = 0; i < 16; i += 1) await knex.migrate.up();
        // knex creates timestamp columns as timestamptz on PostgreSQL: a database built by migrations has nothing to convert.
        const fresh = await columnTypes();
        expect(fresh.length).toBeGreaterThan(10);
        expect(await typeSet()).toEqual(new Set(['timestamp with time zone']));
        await knex.migrate.up();
        expect(await columnTypes()).toEqual(fresh);
        await knex.migrate.down();
        expect(await columnTypes()).toEqual(fresh);
        expect(await knex.schema.hasTable('knex_017_converted_timestamps')).toBe(false);

        // A database whose columns are zone-less (not created by these migrations): simulate it, with data.
        for (const { table_name: table, column_name: column } of fresh) {
          await knex.raw('ALTER TABLE ?? ALTER COLUMN ?? TYPE timestamp USING ?? AT TIME ZONE \'UTC\'', [table, column, column]);
        }
        // One column is already timestamptz and must stay that way after a rollback.
        await knex.raw('ALTER TABLE ?? ALTER COLUMN ?? TYPE timestamptz USING ?? AT TIME ZONE \'UTC\'',
          ['audit_logs', 'timestamp', 'timestamp']);
        expect(await typeSet()).toEqual(new Set(['timestamp without time zone', 'timestamp with time zone']));

        const profileId = '11111111-1111-4111-8111-111111111111';
        await knex('reward_profile_versions').insert({
          id: profileId, name: 'Legacy', min_selections: 3, min_combined_odds: 3, min_selection_odds: 1.2,
          min_boost_pct: 0.05, max_boost_pct: 0.5, ride_duration_seconds: 60, checkpoint_count: 12,
          volatility: 0.5, is_active: true, created_at: '2026-02-03T07:00:00.000Z', updated_at: '2026-02-03T07:00:00.000Z',
        });

        await knex.migrate.up();
        expect(await typeSet()).toEqual(new Set(['timestamp with time zone']));
        // The value the repositories wrote ("07:00Z") reads back as that same instant, whatever the process offset.
        const converted = await knex('reward_profile_versions').where({ id: profileId }).first();
        expect((converted.created_at as Date).toISOString()).toBe('2026-02-03T07:00:00.000Z');
        // A new ISO write is stored as the instant.
        await knex('reward_profile_versions').where({ id: profileId }).update({ updated_at: '2026-02-03T09:30:00+02:00' });
        const instant = await knex('reward_profile_versions').where({ id: profileId }).first();
        expect((instant.updated_at as Date).toISOString()).toBe('2026-02-03T07:30:00.000Z');

        await knex.migrate.down();
        const reverted = await columnTypes();
        expect(reverted.filter((c) => c.data_type === 'timestamp with time zone').map((c) => `${c.table_name}.${c.column_name}`))
          .toEqual(['audit_logs.timestamp']);
        expect(reverted).toHaveLength(fresh.length);
        const clock = await knex.raw(
          "SELECT to_char(created_at, 'YYYY-MM-DD\"T\"HH24:MI:SS') AS c FROM reward_profile_versions WHERE id = ?", [profileId]
        ) as { rows: Array<{ c: string }> };
        expect(clock.rows[0].c).toBe('2026-02-03T07:00:00');
        expect(await knex.schema.hasTable('knex_017_converted_timestamps')).toBe(false);
      } finally {
        await cleanup();
      }
    });
  });
});
