import Knex from 'knex';
import { buildKnexConfig, config } from '../config';

const knexConfig = buildKnexConfig(config);

// PostgreSQL is selected by DATABASE_URL but its driver is not a dependency yet.
if (knexConfig.client === 'pg') {
  try {
    require.resolve('pg');
  } catch {
    throw new Error(
      'DATABASE_URL selects PostgreSQL, but the "pg" driver is not installed. '
      + 'PostgreSQL support is not verified for this service yet; install the driver '
      + '(npm install pg) or use a sqlite:// DATABASE_URL.'
    );
  }
}

const db = Knex(knexConfig);

export default db;
