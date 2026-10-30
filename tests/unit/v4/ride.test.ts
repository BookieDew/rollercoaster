import { calculateFinalBoost, computeBoostModelDetails } from '../../../src/computations/finalBoostCalculator';
import {
  LINEAR_PACE_SECONDS,
  WAVES_SHAPE,
  createV4Ride,
  linearBoostAt,
  payoutBand,
  wavesFinalMapping,
  type V4RideConfig,
} from '../../../src/computations/v4';
import * as publicApi from '../../../src/computations/v4';
import { PAYOUT_CALIBRATION, bendLevel, floorPinnedShare, levelToPayout, payoutBend } from '../../../src/computations/v4/payout';
import { inspectV4Ride } from '../../../src/computations/v4/ride';
import { levelAt } from '../../../src/computations/v4/waves';
import { PROFILE, TICKETS, labConfig, namedSeed, sampleSeed, type TicketName } from './helpers';

const SEED = namedSeed('v4-ride-test');
const round6 = (x: number) => Math.round(x * 1e6) / 1e6;
const linearG = (s: number) => 0.4 * s + 0.6 * s * s;

describe('createV4Ride: API contract', () => {
  it('returns frozen, JSON-safe params that never contain the seed, and is deterministic', () => {
    const config = labConfig('medium');
    const ride = createV4Ride(SEED, config);
    expect(Object.isFrozen(ride)).toBe(true);
    expect(Object.isFrozen(ride.params)).toBe(true);
    const json = JSON.stringify(ride.params);
    for (let i = 0; i + 8 <= SEED.length; i += 8) expect(json).not.toContain(SEED.slice(i, i + 8));
    expect(JSON.parse(json)).toEqual(ride.params);
    expect(ride.params.mathVersion).toBe('V4');

    const again = createV4Ride(SEED.toUpperCase(), config);
    expect(again.params).toEqual(ride.params);
    for (let t = 0; t < 15; t += 0.137) expect(again.boostAt(t)).toBe(ride.boostAt(t));
    expect(createV4Ride(namedSeed('other'), config).params).not.toEqual(ride.params);
  });

  it('is pure: no Math.random and no clock', () => {
    const random = jest.spyOn(Math, 'random').mockImplementation(() => {
      throw new Error('Math.random used');
    });
    const now = jest.spyOn(Date, 'now').mockImplementation(() => {
      throw new Error('Date.now used');
    });
    try {
      for (const mode of ['WAVES', 'LINEAR'] as const) {
        const ride = createV4Ride(SEED, labConfig('strong', mode));
        ride.boostAt(2.5);
        ride.uncrashedBoostAt(2.5);
      }
    } finally {
      random.mockRestore();
      now.mockRestore();
    }
  });

  it('pays 6-dp rates inside the band, the start value before 0, and 0 at/after the crash and end', () => {
    for (let i = 0; i < 300; i++) {
      const ride = createV4Ride(sampleSeed('v4-api', i), labConfig('medium'));
      const p = ride.params;
      const terminal = p.crashAtSeconds ?? p.durationSeconds;
      expect(ride.boostAt(-1)).toBe(ride.boostAt(0));
      expect(ride.boostAt(terminal)).toBe(0);
      expect(ride.boostAt(terminal + 0.5)).toBe(0);
      expect(ride.uncrashedBoostAt(p.durationSeconds)).toBe(0);
      let bad = 0;
      for (let t = 0; t < terminal; t += 0.05) {
        const v = ride.boostAt(t);
        if (v !== round6(v) || v < p.bandMin || v > p.rideMaximum || ride.uncrashedBoostAt(t) !== v) bad++;
      }
      expect(bad).toBe(0);
      if (p.crashAtSeconds !== null) expect(ride.uncrashedBoostAt(p.crashAtSeconds)).toBeGreaterThan(0);
    }
    const ride = createV4Ride(SEED, labConfig('medium'));
    expect(() => ride.boostAt(Number.NaN)).toThrow('finite');
    expect(() => ride.uncrashedBoostAt(Infinity)).toThrow('finite');
  });

  it('shares duration, outcome and maximum between WAVES and LINEAR of the same seed', () => {
    for (let i = 0; i < 200; i++) {
      const seed = sampleSeed('v4-modes', i);
      const waves = createV4Ride(seed, labConfig('weak', 'WAVES')).params;
      const linear = createV4Ride(seed, labConfig('weak', 'LINEAR', 'FAST')).params;
      expect(linear.durationSeconds).toBe(waves.durationSeconds);
      expect(linear.outcome).toBe(waves.outcome);
      expect(linear.crashAtSeconds).toBe(waves.crashAtSeconds);
      expect(linear.crashBucket).toBe(waves.crashBucket);
      expect(linear.linearCap).toBe(waves.rideMaximum);
      expect(linear.crashPhase).toBeNull();
      expect(linear.peakCount).toBeNull();
      expect(linear.linearPace).toBe('FAST');
      expect(waves.linearPace).toBeNull();
      expect(waves.crashPhase === null).toBe(waves.outcome === 'ENDED');
    }
  });

  it('validates the config without echoing the seed', () => {
    const good = labConfig('medium');
    const bad: Array<Partial<V4RideConfig>> = [
      { mode: 'SPIRAL' as never },
      { minBoostPct: -0.1 },
      { maxBoostPct: 0.01 },
      { effectiveMin: Number.NaN },
      { effectiveMax: 0.1 },
      { ticketStrength: 1.2 },
      { ticketStrength: -0.1 },
      { minDurationSeconds: 0 },
      { maxDurationSeconds: 1 },
      { minCrashSeconds: -1 },
    ];
    for (const patch of bad) expect(() => createV4Ride(SEED, { ...good, ...patch })).toThrow('V4 config');
    expect(() => createV4Ride(SEED, { ...good, mode: 'LINEAR' })).toThrow('linearPace');
    expect(() => createV4Ride(SEED, { ...good, mode: 'LINEAR', linearPace: 'toString' as never })).toThrow('linearPace');
    expect(() => createV4Ride('not-a-seed', good)).toThrow('64 hexadecimal');
  });

  it('rejects a minimum crash above the minimum duration (short rides could never crash)', () => {
    const good = labConfig('medium');
    expect(() => createV4Ride(SEED, { ...good, minDurationSeconds: 0.5, maxDurationSeconds: 10 })).toThrow('minCrashSeconds must be <= minDurationSeconds');
    expect(() => createV4Ride(SEED, { ...good, minDurationSeconds: 2, maxDurationSeconds: 2 })).toThrow('minCrashSeconds');
    expect(createV4Ride(SEED, { ...good, minCrashSeconds: 2, minDurationSeconds: 2 }).params.mathVersion).toBe('V4');
  });

  it('keeps the path-revealing inspector out of the public API', () => {
    expect(Object.keys(publicApi)).not.toContain('inspectV4Ride');
    expect(Object.keys(publicApi)).toContain('createV4Ride');
  });
});

