import {
  crashBucket,
  findPeaks,
  firstMaxTime,
  isTell,
  longestFlatSeconds,
  observedPhase,
  prop,
  summarize,
  type RideRecord,
} from '../../tools/ride-lab/metrics';
import { evaluatePolicies, lockValue, policyStats } from '../../tools/ride-lab/policies';
import { seedAt, uniformAt } from '../../tools/ride-lab/seeds';

const STEP = 0.1;

function rec(values: number[], over: Partial<RideRecord> = {}): RideRecord {
  return {
    durationSeconds: values.length * STEP + 2,
    outcome: 'CRASHED',
    terminalAtSeconds: values.length * STEP,
    effectiveMin: 0,
    effectiveMax: 1,
    stepSeconds: STEP,
    values,
    ...over,
  };
}

describe('ride lab metrics on synthetic rides', () => {
  it('computes Wilson intervals that bracket the share', () => {
    const p = prop(8, 100);
    expect(p.p).toBeCloseTo(0.08);
    expect(p.lo).toBeLessThan(0.08);
    expect(p.hi).toBeGreaterThan(0.08);
    expect(prop(0, 0).p).toBeNaN();
  });

  it('buckets crash time at 25% and 80% of duration', () => {
    expect(crashBucket({ terminalAtSeconds: 2, durationSeconds: 10 })).toBe('EARLY');
    expect(crashBucket({ terminalAtSeconds: 2.5, durationSeconds: 10 })).toBe('MID');
    expect(crashBucket({ terminalAtSeconds: 7.9, durationSeconds: 10 })).toBe('MID');
    expect(crashBucket({ terminalAtSeconds: 8, durationSeconds: 10 })).toBe('LATE');
  });

  it('counts two clear peaks and ignores a dip below 5% prominence', () => {
    const v = [0, 0.4, 0.8, 0.4, 0.1, 0.5, 0.9, 0.5, 0.2];
    expect(findPeaks(v, STEP, 1)).toHaveLength(2);
    const small = [0, 0.5, 0.52, 0.5, 0.51, 0.3, 0.1];
    expect(findPeaks(small, STEP, 1).map((p) => p.index)).toEqual([2]);
    expect(findPeaks([0, 0.5, 1], STEP, 1)).toHaveLength(0); // ends at its top: no right side
    expect(findPeaks([1, 1, 1], STEP, 0)).toHaveLength(0);
  });

  it('measures half-prominence width of a spike', () => {
    const v = [0.1, 0.1, 0.9, 0.1, 0.1];
    const [peak] = findPeaks(v, STEP, 1);
    expect(peak.prominence).toBeCloseTo(0.8);
    expect(peak.widthSeconds).toBeCloseTo(STEP);
  });

  it('finds the longest flat run within 0.1 pp', () => {
    const v = [0.1, 0.5, 0.5, 0.5004, 0.5, 0.7, 0.7];
    expect(longestFlatSeconds(v, STEP)).toBeCloseTo(4 * STEP);
    expect(longestFlatSeconds([], STEP)).toBe(0);
    expect(longestFlatSeconds([0, 1, 2], STEP)).toBeCloseTo(STEP);
  });

  it('flags a maximum first reached in the last 800 ms', () => {
    const late = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0];
    expect(firstMaxTime(late, STEP)).toBeCloseTo(0.9);
    expect(isTell(1.0, late, STEP)).toBe(true);
    const early = [0.1, 1.0, 0.8, 0.7, 0.6, 0.5, 0.4, 0.3, 0.2, 0.1, 0.1, 0.1, 0.1];
    expect(isTell(1.3, early, STEP)).toBe(false);
  });

  it('classifies the last 300 ms as UP, DOWN or PEAK', () => {
    const rise = Array.from({ length: 20 }, (_, i) => i / 20);
    expect(observedPhase(rec(rise))).toBe('UP');
    expect(observedPhase(rec([...rise].reverse()))).toBe('DOWN');
    expect(observedPhase(rec(new Array(20).fill(0.5)))).toBe('PEAK');
    expect(observedPhase(rec(rise, { effectiveMax: 0 }))).toBe('PEAK');
  });

  it('summarizes a hand-built set, including thirds and an F8 baseline', () => {
    const recs: RideRecord[] = [];
    for (let i = 0; i < 30; i++) {
      const values = Array.from({ length: 30 }, (_, k) => (k < 15 ? k / 15 : (30 - k) / 15));
      recs.push(rec(values, {
        durationSeconds: 3 + (i % 3) * 5,
        terminalAtSeconds: 3,
        outcome: i % 10 === 9 ? 'ENDED' : 'CRASHED',
        reportedCrashPhase: 'DOWN',
        uncrashedBoostAt: (t) => Math.max(0, 1 - Math.abs(t - 1.5) / 1.5),
      }));
    }
    let c = 0;
    const s = summarize(recs, () => ((c = (c * 7 + 3) % 10) / 10));
    expect(s.n).toBe(30);
    expect(s.noCrash.k).toBe(3);
    expect(s.thirds).toHaveLength(3);
    expect(s.peaks.histogram['1']).toBe(30);
    expect(s.f8.baseline).not.toBeNull();
    expect(s.f8.gapPp).not.toBeNull();
    expect(s.reportedPhase.shares.DOWN.k).toBe(27);
  });

  it('skips the F8 baseline when the engine has no crash-free curve', () => {
    const s = summarize([rec([0, 1, 0.5]), rec([0, 1, 0.5])], Math.random);
    expect(s.f8.baseline).toBeNull();
    expect(s.f8.gapPp).toBeNull();
  });
});

