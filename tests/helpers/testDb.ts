import path from 'path';
import { randomBytes } from 'node:crypto';
import Knex, { type Knex as KnexType } from 'knex';
import { Client } from 'pg';

/**
 * Test database plumbing. By default every test works on private in-memory SQLite. With
 * TEST_DATABASE_URL (`npm run test:pg`) the same tests run on PostgreSQL, each file and each
 * isolated Knex instance in a private schema that is dropped afterwards.
 */
export const PG_URL: string | undefined = process.env.TEST_DATABASE_URL || undefined;
export const isPg = PG_URL !== undefined;

const MIGRATIONS = path.resolve(__dirname, '../../migrations');

export function privateSchemaName(): string {
  return `t_${Date.now().toString(36)}_${randomBytes(4).toString('hex')}`;
}

async function withClient<T>(work: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: PG_URL });
  await client.connect();
  try {
    return await work(client);
  } finally {
    await client.end();
  }
}

export async function createSchema(schema: string): Promise<void> {
  await withClient((client) => client.query(`CREATE SCHEMA "${schema}"`));
}

export async function dropSchema(schema: string): Promise<void> {
  await withClient((client) => client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`));
}

export interface IsolatedKnex {
  knex: KnexType;
  /** Destroys the Knex instance and, on PostgreSQL, drops its schema. */
  cleanup(): Promise<void>;
}

/**
 * A Knex instance on its own empty database (in-memory SQLite, or a fresh PostgreSQL schema) whose
 * migrations point at the repository's migrations directory.
 */
export async function createIsolatedKnex(options: { poolMax?: number } = {}): Promise<IsolatedKnex> {
  const migrations = { directory: MIGRATIONS, extension: 'ts' };
  if (!isPg) {
    const knex = Knex({ client: 'sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true, migrations });
    return { knex, cleanup: () => knex.destroy() };
  }
  const schema = privateSchemaName();
  await createSchema(schema);
  const knex = Knex({
    client: 'pg',
    connection: { connectionString: PG_URL },
    searchPath: [schema],
    pool: { min: 0, max: options.poolMax ?? 4 },
    migrations,
  });
  return {
    knex,
    cleanup: async () => {
      await knex.destroy();
      await dropSchema(schema);
    },
  };
}

/**
 * Reads a JSON column straight from the database: SQLite returns the stored text, PostgreSQL (json
 * columns) returns the parsed value.
 */
export function parseJsonColumn(value: unknown): any { // eslint-disable-line @typescript-eslint/no-explicit-any
  return typeof value === 'string' ? JSON.parse(value) : value;
}