describe('WAVES payout space keeps the V3 final mapping', () => {
  it('band ends and every mapped ride value equal calculateFinalBoost (6 dp)', () => {
    const tickets: Array<{ qualifyingSelections: number; combinedOdds: number; ticketStrength: number }> = [];
    for (const name of Object.keys(TICKETS) as TicketName[]) {
      tickets.push({ ...TICKETS[name], ticketStrength: labConfig(name).ticketStrength });
    }
    for (let s = 3; s <= 9; s++) for (const odds of [3, 5.5, 12, 40, 200]) {
      for (const ticketStrength of [0, 0.1, 0.33, 0.6, 1]) tickets.push({ qualifyingSelections: s, combinedOdds: odds, ticketStrength });
    }
    const mismatches: string[] = [];
    for (const t of tickets) {
      const v3 = (rideValue: number) => calculateFinalBoost({
        rideValue, ticketStrength: t.ticketStrength, qualifyingSelections: t.qualifyingSelections,
        combinedOdds: t.combinedOdds, hasRideEnded: false, config: PROFILE,
      });
      const model = computeBoostModelDetails(t.qualifyingSelections, t.combinedOdds, PROFILE);
      const config = { ...labConfig('medium'), effectiveMin: model.effectiveMinBoost, effectiveMax: model.effectiveMaxBoost, ticketStrength: t.ticketStrength };
      const band = payoutBand(config);
      if (round6(band.min) !== v3(PROFILE.minBoostPct) || round6(band.max) !== v3(PROFILE.maxBoostPct)) mismatches.push(`band ${JSON.stringify(t)}`);
      for (let k = 0; k <= 40; k++) {
        const rideValue = PROFILE.minBoostPct + (k / 40) * (PROFILE.maxBoostPct - PROFILE.minBoostPct);
        if (round6(wavesFinalMapping(rideValue, config)) !== v3(rideValue)) mismatches.push(`map ${rideValue} ${JSON.stringify(t)}`);
      }
    }
    expect(mismatches).toEqual([]);
  });

  it('equals the V3 affine map exactly where V3 never clamps (band = image of the profile range)', () => {
    let worst = 0;
    for (const ticketStrength of [0, 0.25, 0.5, 0.75, 1]) {
      for (const [lo, hi] of [[0.05, 1], [0.1, 0.4], [0, 2]]) {
        const config = { ...labConfig('medium'), minBoostPct: lo, maxBoostPct: hi, effectiveMin: -5, effectiveMax: 6, ticketStrength };
        const band = payoutBand(config);
        expect(band.bend).toBe(0);
        for (let k = 0; k <= 50; k++) {
          const v3Raw = wavesFinalMapping(lo + (k / 50) * (hi - lo), config);
          worst = Math.max(worst, Math.abs(levelToPayout(k / 50, band) - v3Raw));
        }
      }
    }
    expect(worst).toBeLessThan(1e-12);
  });
});

