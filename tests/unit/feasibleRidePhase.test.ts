import { createHash } from 'crypto';
import * as generator from '../../src/computations/deterministicRideGenerator';
import { generatePhaseCorrectedRide, deriveFeasibleCrashPhase } from '../../src/computations/feasibleRidePhase';
import { calculateFinalBoost, computeBoostModelDetails, type FinalBoostConfig } from '../../src/computations/finalBoostCalculator';
import { computeTicketStrength } from '../../src/computations/ticketStrengthScorer';

const base: FinalBoostConfig = { minBoostPct: .05, maxBoostPct: 1, maxBoostMinSelections: null, maxBoostMinCombinedOdds: null, maxEligibilitySelectionWeight: .75, maxEligibilityOddsWeight: .25, effectiveMinFloorRate: .35 };
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const fixtures: Array<[string, number, number, Partial<FinalBoostConfig>]> = [
  ['weak', 3, 1.5, {}], ['medium', 6, 1.8, {}], ['strong', 12, 2, {}],
  ['weak targeted', 3, 1.5, { maxBoostMinSelections: 10, maxBoostMinCombinedOdds: 50 }],
  ['medium targeted', 6, 1.8, { maxBoostMinSelections: 10, maxBoostMinCombinedOdds: 50 }],
  ['strong targeted', 12, 2, { maxBoostMinSelections: 10, maxBoostMinCombinedOdds: 50 }],
  ['equal', 12, 2, { maxBoostPct: .05 }],
  ['selection weight/floor zero', 3, 1.5, { maxBoostMinSelections: 10, maxBoostMinCombinedOdds: 50, maxEligibilitySelectionWeight: 1, maxEligibilityOddsWeight: 0, effectiveMinFloorRate: 0 }],
  ['odds weight/full floor', 3, 1.5, { maxBoostMinSelections: 10, maxBoostMinCombinedOdds: 50, maxEligibilitySelectionWeight: 0, maxEligibilityOddsWeight: 1, effectiveMinFloorRate: 1 }],
  ['tiny range', 12, 2, { minBoostPct: .05, maxBoostPct: .05005 }],
  ['high cap', 12, 2, { maxBoostPct: 10 }],
  ['zero minimum', 12, 2, { minBoostPct: 0 }],
];
function setup(seed: string, count: number, odds: number, overrides: Partial<FinalBoostConfig> = {}) {
  const cfg = { ...base, ...overrides }, combined = Math.round(odds ** count * 1e6) / 1e6;
  const strength = computeTicketStrength(count, combined, { minSelections: 3 });
  const duration = generator.deriveRideDurationSeconds(seed, 2, 15);
  const params = generator.deriveRideParams(seed, duration, 2);
  const input = { ...params, ...cfg, durationSeconds: duration, rideMode: 'WAVES' as const, ticketStrength: strength, qualifyingSelections: count, combinedOdds: combined, finalBoostConfig: cfg };
  const old = generator.generateRide(seed, input), next = generatePhaseCorrectedRide(seed, input);
  const pay = (raw: number) => calculateFinalBoost({ rideValue: raw, ticketStrength: strength, qualifyingSelections: count, combinedOdds: combined, hasRideEnded: false, config: cfg });
  const value = (points: generator.RideCheckpoint[], t: number) => pay(generator.interpolateRideValue(points, t));
  const maximum = (points: generator.RideCheckpoint[]) => pay(Math.max(generator.interpolateRideValue(points, params.crashPct), ...points.filter(p => p.timeOffsetPct <= params.crashPct).map(p => p.baseBoostValue)));
  return { cfg, combined, strength, duration, params, input, old, next, pay, value, maximum };
}

