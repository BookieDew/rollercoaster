import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('user_rewards', (table) => {
    table.string('bet_id');
    table.json('ticket_snapshot');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('user_rewards', (table) => {
    table.dropColumn('bet_id');
    table.dropColumn('ticket_snapshot');
  });
}
