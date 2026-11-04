const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const stage = require('../../public/demo/ride-stage');

const close = (actual, expected, epsilon = 1e-9) => assert.ok(Math.abs(actual - expected) <= epsilon, `${actual} !~ ${expected}`);
const sample = (seconds, boost, gapBefore = false) => ({ seconds, boost, gapBefore });

test('fitDomain: observed range plus 10% margin, at least minSpan wide, floored at 0', () => {
  let d = stage.fitDomain([0.02, 0.12], { minSpan: 0.01 });
  close(d.min, 0.01); close(d.max, 0.13);
  d = stage.fitDomain([0.05], { minSpan: 0.02 });
  close(d.min, 0.04); close(d.max, 0.06);
  d = stage.fitDomain([0, 0.002], { minSpan: 0.02 });
  assert.equal(d.min, 0); close(d.max, 0.02);
  d = stage.fitDomain([]);
  assert.equal(d.min, 0); assert.ok(d.max > 0);
  d = stage.fitDomain([NaN, 0.03, Infinity, 0.05]);
  close(d.min, 0.028); close(d.max, 0.052);
});

test('smoothDomain approaches the target without overshooting it', () => {
  const target = { min: 0, max: 0.2 };
  let domain = { min: 0, max: 0.02 };
  for (let i = 0; i < 400; i += 1) {
    const next = stage.smoothDomain(domain, target, 0.016);
    assert.ok(next.max >= domain.max && next.max <= target.max);
    domain = next;
  }
  close(domain.max, 0.2, 1e-4);
  assert.deepEqual(stage.smoothDomain(null, target, 0.016), target);
});

test('containDomain widens a lagging domain just enough to hold every observed value', () => {
  assert.deepEqual(stage.containDomain({ min: 0, max: 0.02 }, [0.14, 0.19]), { min: 0, max: 0.19 });
  assert.deepEqual(stage.containDomain({ min: 0.1, max: 0.2 }, [0.15]), { min: 0.1, max: 0.2 });
  assert.deepEqual(stage.containDomain({ min: 0.1, max: 0.2 }, [0.05, NaN]), { min: 0.05, max: 0.2 });
  assert.deepEqual(stage.containDomain({ min: 0, max: 1 }, []), { min: 0, max: 1 });
});

test('easeToward never passes the latest observed value, rising or falling', () => {
  for (const [from, to] of [[0, 0.1], [0.1, 0], [0.05, 0.05], [0.2, 0.19]]) {
    let shown = from;
    for (let i = 0; i < 200; i += 1) {
      shown = stage.easeToward(shown, to, 0.016, 0.18);
      assert.ok(to >= from ? shown <= to + 1e-12 && shown >= from - 1e-12 : shown >= to - 1e-12 && shown <= from + 1e-12, `${from}->${to}: ${shown}`);
    }
    close(shown, to, 1e-3);
  }
  assert.equal(stage.easeToward(NaN, 0.04, 0.016), 0.04);
  assert.equal(stage.easeToward(0.03, NaN, 0.016), 0.03);
  assert.equal(stage.easeToward(0.02, 0.5, 0), 0.02);
});

test('advanceView trails the latest sample: monotonic, never past it, buffered', () => {
  const samples = [sample(0.2, 0.01), sample(0.6, 0.02), sample(1.0, 0.03), sample(1.4, 0.025)];
  let view = null;
  let previous = -Infinity;
  for (let i = 0; i < 300; i += 1) {
    view = stage.advanceView(samples, view, 0.016);
    assert.ok(view >= previous, 'view moved backwards');
    assert.ok(view <= samples.at(-1).seconds, 'view passed the latest sample');
    previous = view;
  }
  close(view, 1.4 - 0.3);
  // Starts at the first observation, never before it; with one sample it stays there.
  assert.equal(stage.advanceView(samples, null, 0.016), 0.2);
  assert.equal(stage.advanceView([sample(2, 0.01)], 2, 1), 2);
  assert.equal(stage.advanceView([], 1, 1), 0);
  // A stale or too-large view is clamped to the observed range.
  assert.equal(stage.advanceView(samples, 99, 0.016), 1.4);
  assert.equal(stage.advanceView(samples, -5, 0), 0.2);
});

test('advanceView with huge steps or lag still never exceeds the latest sample', () => {
  const samples = [sample(0, 0), sample(0.5, 0.02), sample(5, 0.04)];
  for (const dt of [0.001, 0.05, 1, 100]) {
    const next = stage.advanceView(samples, 0, dt, { buffer: 0, catchUp: 50 });
    assert.ok(next <= 5 && next >= 0);
  }
});

test('advanceView jumps over a gap instead of drawing through it; valueAt holds the earlier observation inside one', () => {
  const samples = [sample(0, 0.01), sample(0.4, 0.02), sample(3.0, 0.05, true), sample(3.4, 0.06)];
  const view = stage.advanceView(samples, 0.39, 0.05, { buffer: 0 });
  assert.equal(view, 3.0);
  assert.equal(stage.valueAt(samples, 1.5), 0.02);
  close(stage.valueAt(samples, 3.2), 0.055);
  close(stage.valueAt(samples, 0.2), 0.015);
  assert.equal(stage.valueAt(samples, 99), 0.06);
  assert.equal(stage.valueAt(samples, -1), 0.01);
  assert.equal(stage.valueAt([], 1), 0);
});

test('valueAt stays within the observed values (no overshoot, no invention)', () => {
  const samples = [sample(0, 0.01), sample(1, 0.09), sample(2, 0.03)];
  for (let t = -1; t <= 4; t += 0.05) {
    const v = stage.valueAt(samples, t);
    assert.ok(v >= 0.01 - 1e-12 && v <= 0.09 + 1e-12);
  }
});

