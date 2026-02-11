import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('reward_profile_versions', (table) => {
    table.decimal('max_eligibility_selection_weight', 10, 4).notNullable().defaultTo(0.75);
    table.decimal('max_eligibility_odds_weight', 10, 4).notNullable().defaultTo(0.25);
    table.decimal('effective_min_floor_rate', 10, 4).notNullable().defaultTo(0.35);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('reward_profile_versions', (table) => {
    table.dropColumn('max_eligibility_selection_weight');
    table.dropColumn('max_eligibility_odds_weight');
    table.dropColumn('effective_min_floor_rate');
  });
}
