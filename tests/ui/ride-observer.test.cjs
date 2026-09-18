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
test('crash and end append observed zero, retain separate status and never consume a full path', () => {
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
