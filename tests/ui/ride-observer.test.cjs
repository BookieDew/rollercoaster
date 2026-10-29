const test = require('node:test');
const assert = require('node:assert/strict');
const { ObservedRide, finite } = require('../../public/demo/ride-observer');
const identity = { reward_id: 'r1', bet_id: 'b1', user_id: 'u1' };
const sample = (seconds, boost) => ({ eligible: true, ride_elapsed_seconds: seconds, current_boost_pct: boost });
const started = () => { const ride = new ObservedRide(); ride.start(identity); return ride; };

test('numeric nulls, strings and absent fields are not zero observations', () => {
  assert.equal(finite(null), null); assert.equal(finite('0'), null); assert.equal(finite(0), 0);
  const ride = started();
  for (const value of [null, undefined, '0', NaN, Infinity, -1]) {
    assert.equal(ride.accept(sample(0.2, value), ride.token()), false);
  }
  assert.deepEqual(ride.samples, []);
});
test('WAVES rising/falling and LINEAR rising observations retain exact received values', () => {
  for (const boosts of [[0.051, 0.22, 0.072, 0.4], [0.051, 0.10, 0.149, 0.20]]) {
    const ride = started();
    boosts.forEach((boost, index) => assert.equal(ride.accept(sample(index * 0.2, boost), ride.token()), true));
    assert.deepEqual(ride.samples.map(p => p.boost), boosts);
  }
});
test('duplicate and out-of-order authoritative times are ignored', () => {
  const ride = started(), token = ride.token();
  ride.accept(sample(1, 0.1), token);
  assert.equal(ride.accept(sample(0.8, 0.4), token), false);
  assert.equal(ride.accept(sample(1, 0.6), token), false);
  assert.equal(ride.samples.length, 1);
});
test('lock invalidates in-flight quote and appends its exact between-sample stop', () => {
  const ride = started(), quoteToken = ride.token();
  ride.accept(sample(0.2, 0.15), quoteToken);
  const lockToken = ride.beginLock();
  assert.equal(ride.accept(sample(0.6, 0.6), quoteToken), false);
  assert.equal(ride.accept({ lock_id: 'lock', ride_stop_at_offset_seconds: 0.375, locked_boost_pct: 0.123456, theoretical_max_boost_pct: 0.10, ride_path: [{ future: true }] }, lockToken, 'lock'), true);
  assert.deepEqual(ride.samples.map(p => [p.seconds, p.boost]), [[0.2, 0.15], [0.375, 0.123456]]);
  assert.equal(ride.final.referenceMax, 0.10);
  assert.equal(ride.accept(sample(2, 0), ride.token()), false);
});
test('lock at the same millisecond can reconcile the exact final value without rewriting history', () => {
  const ride = started(); ride.accept(sample(0.1, 0.15), ride.token());
  const token = ride.beginLock();
  assert.equal(ride.accept({ lock_id: 'l', ride_stop_at_offset_seconds: 0.1, locked_boost_pct: 0.1499 }, token, 'lock'), true);
  assert.equal(ride.samples[0].boost, 0.15); assert.equal(ride.samples[1].boost, 0.1499);
});
test('crash and end append observed zero, retain separate status and reject malformed full-path metadata', () => {
  for (const code of ['RIDE_CRASHED', 'RIDE_ENDED']) {
    const ride = started(); ride.accept(sample(0.2, 0.2), ride.token());
    assert.equal(ride.accept({ eligible: false, reason_code: code, ride_elapsed_seconds: 1.2, current_boost_pct: 0, ride_path: [{ timePct: 1, baseBoostValue: 1 }] }, ride.token()), true);
    assert.equal(ride.samples.length, 2); assert.equal(ride.samples[1].boost, 0);
    assert.equal(ride.phase, code === 'RIDE_CRASHED' ? 'crashed' : 'ended');
    assert.equal(ride.samples[1].gapBefore, true);
  }
});
test('terminal lock errors accept top-level reason plus details', () => {
  const ride = started(); const token = ride.beginLock();
  assert.equal(ride.accept({ code: 'RIDE_CRASHED', details: { ride_elapsed_seconds: 2, current_boost_pct: 0 } }, token, 'lock'), true);
  assert.equal(ride.phase, 'crashed');
});
test('new ride reset rejects all old quote/lock tokens and observations', () => {
  const ride = started(), old = ride.token(); ride.accept(sample(1, 0.1), old);
  ride.start({ ...identity, reward_id: 'r2' });
  assert.equal(ride.accept(sample(2, 0.2), old), false);
  assert.deepEqual(ride.samples, []); assert.equal(ride.final, null);
});
test('errors/manual gaps and long time gaps disconnect the next observation', () => {
  const ride = started(); ride.accept(sample(0, 0.1), ride.token()); ride.markGap();
  ride.accept(sample(0.2, 0.11), ride.token()); ride.accept(sample(0.4, 0.12), ride.token()); ride.accept(sample(2, 0.3), ride.token());
  assert.deepEqual(ride.samples.map(p => p.gapBefore), [false, true, false, true]);
});
test('ambiguous lock permits idempotent retry, keeps quote responses paused', () => {
  const ride = started(); ride.accept(sample(0.2, 0.1), ride.token());
  const failed = ride.beginLock(); ride.lockFailed(failed);
  assert.equal(ride.phase, 'uncertain'); assert.equal(ride.accept(sample(0.8, 0.6), ride.token()), false);
  const retry = ride.beginLock();
  assert.equal(ride.accept({ lock_id: 'l', ride_stop_at_offset_seconds: 0.3, locked_boost_pct: 0.12 }, failed, 'lock'), false);
  assert.equal(ride.accept({ lock_id: 'l', ride_stop_at_offset_seconds: 0.3, locked_boost_pct: 0.12 }, retry, 'lock'), true);
});