describe('WAVES payout calibration (V3-cost parity, owner decision 2026-10-30)', () => {
  it('bends by the share V3 pins to the floor: weak barely, medium ~1, strong ~3.9', () => {
    const expected = { weak: [0.1345, 0.09], medium: [0.3485, 1.06], strong: [0.5068, 3.91] } as const;
    for (const name of Object.keys(expected) as TicketName[]) {
      const config = labConfig(name);
      expect(floorPinnedShare(config)).toBeCloseTo(expected[name][0], 3);
      expect(payoutBend(config)).toBeCloseTo(expected[name][1], 2);
      expect(payoutBand(config).bend).toBe(payoutBend(config));
    }
  });

  it('keeps the band ends, is strictly increasing with slope >= 1 / (1 + bend), and is the identity at bend 0', () => {
    for (const bend of [0, 0.09, 1, 2.5, PAYOUT_CALIBRATION.MAX_BEND]) {
      expect(bendLevel(0, bend)).toBe(0);
      expect(bendLevel(1, bend)).toBe(1);
      let previous = 0;
      for (let k = 1; k <= 1000; k++) {
        const u = k / 1000;
        const g = bendLevel(u, bend);
        if (bend === 0) expect(g).toBe(u);
        expect(g).toBeLessThanOrEqual(u);
        expect((g - previous) * 1000).toBeGreaterThanOrEqual(1 / (1 + bend) - 1e-9);
        previous = g;
      }
    }
  });

  it('caps the bend (no-flat guard) and handles degenerate ranges', () => {
    const base = labConfig('medium');
    // V3 pins (almost) the whole range to the floor.
    expect(payoutBend({ ...base, effectiveMin: 0.69, effectiveMax: 0.7 })).toBe(PAYOUT_CALIBRATION.MAX_BEND);
    expect(payoutBend({ ...base, effectiveMin: 5, effectiveMax: 6 })).toBe(PAYOUT_CALIBRATION.MAX_BEND);
    expect(floorPinnedShare({ ...base, effectiveMin: 5, effectiveMax: 6 })).toBe(1);
    // Empty profile range: nothing to bend.
    expect(payoutBend({ ...base, minBoostPct: 0.2, maxBoostPct: 0.2 })).toBe(0);
  });

  it('keeps ticket order: at every level weak < medium < strong', () => {
    const bands = (['weak', 'medium', 'strong'] as TicketName[]).map((name) => payoutBand(labConfig(name)));
    for (let k = 0; k <= 100; k++) {
      const pays = bands.map((band) => levelToPayout(k / 100, band));
      expect(pays[0]).toBeLessThan(pays[1]);
      expect(pays[1]).toBeLessThan(pays[2]);
    }
  });
});

