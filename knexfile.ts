import type { Knex } from 'knex';
import { config } from './src/config';

const baseConfig: Partial<Knex.Config> = {
  migrations: {
    directory: './migrations',
    extension: 'ts',
  },
  seeds: {
    directory: './seeds',
    extension: 'ts',
  },
};

const knexConfig: { [key: string]: Knex.Config } = {
  development: {
    ...baseConfig,
    client: 'sqlite3',
    connection: {
      filename: config.database.url,
    },
    useNullAsDefault: true,
  },

  test: {
    ...baseConfig,
    client: 'sqlite3',
    connection: {
      filename: ':memory:',
    },
    useNullAsDefault: true,
  },

  production: {
    ...baseConfig,
    client: 'pg',
    connection: config.database.url,
    pool: {
      min: 2,
      max: 10,
    },
  },
};

export default knexConfig;
