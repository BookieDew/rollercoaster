import type { CrashPhase, Outcome, SampledRide } from './adapter';

/**
 * Distribution checks. Everything here works on a RideRecord: the engine's ride sampled on a
 * fixed time grid before its terminal time (so the crash drop to 0 is never part of the path).
 */
export interface RideRecord {
  durationSeconds: number;
  outcome: Outcome;
  terminalAtSeconds: number;
  reportedCrashPhase?: CrashPhase;
  effectiveMin: number;
  effectiveMax: number;
  stepSeconds: number;
  /** values[k] = payout rate at t = k * stepSeconds, for every grid point strictly before terminal. */
  values: number[];
  /** Optional crash-free curve, used only for the F8 baseline. */
  uncrashedBoostAt?: (t: number) => number;
}

export const GRID_EPS = 1e-9;
export const BUCKET_EDGES = { early: 0.25, mid: 0.8 } as const;
export const TELL_WINDOW_SECONDS = 0.8;
export const PLATEAU_TOLERANCE = 0.001; // 0.1 percentage points as a fraction
export const PLATEAU_MIN_SECONDS = 1.0;
export const PEAK_PROMINENCE_FRACTION = 0.05;
export const HORN_PROMINENCE_FRACTION = 0.15;
export const HORN_MAX_WIDTH_SECONDS = 0.3;
export const PHASE_WINDOW_SECONDS = 0.3;
export const PHASE_SLOPE_FRACTION = 0.03;
export const FIRST_MAX_TOLERANCE = 5e-7; // 6 dp rounding

export function gridValues(
  boostAt: (t: number) => number,
  terminal: number,
  stepSeconds: number
): number[] {
  const out: number[] = [];
  for (let k = 0; k * stepSeconds < terminal - GRID_EPS; k++) out.push(boostAt(k * stepSeconds));
  return out;
}

export function toRecord(ride: SampledRide, stepSeconds: number): RideRecord {
  return {
    durationSeconds: ride.durationSeconds,
    outcome: ride.outcome,
    terminalAtSeconds: ride.terminalAtSeconds,
    reportedCrashPhase: ride.reportedCrashPhase,
    effectiveMin: ride.effectiveMin,
    effectiveMax: ride.effectiveMax,
    stepSeconds,
    values: gridValues(ride.boostAt, ride.terminalAtSeconds, stepSeconds),
    uncrashedBoostAt: ride.uncrashedBoostAt,
  };
}

// ---------- proportions ----------
export interface Prop { k: number; n: number; p: number; lo: number; hi: number }

/** Wilson 95 % score interval. */
export function prop(k: number, n: number): Prop {
  if (n === 0) return { k, n, p: NaN, lo: NaN, hi: NaN };
  const z = 1.959964;
  const p = k / n;
  const denom = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom;
  return { k, n, p, lo: Math.max(0, centre - half), hi: Math.min(1, centre + half) };
}

export function quantile(sortedAsc: number[], q: number): number {
  if (sortedAsc.length === 0) return NaN;
  const idx = Math.min(sortedAsc.length - 1, Math.max(0, Math.ceil(q * sortedAsc.length) - 1));
  return sortedAsc[idx];
}

// ---------- classifiers ----------
export type Bucket = 'EARLY' | 'MID' | 'LATE';

export function crashBucket(rec: Pick<RideRecord, 'terminalAtSeconds' | 'durationSeconds'>): Bucket {
  const f = rec.terminalAtSeconds / rec.durationSeconds;
  return f < BUCKET_EDGES.early ? 'EARLY' : f < BUCKET_EDGES.mid ? 'MID' : 'LATE';
}

/**
 * Observed crash phase (documented rule): look at the path's last 300 ms before the crash.
 * s = (last value - value 300 ms earlier) / (effectiveMax - effectiveMin).
 * s > +3 % -> UP; s < -3 % -> DOWN; otherwise PEAK (flat or turning near the crash).
 * A degenerate range (effectiveMax == effectiveMin) is classed PEAK.
 */
export function observedPhase(rec: RideRecord): CrashPhase {
  const v = rec.values;
  const range = rec.effectiveMax - rec.effectiveMin;
  if (v.length < 2 || range < 1e-9) return 'PEAK';
  const back = Math.max(1, Math.round(PHASE_WINDOW_SECONDS / rec.stepSeconds));
  const s = (v[v.length - 1] - v[Math.max(0, v.length - 1 - back)]) / range;
  return s > PHASE_SLOPE_FRACTION ? 'UP' : s < -PHASE_SLOPE_FRACTION ? 'DOWN' : 'PEAK';
}

export interface PeakInfo { index: number; prominence: number; widthSeconds: number }

