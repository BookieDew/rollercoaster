import { CRASH_BUCKETS, WAVES_SHAPE, type V4CrashPhase } from '../../../src/computations/v4';
import { inspectV4Ride } from '../../../src/computations/v4/ride';
import type { WavesSkeleton } from '../../../src/computations/v4/waves';
import {
  HORN_MAX_WIDTH_SECONDS,
  HORN_PROMINENCE_FRACTION,
  GRID_EPS,
  findPeaks,
  gridValues,
  type PeakInfo,
  isTell,
  longestFlatSeconds,
} from '../../../tools/ride-lab/metrics';
import {
  DURATION_THIRDS,
  expectProportion,
  labConfig,
  sampleSeed,
  sampleUniform,
  thirdOf,
  type TicketName,
} from './helpers';

/**
 * Distribution checks with 99.9 % two-sided binomial bounds (contract §2, spec criterion 6).
 * Outcome sample: 63,000 seeds (>= 20,000 per duration third). Shape sample: 21,000 WAVES seeds
 * (medium ticket) plus 2,000 each for weak and strong (plateau, horn and band checks). Measures use the ride-lab definitions.
 */
const OUTCOME_N = 63_000;
const SHAPE_N = 21_000;
const SIDE_N = 2_000;
const STEP = 0.05;
const BUCKET_P = { EARLY: 0.1, MID: 0.65, LATE: 0.25 } as const;
const PHASE_P = { UP: 0.5, PEAK: 0.2, DOWN: 0.3 } as const;
/** |tell - baseline| measured on this medium sample (+1.51 / +2.38 pp, rounded up); asserted with a 99.9 % margin. */
const F8_MEASURED_ABS_GAP = { sameLaw: 0.016, pooled: 0.024 };

interface OutcomeRow {
  third: number;
  duration: number;
  crashAt: number | null;
  bucket: string | null;
  phase: V4CrashPhase;
  cap: number;
}

const outcome: OutcomeRow[] = [];

beforeAll(() => {
  // LINEAR rides build no shape; their outcome draws are the WAVES draws (asserted in ride.test).
  for (let i = 0; i < OUTCOME_N; i++) {
    const { ride, draws } = inspectV4Ride(sampleSeed('v4-dist-outcome', i), labConfig('medium', 'LINEAR'));
    const p = ride.params;
    outcome.push({
      third: thirdOf(p.durationSeconds), duration: p.durationSeconds, crashAt: p.crashAtSeconds,
      bucket: p.crashBucket, phase: draws.phase, cap: p.linearCap,
    });
  }
}, 120_000);

