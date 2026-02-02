import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('reward_profile_versions', (table) => {
    table.uuid('id').primary();
    table.string('name').notNullable();
    table.text('description');
    table.integer('min_selections').notNullable().defaultTo(3);
    table.decimal('min_combined_odds', 10, 4).notNullable().defaultTo(3.0);
    table.decimal('min_selection_odds', 10, 4).notNullable().defaultTo(1.2);
    table.decimal('min_boost_pct', 10, 4).notNullable().defaultTo(0.01);
    table.decimal('max_boost_pct', 10, 4).notNullable().defaultTo(1.0);
    table.integer('ride_duration_seconds').notNullable().defaultTo(3600);
    table.integer('checkpoint_count').notNullable().defaultTo(10);
    table.decimal('volatility', 10, 4).notNullable().defaultTo(0.5);
    table.boolean('is_active').notNullable().defaultTo(true);
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    table.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('reward_profile_versions');
}
