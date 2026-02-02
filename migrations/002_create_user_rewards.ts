import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('user_rewards', (table) => {
    table.uuid('id').primary();
    table.string('user_id').notNullable().index();
    table.uuid('profile_version_id').notNullable()
      .references('id').inTable('reward_profile_versions');
    table.enum('status', ['GRANTED', 'ENTERED', 'EXPIRED', 'USED']).notNullable().defaultTo('GRANTED');
    table.timestamp('start_time').notNullable();
    table.timestamp('end_time').notNullable();
    table.string('seed').notNullable();
    table.timestamp('opted_in_at');
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    table.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());

    table.index(['user_id', 'status']);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('user_rewards');
}
