import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('bet_boost_locks', (table) => {
    table.uuid('id').primary();
    table.string('bet_id').notNullable().unique();
    table.uuid('reward_id').notNullable()
      .references('id').inTable('user_rewards');
    table.decimal('locked_boost_pct', 10, 6).notNullable();
    table.integer('qualifying_selections').notNullable();
    table.decimal('qualifying_odds', 10, 4).notNullable();
    table.decimal('ticket_strength', 10, 6).notNullable();
    table.json('snapshot').notNullable();
    table.timestamp('locked_at').notNullable().defaultTo(knex.fn.now());
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());

    table.index('reward_id');
    table.index('bet_id');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('bet_boost_locks');
}
