import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('reward_profile_versions', (table) => {
    table.integer('max_boost_min_selections').nullable();
    table.decimal('max_boost_min_combined_odds', 10, 4).nullable();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('reward_profile_versions', (table) => {
    table.dropColumn('max_boost_min_selections');
    table.dropColumn('max_boost_min_combined_odds');
  });
}
