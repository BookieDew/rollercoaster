import path from 'path';
import Knex, { type Knex as KnexType } from 'knex';

const MIGRATIONS = path.resolve(__dirname, '../../migrations');
const PROFILE = '11111111-1111-4111-8111-111111111111';
const NOW = '2026-02-03T07:00:00.000Z';
const CLOSE = 'RIDE_CLOSED_V4_MIGRATION';

const ids = {
  v1: 'a0000001-0000-4000-8000-000000000001',
  v2: 'a0000002-0000-4000-8000-000000000002',
  v3: 'a0000003-0000-4000-8000-000000000003',
  none: 'a0000004-0000-4000-8000-000000000004',
  v4: 'a0000005-0000-4000-8000-000000000005',
  lockedEntered: 'a0000006-0000-4000-8000-000000000006',
  usedV3: 'a0000007-0000-4000-8000-000000000007',
  settledV3: 'a0000008-0000-4000-8000-000000000008',
  granted: 'a0000009-0000-4000-8000-000000000009',
  expired: 'a000000a-0000-4000-8000-00000000000a',
  otherBrandV3: 'a000000b-0000-4000-8000-00000000000b',
} as const;
const CLOSED_BY_MIGRATION = [ids.v1, ids.v2, ids.v3, ids.none, ids.otherBrandV3];

function newKnex(): KnexType {
  return Knex({
    client: 'sqlite3',
    connection: { filename: ':memory:' },
    useNullAsDefault: true,
    migrations: { directory: MIGRATIONS, extension: 'ts' },
  });
}

async function migrateTo015(knex: KnexType): Promise<void> {
  for (let i = 0; i < 15; i += 1) await knex.migrate.up();
}

async function insertReward(
  knex: KnexType,
  id: string,
  status: string,
  snapshot: unknown,
  extra: Record<string, unknown> = {}
): Promise<void> {
  await knex('user_rewards').insert({
    id,
    user_id: `user-${id.slice(0, 8)}`,
    profile_version_id: PROFILE,
    status,
    start_time: NOW,
    end_time: NOW,
    seed: `seed-${id}`,
    bet_id: `bet-${id.slice(0, 8)}`,
    ticket_snapshot: snapshot === undefined ? null : JSON.stringify(snapshot),
    created_at: NOW,
    updated_at: NOW,
    ...extra,
  });
}

async function insertLock(knex: KnexType, lockId: string, rewardId: string, version: number | null): Promise<void> {
  await knex('bet_boost_locks').insert({
    id: lockId, bet_id: `bet-${rewardId.slice(0, 8)}`, reward_id: rewardId, locked_boost_pct: 0.2,
    qualifying_selections: 3, qualifying_odds: 4.2, ticket_strength: 0.5,
    snapshot: JSON.stringify({ rideMath: { version }, boostLocked: 0.2, note: 'frozen' }),
    locked_at: NOW, created_at: NOW,
  });
}