it.each(fixtures)('%s: 5000 shared seeds preserve maxima/prefix/bounds and truthful effective phases', (_name, count, odds, override) => {
  const statuses = new Set<string>();
  for (let i = 0; i < 5000; i++) {
    const seed = hash(`phase-candidate-v1-${i}`), f = setup(seed, count, odds, override), d = f.next.phaseDiagnostics;
    const fail = (message: string) => { throw new Error(`${_name} ${seed}: ${message}`); };
    statuses.add(d.status);
    if (f.maximum(f.next.checkpoints) !== f.maximum(f.old.checkpoints)) fail('maximum changed');
    if (d.status !== 'REPAIRED') {
      if (JSON.stringify(f.next.checkpoints) !== JSON.stringify(f.old.checkpoints)) fail('exception changed curve');
      continue;
    }
    const start = d.suffixStartSeconds! / f.duration;
    if (d.suffixStartSeconds! < 2 || f.params.crashPct * f.duration - d.suffixStartSeconds! > .800000001) fail('suffix timing');
    for (const pct of [0, start * .1, start * .9, start - 1e-10]) {
      if (f.value(f.old.checkpoints, pct) !== f.value(f.next.checkpoints, pct)) fail('prefix changed');
    }
    const m = computeBoostModelDetails(count, f.combined, f.cfg), maximum = f.maximum(f.old.checkpoints);
    for (const p of f.next.checkpoints.filter(p => p.timeOffsetPct < f.params.crashPct)) {
      const value = f.value(f.next.checkpoints, p.timeOffsetPct);
      if (!Number.isFinite(value) || value < m.effectiveMinBoost || value > m.effectiveMaxBoost || value > maximum) fail('bounds');
    }
    const T = f.params.crashPct * f.duration, last = Math.floor((T - 1e-9) / .2) * .2;
    for (const [a, b] of [[T - .4, T - 1e-9], [last - .2, last]]) {
      const before = f.value(f.next.checkpoints, a / f.duration), after = f.value(f.next.checkpoints, b / f.duration);
      if (d.phase === 'UP' && after <= before) fail('UP not up');
      if (d.phase === 'DOWN' && after >= before) fail('DOWN not down');
      if (d.phase === 'PEAK' && Math.min(before, after) < d.reachableLowerBoostPct! + .95 * (maximum - d.reachableLowerBoostPct!) - .000002) fail('PEAK not near top');
    }
    const copied = JSON.parse(JSON.stringify(f.next.checkpoints));
    if (f.value(copied, start + .00001) !== f.value(f.next.checkpoints, start + .00001)) fail('JSON precision');
  }
  expect(statuses.has('NO_CRASH_UNCHANGED')).toBe(true);
}, 60000);

it('preserves LINEAR checkpoint generation and uses an independent conditional phase draw', () => {
  const labels = { UP: 0, PEAK: 0, DOWN: 0 };
  for (let i = 0; i < 5000; i++) {
    const seed = hash(`phase-candidate-v1-${i}`), f = setup(seed, 3, 1.5);
    const config = { ...f.input, rideMode: 'LINEAR' as const };
    const next = generatePhaseCorrectedRide(seed, config);
    if (JSON.stringify(next.checkpoints) !== JSON.stringify(generator.generateRide(seed, config).checkpoints)) throw new Error(seed);
    if (f.params.crashPct < 1) labels[deriveFeasibleCrashPhase(seed)]++;
  }
  const n = Object.values(labels).reduce((a, b) => a + b, 0);
  expect(labels.UP / n).toBeCloseTo(.5, 1);
  expect(labels.PEAK / n).toBeCloseTo(.2, 1);
  expect(labels.DOWN / n).toBeCloseTo(.3, 1);
});

