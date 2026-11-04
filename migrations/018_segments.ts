import type { Knex } from 'knex';

/**
 * Slice API-2: operator-owned player groups. We store only a free-form label (segment), never group membership.
 *
 * - reward_profile_versions.segment: optional label on a profile version; (brand_id, segment) index for the filter.
 * - user_rewards.segment: optional label on a granted reward, for reporting.
 *
 * Both columns are nullable and existing rows stay NULL (no segment). down() drops the index, then the columns.
 */
const PROFILES = 'reward_profile_versions';
const REWARDS = 'user_rewards';
const PROFILE_INDEX = 'reward_profile_versions_brand_id_segment_index';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable(PROFILES, (table) => {
    table.string('segment', 64).nullable();
    table.index(['brand_id', 'segment'], PROFILE_INDEX);
  });
  await knex.schema.alterTable(REWARDS, (table) => {
    table.string('segment', 64).nullable();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable(REWARDS, (table) => {
    table.dropColumn('segment');
  });
  await knex.schema.alterTable(PROFILES, (table) => {
    table.dropIndex(['brand_id', 'segment'], PROFILE_INDEX);
  });
  await knex.schema.alterTable(PROFILES, (table) => {
    table.dropColumn('segment');
  });
}
