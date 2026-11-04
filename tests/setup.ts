// Test setup file
import http from 'http';

process.env.NODE_ENV = 'test';
process.env.API_KEY_SECRET = 'test-api-key';
process.env.ADMIN_API_KEY_SECRET = 'test-api-key';
process.env.HMAC_SECRET = 'test-hmac-secret';
process.env.HMAC_MAX_SKEW_MS = '300000';
process.env.HMAC_REPLAY_CACHE_SIZE = '1000';
process.env.RIDE_MIN_DURATION_SECONDS = '0.5';
process.env.RIDE_MAX_DURATION_SECONDS = '10';
// V4 needs 0.4 <= min crash <= min duration.
process.env.RIDE_MIN_CRASH_SECONDS = '0.5';
process.env.DATABASE_URL = 'sqlite://:memory:';

// Opt-in PostgreSQL run (`npm run test:pg`): TEST_DATABASE_URL selects the database. Every test file works in
// its own schema, created before and dropped after the file, so files cannot see each other's tables.
if (process.env.TEST_DATABASE_URL) {
  // eslint-disable-next-line global-require
  const { privateSchemaName, createSchema, dropSchema } = require('./helpers/testDb') as typeof import('./helpers/testDb');
  const schema = privateSchemaName();
  process.env.TEST_DATABASE_SCHEMA = schema;
  process.env.DATABASE_POOL_MIN = '0';
  beforeAll(() => createSchema(schema));
  afterAll(async () => {
    // Close the shared application pool (a no-op when the file never loaded it), then drop the schema.
    // eslint-disable-next-line global-require
    await (require('../src/db/connection').default as import('knex').Knex).destroy();
    await dropSchema(schema);
  });
}

// Cause of rare `read ECONNRESET`: supertest's listen(0) binds the wildcard address, so macOS can pick a port another process holds on 127.0.0.1, where supertest then connects.
// Bind those ephemeral servers to 127.0.0.1 instead. _listen2 is Node's synchronous bind (a host
// argument to listen() resolves asynchronously, but supertest reads address() immediately).
type ListenableServer = http.Server & {
  _listen2?: (address: string, port: number, addressType: number, backlog: number) => void;
};
const LOOPBACK_LISTEN = Symbol.for('rollercoaster.tests.loopbackListen');
const serverPrototype = http.Server.prototype as ListenableServer & { [LOOPBACK_LISTEN]?: true };
if (!serverPrototype[LOOPBACK_LISTEN]) {
  const wildcardListen = serverPrototype.listen as (...args: unknown[]) => http.Server;
  serverPrototype.listen = function listen(this: ListenableServer, ...args: unknown[]) {
    if (args.length === 1 && args[0] === 0 && !this.listening && typeof this._listen2 === 'function') {
      this._listen2('127.0.0.1', 0, 4, 511);
      return this;
    }
    return wildcardListen.apply(this, args);
  } as typeof serverPrototype.listen;
  serverPrototype[LOOPBACK_LISTEN] = true;
}
