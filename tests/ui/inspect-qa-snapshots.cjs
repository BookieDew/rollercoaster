const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const real = fs.realpathSync(process.argv[2]);
if (!real.startsWith(fs.realpathSync(os.tmpdir()) + path.sep) || !path.basename(path.dirname(real)).startsWith('rollercoaster-demo-') || path.basename(real) !== 'qa.sqlite') throw new Error('Refusing any non-QA database');
const db = require('knex')({ client: 'sqlite3', connection: { filename: real }, useNullAsDefault: true });
(async () => {
  const rows = await db('user_rewards').whereNotNull('ticket_snapshot').select('id', 'seed', 'bet_id', 'ticket_snapshot');
  console.log(JSON.stringify(rows.map(row => {
    const snapshot = JSON.parse(row.ticket_snapshot), math = snapshot.rideMath;
    if (math.version !== 3 || math.phaseModel !== 'FEASIBLE_WAVES_PHASE_V3') throw new Error('Real opt-in did not use V3');
    return { rewardId: row.id, betId: row.bet_id, seed: row.seed, version: math.version, phaseModel: math.phaseModel, maximumModel: math.maximumModel, mode: math.profile.rideMode, duration: math.rideDurationSeconds, crashPct: math.crashPct, checkpointCount: math.checkpoints.length, incomingSegmentMetadataCount: math.checkpoints.filter(point => point.incomingSegmentEnd).length, diagnostics: math.phaseDiagnostics };
  }), null, 2));
})().finally(() => db.destroy());
