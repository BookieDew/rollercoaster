import { randomUUID } from 'node:crypto';
import type { Knex } from 'knex';

/**
 * Phase 1b-iii-b: V4 is the only ride math (contract section 5).
 *
 * 1. Closes every in-flight ride that is still on a V1-V3 ride snapshot: a user_rewards row in
 *    status ENTERED, with no bet_boost_locks row, whose ticket_snapshot.rideMath.version is 1-3 (or
 *    that has no rideMath at all, the pre-snapshot V1 rides). Such a ride can no longer be quoted or
 *    locked (V4 fails closed on it), so it is closed the same way the expiry job closes an unlocked
 *    ride that is over: status EXPIRED (the API has no separate ENDED reward status), through a
 *    conditional update (only while still ENTERED), with one audit_logs row per ride
 *    (action RIDE_CLOSED_V4_MIGRATION, reason RIDE_CLOSED_BY_V4_MIGRATION). Locked rewards, their locks,
 *    their settlements and every stored snapshot are never read for change or written. Re-running
 *    changes nothing: closed rides are no longer ENTERED.
 * 2. Widens bet_boost_locks.qualifying_odds from decimal(10,4) to double precision, so any finite
 *    double (Number.MAX_VALUE included) stores on PostgreSQL. SQLite columns are type-affine and
 *    already store doubles, so the column is left as it is there (rebuilding the table would risk the
 *    bet_settlements foreign key for no gain).
 *    user_rewards.seed is never touched (settled bets are re-verified from it).
 *
 * down() restores EXPIRED -> ENTERED for exactly the rows this migration closed, but only for a row that
 * is still EXPIRED and whose newest audit row is this migration's close row (a ride that changed since
 * then keeps its state). It then narrows qualifying_odds back to decimal(10,4) on PostgreSQL; that
 * fails (nothing is changed) if a stored value no longer fits, which is the correct refusal.
 * Postgres notes for Phase 2: the audit payload column is json (parsed in JS here, no JSON operators),
 * and the 10,4 narrowing is the only step that can legitimately fail on rollback.
 */
export const CLOSE_ACTION = 'RIDE_CLOSED_V4_MIGRATION';
export const RESTORE_ACTION = 'RIDE_RESTORED_V4_MIGRATION_ROLLBACK';
export const CLOSE_REASON = 'RIDE_CLOSED_BY_V4_MIGRATION';
const REWARDS = 'user_rewards';
const LOCKS = 'bet_boost_locks';
const BATCH = 500;
const FALLBACK_BRAND = 'default';

function isPostgres(knex: Knex): boolean {
  const client = String((knex.client as { config?: { client?: unknown } }).config?.client ?? '');
  return client === 'pg' || client === 'postgres' || client === 'postgresql';
}

