// Local UI verification server: its database is always isolated from dev.db.
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rollercoaster-demo-'));
Object.assign(process.env, {
  NODE_ENV: 'development',
  DATABASE_URL: `sqlite://${path.join(testDir, 'qa.sqlite')}`,
  API_KEY_SECRET: 'demo-ui-test-key',
  ADMIN_API_KEY_SECRET: 'demo-ui-test-key',
  HMAC_SECRET: 'demo-ui-test-hmac',
  PORT: '4318',
  RIDE_MIN_DURATION_SECONDS: '2',
  RIDE_MAX_DURATION_SECONDS: '15',
  RIDE_MIN_CRASH_SECONDS: '2',
});
require('ts-node/register/transpile-only');
(async () => {
  const db = require('../../src/db/connection').default;
  await db.migrate.latest();
  const { app } = require('../../src/index');
  const server = app.listen(4318, '127.0.0.1');
  console.log(`UI test DB: ${testDir}; API key: demo-ui-test-key; PID: ${process.pid}`);
  const close = () => server.close(async () => { await db.destroy(); process.exit(0); });
  process.on('SIGINT', close); process.on('SIGTERM', close);
})().catch(error => { console.error(error); process.exit(1); });