describe('V4 outcome draws: identical mix in every duration third (F3)', () => {
  const groups = () => [
    { label: 'all', rows: outcome },
    ...DURATION_THIRDS.map((t, i) => ({ label: t.label, rows: outcome.filter((r) => r.third === i) })),
  ];

  it('durations are uniform: each third holds a third of the seeds, at least 20,000', () => {
    for (let i = 0; i < 3; i++) {
      const n = outcome.filter((r) => r.third === i).length;
      expect(n).toBeGreaterThanOrEqual(20_000);
      expectProportion(n, OUTCOME_N, 1 / 3, `third ${i}`);
    }
  });

  it('no-crash is 8 %', () => {
    for (const g of groups()) expectProportion(g.rows.filter((r) => r.crashAt === null).length, g.rows.length, 0.08, `no-crash ${g.label}`);
  });

  it('crash buckets are 10/65/25 of the crash window, and every crash lies in its bucket', () => {
    for (const g of groups()) {
      const crashed = g.rows.filter((r) => r.crashAt !== null);
      for (const [bucket, p] of Object.entries(BUCKET_P)) {
        expectProportion(crashed.filter((r) => r.bucket === bucket).length, crashed.length, p, `${bucket} ${g.label}`);
      }
    }
    let outside = 0;
    for (const r of outcome) {
      if (r.crashAt === null) continue;
      const position = (r.crashAt - 2) / (r.duration - 2);
      const b = CRASH_BUCKETS.find((x) => x.bucket === r.bucket)!;
      if (!(position >= b.from - 1e-12 && position < b.to + 1e-12) || r.crashAt < 2 || r.crashAt >= r.duration) outside++;
    }
    expect(outside).toBe(0);
  });

  it('crash phases are 50/20/30', () => {
    for (const g of groups()) {
      const crashed = g.rows.filter((r) => r.crashAt !== null);
      for (const [phase, p] of Object.entries(PHASE_P)) {
        expectProportion(crashed.filter((r) => r.phase === phase).length, crashed.length, p, `${phase} ${g.label}`);
      }
    }
  });

  it('documents the bucket-basis conflict: no crash before 25 % of a ride shorter than 8 s is possible', () => {
    // With a 2 s minimum crash, "EARLY = before 25 % of the duration" needs a duration above 8 s,
    // so a duration-relative 10 % EARLY share cannot hold in the first duration third.
    const shortCrashed = outcome.filter((r) => r.crashAt !== null && r.duration < 8);
    expect(shortCrashed.length).toBeGreaterThan(10_000);
    expect(shortCrashed.filter((r) => r.crashAt! / r.duration < 0.25)).toHaveLength(0);
  });

  it('LINEAR cap (same-seed WAVES maximum) is independent of crash time and duration', () => {
    const crashed = outcome.filter((r) => r.crashAt !== null);
    const n = crashed.length;
    const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    const caps = crashed.map((r) => r.cap);
    const times = crashed.map((r) => r.crashAt!);
    const mc = mean(caps);
    const mt = mean(times);
    let sxy = 0;
    let sxx = 0;
    let syy = 0;
    for (let i = 0; i < n; i++) {
      sxy += (caps[i] - mc) * (times[i] - mt);
      sxx += (caps[i] - mc) ** 2;
      syy += (times[i] - mt) ** 2;
    }
    expect(Math.abs(sxy / Math.sqrt(sxx * syy))).toBeLessThan(3.2905 / Math.sqrt(n));
    const sd = Math.sqrt(sxx / (n - 1));
    const groupsToCheck = [
      ...Object.keys(BUCKET_P).map((b) => crashed.filter((r) => r.bucket === b)),
      ...[0, 1, 2].map((i) => crashed.filter((r) => r.third === i)),
    ];
    for (const g of groupsToCheck) {
      const bound = 3.2905 * sd * Math.sqrt(1 / g.length - 1 / n);
      expect(Math.abs(mean(g.map((r) => r.cap)) - mc)).toBeLessThan(bound);
    }
  });
});

interface ShapeRow {
  duration: number;
  crashed: boolean;
  phaseOk: boolean;
  reportedMatchesDraw: boolean;
  phase: V4CrashPhase | null;
  skeletonPeaks: number;
  preCrashPeaks: number;
  fullPeaks: number;
  longestFlat: number;
  horns: number;
  edgeHorns: number;
  valuesOk: boolean;
  tell: boolean;
  sameLawTell: boolean;
  pooledTell: boolean;
}

/** The anchor lies in the drawn zone of its wave: UP rising before the top, PEAK in the top zone, DOWN falling after it. */
function phaseHolds(sk: WavesSkeleton, anchor: number, phase: V4CrashPhase): boolean {
  const a = sk.anchor;
  const i = sk.times.findIndex((t, k) => k + 1 < sk.times.length && t <= anchor && anchor < sk.times[k + 1]);
  if (i < 0) return false;
  const rising = sk.levels[i + 1] > sk.levels[i];
  const top = anchor >= a.peakSeconds - a.topBeforeSeconds && anchor < a.peakSeconds + a.topAfterSeconds;
  if (phase === 'UP') return rising && sk.times[i + 1] === a.peakSeconds && !top;
  if (phase === 'DOWN') return !rising && sk.times[i] === a.peakSeconds && !top && anchor < a.fallEndSeconds;
  return top && (sk.times[i] === a.peakSeconds || sk.times[i + 1] === a.peakSeconds);
}

/**
 * Ride-lab horn proxy (prominence >= 15 % of the range, half-height width <= 0.3 s), skipping peaks
 * whose fall is cut off by the end of the ride: there the path edge, not the shape, narrows the peak.
 */
