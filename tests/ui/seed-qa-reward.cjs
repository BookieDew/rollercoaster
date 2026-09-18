// Seeds only a granted reward in an explicitly named isolated demo QA database.
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const [database, rewardId, seed] = process.argv.slice(2);
if (!database || !rewardId || !seed) throw new Error('Usage: node tests/ui/seed-qa-reward.cjs QA_DB REWARD_ID SEED');
const real = fs.realpathSync(database);
const tmp = fs.realpathSync(os.tmpdir());
if (!real.startsWith(tmp + path.sep) || !path.basename(path.dirname(real)).startsWith('rollercoaster-demo-') || path.basename(real) !== 'qa.sqlite') throw new Error('Refusing any non-QA database');
const db = require('knex')({ client: 'sqlite3', connection: { filename: real }, useNullAsDefault: true });
(async () => {
  const row = await db('user_rewards').where({ id: rewardId }).first();
  if (!row || row.status !== 'GRANTED' || row.ticket_snapshot) throw new Error('Reward must be granted with no prior opt-in snapshot');
  await db('user_rewards').where({ id: rewardId, status: 'GRANTED' }).update({ seed });
  console.log(JSON.stringify({ database: real, rewardId, seed, status: row.status }));
})().finally(() => db.destroy());
