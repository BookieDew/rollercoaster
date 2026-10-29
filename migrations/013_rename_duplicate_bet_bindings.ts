import { randomUUID } from 'node:crypto';
import type { Knex } from 'knex';

/**
 * Makes historical duplicate bet bindings unique per brand so the unique index
 * in 014 can be created without deleting any reward.
 *
 * For every (brand_id, bet_id) bound to more than one reward, the binding stays
 * on the reward that owns that bet's lock, or on the earliest reward when none
 * is locked. Every other reward is renamed to
 * `<bet_id>~legacy-<first 8 chars of its id>`, and each rename writes one
 * audit_logs row (action LEGACY_BET_ID_RENAMED). A database without duplicates
 * (every fresh install) is left untouched.
 */
const RENAME_ACTION = 'LEGACY_BET_ID_RENAMED';
const RESTORE_ACTION = 'LEGACY_BET_ID_RESTORED';
const SUFFIX_PREFIX_LENGTH = 8;

interface RewardRow {
  id: string;
  created_at: string;
}

export function legacyBetId(betId: string, rewardId: string, length = SUFFIX_PREFIX_LENGTH): string {
  return `${betId}~legacy-${rewardId.slice(0, length)}`;
}

export async function up(knex: Knex): Promise<void> {
  const groups: Array<{ brand_id: string; bet_id: string }> = await knex('user_rewards')
    .select('brand_id', 'bet_id')
    .whereNotNull('bet_id')
    .groupBy('brand_id', 'bet_id')
    .havingRaw('count(*) > 1');

  for (const { brand_id: brandId, bet_id: betId } of groups) {
    const rewards: RewardRow[] = await knex('user_rewards')
      .where({ brand_id: brandId, bet_id: betId })
      .select('id', 'created_at')
      .orderBy([{ column: 'created_at', order: 'asc' }, { column: 'id', order: 'asc' }]);

    const lock = await knex('bet_boost_locks')
      .where({ brand_id: brandId, bet_id: betId })
      .first('reward_id');
    const keeperId = rewards.find((reward) => reward.id === lock?.reward_id)?.id ?? rewards[0].id;

    for (const reward of rewards) {
      if (reward.id === keeperId) continue;

      // The 8-character suffix is unique in practice; widen it if it is ever not.
      let length = SUFFIX_PREFIX_LENGTH;
      let renamed = legacyBetId(betId, reward.id, length);
      while (length < reward.id.length && await knex('user_rewards')
        .where({ brand_id: brandId, bet_id: renamed }).first('id')) {
        length += 1;
        renamed = legacyBetId(betId, reward.id, length);
      }

      await knex('user_rewards').where({ id: reward.id }).update({ bet_id: renamed });
      await appendAudit(knex, reward.id, RENAME_ACTION, {
        brandId,
        originalBetId: betId,
        renamedBetId: renamed,
        keptRewardId: keeperId,
        reason: 'Duplicate bet binding made unique per brand (Phase 1a migration 013)',
      });
    }
  }
}

export async function down(knex: Knex): Promise<void> {
  const renames: Array<{ entity_id: string; payload: unknown; timestamp: string }> = await knex('audit_logs')
    .where({ entity_type: 'user_reward', action: RENAME_ACTION })
    .select('entity_id', 'payload', 'timestamp')
    .orderBy('timestamp', 'desc');

  for (const row of renames) {
    const payload = (typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload) as {
      brandId: string;
      originalBetId: string;
      renamedBetId: string;
    };
    const restored = await knex('user_rewards')
      .where({ id: row.entity_id, brand_id: payload.brandId, bet_id: payload.renamedBetId })
      .update({ bet_id: payload.originalBetId });
    if (restored > 0) {
      await appendAudit(knex, row.entity_id, RESTORE_ACTION, {
        brandId: payload.brandId,
        restoredBetId: payload.originalBetId,
        previousBetId: payload.renamedBetId,
        reason: 'Migration 013 rolled back',
      });
    }
  }
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
