import type { Knex } from 'knex';

/**
 * Slice API-3: open boosts. A profile version is either PERSONAL (rewards are granted in advance to chosen
 * players and carry over until used or expired; today's behaviour) or OPEN (no advance grant: the reward is
 * created when the player uses the boost on a qualifying bet).
 *
 * reward_profile_versions.availability: 'PERSONAL' | 'OPEN', not null, default 'PERSONAL', so every existing
 * profile stays PERSONAL. Values are validated by the API (zod). down() drops the column.
 */
const PROFILES = 'reward_profile_versions';
const COLUMN = 'availability';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable(PROFILES, (table) => {
    table.string(COLUMN, 16).notNullable().defaultTo('PERSONAL');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable(PROFILES, (table) => {
    table.dropColumn(COLUMN);
  });
}
