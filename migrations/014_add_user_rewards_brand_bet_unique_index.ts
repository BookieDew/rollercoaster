import type { Knex } from 'knex';

const INDEX_NAME = 'user_rewards_brand_id_bet_id_unique';

/**
 * A bet is identified by (brand_id, bet_id). Rows with a NULL bet_id (rewards
 * that have not started a ride) are unrestricted. Migration 013 has already
 * renamed historical duplicates.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('user_rewards', (table) => {
    table.unique(['brand_id', 'bet_id'], INDEX_NAME);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('user_rewards', (table) => {
    table.dropUnique(['brand_id', 'bet_id'], INDEX_NAME);
  });
}