describe('WAVES structure (by construction)', () => {
  it('alternates strictly between valleys and peaks with minimum segment durations, at most 4 peaks', () => {
    for (let i = 0; i < 3000; i++) {
      const { ride, skeleton, draws } = inspectV4Ride(sampleSeed('v4-structure', i), labConfig('strong'));
      const sk = skeleton!;
      const D = ride.params.durationSeconds;
      expect(sk.kinds[0]).toBe('start');
      expect(sk.times[0]).toBe(0);
      expect(sk.times[sk.times.length - 1]).toBeGreaterThanOrEqual(D);
      for (let k = 1; k < sk.times.length; k++) {
        const duration = sk.times[k] - sk.times[k - 1];
        expect(duration).toBeGreaterThanOrEqual(WAVES_SHAPE.MIN_FALL_SECONDS - 1e-9);
        if (sk.kinds[k] === 'peak') {
          expect(sk.levels[k]).toBeGreaterThan(sk.levels[k - 1] + 0.149);
          expect(sk.kinds[k - 1]).not.toBe('peak');
        } else {
          expect(sk.kinds[k]).toBe('valley');
          expect(sk.levels[k]).toBeLessThan(sk.levels[k - 1] - 0.149);
          expect(sk.kinds[k - 1]).toBe('peak');
        }
      }
      // First peak at >= 2 s, except DOWN crashes within 0.1 s of 2 s (peak at most 0.1 s earlier).
      const firstPeak = sk.times[1];
      if (firstPeak < 2) {
        expect(draws.phase).toBe('DOWN');
        expect(firstPeak).toBeGreaterThanOrEqual(draws.anchorSeconds - WAVES_SHAPE.MIN_FALL_SECONDS / 4 - 1e-9);
      }
      expect(sk.peakCount).toBeLessThanOrEqual(WAVES_SHAPE.MAX_PEAKS);
      expect(sk.peakCount).toBe(sk.times.filter((t, k) => sk.kinds[k] === 'peak' && t <= D).length);
      // The highest peak is the ride maximum (and the LINEAR cap), exactly.
      expect(Math.max(...sk.levels)).toBe(sk.highest);
      expect(round6(levelToPayout(levelAt(sk, sk.highestPeakSeconds), payoutBand(labConfig('strong'))))).toBe(ride.params.rideMaximum);
      if (sk.peakCount > 0) {
        expect(sk.highestPeakSeconds).toBeLessThanOrEqual(D);
        expect(ride.uncrashedBoostAt(sk.highestPeakSeconds)).toBe(ride.params.rideMaximum);
      }
    }
  });

  it('handles edge configs without throwing', () => {
    const base = labConfig('medium');
    const flat = { ...base, minBoostPct: 0.2, maxBoostPct: 0.2, effectiveMin: 0.2, effectiveMax: 0.2 };
    const flatRide = createV4Ride(SEED, flat);
    expect(flatRide.params.bandMin).toBe(0.2);
    expect(flatRide.params.rideMaximum).toBe(0.2);
    expect(flatRide.boostAt(1)).toBe(0.2);
    const extras: Array<Partial<V4RideConfig>> = [
      { minCrashSeconds: 0 }, { ticketStrength: 0 }, { ticketStrength: 1 }, { maxDurationSeconds: 60 }, { minDurationSeconds: 15 },
    ];
    for (const extra of extras) {
      const config = { ...base, ...extra };
      for (let i = 0; i < 100; i++) {
        const { ride, skeleton } = inspectV4Ride(sampleSeed('v4-edge-2', i), config);
        expect(skeleton!.peakCount).toBeLessThanOrEqual(4);
        const terminal = ride.params.crashAtSeconds ?? ride.params.durationSeconds;
        expect(ride.boostAt(terminal / 2)).toBeGreaterThan(0);
        if (ride.params.crashAtSeconds !== null) {
          expect(ride.params.crashAtSeconds).toBeGreaterThanOrEqual(config.minCrashSeconds);
          expect(ride.params.crashAtSeconds).toBeLessThan(ride.params.durationSeconds);
        }
      }
    }
  });
});

