import type { Knex } from 'knex';

/**
 * Phase 1a: brand scoping, money snapshot, bonus caps and reward validity.
 *
 * Every legacy row becomes brand 'default'. Legacy profiles get no validity
 * (NULL = rewards never expire) and an empty bonus-cap map ('{}'), so a legacy
 * profile needs a PUT with max_bonus_minor before it can take new opt-ins.
 *
 * bet_boost_locks keeps its unique(bet_id) here; replacing it with
 * unique(brand_id, bet_id) is a later slice.
 */
export const LEGACY_BRAND = 'default';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('reward_profile_versions', (table) => {
    table.string('brand_id', 64).notNullable().defaultTo(LEGACY_BRAND);
    table.json('max_bonus_minor').notNullable().defaultTo('{}');
    table.integer('reward_validity_seconds');
    table.index('brand_id', 'reward_profile_versions_brand_id_index');
  });

  await knex.schema.alterTable('user_rewards', (table) => {
    table.string('brand_id', 64).notNullable().defaultTo(LEGACY_BRAND);
    table.timestamp('valid_until');
    table.bigInteger('stake_minor');
    table.string('currency', 3);
    table.bigInteger('bonus_cap_minor');
    // Set by the settlement slice when a cancelled bet returns its token.
    table.uuid('replaces_reward_id');
    table.index(['brand_id', 'user_id'], 'user_rewards_brand_id_user_id_index');
    table.index('valid_until', 'user_rewards_valid_until_index');
    table.index('replaces_reward_id', 'user_rewards_replaces_reward_id_index');
  });

  await knex.schema.alterTable('bet_boost_locks', (table) => {
    table.string('brand_id', 64).notNullable().defaultTo(LEGACY_BRAND);
    table.index(['brand_id', 'bet_id'], 'bet_boost_locks_brand_id_bet_id_index');
  });

  // Inherit explicitly (a no-op while every row is 'default'; correct on re-runs).
  await knex.raw(`
    UPDATE user_rewards
    SET brand_id = (
      SELECT p.brand_id FROM reward_profile_versions p WHERE p.id = user_rewards.profile_version_id
    )
    WHERE EXISTS (
      SELECT 1 FROM reward_profile_versions p WHERE p.id = user_rewards.profile_version_id
    )
  `);
  await knex.raw(`
    UPDATE bet_boost_locks
    SET brand_id = (SELECT r.brand_id FROM user_rewards r WHERE r.id = bet_boost_locks.reward_id)
    WHERE EXISTS (SELECT 1 FROM user_rewards r WHERE r.id = bet_boost_locks.reward_id)
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('bet_boost_locks', (table) => {
    table.dropIndex(['brand_id', 'bet_id'], 'bet_boost_locks_brand_id_bet_id_index');
  });
  await knex.schema.alterTable('bet_boost_locks', (table) => {
    table.dropColumn('brand_id');
  });

  await knex.schema.alterTable('user_rewards', (table) => {
    table.dropIndex(['brand_id', 'user_id'], 'user_rewards_brand_id_user_id_index');
    table.dropIndex('valid_until', 'user_rewards_valid_until_index');
    table.dropIndex('replaces_reward_id', 'user_rewards_replaces_reward_id_index');
  });
  await knex.schema.alterTable('user_rewards', (table) => {
    table.dropColumn('brand_id');
    table.dropColumn('valid_until');
    table.dropColumn('stake_minor');
    table.dropColumn('currency');
    table.dropColumn('bonus_cap_minor');
    table.dropColumn('replaces_reward_id');
  });

  await knex.schema.alterTable('reward_profile_versions', (table) => {
    table.dropIndex('brand_id', 'reward_profile_versions_brand_id_index');
  });
  await knex.schema.alterTable('reward_profile_versions', (table) => {
    table.dropColumn('brand_id');
    table.dropColumn('max_bonus_minor');
    table.dropColumn('reward_validity_seconds');
  });
}