it('paired raw boundary is effectively continuous before/at/after rounding surfaces', () => {
  // Real clamp fixtures which previously diverged by up to 21pp during raw inversion.
  for (const seed of ['140f62b073c80d434c04b764bc80c46ba9aca5e610611a75238964490f4a53bb', 'b3d51c47b2166c0b5144499400f98185c3ea701f72ce9e50ecb69f7b42eb1c57']) {
    for (const overrides of [{}, { maxBoostMinSelections: 10, maxBoostMinCombinedOdds: 50 }]) {
      const f = setup(seed, 12, 2, overrides), start = f.next.phaseDiagnostics.suffixStartSeconds! / f.duration;
      const pair = f.next.checkpoints.filter(p => p.timeOffsetPct === start);
      expect(pair.length).toBe(2);
      expect(f.pay(Math.round(pair[0].baseBoostValue * 1e6) / 1e6)).toBe(f.pay(Math.round(pair[1].baseBoostValue * 1e6) / 1e6));
      for (const delta of [-1e-10, -Number.EPSILON, 0, Number.EPSILON, 1e-10]) {
        const value = f.value(f.next.checkpoints, start + delta);
        expect(Number.isFinite(value)).toBe(true);
        expect(Math.abs(value - f.value(f.old.checkpoints, start))).toBeLessThanOrEqual(.0000021);
        if (delta < 0) expect(value).toBe(f.value(f.old.checkpoints, start + delta));
      }
    }
  }
});

it('makes early/zero-range/no-crash exceptions explicit without changing their original checkpoints', () => {
  const seed = hash('edge-phase');
  const f = setup(seed, 12, 2);
  for (const duration of [0.5, 1, 2, 2.599, 2.6]) {
    const input = { ...f.input, durationSeconds: duration, crashPct: .9999 };
    const ride = generatePhaseCorrectedRide(seed, input);
    expect(ride.phaseDiagnostics.status).toBe('TIMING_CONSTRAINED');
    expect(ride.checkpoints).toEqual(generator.generateRide(seed, input).checkpoints);
  }
  const noCrash = generatePhaseCorrectedRide(seed, { ...f.input, crashPct: 1 });
  expect(noCrash.phaseDiagnostics.status).toBe('NO_CRASH_UNCHANGED');
});

it('keeps the incoming original segment at raw half-micro rounding boundaries', () => {
  const seed = hash('rounding-surface');
  for (const target of [.4000005 - 1e-12, .4000005, .4000005 + 1e-12]) {
    const points = [
      { index: 0, timeOffsetPct: 0, baseBoostValue: .05 },
      { index: 1, timeOffsetPct: .5, baseBoostValue: .1 },
      { index: 2, timeOffsetPct: .9, baseBoostValue: .1 + (target - .1) / .55 },
      { index: 3, timeOffsetPct: 1, baseBoostValue: 0 },
    ];
    const spy = jest.spyOn(generator, 'generateRide').mockReturnValue({ seed, checkpoints: points });
    try {
      const cfg = { ...base, checkpointCount: 4, volatility: .5, durationSeconds: 10, crashPct: .8, rideMode: 'WAVES' as const, ticketStrength: 1, qualifyingSelections: 12, combinedOdds: 4096, finalBoostConfig: base };
      const next = generatePhaseCorrectedRide(seed, cfg);
      const start = next.phaseDiagnostics.suffixStartSeconds! / 10;
      for (const delta of [-1e-9, -1e-12, -Number.EPSILON]) {
        expect(generator.interpolateRideValue(next.checkpoints, start + delta)).toBe(generator.interpolateRideValue(points, start + delta));
      }
      const value = generator.interpolateRideValue(next.checkpoints, start);
      expect(Number.isFinite(value)).toBe(true);
    } finally { spy.mockRestore(); }
  }
});


it('preserves the independently found real millisecond prefix regression exactly', () => {
  const f = setup('4ba80023ab0e6a4ebb5c3ce126bd065009a35a2d58af43046329a2187357d7f1', 12, 2);
  expect(f.duration).toBe(11.712);
  expect(f.next.phaseDiagnostics.suffixStartSeconds).toBeCloseTo(9.7302592, 12);
  expect(f.value(f.old.checkpoints, 9.638 / f.duration)).toBe(.516485);
  expect(f.value(f.next.checkpoints, 9.638 / f.duration)).toBe(.516485);
  const f2 = setup('a1fab00ed985ce454f2bbb171edafc951a7b5b5130b754fb32b259cccd04f647', 12, 2);
  const t = 4.647913413481356 / f2.duration;
  expect(f2.value(f2.next.checkpoints, t)).toBe(f2.value(f2.old.checkpoints, t));
});
