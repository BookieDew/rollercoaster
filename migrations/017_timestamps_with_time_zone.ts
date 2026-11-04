import type { Knex } from 'knex';

/**
 * Phase 2a: any PostgreSQL `timestamp without time zone` column becomes `timestamp with time zone` (timestamptz).
 *
 * knex creates `table.timestamp()` columns as timestamptz on PostgreSQL, so a database built by migrations 001-016
 * has nothing to convert. This migration is the safety net for a database whose columns are zone-less (created by
 * another tool or an older knex): the repositories write ISO-8601 UTC strings ("...Z"); on a zone-less column
 * PostgreSQL silently drops the "Z" and the node-postgres driver reads the clock value back as process-local time,
 * so every timestamp would shift by the process's UTC offset. timestamptz stores the instant instead.
 *
 * up() converts every base-table `timestamp without time zone` column of the current schema, reading the stored
 * clock values as UTC (the only value the application ever wrote), and records exactly which columns it changed in
 * knex_017_converted_timestamps. down() converts only those recorded columns back (writing the UTC clock value) and
 * drops the record, so a rollback restores the schema as it was before 017 (a column that was already timestamptz
 * stays timestamptz). knex's own tables are skipped. SQLite stores timestamps as text and has no such column type:
 * both directions are a no-op there.
 *
 * Rewriting a column rebuilds its indexes (for example user_rewards.valid_until). A later migration that creates a
 * timestamp column should keep knex's default (timestamptz) or pass `{ useTz: true }`.
 */
const RECORD = 'knex_017_converted_timestamps';

function isPostgres(knex: Knex): boolean {
  const client = String((knex.client as { config?: { client?: unknown } }).config?.client ?? '');
  return client === 'pg' || client === 'postgres' || client === 'postgresql';
}

export async function up(knex: Knex): Promise<void> {
  if (!isPostgres(knex)) return;

  const result = await knex.raw(
    `SELECT c.table_name, c.column_name
       FROM information_schema.columns c
       JOIN information_schema.tables t
         ON t.table_schema = c.table_schema AND t.table_name = c.table_name
      WHERE c.table_schema = current_schema()
        AND t.table_type = 'BASE TABLE'
        AND c.table_name NOT LIKE 'knex\\_%'
        AND c.data_type = 'timestamp without time zone'
      ORDER BY c.table_name, c.ordinal_position`
  ) as { rows: Array<{ table_name: string; column_name: string }> };

  await knex.schema.createTable(RECORD, (table) => {
    table.string('table_name').notNullable();
    table.string('column_name').notNullable();
    table.primary(['table_name', 'column_name']);
  });
  for (const { table_name: table, column_name: column } of result.rows) {
    await knex.raw(`ALTER TABLE ?? ALTER COLUMN ?? TYPE timestamptz USING ?? AT TIME ZONE 'UTC'`, [table, column, column]);
    await knex(RECORD).insert({ table_name: table, column_name: column });
  }
}

export async function down(knex: Knex): Promise<void> {
  if (!isPostgres(knex)) return;
  if (!(await knex.schema.hasTable(RECORD))) return;

  const converted: Array<{ table_name: string; column_name: string }> = await knex(RECORD)
    .select('table_name', 'column_name')
    .orderBy(['table_name', 'column_name']);
  for (const { table_name: table, column_name: column } of converted) {
    await knex.raw(`ALTER TABLE ?? ALTER COLUMN ?? TYPE timestamp USING ?? AT TIME ZONE 'UTC'`, [table, column, column]);
  }
  await knex.schema.dropTable(RECORD);
}
