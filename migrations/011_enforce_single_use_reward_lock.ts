import type { Knex } from 'knex';

const UNIQUE_REWARD_LOCK_INDEX = 'bet_boost_locks_reward_id_unique';

export async function up(knex: Knex): Promise<void> {
  // Keep only the earliest lock per reward if historical duplicates exist.
  await knex.raw(`
    DELETE FROM bet_boost_locks
    WHERE id IN (
      SELECT id
      FROM (
        SELECT
          id,
          ROW_NUMBER() OVER (
            PARTITION BY reward_id
            ORDER BY created_at ASC, id ASC
          ) AS rn
        FROM bet_boost_locks
      ) ranked
      WHERE ranked.rn > 1
    )
  `);

  await knex.schema.alterTable('bet_boost_locks', (table) => {
    table.unique(['reward_id'], UNIQUE_REWARD_LOCK_INDEX);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('bet_boost_locks', (table) => {
    table.dropUnique(['reward_id'], UNIQUE_REWARD_LOCK_INDEX);
  });
}
