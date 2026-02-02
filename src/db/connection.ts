import Knex from 'knex';
import knexConfig from '../../knexfile';
import { config } from '../config';

const environment = config.server.env;
const connectionConfig = knexConfig[environment];

if (!connectionConfig) {
  throw new Error(`No Knex configuration found for environment: ${environment}`);
}

const db = Knex(connectionConfig);

export default db;