/**
 * Peak/turn rule (documented): collapse equal-valued runs, take interior local maxima, keep those
 * with prominence >= 5 % of (effectiveMax - effectiveMin). Prominence = peak minus the higher of
 * the two base levels (lowest point before a higher-or-equal point, or the path edge, each side).
 * A path that ends at its top (crash from the top) has no right side and is not counted.
 */
export function findPeaks(values: number[], stepSeconds: number, range: number, minProminenceFraction = PEAK_PROMINENCE_FRACTION): PeakInfo[] {
  if (range < 1e-9 || values.length < 3) return [];
  const minProm = minProminenceFraction * range;
  // run-collapse
  const runs: { start: number; end: number; v: number }[] = [];
  for (let i = 0; i < values.length; i++) {
    const last = runs[runs.length - 1];
    if (last && Math.abs(values[i] - last.v) < 1e-9) last.end = i;
    else runs.push({ start: i, end: i, v: values[i] });
  }
  const peaks: PeakInfo[] = [];
  for (let r = 1; r < runs.length - 1; r++) {
    const pv = runs[r].v;
    if (!(pv > runs[r - 1].v && pv > runs[r + 1].v)) continue;
    let leftBase = pv;
    let l = r - 1;
    while (l >= 0 && runs[l].v < pv) { leftBase = Math.min(leftBase, runs[l].v); l--; }
    let rightBase = pv;
    let rr = r + 1;
    while (rr < runs.length && runs[rr].v < pv) { rightBase = Math.min(rightBase, runs[rr].v); rr++; }
    const prominence = pv - Math.max(leftBase, rightBase);
    if (prominence < minProm) continue;
    const half = pv - prominence / 2;
    let a = runs[r].start;
    while (a > 0 && values[a - 1] > half) a--;
    let b = runs[r].end;
    while (b < values.length - 1 && values[b + 1] > half) b++;
    peaks.push({ index: runs[r].start, prominence, widthSeconds: (b - a + 1) * stepSeconds });
  }
  return peaks;
}

/** Longest run of grid points whose max-min stays within `tolerance`, in seconds. Two-pointer. */
export function longestFlatSeconds(values: number[], stepSeconds: number, tolerance = PLATEAU_TOLERANCE): number {
  if (values.length === 0) return 0;
  let best = 1;
  let lo = 0;
  const maxQ: number[] = [];
  const minQ: number[] = [];
  for (let hi = 0; hi < values.length; hi++) {
    while (maxQ.length && values[maxQ[maxQ.length - 1]] <= values[hi]) maxQ.pop();
    maxQ.push(hi);
    while (minQ.length && values[minQ[minQ.length - 1]] >= values[hi]) minQ.pop();
    minQ.push(hi);
    while (values[maxQ[0]] - values[minQ[0]] > tolerance + 1e-12) {
      lo++;
      if (maxQ[0] < lo) maxQ.shift();
      if (minQ[0] < lo) minQ.shift();
    }
    best = Math.max(best, hi - lo + 1);
  }
  return best * stepSeconds;
}

/** Time (grid) at which the path first reaches its maximum. */
export function firstMaxTime(values: number[], stepSeconds: number): number {
  let max = -Infinity;
  for (const v of values) if (v > max) max = v;
  for (let k = 0; k < values.length; k++) if (values[k] >= max - FIRST_MAX_TOLERANCE) return k * stepSeconds;
  return 0;
}

export function isTell(terminal: number, values: number[], stepSeconds: number): boolean {
  return terminal - firstMaxTime(values, stepSeconds) <= TELL_WINDOW_SECONDS;
}

// ---------- aggregation ----------
export interface Mix { n: number; shares: Record<string, Prop> }

function mix(keys: string[], values: string[]): Mix {
  const shares: Record<string, Prop> = {};
  for (const key of keys) shares[key] = prop(values.filter((x) => x === key).length, values.length);
  return { n: values.length, shares };
}

export interface ThirdSummary {
  label: string;
  n: number;
  noCrash: Prop;
  buckets: Mix;
  reportedPhase: Mix;
  observedPhase: Mix;
}

export interface DistributionSummary {
  n: number;
  noCrash: Prop;
  buckets: Mix;
  reportedPhase: Mix & { reportedShareOfCrashed: Prop };
  observedPhase: Mix;
  peaks: { histogram: Record<string, number>; mean: number; share2to4: Prop };
  plateau: { share: Prop; meanLongestSeconds: number };
  horn: Prop;
  f8: {
    crashed: number;
    tell: Prop;
    baseline: Prop | null;
    gapPp: number | null;
    gapCi95Pp: [number, number] | null;
  };
  thirds: ThirdSummary[];
}

const BUCKETS = ['EARLY', 'MID', 'LATE'];
const PHASES = ['UP', 'PEAK', 'DOWN'];