function hornCount(peaks: PeakInfo[], range: number, sk: WavesSkeleton, duration: number): number {
  return peaks.filter((p) => {
    if (p.prominence < HORN_PROMINENCE_FRACTION * range || p.widthSeconds > HORN_MAX_WIDTH_SECONDS) return false;
    // The skeleton peak this grid peak belongs to (nearest peak knot; the grid point can sit just before it),
    // and the end of its fall. Before calibration the first knot after the grid point was used, which is the
    // peak knot itself when the grid point precedes it, so a fall cut by the end was miscounted as a horn.
    let peakKnot = -1;
    sk.times.forEach((t, k) => {
      if (sk.kinds[k] === 'peak' && (peakKnot < 0 || Math.abs(t - p.index * STEP) < Math.abs(sk.times[peakKnot] - p.index * STEP))) peakKnot = k;
    });
    const fallEnd = sk.times[peakKnot + 1];
    return fallEnd !== undefined && fallEnd <= duration;
  }).length;
}

/** Crash time redrawn from the engine's own law (bucket mix and uniform position), independent of the curve. */
function sameLawCrash(duration: number, i: number): number {
  const roll = sampleUniform('v4-f8-bucket', i);
  const b = CRASH_BUCKETS.find((x) => roll < x.upTo)!;
  return 2 + (b.from + sampleUniform('v4-f8-position', i) * (b.to - b.from)) * (duration - 2);
}

/** Grid values strictly before t (the same points gridValues would produce for terminal t). */
function before(full: number[], t: number): number[] {
  let k = 0;
  while (k < full.length && k * STEP < t - GRID_EPS) k++;
  return full.slice(0, k);
}

/**
 * One 50 ms grid of the uncrashed curve per ride; the pre-crash path and both F8 baselines are
 * prefixes of it (boostAt equals uncrashedBoostAt before the crash), so nothing is sampled twice.
 */
function shapeSample(ticket: TicketName, n: number, withPooledBaseline: boolean): ShapeRow[] {
  const config = labConfig(ticket);
  const range = config.effectiveMax - config.effectiveMin;
  const rows: ShapeRow[] = [];
  const crashedRides: { full: number[]; duration: number; fraction: number; row: ShapeRow }[] = [];
  for (let i = 0; i < n; i++) {
    const { ride, skeleton, draws } = inspectV4Ride(sampleSeed(`v4-dist-shape-${ticket}`, i), config);
    const p = ride.params;
    const sk = skeleton!;
    const crashed = p.crashAtSeconds !== null;
    const full = gridValues(ride.uncrashedBoostAt, p.durationSeconds, STEP);
    const values = crashed ? before(full, p.crashAtSeconds!) : full;
    const peaks = findPeaks(full, STEP, range);
    const horns = hornCount(peaks, range, sk, p.durationSeconds);
    const redrawn = sameLawCrash(p.durationSeconds, i);
    const row: ShapeRow = {
      duration: p.durationSeconds,
      crashed,
      phaseOk: !crashed || phaseHolds(sk, p.crashAtSeconds!, p.crashPhase!),
      reportedMatchesDraw: !crashed || p.crashPhase === draws.phase,
      phase: p.crashPhase,
      skeletonPeaks: sk.peakCount,
      preCrashPeaks: crashed ? findPeaks(values, STEP, range).length : peaks.length,
      fullPeaks: peaks.length,
      longestFlat: longestFlatSeconds(full, STEP),
      horns,
      edgeHorns: peaks.filter((x) => x.prominence >= HORN_PROMINENCE_FRACTION * range && x.widthSeconds <= HORN_MAX_WIDTH_SECONDS).length - horns,
      valuesOk: full.every((v) => v >= p.bandMin && v <= p.rideMaximum && Math.round(v * 1e6) / 1e6 === v),
      tell: crashed && isTell(p.crashAtSeconds!, values, STEP),
      sameLawTell: crashed && isTell(redrawn, before(full, redrawn), STEP),
      pooledTell: false,
    };
    rows.push(row);
    if (crashed && withPooledBaseline) {
      crashedRides.push({ full, duration: p.durationSeconds, fraction: p.crashAtSeconds! / p.durationSeconds, row });
    }
  }
  // Ride-lab baseline: crash fraction redrawn from the pooled crash fractions, keeping >= 2 s.
  const pool = crashedRides.map((c) => c.fraction);
  let k = 0;
  for (const c of crashedRides) {
    let redrawn = -1;
    for (let tries = 0; tries < 50 && redrawn < 0; tries++) {
      const candidate = c.duration * pool[Math.floor(sampleUniform('v4-f8-pooled', k++) * pool.length)];
      if (candidate >= 2) redrawn = candidate;
    }
    c.row.pooledTell = isTell(redrawn, before(c.full, redrawn), STEP);
  }
  return rows;
}