describe('ride lab policies on synthetic rides', () => {
  const ride = rec([0.1, 0.3, 0.6, 0.9, 0.5], { effectiveMax: 1, durationSeconds: 1 });

  it('evaluates each lock policy', () => {
    expect(lockValue('hindsight', ride, 0)).toBe(0.9);
    expect(lockValue('uniform-terminal', ride, 0.5)).toBe(0.6);
    expect(lockValue('uniform-terminal', ride, 0.999)).toBe(0.5);
    expect(lockValue('uniform-duration', ride, 0.05)).toBe(0.1);
    expect(lockValue('uniform-duration', ride, 0.9)).toBe(0); // crashed at 0.5 s
    expect(lockValue('reach-50', ride, 0)).toBe(0.6);
    expect(lockValue('reach-90', ride, 0)).toBe(0.9);
    expect(lockValue('reach-90', rec([0.1, 0.5]), 0)).toBe(0);
    expect(lockValue('ceil-50', ride, 0, 0.4)).toBe(0.3);
    expect(lockValue('hindsight', rec([]), 0)).toBe(0);
  });

  it('reports mean, percentiles and zero share', () => {
    const s = policyStats([0, 0, 0.2, 0.4, 1]);
    expect(s.mean).toBeCloseTo(0.32);
    expect(s.p50).toBe(0.2);
    expect(s.p99).toBe(1);
    expect(s.zeroShare).toBeCloseTo(0.4);
    expect(policyStats([]).mean).toBeNaN();
  });

  it('evaluates all policies over a set', () => {
    const out = evaluatePolicies([ride, ride], [0.1, 0.9]);
    expect(out.hindsight.mean).toBeCloseTo(0.9);
    expect(out['uniform-duration'].zeroShare).toBeCloseTo(0.5);
  });
});

describe('ride lab seeds', () => {
  it('are reproducible 64-hex strings that differ by base and counter', () => {
    const a = seedAt('base', 'ride', 0);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(seedAt('base', 'ride', 0)).toBe(a);
    expect(seedAt('base', 'ride', 1)).not.toBe(a);
    expect(seedAt('other', 'ride', 0)).not.toBe(a);
    const u = uniformAt('base', 'lock', 3);
    expect(u).toBeGreaterThanOrEqual(0);
    expect(u).toBeLessThan(1);
  });
});
