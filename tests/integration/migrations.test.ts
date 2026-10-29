import path from 'path';
import Knex, { type Knex as KnexType } from 'knex';
import { legacyBetId } from '../../migrations/013_rename_duplicate_bet_bindings';
import { isUniqueViolation } from '../../src/db/repositories/transaction';

const MIGRATIONS = path.resolve(__dirname, '../../migrations');

const PROFILE = '11111111-1111-4111-8111-111111111111';
const R = {
  lockedFirst: 'a1111111-0000-4000-8000-000000000001',
  lockedOwner: 'a2222222-0000-4000-8000-000000000002',
  lockedLast: 'a3333333-0000-4000-8000-000000000003',
  earliest: 'b4444444-0000-4000-8000-000000000004',
  later: 'b5555555-0000-4000-8000-000000000005',
  unique: 'c6666666-0000-4000-8000-000000000006',
  taken: 'd7777777-0000-4000-8000-000000000007',
  noBetA: 'e8888888-0000-4000-8000-000000000008',
  noBetB: 'e9999999-0000-4000-8000-000000000009',
} as const;

function newKnex(): KnexType {
  return Knex({
    client: 'sqlite3',
    connection: { filename: ':memory:' },
    useNullAsDefault: true,
    migrations: { directory: MIGRATIONS, extension: 'ts' },
  });
}

async function migrateTo011(knex: KnexType): Promise<void> {
  for (let i = 0; i < 11; i += 1) {
    await knex.migrate.up();
  }
}

async function insertReward(
  knex: KnexType,
  id: string,
  betId: string | null,
  createdAt: string,
  status = 'ENTERED'
): Promise<void> {
  await knex('user_rewards').insert({
    id,
    user_id: `user-${id.slice(0, 2)}`,
    profile_version_id: PROFILE,
    status,
    start_time: createdAt,
    end_time: createdAt,
    seed: `seed-${id}`,
    bet_id: betId,
    created_at: createdAt,
    updated_at: createdAt,
  });
}

/** A pre-Phase-1a database with the same shape of duplicates as the owner's dev.db. */
async function seedLegacyData(knex: KnexType): Promise<void> {
  const now = '2026-02-03T07:00:00.000Z';
  await knex('reward_profile_versions').insert({
    id: PROFILE, name: 'Legacy', min_selections: 3, min_combined_odds: 3, min_selection_odds: 1.2,
    min_boost_pct: 0.05, max_boost_pct: 0.5, ride_duration_seconds: 60, checkpoint_count: 12,
    volatility: 0.5, is_active: true, created_at: now, updated_at: now,
  });

  // Three rewards share one bet; the middle one owns the lock.
  await insertReward(knex, R.lockedFirst, 'dup-locked', '2026-02-03T07:01:00.000Z');
  await insertReward(knex, R.lockedOwner, 'dup-locked', '2026-02-03T07:02:00.000Z', 'USED');
  await insertReward(knex, R.lockedLast, 'dup-locked', '2026-02-03T07:03:00.000Z');
  // Two rewards share a bet nobody locked: the earliest keeps it.
  await insertReward(knex, R.later, 'dup-unlocked', '2026-02-03T07:05:00.000Z');
  await insertReward(knex, R.earliest, 'dup-unlocked', '2026-02-03T07:04:00.000Z');
  await insertReward(knex, R.unique, 'unique-bet', '2026-02-03T07:06:00.000Z');
  // A reward that already uses the name the rename would pick.
  await insertReward(knex, R.taken, legacyBetId('dup-unlocked', R.later), '2026-02-03T07:07:00.000Z');
  await insertReward(knex, R.noBetA, null, '2026-02-03T07:08:00.000Z', 'GRANTED');
  await insertReward(knex, R.noBetB, null, '2026-02-03T07:09:00.000Z', 'GRANTED');

  await knex('bet_boost_locks').insert({
    id: '22222222-2222-4222-8222-222222222222', bet_id: 'dup-locked', reward_id: R.lockedOwner,
    locked_boost_pct: 0.2, qualifying_selections: 3, qualifying_odds: 4, ticket_strength: 0.5,
    snapshot: '{}', locked_at: now, created_at: now,
  });
}