test('intensity is a smooth curve of the absolute boost with no end stop (it never reveals a maximum)', () => {
  assert.equal(stage.intensity(0), 0);
  close(stage.intensity(0.25), 1 - Math.exp(-1));
  assert.equal(stage.intensity(-1), 0);
  assert.equal(stage.intensity(NaN), 0);
  assert.equal(stage.intensity(Infinity), 0);
  assert.equal(stage.intensity.length <= 2, true, 'no maximum parameter');
  let previous = 0;
  let lastStep = Infinity;
  for (let boost = 0.01; boost <= 2; boost += 0.01) {
    const value = stage.intensity(boost);
    assert.ok(value > previous, `strictly rising up to ${boost}`);
    assert.ok(value <= 1);
    lastStep = Math.min(lastStep, value - previous);
    previous = value;
  }
  // The same boost always looks the same: nothing depends on any ride-specific ceiling.
  assert.equal(stage.intensity(0.12), stage.intensity(0.12));
  assert.ok(stage.intensity(0.5) < 0.9 && stage.intensity(0.1) > 0.3);
});

test('intensityStyle grows glow, particles, pulse and whiteness monotonically', () => {
  let prev = stage.intensityStyle(0);
  for (let i = 1; i <= 10; i += 1) {
    const next = stage.intensityStyle(i / 10);
    for (const key of ['glow', 'core', 'particleRate', 'pulse', 'pulseHz', 'white']) assert.ok(next[key] >= prev[key], key);
    prev = next;
  }
  assert.deepEqual(stage.intensityStyle(5), stage.intensityStyle(1));
  assert.deepEqual(stage.intensityStyle(NaN), stage.intensityStyle(0));
});

test('colours parse from CSS custom properties and mix', () => {
  assert.deepEqual(stage.parseColor('#1cae66'), [28, 174, 102]);
  assert.deepEqual(stage.parseColor(' #0F8 '), [0, 255, 136]);
  assert.deepEqual(stage.parseColor('rgb(10, 20, 30)'), [10, 20, 30]);
  assert.deepEqual(stage.parseColor('rgba(10 20 30 / 0.5)'), [10, 20, 30]);
  assert.equal(stage.parseColor('hotpink'), null);
  assert.equal(stage.parseColor(undefined), null);
  assert.deepEqual(stage.mixColor([0, 0, 0], [255, 255, 255], 0.5), [128, 128, 128]);
  assert.deepEqual(stage.mixColor([0, 0, 0], [255, 255, 255], 9), [255, 255, 255]);
});

test('tone frequency rises with intensity', () => {
  assert.equal(stage.toneFrequency(0), 196);
  assert.ok(stage.toneFrequency(0.5) > stage.toneFrequency(0));
  assert.ok(stage.toneFrequency(1) > stage.toneFrequency(0.5));
  assert.ok(stage.toneFrequency(1) < 1000);
  assert.equal(stage.toneFrequency(7), stage.toneFrequency(1));
});

test('sound is muted by default, remembered, and silent until a user gesture', () => {
  const store = new Map();
  const storage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, v) };
  const created = [];
  class FakeContext {
    constructor() { created.push(this); this.state = 'running'; this.currentTime = 0; this.destination = {}; this.sampleRate = 8000; }
    createGain() { return { gain: { value: 0, setTargetAtTime() {}, cancelScheduledValues() {}, setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {} }; }
    createBiquadFilter() { return { frequency: { value: 0, setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {} }; }
    createOscillator() { return { frequency: { value: 0, setTargetAtTime() {}, setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {}, start() {}, stop() {} }; }
    createBuffer(c, n) { return { getChannelData: () => new Float32Array(n) }; }
    createBufferSource() { return { connect() {}, start() {} }; }
    resume() {}
  }
  let sound = stage.createSound({ storage, AudioContextClass: FakeContext });
  assert.equal(sound.isEnabled(), false);
  sound.startRide(); sound.lock(); sound.crash();
  assert.equal(created.length, 0, 'nothing may be created while muted');
  sound.setEnabled(true);
  assert.equal(store.get(stage.SOUND_KEY), '1');
  sound.startRide();
  assert.equal(created.length, 0, 'enabled but no user gesture yet: still silent');
  sound.unlock();
  assert.equal(created.length, 1, 'audio starts only after the gesture');
  sound.setLevel(0.7); sound.lock(); sound.crash(); sound.stop();
  sound.toggle();
  assert.equal(store.get(stage.SOUND_KEY), '0');
  // A remembered "on" is restored but still needs a gesture.
  store.set(stage.SOUND_KEY, '1');
  created.length = 0;
  sound = stage.createSound({ storage, AudioContextClass: FakeContext });
  assert.equal(sound.isEnabled(), true);
  sound.startRide();
  assert.equal(created.length, 0);
  // Broken storage never throws.
  const broken = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } };
  sound = stage.createSound({ storage: broken, AudioContextClass: FakeContext });
  assert.equal(sound.isEnabled(), false);
  assert.doesNotThrow(() => sound.setEnabled(true));
});

test('the stage and slip sources never read the ride maximum or the future path', () => {
  for (const file of ['ride-stage.js', 'player-slip.js']) {
    const source = fs.readFileSync(path.join(__dirname, '../../public/demo', file), 'utf8');
    assert.ok(!/theoretical_max|referenceMax|ride_path|finalDisplay|ride_crash_at|ride_end_at|effective_max|effectiveMax|up to/i.test(source), `${file} touches ride-maximum or path fields`);
  }
});
