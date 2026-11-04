import Knex from 'knex';
import { buildKnexConfig, config } from '../config';

const db = Knex(buildKnexConfig(config));

export default db;