async function betIds(knex: KnexType): Promise<Record<string, string | null>> {
  const rows = await knex('user_rewards').select('id', 'bet_id');
  return Object.fromEntries(rows.map((row: { id: string; bet_id: string | null }) => [row.id, row.bet_id]));
}

async function auditActions(knex: KnexType, action: string) {
  return knex('audit_logs').where({ entity_type: 'user_reward', action }).orderBy('entity_id');
}

describe('Phase 1a migrations 012-015', () => {
  let knex: KnexType;

  beforeEach(() => {
    knex = newKnex();
  });

  afterEach(async () => {
    await knex.destroy();
  });

  describe('on a database with legacy duplicate bet bindings', () => {
    const expectedAfterUp = {
      [R.lockedFirst]: legacyBetId('dup-locked', R.lockedFirst),
      [R.lockedOwner]: 'dup-locked',
      [R.lockedLast]: legacyBetId('dup-locked', R.lockedLast),
      [R.earliest]: 'dup-unlocked',
      // The 8-character suffix was taken, so the rename widens it by one character.
      [R.later]: legacyBetId('dup-unlocked', R.later, 9),
      [R.unique]: 'unique-bet',
      [R.taken]: legacyBetId('dup-unlocked', R.later),
      [R.noBetA]: null,
      [R.noBetB]: null,
    };

    beforeEach(async () => {
      await migrateTo011(knex);
      await seedLegacyData(knex);
    });

    it('keeps every row, keeps the binding on the locked/earliest reward and renames the rest with audit rows', async () => {
      const before = await betIds(knex);
      const [rewardCount, lockCount] = [
        (await knex('user_rewards').count('* as c').first())!.c,
        (await knex('bet_boost_locks').count('* as c').first())!.c,
      ];

      const [, applied] = await knex.migrate.latest();
      expect(applied).toEqual([
        '012_add_brand_scoping_and_money_columns.ts',
        '013_rename_duplicate_bet_bindings.ts',
        '014_add_user_rewards_brand_bet_unique_index.ts',
        '015_create_bet_settlements.ts',
      ]);

      expect((await knex('user_rewards').count('* as c').first())!.c).toBe(rewardCount);
      expect((await knex('bet_boost_locks').count('* as c').first())!.c).toBe(lockCount);
      expect(await betIds(knex)).toEqual(expectedAfterUp);
      // Renamed names are unique and never collide with another reward.
      const names = Object.values(await betIds(knex)).filter((name) => name !== null);
      expect(new Set(names).size).toBe(names.length);
      // Unchanged rows keep their previous bet_id.
      for (const id of [R.lockedOwner, R.earliest, R.unique, R.taken, R.noBetA, R.noBetB]) {
        expect(before[id]).toBe(expectedAfterUp[id]);
      }

      const renames = await auditActions(knex, 'LEGACY_BET_ID_RENAMED');
      expect(renames.map((row: { entity_id: string }) => row.entity_id).sort()).toEqual(
        [R.lockedFirst, R.lockedLast, R.later].sort()
      );
      const payload = JSON.parse(renames.find((row: { entity_id: string }) => row.entity_id === R.lockedFirst).payload);
      expect(payload).toMatchObject({
        brandId: 'default',
        originalBetId: 'dup-locked',
        renamedBetId: legacyBetId('dup-locked', R.lockedFirst),
        keptRewardId: R.lockedOwner,
      });
      const unlockedPayload = JSON.parse(renames.find((row: { entity_id: string }) => row.entity_id === R.later).payload);
      expect(unlockedPayload.keptRewardId).toBe(R.earliest);
    });

    it('gives legacy rows brand default, no validity, empty caps and a lock brand', async () => {
      await knex.migrate.latest();
      const profile = await knex('reward_profile_versions').first();
      expect(profile.brand_id).toBe('default');
      expect(profile.max_bonus_minor).toBe('{}');
      expect(profile.reward_validity_seconds).toBeNull();
      for (const reward of await knex('user_rewards')) {
        expect(reward).toMatchObject({
          brand_id: 'default', valid_until: null, stake_minor: null, currency: null,
          bonus_cap_minor: null, replaces_reward_id: null,
        });
      }
      expect((await knex('bet_boost_locks').first()).brand_id).toBe('default');
    });

    it('creates the (brand_id, bet_id) unique index: NULL bets repeat, other brands and brand-wide duplicates behave', async () => {
      await knex.migrate.latest();
      const now = new Date().toISOString();
      const base = {
        user_id: 'idx', profile_version_id: PROFILE, status: 'GRANTED', start_time: now, end_time: now,
        seed: 's', created_at: now, updated_at: now,
      };

      await knex('user_rewards').insert({ ...base, id: 'n1', brand_id: 'default', bet_id: null });
      await knex('user_rewards').insert({ ...base, id: 'n2', brand_id: 'default', bet_id: null });
      await knex('user_rewards').insert({ ...base, id: 'o1', brand_id: 'other', bet_id: 'unique-bet' });

      let error: unknown;
      try {
        await knex('user_rewards').insert({ ...base, id: 'd1', brand_id: 'default', bet_id: 'unique-bet' });
      } catch (caught) {
        error = caught;
      }
      expect(isUniqueViolation(error)).toBe(true);
    });

    it('replaces unique(bet_id) on bet_boost_locks with unique(brand_id, bet_id) and swaps the settlement tables', async () => {
      await knex.migrate.latest();
      const now = new Date().toISOString();
      const lockRow = {
        reward_id: R.unique, locked_boost_pct: 0.1, qualifying_selections: 3, qualifying_odds: 4,
        ticket_strength: 0.5, snapshot: '{}', locked_at: now, created_at: now,
      };
      // Another brand may lock the same bet_id ...
      await knex('bet_boost_locks').insert({
        ...lockRow, id: '33333333-3333-4333-8333-333333333333', bet_id: 'dup-locked', brand_id: 'other',
      });
      // ... but one brand may not lock it twice.
      let error: unknown;
      try {
        await knex('bet_boost_locks').insert({
          ...lockRow, id: '44444444-4444-4444-8444-444444444444', bet_id: 'dup-locked', brand_id: 'other',
          reward_id: R.taken,
        });
      } catch (caught) {
        error = caught;
      }
      expect(isUniqueViolation(error)).toBe(true);
      expect(await knex.schema.hasTable('settlement_records')).toBe(false);
      expect(await knex.schema.hasTable('bet_settlements')).toBe(true);
      // The legacy lock row keeps its data.
      expect((await knex('bet_boost_locks').where({ brand_id: 'default', bet_id: 'dup-locked' })).length).toBe(1);
    });

    it('is idempotent: running latest again changes nothing', async () => {
      await knex.migrate.latest();
      const snapshot = JSON.stringify([await betIds(knex), await knex('audit_logs').select('id')]);

      const [, applied] = await knex.migrate.latest();
      expect(applied).toEqual([]);
      expect(JSON.stringify([await betIds(knex), await knex('audit_logs').select('id')])).toBe(snapshot);
    });

    it('rolls back to the original bet bindings and columns, then migrates again to the same result', async () => {
      const original = await betIds(knex);
      await knex.migrate.latest();

      const [, rolledBack] = await knex.migrate.rollback();
      expect(rolledBack).toHaveLength(4);
      expect(await knex.schema.hasTable('settlement_records')).toBe(true);
      expect(await knex.schema.hasTable('bet_settlements')).toBe(false);
      expect(await betIds(knex)).toEqual(original);
      expect(await knex.schema.hasColumn('user_rewards', 'brand_id')).toBe(false);
      expect(await knex.schema.hasColumn('user_rewards', 'stake_minor')).toBe(false);
      expect(await knex.schema.hasColumn('reward_profile_versions', 'max_bonus_minor')).toBe(false);
      expect(await knex.schema.hasColumn('bet_boost_locks', 'brand_id')).toBe(false);
      // Rows survive the rollback, and the rename history stays in the audit log.
      expect((await knex('user_rewards').count('* as c').first())!.c).toBe(9);
      expect(await auditActions(knex, 'LEGACY_BET_ID_RESTORED')).toHaveLength(3);
      expect(await auditActions(knex, 'LEGACY_BET_ID_RENAMED')).toHaveLength(3);
      // Pre-Phase-1a constraints still hold after the rollback.
      expect((await knex('bet_boost_locks').select('bet_id')).map((row: { bet_id: string }) => row.bet_id))
        .toEqual(['dup-locked']);

      await knex.migrate.latest();
      expect(await betIds(knex)).toEqual(expectedAfterUp);
      expect(await auditActions(knex, 'LEGACY_BET_ID_RENAMED')).toHaveLength(6);
    });
  });

  it('migrates a fresh empty database without touching audit_logs', async () => {
    const [, applied] = await knex.migrate.latest();
    expect(applied).toHaveLength(15);
    expect(await knex('audit_logs')).toHaveLength(0);
    expect(await knex.schema.hasColumn('user_rewards', 'replaces_reward_id')).toBe(true);
    expect(await knex.schema.hasColumn('reward_profile_versions', 'reward_validity_seconds')).toBe(true);

    const [, again] = await knex.migrate.latest();
    expect(again).toEqual([]);
    await knex.migrate.rollback();
    expect(await knex.schema.hasColumn('user_rewards', 'brand_id')).toBe(false);
    await knex.migrate.latest();
    expect(await knex.schema.hasColumn('user_rewards', 'brand_id')).toBe(true);
  });

  describe('015 bet_settlements', () => {
    async function migrateTo014(): Promise<void> {
      for (let i = 0; i < 14; i += 1) {
        await knex.migrate.up();
      }
    }

    async function appliedNames(): Promise<string[]> {
      return (await knex('knex_migrations').select('name').orderBy('id')).map((row: { name: string }) => row.name);
    }

    async function seedLock(id: string, brandId: string, betId: string, rewardId: string): Promise<void> {
      const now = new Date().toISOString();
      await knex('bet_boost_locks').insert({
        id, brand_id: brandId, bet_id: betId, reward_id: rewardId, locked_boost_pct: 0.2, qualifying_selections: 3,
        qualifying_odds: 4, ticket_strength: 0.5, snapshot: '{}', locked_at: now, created_at: now,
      });
    }

    it('aborts without changing anything while the legacy settlement_records table has rows', async () => {
      await migrateTo014();
      await seedLock('55555555-5555-4555-8555-555555555555', 'default', 'legacy-bet', R.unique);
      await knex('settlement_records').insert({
        id: '66666666-6666-4666-8666-666666666666', bet_id: 'legacy-bet', outcome: 'WIN', winnings: 10,
        bonus_amount: 2, settled_at: new Date().toISOString(), created_at: new Date().toISOString(),
      });

      await expect(knex.migrate.latest()).rejects.toThrow(
        /Migration 015 aborted: the legacy settlement_records table has 1 row\(s\)/
      );
      expect(await appliedNames()).not.toContain('015_create_bet_settlements.ts');
      expect(await knex('settlement_records')).toHaveLength(1);
      expect(await knex.schema.hasTable('bet_settlements')).toBe(false);
      // unique(bet_id) on bet_boost_locks is still in place.
      let error: unknown;
      try {
        await seedLock('77777777-7777-4777-8777-777777777777', 'other', 'legacy-bet', R.taken);
      } catch (caught) {
        error = caught;
      }
      expect(isUniqueViolation(error)).toBe(true);

      // Once the legacy rows are archived and removed, the migration applies.
      await knex('settlement_records').del();
      const [, applied] = await knex.migrate.latest();
      expect(applied).toEqual(['015_create_bet_settlements.ts']);
      expect(await knex.schema.hasTable('settlement_records')).toBe(false);
    });

    async function lockIndexNames(): Promise<string[]> {
      const rows = await knex.raw("PRAGMA index_list('bet_boost_locks')") as Array<{ name: string }>;
      return rows.map((row) => row.name);
    }

    it('drops the redundant non-unique (brand_id, bet_id) lock index and recreates it on rollback', async () => {
      await migrateTo014();
      expect(await lockIndexNames()).toContain('bet_boost_locks_brand_id_bet_id_index');
      await knex.migrate.latest();
      const up = await lockIndexNames();
      expect(up).not.toContain('bet_boost_locks_brand_id_bet_id_index');
      expect(up).toContain('bet_boost_locks_brand_id_bet_id_unique');
      await knex.migrate.down();
      const down = await lockIndexNames();
      expect(down).toContain('bet_boost_locks_brand_id_bet_id_index');
      expect(down).not.toContain('bet_boost_locks_brand_id_bet_id_unique');
    });

    it('creates bigint money columns, an exact text total return, unique(lock_id, revision) and one current revision per lock', async () => {
      await knex.migrate.latest();
      await seedLock('55555555-5555-4555-8555-555555555555', 'brand-a', 'bet-1', R.unique);
      const HUGE_RETURN = `1${'0'.repeat(412)}`;
      const now = new Date().toISOString();
      const row = {
        brand_id: 'brand-a', bet_id: 'bet-1', lock_id: '55555555-5555-4555-8555-555555555555',
        outcome: 'SETTLED', bet_result: 'WON', legs: '[]', currency: 'EUR', stake_minor: 1_000_000_000_000,
        total_return_minor: HUGE_RETURN, locked_boost_pct: 0.2, bonus_minor: 1995,
        bonus_cap_minor: 50_000, cap_applied: false, minimums_met: null, settled_at: now, created_at: now,
      };
      await knex('bet_settlements').insert({ ...row, id: 'r1', revision: 1, is_current: true });
      const stored = await knex('bet_settlements').where({ id: 'r1' }).first();
      // Text, not bigint: 100 legs at odds 10,000 on a 1e12 stake return 10^412 minor units.
      expect(stored.total_return_minor).toBe(HUGE_RETURN);
      expect(stored.stake_minor).toBe(1_000_000_000_000);

      const attempts = [
        { ...row, id: 'r1-again', revision: 1, is_current: false },
        { ...row, id: 'r2-current', revision: 2, is_current: true },
      ];
      for (const attempt of attempts) {
        let error: unknown;
        try {
          await knex('bet_settlements').insert(attempt);
        } catch (caught) {
          error = caught;
        }
        expect(isUniqueViolation(error)).toBe(true);
      }
      await knex('bet_settlements').insert({ ...row, id: 'r2', revision: 2, is_current: false });
      expect(await knex('bet_settlements')).toHaveLength(2);
    });

    it('rolls back to the legacy table and unique(bet_id), refusing while data would be lost', async () => {
      await knex.migrate.latest();
      await seedLock('55555555-5555-4555-8555-555555555555', 'brand-a', 'shared-bet', R.unique);
      await seedLock('66666666-6666-4666-8666-666666666666', 'brand-b', 'shared-bet', R.taken);

      await expect(knex.migrate.down()).rejects.toThrow(/locked in more than one brand/);
      expect(await knex.schema.hasTable('bet_settlements')).toBe(true);

      await knex('bet_boost_locks').where({ brand_id: 'brand-b' }).del();
      const now = new Date().toISOString();
      await knex('bet_settlements').insert({
        id: 'r1', brand_id: 'brand-a', bet_id: 'shared-bet', lock_id: '55555555-5555-4555-8555-555555555555',
        revision: 1, is_current: true, outcome: 'CASHOUT', bet_result: 'CASHED_OUT', currency: 'EUR',
        stake_minor: 1000, locked_boost_pct: 0.2, bonus_minor: 0, bonus_cap_minor: 50_000, cap_applied: false,
        settled_at: now, created_at: now,
      });
      await expect(knex.migrate.down()).rejects.toThrow(/bet_settlements has 1 row/);

      await knex('bet_settlements').del();
      await knex.migrate.down();
      expect(await appliedNames()).not.toContain('015_create_bet_settlements.ts');
      expect(await knex.schema.hasTable('bet_settlements')).toBe(false);
      expect(await knex.schema.hasTable('settlement_records')).toBe(true);
      let error: unknown;
      try {
        await seedLock('77777777-7777-4777-8777-777777777777', 'brand-b', 'shared-bet', R.taken);
      } catch (caught) {
        error = caught;
      }
      expect(isUniqueViolation(error)).toBe(true);

      const [, applied] = await knex.migrate.latest();
      expect(applied).toEqual(['015_create_bet_settlements.ts']);
    });
  });
});