describe('V4 WAVES shape (spec criteria 3, 6)', () => {
  let rows: ShapeRow[] = [];
  let side: ShapeRow[] = [];
  beforeAll(() => {
    rows = shapeSample('medium', SHAPE_N, true);
    side = [...shapeSample('weak', SIDE_N, false), ...shapeSample('strong', SIDE_N, false)];
  }, 180_000);

  const share = (xs: ShapeRow[], f: (r: ShapeRow) => boolean) => xs.filter(f).length / xs.length;

  it('reports the drawn phase, 50/20/30, and the curve really is UP/PEAK/DOWN at every crash', () => {
    const crashed = rows.filter((r) => r.crashed);
    for (const [phase, p] of Object.entries(PHASE_P)) {
      expectProportion(crashed.filter((r) => r.phase === phase).length, crashed.length, p, `WAVES ${phase}`);
    }
    expect(rows.filter((r) => !r.reportedMatchesDraw)).toHaveLength(0);
    expect([...rows, ...side].filter((r) => !r.phaseOk)).toHaveLength(0);
  });

  it('has 2-4 peaks over the full ride whenever the duration allows (documented shares)', () => {
    expect(rows.every((r) => r.skeletonPeaks <= WAVES_SHAPE.MAX_PEAKS)).toBe(true);
    const long = rows.filter((r) => r.duration >= 5);
    expect(share(long, (r) => r.skeletonPeaks >= 2)).toBeGreaterThanOrEqual(0.995);
    expect(share(rows, (r) => r.skeletonPeaks >= 2)).toBeGreaterThanOrEqual(0.83);
    // Ride-lab rule (5 % prominence, 50 ms grid): full uncrashed path and the visible pre-crash path.
    expect(share(rows, (r) => r.fullPeaks >= 2 && r.fullPeaks <= 4)).toBeGreaterThanOrEqual(0.8);
    expect(rows.every((r) => r.fullPeaks <= 4)).toBe(true);
    expect(share(rows, (r) => r.preCrashPeaks >= 2 && r.preCrashPeaks <= 4)).toBeGreaterThanOrEqual(0.48);
  });

  it('has no plateau of 1 s (0.1 pp tolerance; 0.5 s for weak/medium), no horns, and 6-dp values inside the band', () => {
    const all = [...rows, ...side];
    // Weak and medium (payout bend <= ~1): no near-flat run of 0.5 s, as before calibration.
    expect(Math.max(...[...rows, ...side.slice(0, SIDE_N)].map((r) => r.longestFlat))).toBeLessThan(0.5);
    // Strong (bend ~3.9 for V3-cost parity): slow valleys of long rides can stay within 0.1 pp for 0.5-0.55 s
    // (measured 0.3 % of this sample, 0.06 % of 20,000 ride-lab rides); never for 1 s (the held-flat measure).
    const strong = side.slice(SIDE_N);
    expect(Math.max(...strong.map((r) => r.longestFlat))).toBeLessThan(0.6);
    expect(share(strong, (r) => r.longestFlat >= 0.5 - 1e-9)).toBeLessThan(0.01);
    expect(all.filter((r) => r.horns > 0)).toHaveLength(0);
    // Peaks cut by the ride end can look narrow to the proxy; measured 1 in ~10,000 rides.
    expect(share(all, (r) => r.edgeHorns > 0)).toBeLessThan(0.001);
    expect(all.filter((r) => !r.valuesOk)).toHaveLength(0);
  });

  it('F8: a new high says nothing about the crash (gap to both baselines within the measured size)', () => {
    const crashed = rows.filter((r) => r.crashed);
    const n = crashed.length;
    const tell = share(crashed, (r) => r.tell);
    const check = (baseline: number, measuredAbsGap: number) => {
      const gap = tell - baseline;
      // Bound = gap measured on this fixed sample + 99.9 % sampling margin of a fresh sample of this size.
      const se = Math.sqrt((tell * (1 - tell) + baseline * (1 - baseline)) / n);
      if (process.env.V4_PRINT_F8) console.log({ tell, baseline, gap, se });
      expect(Math.abs(gap)).toBeLessThan(measuredAbsGap + 3.2905 * se);
    };
    check(share(crashed, (r) => r.sameLawTell), F8_MEASURED_ABS_GAP.sameLaw);
    check(share(crashed, (r) => r.pooledTell), F8_MEASURED_ABS_GAP.pooled);
  });
});
