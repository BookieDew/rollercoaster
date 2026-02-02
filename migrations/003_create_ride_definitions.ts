import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('ride_definitions', (table) => {
    table.uuid('id').primary();
    table.uuid('reward_id').notNullable()
      .references('id').inTable('user_rewards');
    table.integer('checkpoint_index').notNullable();
    table.decimal('time_offset_pct', 10, 6).notNullable();
    table.decimal('base_boost_value', 10, 6).notNullable();
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());

    table.unique(['reward_id', 'checkpoint_index']);
    table.index('reward_id');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('ride_definitions');
}