async function seed(knex: KnexType): Promise<void> {
  await knex('reward_profile_versions').insert({
    id: PROFILE, name: 'Legacy', min_selections: 3, min_combined_odds: 3, min_selection_odds: 1.2,
    min_boost_pct: 0.05, max_boost_pct: 0.5, ride_duration_seconds: 60, checkpoint_count: 12,
    volatility: 0.5, is_active: true, created_at: NOW, updated_at: NOW,
  });
  const v = (version: number) => ({ rideMath: { version, note: `v${version}` }, other: 'kept' });
  await insertReward(knex, ids.v1, 'ENTERED', v(1));
  await insertReward(knex, ids.v2, 'ENTERED', v(2));
  await insertReward(knex, ids.v3, 'ENTERED', v(3));
  await insertReward(knex, ids.none, 'ENTERED', { ticket: 'pre-snapshot ride' });
  await insertReward(knex, ids.v4, 'ENTERED', { rideMath: { version: 4, mathVersion: 'V4' } });
  await insertReward(knex, ids.lockedEntered, 'ENTERED', v(3));
  await insertReward(knex, ids.usedV3, 'USED', v(3));
  await insertReward(knex, ids.settledV3, 'USED', v(2));
  await insertReward(knex, ids.granted, 'GRANTED', undefined);
  await insertReward(knex, ids.expired, 'EXPIRED', v(3));
  await insertReward(knex, ids.otherBrandV3, 'ENTERED', v(3), { brand_id: 'brand-b' });

  await insertLock(knex, 'b0000001-0000-4000-8000-000000000001', ids.lockedEntered, 3);
  await insertLock(knex, 'b0000002-0000-4000-8000-000000000002', ids.usedV3, 3);
  await insertLock(knex, 'b0000003-0000-4000-8000-000000000003', ids.settledV3, 2);
  await knex('bet_settlements').insert({
    id: 'c0000001-0000-4000-8000-000000000001', brand_id: 'default', bet_id: `bet-${ids.settledV3.slice(0, 8)}`,
    lock_id: 'b0000003-0000-4000-8000-000000000003', revision: 1, is_current: true, outcome: 'SETTLED',
    bet_result: 'WON', legs: '[]', currency: 'EUR', stake_minor: 1000, total_return_minor: '5000',
    locked_boost_pct: 0.2, bonus_minor: 200, bonus_cap_minor: 50000, cap_applied: false,
    settled_at: NOW, created_at: NOW,
  });
}

/** Full-row dump of every row that must not change, keyed by table and id. */
async function untouched(knex: KnexType): Promise<string> {
  const keep = [ids.v4, ids.lockedEntered, ids.usedV3, ids.settledV3, ids.granted, ids.expired];
  return JSON.stringify({
    rewards: await knex('user_rewards').whereIn('id', keep).orderBy('id'),
    locks: await knex('bet_boost_locks').orderBy('id'),
    settlements: await knex('bet_settlements').orderBy('id'),
  });
}

async function statuses(knex: KnexType): Promise<Record<string, string>> {
  const rows = await knex('user_rewards').select('id', 'status');
  return Object.fromEntries(rows.map((row: { id: string; status: string }) => [row.id, row.status]));
}

