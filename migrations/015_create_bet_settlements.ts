import type { Knex } from 'knex';

/**
 * Phase 1a settlement (contract section 4).
 *
 * 1. Drops the legacy `settlement_records` table, but ONLY when it is empty. A
 *    non-empty table aborts the migration (nothing is changed) with instructions.
 * 2. Replaces bet_boost_locks unique(bet_id) with unique(brand_id, bet_id): a bet
 *    is identified by (brand_id, bet_id), so two brands may lock the same bet_id.
 *    The non-unique (brand_id, bet_id) index from migration 012 is then redundant
 *    (the unique index covers the same lookups) and is dropped.
 * 3. Creates `bet_settlements`: one row per settlement revision of a lock, with
 *    integer (bigint) money columns, total_return_minor as an exact decimal-integer
 *    text column (returns can exceed 64 bits), unique(lock_id, revision) and at
 *    most one current revision per lock.
 *
 * down() restores the legacy table and unique(bet_id). It refuses to run while
 * bet_settlements has rows or while two brands share a locked bet_id, because
 * either would lose data or violate the restored index.
 */
const LEGACY_TABLE = 'settlement_records';
const TABLE = 'bet_settlements';
const LOCKS = 'bet_boost_locks';
const LEGACY_LOCK_UNIQUE = 'bet_boost_locks_bet_id_unique';
const BRAND_LOCK_UNIQUE = 'bet_boost_locks_brand_id_bet_id_unique';
const REDUNDANT_LOCK_INDEX = 'bet_boost_locks_brand_id_bet_id_index';
const CURRENT_UNIQUE = 'bet_settlements_lock_id_current_unique';

export const SETTLEMENT_OUTCOMES = ['SETTLED', 'CASHOUT', 'CANCELLED'] as const;
export const SETTLEMENT_BET_RESULTS = ['WON', 'WON_NO_BONUS', 'LOST', 'PUSHED', 'CANCELLED', 'CASHED_OUT'] as const;

async function countRows(knex: Knex, table: string): Promise<number> {
  const row = await knex(table).count('* as c').first();
  return Number(row?.c ?? 0);
}

export async function up(knex: Knex): Promise<void> {
  if (await knex.schema.hasTable(LEGACY_TABLE)) {
    const legacyRows = await countRows(knex, LEGACY_TABLE);
    if (legacyRows > 0) {
      throw new Error(
        `Migration 015 aborted: the legacy ${LEGACY_TABLE} table has ${legacyRows} row(s). `
        + 'The settlement contract changed (bet_settlements replaces it) and legacy records are '
        + 'never dropped automatically. Export or archive those rows, delete them from '
        + `${LEGACY_TABLE}, then run the migration again. Nothing was changed.`
      );
    }
    // settlement_records has a foreign key to bet_boost_locks(bet_id), so it must go
    // before unique(bet_id) can be dropped.
    await knex.schema.dropTable(LEGACY_TABLE);
  }

  await knex.schema.alterTable(LOCKS, (table) => {
    table.dropUnique(['bet_id'], LEGACY_LOCK_UNIQUE);
  });
  await knex.schema.alterTable(LOCKS, (table) => {
    table.unique(['brand_id', 'bet_id'], { indexName: BRAND_LOCK_UNIQUE });
  });
  await knex.schema.alterTable(LOCKS, (table) => {
    table.dropIndex(['brand_id', 'bet_id'], REDUNDANT_LOCK_INDEX);
  });

  await knex.schema.createTable(TABLE, (table) => {
    table.uuid('id').primary();
    table.string('brand_id', 64).notNullable();
    table.string('bet_id', 255).notNullable();
    table.uuid('lock_id').notNullable().references('id').inTable(LOCKS);
    table.integer('revision').notNullable();
    table.boolean('is_current').notNullable().defaultTo(false);
    table.enu('outcome', [...SETTLEMENT_OUTCOMES]).notNullable();
    table.enu('bet_result', [...SETTLEMENT_BET_RESULTS]).notNullable();
    // Normalized legs (sorted by selection_id) for SETTLED; NULL otherwise.
    table.json('legs');
    table.string('currency', 3).notNullable();
    table.bigInteger('stake_minor').notNullable();
    // Exact decimal-integer string of minor units: a sportsbook return can exceed
    // 2^53 and even 64-bit integers (100 legs at odds 10,000), so it is text, not
    // bigint. NULL for CANCELLED and CASHED_OUT (no return is computed).
    table.text('total_return_minor');
    table.decimal('locked_boost_pct', 10, 6).notNullable();
    table.bigInteger('bonus_minor').notNullable();
    table.bigInteger('bonus_cap_minor').notNullable();
    table.boolean('cap_applied').notNullable();
    // NULL when the minimums re-check did not run.
    table.boolean('minimums_met');
    table.uuid('replacement_reward_id').references('id').inTable('user_rewards');
    // Correction reason; NULL on revision 1.
    table.text('reason');
    table.timestamp('settled_at').notNullable();
    table.timestamp('created_at').notNullable();

    table.unique(['lock_id', 'revision'], { indexName: 'bet_settlements_lock_id_revision_unique' });
    table.index(['brand_id', 'bet_id', 'is_current'], 'bet_settlements_brand_bet_current_index');
    table.index('replacement_reward_id', 'bet_settlements_replacement_reward_id_index');
  });

  // At most one current revision per lock (SQLite and PostgreSQL partial index).
  await knex.raw(`CREATE UNIQUE INDEX ${CURRENT_UNIQUE} ON ${TABLE} (lock_id) WHERE is_current`);
}

export async function down(knex: Knex): Promise<void> {
  const settlements = await countRows(knex, TABLE);
  if (settlements > 0) {
    throw new Error(
      `Rollback of migration 015 refused: ${TABLE} has ${settlements} row(s) that the legacy `
      + `${LEGACY_TABLE} table cannot hold. Export them and delete them first. Nothing was changed.`
    );
  }
  const shared = await knex(LOCKS)
    .select('bet_id')
    .groupBy('bet_id')
    .havingRaw('count(*) > 1');
  if (shared.length > 0) {
    throw new Error(
      `Rollback of migration 015 refused: ${shared.length} bet_id value(s) are locked in more than `
      + `one brand, which the legacy unique(bet_id) index cannot hold. Nothing was changed.`
    );
  }

  await knex.schema.dropTable(TABLE);

  await knex.schema.alterTable(LOCKS, (table) => {
    table.dropUnique(['brand_id', 'bet_id'], BRAND_LOCK_UNIQUE);
  });
  await knex.schema.alterTable(LOCKS, (table) => {
    table.index(['brand_id', 'bet_id'], REDUNDANT_LOCK_INDEX);
  });
  await knex.schema.alterTable(LOCKS, (table) => {
    table.unique(['bet_id'], { indexName: LEGACY_LOCK_UNIQUE });
  });

  // Same definition as migration 005.
  await knex.schema.createTable(LEGACY_TABLE, (table) => {
    table.uuid('id').primary();
    table.string('bet_id').notNullable().unique()
      .references('bet_id').inTable(LOCKS);
    table.enum('outcome', ['WIN', 'LOSS', 'VOID', 'CASHOUT']).notNullable();
    table.decimal('winnings', 14, 4).notNullable().defaultTo(0);
    table.decimal('bonus_amount', 14, 4).notNullable().defaultTo(0);
    table.timestamp('settled_at').notNullable().defaultTo(knex.fn.now());
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());

    table.index('bet_id');
    table.index('settled_at');
  });
}