const replay = () => ({
  ride_end_at_offset_seconds: 10, ride_crash_at_offset_seconds: 6.2,
  ride_path: [0, 0.25, 0.5, 0.75, 1].map((timePct, i) => ({ timePct, baseBoostValue: [0.1, 0.2, 0.25, 0, 0][i] })),
});
const lockPayload = () => ({ ...replay(), lock_id: 'l', bet_id: 'b1', reward_id: 'r1', ride_stop_at_offset_seconds: 0.375, locked_boost_pct: 0.123456, theoretical_max_boost_pct: 0.45 });

test('direction uses accepted consecutive observations and neutralizes first, gap, pause, stale and final', () => {
  const ride = started();
  assert.equal(ride.direction(), 'none');
  ride.accept(sample(0.1, 0.1), ride.token()); assert.equal(ride.direction(), 'none');
  ride.accept(sample(0.2, 0.2), ride.token()); assert.equal(ride.direction(), 'up');
  assert.equal(ride.direction({ paused: true }), 'none');
  assert.equal(ride.direction({ now: ride.lastAcceptedAt + 801 }), 'none');
  ride.accept(sample(0.3, 0.15), ride.token()); assert.equal(ride.direction(), 'down');
  ride.accept(sample(0.4, 0.15), ride.token()); assert.equal(ride.direction(), 'flat');
  ride.markGap(); assert.equal(ride.direction(), 'none');
  ride.accept(sample(0.5, 0.3), ride.token()); assert.equal(ride.direction(), 'none');
  ride.accept(sample(0.6, 0.4), ride.token()); assert.equal(ride.direction(), 'up');
  const token = ride.beginLock(); assert.equal(ride.direction(), 'none');
  ride.lockFailed(token); assert.equal(ride.direction(), 'none');
  const retry = ride.beginLock();
  ride.accept({ ...lockPayload(), ride_stop_at_offset_seconds: 0.7 }, retry, 'lock');
  assert.equal(ride.direction(), 'none');
});
test('full display is accepted-final-only, copied immutably, and separate from observations and true maximum', () => {
  const ride = started();
  ride.accept({ ...sample(0.2, 0.15), ...replay() }, ride.token());
  assert.equal(ride.finalDisplay, null);
  const payload = lockPayload();
  assert.equal(ride.accept(payload, ride.beginLock(), 'lock'), true);
  assert.deepEqual(ride.finalDisplay.points.map(p => [p.seconds, p.boost]), [[0,.1],[2.5,.2],[5,.25],[7.5,0],[10,0]]);
  assert.deepEqual(ride.samples.map(p => [p.seconds, p.boost]), [[.2,.15],[.375,.123456]]);
  assert.equal(ride.finalDisplay.points[3].gapBefore, true, 'No chord into post-crash zero');
  assert.equal(ride.final.referenceMax, .45, 'Must not use sampled maximum');
  assert(Object.isFrozen(ride.finalDisplay) && Object.isFrozen(ride.finalDisplay.points) && Object.isFrozen(ride.finalDisplay.points[0]));
  payload.ride_path[0].baseBoostValue = 9; payload.ride_end_at_offset_seconds = 20;
  assert.equal(ride.finalDisplay.points[0].boost, .1); assert.equal(ride.finalDisplay.duration, 10);
  const snapshot = ride.finalDisplay;
  assert.equal(ride.accept({ ...sample(12,0), ...replay() }, ride.token()), false);
  assert.equal(ride.finalDisplay, snapshot);
  ride.start({ ...identity, reward_id: 'r2' });
  assert.equal(ride.finalDisplay, null); assert.equal(ride.direction(), 'none');
});
test('malformed replay never removes exact final outcome and never reveals partial data', () => {
  const cases = [
    data => delete data.ride_end_at_offset_seconds,
    data => data.ride_end_at_offset_seconds = 0,
    data => data.ride_end_at_offset_seconds = Infinity,
    data => data.ride_crash_at_offset_seconds = -1,
    data => data.ride_crash_at_offset_seconds = 11,
    data => data.ride_crash_at_offset_seconds = .1,
    data => data.ride_path = [],
    data => data.ride_path[0].timePct = .1,
    data => data.ride_path.at(-1).timePct = .9,
    data => data.ride_path[1].timePct = 0,
    data => data.ride_path[2].timePct = -.1,
    data => data.ride_path[2].baseBoostValue = '0.2',
    data => data.ride_path[2].baseBoostValue = NaN,
    data => data.ride_path[2].baseBoostValue = -1,
    data => data.ride_path[2].baseBoostValue = 10.01,
    data => data.ride_path[3].baseBoostValue = .1,
    data => data.ride_path.at(-1).baseBoostValue = .1,
  ];
  for (const mutate of cases) {
    const ride = started(), payload = lockPayload(); mutate(payload);
    assert.equal(ride.accept(payload, ride.beginLock(), 'lock'), true);
    assert.equal(ride.final.boost, .123456);
    assert.equal(ride.finalDisplay, null);
  }
});
test('all-zero path and independent millisecond rounding are supported', () => {
  const ride = started(), payload = lockPayload();
  payload.ride_path.forEach(point => point.baseBoostValue = 0);
  payload.ride_stop_at_offset_seconds = 6.2;
  assert.equal(ride.accept(payload, ride.beginLock(), 'lock'), true);
  assert(ride.finalDisplay); assert(ride.finalDisplay.points.every(point => point.boost === 0));
});
test('rounded-down crash offset still breaks the sampled chord after a valid positive predecessor', () => {
  const ride = started();
  const payload = { ...lockPayload(), ride_end_at_offset_seconds: 8, ride_crash_at_offset_seconds: 2.983 };
  payload.ride_path = Array.from({length:60}, (_,index) => ({timePct:index/59,baseBoostValue:index/59 < .3729 ? .1 : 0}));
  assert(ride.accept(payload, ride.beginLock(), 'lock'));
  assert(ride.finalDisplay.points[22].seconds > 2.983);
  assert.equal(ride.finalDisplay.points[22].boost, .1);
  assert.equal(ride.finalDisplay.points[23].gapBefore, true);
  assert.equal(ride.finalDisplay.points[23].seconds, 23/59*8);
  assert.equal(ride.final.boost, .123456);
});
test('late crash/end results and terminal error details retain reported event and observed times separately', () => {
  for (const reason of ['RIDE_CRASHED','RIDE_ENDED']) {
    const ride = started();
    const data = { ...replay(), current_boost_pct: 0, ride_elapsed_seconds: 12 };
    if (reason === 'RIDE_ENDED') data.ride_crash_at_offset_seconds = 10;
    assert.equal(ride.accept({ code: reason, details: data }, ride.beginLock(), 'lock'), true);
    assert.equal(ride.final.seconds, 12); assert.equal(ride.finalDisplay.duration, 10);
    assert.equal(ride.finalDisplay.crash, reason === 'RIDE_ENDED' ? 10 : 6.2);
  }
});
test('contradictory early terminal times fall back to observed-only without losing final zero', () => {
  for (const [code, seconds, crash] of [['RIDE_CRASHED', 5, 6.2], ['RIDE_ENDED', 9, 10], ['RIDE_ENDED', 12, 6.2]]) {
    const ride = started();
    assert(ride.accept({ ...replay(), ride_crash_at_offset_seconds: crash, reason_code: code, ride_elapsed_seconds: seconds, current_boost_pct: 0 }, ride.token()));
    assert.equal(ride.finalDisplay, null); assert.equal(ride.final.boost, 0);
  }
});
test('explicit identity mismatches and stale terminal tokens cannot reveal or overwrite current ride', () => {
  for (const key of ['reward_id','bet_id','user_id']) {
    const ride = started();
    assert.equal(ride.accept({ ...lockPayload(), [key]: 'different' }, ride.beginLock(), 'lock'), false);
    assert.equal(ride.finalDisplay, null); assert.equal(ride.final, null); assert.deepEqual(ride.samples, []);
  }
  const ride = started(), old = ride.beginLock();
  ride.start({ ...identity, reward_id: 'r2' });
  assert.equal(ride.accept(lockPayload(), old, 'lock'), false);
  assert.equal(ride.finalDisplay, null);
});