describe('LINEAR V4', () => {
  it('climbs on a ticket-wide clock from effectiveMin, stops at the cap, and is 0 at/after the end', () => {
    for (const pace of ['FAST', 'MEDIUM', 'SLOW'] as const) {
      for (let i = 0; i < 100; i++) {
        const config = labConfig(i % 2 ? 'weak' : 'strong', 'LINEAR', pace);
        const ride = createV4Ride(sampleSeed('v4-linear', i), config);
        const p = ride.params;
        const terminal = p.crashAtSeconds ?? p.durationSeconds;
        expect(p.linearStart).toBe(round6(config.effectiveMin));
        expect(p.linearCap).toBeLessThan(p.bandMax);
        expect(ride.boostAt(0)).toBe(p.linearStart);
        let previous = -1;
        let bad = 0;
        for (let t = 0; t < terminal; t += 0.05) {
          const v = ride.boostAt(t);
          if (v !== linearBoostAt(t, p.linearStart, p.bandMax, p.linearCap, pace) || v < previous || v > p.linearCap) bad++;
          previous = v;
        }
        expect(bad).toBe(0);
        // The cap is reached before the pace time (the band top would be reached at it).
        if (LINEAR_PACE_SECONDS[pace] < terminal) expect(ride.boostAt(LINEAR_PACE_SECONDS[pace] - 1e-9)).toBe(p.linearCap);
      }
    }
    expect(LINEAR_PACE_SECONDS).toEqual({ FAST: 6, MEDIUM: 9, SLOW: 12 });
    expect(linearBoostAt(4.5, 0.1, 0.5, 0.45, 'MEDIUM')).toBe(round6(0.1 + 0.4 * (0.4 * 0.5 + 0.6 * 0.25)));
    expect(linearBoostAt(8, 0.1, 0.5, 0.45, 'MEDIUM')).toBe(round6(0.1 + 0.4 * linearG(8 / 9)));
    expect(linearBoostAt(8.8, 0.1, 0.5, 0.45, 'MEDIUM')).toBe(0.45);
    expect(linearBoostAt(-1, 0.1, 0.5, 0.45, 'FAST')).toBe(0.1);
    expect(linearBoostAt(20, 0.1, 0.5, 0.45, 'SLOW')).toBe(0.45);
  });

  it('reveals nothing about the cap before reaching it: rides with different caps quote identically', () => {
    for (const pace of ['FAST', 'MEDIUM', 'SLOW'] as const) {
      const config = labConfig('medium', 'LINEAR', pace);
      const rides = Array.from({ length: 200 }, (_, i) => createV4Ride(sampleSeed('v4-linear-caps', i), config));
      const caps = new Set(rides.map((r) => r.params.linearCap));
      expect(caps.size).toBeGreaterThan(150);
      const lowestCap = Math.min(...caps);
      let differing = 0;
      let compared = 0;
      for (let t = 0; t < LINEAR_PACE_SECONDS[pace]; t += 0.01) {
        const quotes = rides
          .filter((r) => t < (r.params.crashAtSeconds ?? r.params.durationSeconds))
          .map((r) => r.boostAt(t))
          .filter((v) => v < lowestCap);
        compared += quotes.length;
        if (new Set(quotes).size > 1) differing++;
      }
      expect(compared).toBeGreaterThan(10_000);
      expect(differing).toBe(0);
      // Two specific rides: identical until the lower cap, then each stops at its own cap.
      const [a, b] = [...rides].filter((r) => r.params.outcome === 'ENDED' || r.params.crashAtSeconds! > 5)
        .sort((x, y) => x.params.linearCap - y.params.linearCap).filter((_, i, all) => i === 0 || i === all.length - 1);
      for (let t = 0; t < 2; t += 0.1) expect(a.boostAt(t)).toBe(b.boostAt(t));
      expect(a.params.linearCap).toBeLessThan(b.params.linearCap);
    }
  });

  it('has no WAVES skeleton', () => {
    expect(inspectV4Ride(SEED, labConfig('medium', 'LINEAR')).skeleton).toBeNull();
  });
});