function parseJson(value: unknown): Record<string, unknown> | null {
  if (value == null) return null;
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    return parsed !== null && typeof parsed === 'object' ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

/** The retired ride-math version of a snapshot (1-3), 0 for a ride without any rideMath, or null for V4 and later. */
function retiredVersion(snapshot: Record<string, unknown> | null): number | null {
  const rideMath = snapshot?.rideMath;
  if (rideMath === undefined || rideMath === null) return 0;
  const version = (rideMath as { version?: unknown }).version;
  if (typeof version === 'number' && version >= 1 && version <= 3) return version;
  return null;
}

async function appendAudit(
  knex: Knex,
  rewardId: string,
  action: string,
  payload: Record<string, unknown>
): Promise<void> {
  const now = new Date().toISOString();
  await knex('audit_logs').insert({
    id: randomUUID(),
    entity_type: 'user_reward',
    entity_id: rewardId,
    action,
    payload: JSON.stringify(payload),
    timestamp: now,
    created_at: now,
  });
}

export async function up(knex: Knex): Promise<void> {
  // Unlocked ENTERED rides, ordered by id; the loop pages on the id so closed rows never reappear.
  // The id filter is applied only after the first page: user_rewards.id is a uuid on PostgreSQL,
  // so `id > ''` would be an invalid uuid literal there.
  let lastId: string | null = null;
  for (;;) {
    const rows: Array<{ id: string; brand_id: string | null; bet_id: string | null; ticket_snapshot: unknown }> =
      await knex(REWARDS)
        .select('id', 'brand_id', 'bet_id', 'ticket_snapshot')
        .where('status', 'ENTERED')
        .whereNotExists(function noLock() {
          this.select(knex.raw('1')).from(LOCKS).whereRaw(`${LOCKS}.reward_id = ${REWARDS}.id`);
        })
        .modify((query) => {
          if (lastId !== null) query.andWhere('id', '>', lastId);
        })
        .orderBy('id', 'asc')
        .limit(BATCH);
    if (rows.length === 0) break;
    lastId = rows[rows.length - 1].id;

    for (const row of rows) {
      const previousVersion = retiredVersion(parseJson(row.ticket_snapshot));
      if (previousVersion === null) continue;

      const now = new Date().toISOString();
      const closed = await knex(REWARDS)
        .where({ id: row.id, status: 'ENTERED' })
        .whereNotExists(function noLock() {
          this.select(knex.raw('1')).from(LOCKS).whereRaw(`${LOCKS}.reward_id = ${REWARDS}.id`);
        })
        .update({ status: 'EXPIRED', updated_at: now });
      if (closed === 0) continue;

      await appendAudit(knex, row.id, CLOSE_ACTION, {
        brandId: row.brand_id ?? FALLBACK_BRAND,
        reason: CLOSE_REASON,
        migration: '016_close_inflight_rides_for_v4',
        previousStatus: 'ENTERED',
        newStatus: 'EXPIRED',
        previousMathVersion: previousVersion === 0 ? null : previousVersion,
        betId: row.bet_id,
        closedAt: now,
      });
    }
  }

  if (isPostgres(knex)) {
    await knex.schema.alterTable(LOCKS, (table) => {
      table.double('qualifying_odds').notNullable().alter();
    });
  }
}

export async function down(knex: Knex): Promise<void> {
  if (isPostgres(knex)) {
    await knex.schema.alterTable(LOCKS, (table) => {
      table.decimal('qualifying_odds', 10, 4).notNullable().alter();
    });
  }

  const closes: Array<{ id: string; entity_id: string; payload: unknown; timestamp: string }> =
    await knex('audit_logs')
      .where({ entity_type: 'user_reward', action: CLOSE_ACTION })
      .select('id', 'entity_id', 'payload', 'timestamp')
      .orderBy([{ column: 'timestamp', order: 'desc' }, { column: 'id', order: 'desc' }]);

  const handled = new Set<string>();
  for (const close of closes) {
    if (handled.has(close.entity_id)) continue;
    handled.add(close.entity_id);

    // Only the newest close row of a ride counts (ties on the timestamp break by id), and only while
    // nothing was recorded after it. Any other audit row in the same millisecond counts as later (the
    // safe side: the ride is then left as it is); only another close row at that instant is ordered by id.
    const later = await knex('audit_logs')
      .where({ entity_type: 'user_reward', entity_id: close.entity_id })
      .andWhereNot('id', close.id)
      .andWhere((query) => {
        query.where('timestamp', '>', close.timestamp).orWhere((tie) => {
          tie.where('timestamp', close.timestamp).andWhere((other) => {
            other.whereNot('action', CLOSE_ACTION).orWhere('id', '>', close.id);
          });
        });
      })
      .first('id');
    if (later) continue;

    const payload = parseJson(close.payload);
    const previousStatus = typeof payload?.previousStatus === 'string' ? payload.previousStatus : 'ENTERED';
    const restoredAt = new Date().toISOString();
    const restored = await knex(REWARDS)
      .where({ id: close.entity_id, status: 'EXPIRED' })
      .update({ status: previousStatus, updated_at: restoredAt });
    if (restored > 0) {
      await appendAudit(knex, close.entity_id, RESTORE_ACTION, {
        brandId: typeof payload?.brandId === 'string' ? payload.brandId : FALLBACK_BRAND,
        reason: 'Migration 016 rolled back',
        restoredStatus: previousStatus,
        previousStatus: 'EXPIRED',
        restoredAt,
      });
    }
  }
}