describe('migration 016: close in-flight V1-V3 rides, widen qualifying_odds', () => {
  let knex: KnexType;

  beforeEach(async () => {
    knex = newKnex();
    await migrateTo015(knex);
    await seed(knex);
  });

  afterEach(async () => {
    await knex.destroy();
  });

  it('closes only unlocked, unsettled V1-V3 (and snapshot-less) rides, one audit row each', async () => {
    const before = await untouched(knex);
    const seedsBefore = await knex('user_rewards').select('id', 'seed').orderBy('id');
    const snapshotsBefore = await knex('user_rewards').select('id', 'ticket_snapshot').orderBy('id');

    const [, applied] = await knex.migrate.latest();
    expect(applied).toEqual(['016_close_inflight_rides_for_v4.ts']);

    const after = await statuses(knex);
    for (const id of CLOSED_BY_MIGRATION) expect(after[id]).toBe('EXPIRED');
    expect(after[ids.v4]).toBe('ENTERED');
    expect(after[ids.lockedEntered]).toBe('ENTERED');
    expect(after[ids.usedV3]).toBe('USED');
    expect(after[ids.settledV3]).toBe('USED');
    expect(after[ids.granted]).toBe('GRANTED');
    expect(after[ids.expired]).toBe('EXPIRED');

    // Locked, settled, V4, granted and already-expired rows plus locks and settlements: byte-identical.
    expect(await untouched(knex)).toBe(before);
    // No seed or snapshot changes anywhere (settled bets are re-verified from the seed).
    expect(await knex('user_rewards').select('id', 'seed').orderBy('id')).toEqual(seedsBefore);
    expect(await knex('user_rewards').select('id', 'ticket_snapshot').orderBy('id')).toEqual(snapshotsBefore);

    const audits = await knex('audit_logs').where({ action: CLOSE }).orderBy('entity_id');
    expect(audits.map((row: { entity_id: string }) => row.entity_id)).toEqual([...CLOSED_BY_MIGRATION].sort());
    const byId = Object.fromEntries(audits.map((row: { entity_id: string; payload: string }) =>
      [row.entity_id, JSON.parse(row.payload)]));
    expect(byId[ids.v2]).toMatchObject({
      reason: 'RIDE_CLOSED_BY_V4_MIGRATION', previousStatus: 'ENTERED', newStatus: 'EXPIRED',
      previousMathVersion: 2, brandId: 'default',
    });
    expect(byId[ids.none].previousMathVersion).toBeNull();
    expect(byId[ids.otherBrandV3].brandId).toBe('brand-b');
    expect(await knex('audit_logs')).toHaveLength(CLOSED_BY_MIGRATION.length);
  });

  it('is idempotent: a second run changes nothing, even after the migration is re-applied', async () => {
    await knex.migrate.latest();
    const snapshot = JSON.stringify([await knex('user_rewards').orderBy('id'), await knex('audit_logs').orderBy('id')]);

    // Run the up step again by hand: nothing is ENTERED on V1-V3 any more.
    const migration = await import('../../migrations/016_close_inflight_rides_for_v4');
    await migration.up(knex);
    expect(JSON.stringify([await knex('user_rewards').orderBy('id'), await knex('audit_logs').orderBy('id')]))
      .toBe(snapshot);
    const [, again] = await knex.migrate.latest();
    expect(again).toEqual([]);
  });

  it('rolls back exactly the rows it closed, leaving rides that changed since untouched', async () => {
    const original = await statuses(knex);
    await knex.migrate.latest();
    // A closed ride that moved on after the migration must not be reopened.
    const now = new Date(Date.now() + 5000).toISOString();
    await knex('audit_logs').insert({
      id: 'd0000001-0000-4000-8000-000000000001', entity_type: 'user_reward', entity_id: ids.v2,
      action: 'SOMETHING_ELSE', payload: null, timestamp: now, created_at: now,
    });
    const before = await untouched(knex);

    await knex.migrate.rollback();
    const rolled = await statuses(knex);
    for (const id of [ids.v1, ids.v3, ids.none, ids.otherBrandV3]) expect(rolled[id]).toBe(original[id]);
    expect(rolled[ids.v2]).toBe('EXPIRED');
    expect(await untouched(knex)).toBe(before);
    expect(await knex('audit_logs').where({ action: 'RIDE_RESTORED_V4_MIGRATION_ROLLBACK' })).toHaveLength(4);

    // Re-applying closes the restored rides again (one more audit row each); a second rollback restores each once.
    await knex.migrate.latest();
    expect(await knex('audit_logs').where({ action: CLOSE })).toHaveLength(CLOSED_BY_MIGRATION.length + 4);
    await knex.migrate.rollback();
    const again = await statuses(knex);
    for (const id of [ids.v1, ids.v3, ids.none, ids.otherBrandV3]) expect(again[id]).toBe('ENTERED');
    expect(await knex('audit_logs').where({ action: 'RIDE_RESTORED_V4_MIGRATION_ROLLBACK' })).toHaveLength(8);
  });

  it('treats another audit row in the same millisecond as later, so that ride is not reopened', async () => {
    await knex.migrate.latest();
    const close = await knex('audit_logs').where({ action: CLOSE, entity_id: ids.v2 }).first();
    await knex('audit_logs').insert({
      id: '00000000-0000-4000-8000-000000000000', entity_type: 'user_reward', entity_id: ids.v2,
      action: 'SAME_MILLISECOND', payload: null, timestamp: close.timestamp, created_at: close.created_at,
    });
    await knex.migrate.rollback();
    const rolled = await statuses(knex);
    expect(rolled[ids.v2]).toBe('EXPIRED');
    expect(rolled[ids.v1]).toBe('ENTERED');
  });

  it('stores any finite double in qualifying_odds, including Number.MAX_VALUE, and keeps the seed', async () => {
    await knex.migrate.latest();
    for (const [index, value] of [4.2, 1_000_000.5, 1e15, Number.MAX_VALUE].entries()) {
      const rewardId = `e000000${index}-0000-4000-8000-00000000000${index}`;
      await insertReward(knex, rewardId, 'USED', { rideMath: { version: 4 } });
      await knex('bet_boost_locks').insert({
        id: `f000000${index}-0000-4000-8000-00000000000${index}`, bet_id: `big-${index}`, reward_id: rewardId,
        locked_boost_pct: 0.2, qualifying_selections: 3, qualifying_odds: value, ticket_strength: 0.5,
        snapshot: '{}', locked_at: NOW, created_at: NOW,
      });
      const stored = await knex('bet_boost_locks').where({ bet_id: `big-${index}` }).first();
      expect(Number(stored.qualifying_odds)).toBe(value);
    }
    const reward = await knex('user_rewards').where({ id: ids.v4 }).first();
    expect(reward.seed).toBe(`seed-${ids.v4}`);
  });

  it("runs the migration's own PostgreSQL branch: uuid-safe first page, conditional update, widening and narrowing", async () => {
    const migration = await import('../../migrations/016_close_inflight_rides_for_v4');
    const rewardId = ids.v3;

    async function capture(run: (pg: KnexType) => Promise<void>, firstPage: unknown[]): Promise<string[]> {
      const pg = Knex({ client: 'pg' });
      const sqls: string[] = [];
      let selects = 0;
      const client = pg.client as unknown as Record<string, unknown>;
      client.acquireConnection = async () => ({});
      client.releaseConnection = async () => undefined;
      client.query = async (_connection: unknown, obj: { sql: string; bindings?: unknown[] }) => {
        sqls.push(`${obj.sql} :: ${JSON.stringify(obj.bindings ?? [])}`);
        const command = /^(select|update|insert)/i.exec(obj.sql)?.[1].toUpperCase() ?? 'ALTER';
        const rows = command === 'SELECT' && /from "user_rewards"/i.test(obj.sql) && selects++ === 0 ? firstPage : [];
        return { ...obj, response: { rows, rowCount: command === 'UPDATE' ? 1 : rows.length, command } };
      };
      try {
        await run(pg);
      } finally {
        await pg.destroy();
      }
      return sqls;
    }

    const row = {
      id: rewardId, brand_id: 'default', bet_id: 'b', ticket_snapshot: JSON.stringify({ rideMath: { version: 3 } }),
    };
    const up = await capture((pg) => migration.up(pg), [row]);
    const firstSelect = up[0];
    // The first page must carry no id comparison (an empty string is not a uuid on PostgreSQL) ...
    expect(firstSelect).toMatch(/^select "id", "brand_id", "bet_id", "ticket_snapshot" from "user_rewards"/i);
    expect(firstSelect).toMatch(/"status" = \?/);
    expect(firstSelect).not.toMatch(/"id" >/);
    expect(firstSelect).not.toContain('""');
    expect(firstSelect).toMatch(/not exists \(select 1 from "bet_boost_locks" where bet_boost_locks\.reward_id = user_rewards\.id\)/i);
    // ... the following page filters on the last id seen ...
    const secondSelect = up.find((sql, index) => index > 0 && /^select/i.test(sql) && /"id" >/.test(sql));
    expect(secondSelect).toBeDefined();
    expect(secondSelect).toContain(`["ENTERED","${rewardId}",500]`);
    expect(firstSelect).toContain('["ENTERED",500]');
    // ... and the close is a conditional update.
    const update = up.find((sql) => /^update "user_rewards"/i.test(sql));
    expect(update).toMatch(/where "id" = \? and "status" = \? and not exists/i);
    expect(up.some((sql) => /^insert into "audit_logs"/i.test(sql))).toBe(true);
    expect(up.find((sql) => /alter table "bet_boost_locks"/i.test(sql) && /type double precision/i.test(sql)))
      .toBeDefined();

    const down = await capture((pg) => migration.down(pg), []);
    expect(down.find((sql) => /alter table "bet_boost_locks"/i.test(sql) && /type decimal\(10, 4\)/i.test(sql)))
      .toBeDefined();
  });
});
