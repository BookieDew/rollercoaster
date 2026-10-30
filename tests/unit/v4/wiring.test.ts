import { createHash } from 'crypto';
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import {
  createV4Ride,
  exactFromNumber,
  exactRatio,
  lnExact,
  meetsExactTarget,
  seedCommitment,
  toDecimalString,
  toDisplayNumber,
  v4RideDurationSeconds,
  combinedOddsExact,
} from '../../../src/computations/v4';
import { computeBoostModelDetails, computeTicketStrength } from '../../../src/computations';
import { inspectV4Ride } from '../../../src/computations/v4/ride';
import { levelAt } from '../../../src/computations/v4/waves';
import { levelToPayout, payoutBand, round6 } from '../../../src/computations/v4/payout';
import { PROFILE, labConfig, sampleSeed } from './helpers';

/** Slice 1b-iii-a: the V4 API the live paths use. */
describe('V4 wiring helpers', () => {
  it('keeps the path-revealing inspector out of every service, controller and route', () => {
    const roots = ['services', 'controllers', 'routes', 'middleware'].map((d) => join(__dirname, '../../../src', d));
    for (const root of roots) {
      for (const file of readdirSync(root)) {
        expect(readFileSync(join(root, file), 'utf8')).not.toMatch(/inspectV4Ride|v4\/ride'|v4\/waves'/);
      }
    }
  });

  it('v4RideDurationSeconds equals the ride duration of createV4Ride', () => {
    for (let i = 0; i < 50; i += 1) {
      const seed = sampleSeed('wiring-duration', i);
      const cfg = labConfig('medium', i % 2 ? 'LINEAR' : 'WAVES');
      expect(v4RideDurationSeconds(seed, cfg)).toBe(createV4Ride(seed, cfg).params.durationSeconds);
    }
    expect(() => v4RideDurationSeconds(sampleSeed('x', 0), { minDurationSeconds: 0, maxDurationSeconds: 5 })).toThrow('limits');
    expect(() => v4RideDurationSeconds(sampleSeed('x', 0), { minDurationSeconds: 5, maxDurationSeconds: 4 })).toThrow('limits');
    expect(() => v4RideDurationSeconds('short', { minDurationSeconds: 2, maxDurationSeconds: 4 })).toThrow('64 hexadecimal');
  });

  it('seedCommitment is the SHA-256 of the seed bytes and never echoes the seed', () => {
    const seed = sampleSeed('wiring-commit', 1);
    const commitment = seedCommitment(seed);
    expect(commitment).toBe(createHash('sha256').update(Buffer.from(seed, 'hex')).digest('hex'));
    expect(commitment).toMatch(/^[0-9a-f]{64}$/);
    expect(commitment).not.toBe(seed);
    expect(seedCommitment(seed.toUpperCase())).toBe(commitment);
    expect(() => seedCommitment('nope')).toThrow('64 hexadecimal');
  });

  it.each(['WAVES', 'LINEAR'] as const)('%s: maximumBefore is the exact maximum of the uncrashed curve so far', (mode) => {
    for (let i = 0; i < 40; i += 1) {
      const seed = sampleSeed(`wiring-max-${mode}`, i);
      const cfg = labConfig(i % 3 === 0 ? 'weak' : i % 3 === 1 ? 'medium' : 'strong', mode);
      const ride = createV4Ride(seed, cfg);
      const p = ride.params;
      const terminal = p.crashAtSeconds ?? p.durationSeconds;
      let sampled = 0;
      for (let t = 0; t < terminal; t += 0.005) {
        const value = ride.uncrashedBoostAt(t);
        sampled = Math.max(sampled, value);
        // Never below anything already seen.
        expect(ride.maximumBefore(t)).toBeGreaterThanOrEqual(sampled);
      }
      const max = ride.maximumBefore(terminal);
      expect(max).toBeGreaterThanOrEqual(sampled);
      // Sampling at 5 ms gets within a hair of it, and it never exceeds the ride maximum.
      expect(max - sampled).toBeLessThan(0.002);
      expect(max).toBeLessThanOrEqual(p.rideMaximum);
      expect(ride.maximumBefore(p.durationSeconds + 100)).toBe(ride.maximumBefore(p.durationSeconds));
      expect(ride.maximumBefore(-1)).toBe(ride.maximumBefore(0));
    }
    expect(() => createV4Ride(sampleSeed('w', 0), labConfig('medium', mode)).maximumBefore(NaN)).toThrow('finite');
  });

  it('WAVES maximumBefore matches the knot maximum of the inspected path', () => {
    for (let i = 0; i < 30; i += 1) {
      const seed = sampleSeed('wiring-knots', i);
      const cfg = labConfig('strong');
      const { ride, skeleton } = inspectV4Ride(seed, cfg);
      const band = payoutBand(cfg);
      const terminal = ride.params.crashAtSeconds ?? ride.params.durationSeconds;
      let best = levelAt(skeleton!, terminal);
      skeleton!.times.forEach((t, k) => { if (t <= terminal) best = Math.max(best, skeleton!.levels[k]); });
      expect(ride.maximumBefore(terminal)).toBe(round6(levelToPayout(best, band)));
    }
  });

  it('reads profile targets exactly and keeps ratios and logs finite beyond the double range', () => {
    expect(toDecimalString(exactFromNumber(3))).toBe('3');
    expect(toDecimalString(exactFromNumber(1.45475))).toBe('1.45475');
    expect(toDecimalString(exactFromNumber(3.1234567))).toBe('3.1234567');
    expect(toDecimalString(exactFromNumber(1e21))).toBe('1' + '0'.repeat(21));
    expect(toDecimalString(exactFromNumber(1.5e-7))).toBe('0.00000015');
    expect(toDecimalString(exactFromNumber(0))).toBe('0');
    for (const bad of [-1, NaN, Infinity]) expect(() => exactFromNumber(bad)).toThrow();

    const huge = combinedOddsExact(Array.from({ length: 100 }, () => 10000));
    expect(toDisplayNumber(huge)).toBe('1' + '0'.repeat(400));
    expect(toDisplayNumber(combinedOddsExact([1.5, 2]))).toBe(3);
    expect(meetsExactTarget(huge, exactFromNumber(1e300))).toBe(true);
    expect(exactRatio(huge, exactFromNumber(50))).toBe(1);
    expect(exactRatio(combinedOddsExact([10]), exactFromNumber(50))).toBe(0.2);
    expect(() => exactRatio(huge, exactFromNumber(0))).toThrow('positive');
    expect(lnExact(huge)).toBeCloseTo(400 * Math.LN10, 9);
    expect(lnExact(combinedOddsExact([2.5]))).toBe(Math.log(2.5));
    expect(() => lnExact(combinedOddsExact([]))).toThrow('positive');
  });

  it('ticket strength and the boost model take the exact product and never become Infinity or NaN', () => {
    const exactSmall = combinedOddsExact([2, 2.5, 3]);
    expect(computeTicketStrength(3, exactSmall, { minSelections: 3 })).toBe(computeTicketStrength(3, 15, { minSelections: 3 }));
    expect(computeBoostModelDetails(3, exactSmall, PROFILE)).toEqual(computeBoostModelDetails(3, 15, PROFILE));

    const huge = combinedOddsExact(Array.from({ length: 100 }, () => 10000));
    expect(computeTicketStrength(100, huge, { minSelections: 3 })).toBe(1);
    expect(computeTicketStrength(100, combinedOddsExact([]), { minSelections: 3 })).toBe(0);
    expect(computeTicketStrength(3, combinedOddsExact([1, 1, 1]), { minSelections: 3 })).toBe(0);
    const model = computeBoostModelDetails(100, huge, PROFILE);
    expect(model.oddsRatio).toBe(1);
    for (const value of Object.values(model)) {
      if (typeof value === 'number') expect(Number.isFinite(value)).toBe(true);
    }
    // The float path would have produced Infinity odds; the exact path keeps every ratio finite.
    expect(Number.isFinite(10000 ** 100)).toBe(false);
  });
});
