import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('settlement_records', (table) => {
    table.uuid('id').primary();
    table.string('bet_id').notNullable().unique()
      .references('bet_id').inTable('bet_boost_locks');
    table.enum('outcome', ['WIN', 'LOSS', 'VOID', 'CASHOUT']).notNullable();
    table.decimal('winnings', 14, 4).notNullable().defaultTo(0);
    table.decimal('bonus_amount', 14, 4).notNullable().defaultTo(0);
    table.timestamp('settled_at').notNullable().defaultTo(knex.fn.now());
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());

    table.index('bet_id');
    table.index('settled_at');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('settlement_records');
}
