import type { Knex } from 'knex';
import { buildKnexConfig, config } from './src/config';

// Development knex CLI (`npm run migrate`, `npm run seed`). The client follows
// DATABASE_URL and NODE_ENV comes from the environment, so `--env` is not used.
// Production migrations run from compiled JavaScript: `npm run migrate:prod`.
const knexConfig: Knex.Config = buildKnexConfig(config);

export default knexConfig;