function groupSummary(label: string, recs: RideRecord[]): ThirdSummary {
  const crashed = recs.filter((r) => r.outcome === 'CRASHED');
  return {
    label,
    n: recs.length,
    noCrash: prop(recs.length - crashed.length, recs.length),
    buckets: mix(BUCKETS, crashed.map(crashBucket)),
    reportedPhase: mix(PHASES, crashed.filter((r) => r.reportedCrashPhase).map((r) => r.reportedCrashPhase as string)),
    observedPhase: mix(PHASES, crashed.map(observedPhase)),
  };
}

/** rand: uniform [0,1) stream used only to redraw crash times for the F8 baseline. */
export function summarize(recs: RideRecord[], rand: () => number, minCrashSeconds = 2): DistributionSummary {
  const crashed = recs.filter((r) => r.outcome === 'CRASHED');
  const base = groupSummary('all', recs);

  // peaks / plateau / horn on every ride's pre-terminal path
  const hist: Record<string, number> = { '0': 0, '1': 0, '2': 0, '3': 0, '4': 0, '5+': 0 };
  let peakSum = 0, in24 = 0, plateau = 0, plateauSecSum = 0, horns = 0;
  for (const r of recs) {
    const range = r.effectiveMax - r.effectiveMin;
    const peaks = findPeaks(r.values, r.stepSeconds, range);
    hist[peaks.length >= 5 ? '5+' : String(peaks.length)]++;
    peakSum += peaks.length;
    if (peaks.length >= 2 && peaks.length <= 4) in24++;
    const flat = longestFlatSeconds(r.values, r.stepSeconds);
    plateauSecSum += flat;
    if (flat >= PLATEAU_MIN_SECONDS) plateau++;
    const hornMin = HORN_PROMINENCE_FRACTION * range;
    if (findPeaks(r.values, r.stepSeconds, range, HORN_PROMINENCE_FRACTION).some(
      (p) => p.prominence >= hornMin && p.widthSeconds <= HORN_MAX_WIDTH_SECONDS)) horns++;
  }

  // F8 tell vs baseline
  const tellCount = crashed.filter((r) => isTell(r.terminalAtSeconds, r.values, r.stepSeconds)).length;
  let baseline: Prop | null = null;
  const canBaseline = crashed.length > 1 && crashed.every((r) => r.uncrashedBoostAt);
  if (canBaseline) {
    const fractions = crashed.map((r) => r.terminalAtSeconds / r.durationSeconds);
    let k = 0;
    for (const r of crashed) {
      let t2 = r.terminalAtSeconds;
      for (let tries = 0; tries < 50; tries++) {
        const cand = r.durationSeconds * fractions[Math.floor(rand() * fractions.length)];
        if (cand >= minCrashSeconds) { t2 = cand; break; }
      }
      const vals = gridValues(r.uncrashedBoostAt as (t: number) => number, t2, r.stepSeconds);
      if (isTell(t2, vals, r.stepSeconds)) k++;
    }
    baseline = prop(k, crashed.length);
  }
  const tell = prop(tellCount, crashed.length);
  let gapPp: number | null = null;
  let gapCi: [number, number] | null = null;
  if (baseline) {
    const gap = tell.p - baseline.p;
    const se = Math.sqrt((tell.p * (1 - tell.p)) / tell.n + (baseline.p * (1 - baseline.p)) / baseline.n);
    gapPp = gap * 100;
    gapCi = [(gap - 1.959964 * se) * 100, (gap + 1.959964 * se) * 100];
  }

  // duration thirds by the observed duration range
  const durs = recs.map((r) => r.durationSeconds);
  const dmin = Math.min(...durs);
  const dmax = Math.max(...durs);
  const third = (d: number) => Math.min(2, Math.floor(((d - dmin) / (dmax - dmin || 1)) * 3));
  const thirds = [0, 1, 2].map((i) => {
    const lo = dmin + ((dmax - dmin) * i) / 3;
    const hi = dmin + ((dmax - dmin) * (i + 1)) / 3;
    return groupSummary(`${lo.toFixed(1)}-${hi.toFixed(1)} s`, recs.filter((r) => third(r.durationSeconds) === i));
  });

  const reported = crashed.filter((r) => r.reportedCrashPhase).length;
  return {
    n: recs.length,
    noCrash: base.noCrash,
    buckets: base.buckets,
    reportedPhase: { ...base.reportedPhase, reportedShareOfCrashed: prop(reported, crashed.length) },
    observedPhase: base.observedPhase,
    peaks: { histogram: hist, mean: peakSum / recs.length, share2to4: prop(in24, recs.length) },
    plateau: { share: prop(plateau, recs.length), meanLongestSeconds: plateauSecSum / recs.length },
    horn: prop(horns, recs.length),
    f8: { crashed: crashed.length, tell, baseline, gapPp, gapCi95Pp: gapCi },
    thirds,
  };
}
