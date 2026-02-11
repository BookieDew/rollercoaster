import type { Knex } from 'knex';

const COLUMN_NAME = 'ride_mode';
const DEFAULT_MODE = 'WAVES';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('reward_profile_versions', (table) => {
    table.string(COLUMN_NAME).notNullable().defaultTo(DEFAULT_MODE);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('reward_profile_versions', (table) => {
    table.dropColumn(COLUMN_NAME);
  });
}
