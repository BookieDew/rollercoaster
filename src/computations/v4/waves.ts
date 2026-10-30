import type { V4CrashPhase } from './types';

/**
 * WAVES V4 shape, built directly in normalized payout space (0 = band bottom, 1 = band top).
 *
 * A ride is a chain of knots: start, then alternating peaks and valleys. Every segment between two
 * knots is strictly monotone (no plateaus) and has a minimum duration (no horns). Each wave splits
 * its time into UP (first 5/6 of the rise), PEAK (last 1/6 of the rise + first 1/4 of the fall)
 * and DOWN (rest of the fall); with rise:fall = 3:2 that is 50/20/30 of the time, the crash-phase
 * mix, so placing the crash inside the drawn zone looks like an ordinary moment of the curve.
 *
 * The crash anchor is placed first: the anchor wave is laid out so that the anchor sits at a
 * uniform position inside the drawn phase zone. The waves before it share one tempo, solved in
 * closed form so the prefix ends exactly where the anchor wave starts; the waves after it use the
 * same tempo and run past the end. Peak levels never depend on the anchor, so the highest level is
 * independent of the crash time.
 */
export const WAVES_SHAPE = {
  RISE: 0.6,
  FALL: 0.4,
  JITTER: 0.2,
  MIN_RISE_SECONDS: 0.6,
  MIN_FALL_SECONDS: 0.4,
  INITIAL_CLIMB_SECONDS: 2,
  MIN_FIRST_PEAK_SECONDS: 0.3,
  EASE: 0.5,
  HIGHEST_MIN: 0.68,
  HIGHEST_SPAN: 0.24,
  PEAK_LOW: 0.45,
  PEAK_HIGH: 0.76,
  PEAK_GAP: 0.06,
  VALLEY_HIGH: 0.3,
  START_BASE: 0.01,
  START_SLOPE: 0.14,
  AVOID_FIRST_HIGHEST: 0.75,
  MIN_PEAKS: 2,
  MAX_PEAKS: 4,
  MAX_PREFIX_PEAKS: 3,
  MAX_SUFFIX_WAVES: 16,
} as const;

const S = WAVES_SHAPE;
/** Slowest-jitter segments still meet the minimum rise/fall durations at this tempo (1.25 s). */
export const MIN_TEMPO_SECONDS = Math.max(
  S.MIN_RISE_SECONDS / (S.RISE * (1 - S.JITTER)),
  S.MIN_FALL_SECONDS / (S.FALL * (1 - S.JITTER))
);

/** Shape-stream counters, fixed per purpose. */
export const SHAPE_DRAW = {
  HIGHEST: 0,
  PEAK_TARGET: 1,
  HIGHEST_AVOID_FIRST: 2,
  HIGHEST_PICK: 3,
  ANCHOR: 8,
  PREFIX: 16,
  SUFFIX: 32,
  PEAK_LEVEL: 64,
  VALLEY_LEVEL: 96,
} as const;

export type KnotKind = 'start' | 'peak' | 'valley';

export interface WavesAnchor {
  peakSeconds: number;
  /** Valley before the anchor peak; 0 when the anchor rise is the initial climb. */
  riseStartSeconds: number;
  fallEndSeconds: number;
  /** PEAK zone = [peak - topBefore, peak + topAfter); UP before it on the rise, DOWN after it. */
  topBeforeSeconds: number;
  topAfterSeconds: number;
}

export interface WavesSkeleton {
  times: number[];
  levels: number[];
  kinds: KnotKind[];
  /** Peaks with time <= duration. */
  peakCount: number;
  highest: number;
  highestPeakSeconds: number;
  anchor: WavesAnchor;
  tempoSeconds: number;
  baseTempoSeconds: number;
  prefixPeaks: number;
}

export interface WavesInput {
  durationSeconds: number;
  anchorSeconds: number;
  phase: V4CrashPhase;
  phasePosition: number;
  ticketStrength: number;
}

type Draw = (counter: number) => number;
interface Knot { t: number; kind: KnotKind }
interface Layout {
  knots: Knot[];
  anchorIndex: number;
  anchor: WavesAnchor;
  tempo: number;
  ratio: number;
  peakCount: number;
  prefixPeaks: number;
}
interface Context {
  D: number;
  A: number;
  climbMin: number;
  rhoA: number;
  phiA: number;
  offset: number;
  phase: V4CrashPhase;
  q: number;
  baseTempo: number;
  draw: Draw;
  jit: (counter: number) => number;
}

/** Highest peak level; its own draw, so it can be read without building the shape (LINEAR cap). */
export function highestLevel(draw: Draw): number {
  return S.HIGHEST_MIN + draw(SHAPE_DRAW.HIGHEST) * S.HIGHEST_SPAN;
}

export function startLevel(ticketStrength: number): number {
  return S.START_BASE + S.START_SLOPE * ticketStrength;
}

/** Anchor peak = anchor + offset * tempo, placing the anchor uniformly inside the phase zone. */
export function anchorOffset(phase: V4CrashPhase, q: number, rho: number, phi: number): number {
  if (phase === 'UP') return rho * (1 - (5 / 6) * q);
  if (phase === 'PEAK') return rho / 6 - q * (rho / 6 + phi / 4);
  return -phi / 4 - q * 0.75 * phi;
}

export function buildWavesSkeleton(draw: Draw, input: WavesInput): WavesSkeleton {
  const D = input.durationSeconds;
  const A = input.anchorSeconds;
  const target = 2 + Math.floor(draw(SHAPE_DRAW.PEAK_TARGET) * 3);
  const jit = (counter: number) => 1 + S.JITTER * (2 * draw(counter) - 1);
  const rhoA = S.RISE * jit(SHAPE_DRAW.ANCHOR);
  const phiA = S.FALL * jit(SHAPE_DRAW.ANCHOR + 1);
  const ctx: Context = {
    D, A, rhoA, phiA, draw, jit,
    climbMin: Math.min(S.INITIAL_CLIMB_SECONDS, A),
    offset: anchorOffset(input.phase, input.phasePosition, rhoA, phiA),
    phase: input.phase,
    q: input.phasePosition,
    baseTempo: Math.max(D / (target + 0.25), MIN_TEMPO_SECONDS),
  };
  // Candidates differ only in how many peaks precede the anchor wave. Prefer 2-4 peaks in the
  // ride, then the tempo closest to the duration-based base tempo.
  const build = (n: number, capPeaks: boolean) => (n === 0 ? mergedLayout(ctx, capPeaks) : prefixLayout(ctx, n, capPeaks));
  let best: Layout | null = null;
  let fallback: Layout | null = null;
  for (let n = 0; n <= S.MAX_PREFIX_PEAKS; n++) {
    const layout = build(n, false);
    if (!layout) continue;
    if (!fallback || layout.ratio < fallback.ratio) fallback = layout;
    const inRange = layout.peakCount >= S.MIN_PEAKS && layout.peakCount <= S.MAX_PEAKS;
    if (inRange && (!best || layout.ratio < best.ratio)) best = layout;
  }
  // Without an in-range candidate, the closest tempo wins; its suffix stops adding peaks at 4.
  const chosen = best ?? (fallback && build(fallback.prefixPeaks, true));
  if (!chosen) throw new Error('V4 WAVES layout unavailable');
  return assignLevels(chosen, ctx, input.ticketStrength);
}

/** n = 0: the anchor rise is the initial climb, at the duration-based tempo. */
function mergedLayout(ctx: Context, capPeaks: boolean): Layout | null {
  const W = ctx.baseTempo;
  const rA = ctx.rhoA * W;
  let fA = ctx.phiA * W;
  let peak = ctx.A + ctx.offset * W;
  if (ctx.phase === 'PEAK' && ctx.A - fA / 4 < ctx.climbMin) {
    // Peaks come at the climb end or later, so part of the PEAK zone is unreachable for an anchor this
    // early: place the anchor uniformly over the reachable part (no mass point at the climb end).
    const latest = ctx.A + rA / 6;
    peak = latest - ctx.q * (latest - ctx.climbMin);
  } else if (peak < ctx.climbMin) {
    // DOWN anchor just after the climb end: shorten the first fall so the anchor is in its DOWN zone,
    // keeping the fall at least MIN_FALL (then the peak may come up to MIN_FALL/4 before the climb end).
    const room = ctx.A - ctx.climbMin;
    if (room < fA / 4) fA = Math.max(S.MIN_FALL_SECONDS, 4 * room);
    peak = Math.max(S.MIN_FIRST_PEAK_SECONDS, Math.min(ctx.climbMin, ctx.A - fA / 4));
  }
  const nominal = Math.max(ctx.climbMin, rA);
  return finishLayout(ctx, capPeaks, [{ t: 0, kind: 'start' }], {
    peak, riseStart: 0, rA, fA, tempo: W,
    ratio: peak > nominal ? peak / nominal : nominal / peak,
    prefixPeaks: 0,
  });
}

/** n >= 1 peaks before the anchor wave; tempo solved so the prefix ends where the anchor rise starts. */
function prefixLayout(ctx: Context, n: number, capPeaks: boolean): Layout | null {
  const { jit } = ctx;
  const rho1 = S.RISE * jit(SHAPE_DRAW.PREFIX);
  const fall = (i: number) => S.FALL * jit(SHAPE_DRAW.PREFIX + 2 * i - 1);
  const rise = (i: number) => S.RISE * jit(SHAPE_DRAW.PREFIX + 2 * i - 2);
  let mu = 0;
  for (let i = 1; i <= n; i++) mu += fall(i) + (i >= 2 ? rise(i) : 0);
  const den = mu + ctx.rhoA - ctx.offset;
  let W = ctx.A / (rho1 + den);
  let climb = rho1 * W;
  if (climb < ctx.climbMin) {
    W = (ctx.A - ctx.climbMin) / den;
    climb = ctx.climbMin;
  }
  if (!(W >= MIN_TEMPO_SECONDS)) return null;
  const knots: Knot[] = [{ t: 0, kind: 'start' }, { t: climb, kind: 'peak' }];
  let t = climb;
  for (let i = 1; i < n; i++) {
    t += fall(i) * W;
    knots.push({ t, kind: 'valley' });
    t += rise(i + 1) * W;
    knots.push({ t, kind: 'peak' });
  }
  const peak = ctx.A + ctx.offset * W;
  const riseStart = peak - ctx.rhoA * W;
  knots.push({ t: riseStart, kind: 'valley' });
  return finishLayout(ctx, capPeaks, knots, {
    peak, riseStart, rA: ctx.rhoA * W, fA: ctx.phiA * W, tempo: W,
    ratio: W > ctx.baseTempo ? W / ctx.baseTempo : ctx.baseTempo / W,
    prefixPeaks: n,
  });
}

/** Appends the anchor wave and the suffix (same tempo) until the curve passes the end. */
function finishLayout(
  ctx: Context,
  capPeaks: boolean,
  knots: Knot[],
  a: { peak: number; riseStart: number; rA: number; fA: number; tempo: number; ratio: number; prefixPeaks: number }
): Layout | null {
  const anchorIndex = knots.length;
  knots.push({ t: a.peak, kind: 'peak' });
  const fallEnd = a.peak + a.fA;
  knots.push({ t: fallEnd, kind: 'valley' });
  let peakCount = knots.filter((k) => k.kind === 'peak' && k.t <= ctx.D).length;
  let t = fallEnd;
  for (let j = 0; t < ctx.D; j++) {
    if (j >= S.MAX_SUFFIX_WAVES) return null;
    let rise = S.RISE * ctx.jit(SHAPE_DRAW.SUFFIX + 2 * j) * a.tempo;
    // Capped layout: after the fourth peak the curve climbs past the end.
    if (capPeaks && peakCount >= S.MAX_PEAKS) rise = Math.max(rise, ctx.D - t + rise / 2);
    t += rise;
    knots.push({ t, kind: 'peak' });
    if (t > ctx.D) break;
    peakCount++;
    t += S.FALL * ctx.jit(SHAPE_DRAW.SUFFIX + 2 * j + 1) * a.tempo;
    knots.push({ t, kind: 'valley' });
  }
  return {
    knots, anchorIndex, tempo: a.tempo, ratio: a.ratio, peakCount, prefixPeaks: a.prefixPeaks,
    anchor: {
      peakSeconds: a.peak,
      riseStartSeconds: a.riseStart,
      fallEndSeconds: fallEnd,
      topBeforeSeconds: a.rA / 6,
      topAfterSeconds: a.fA / 4,
    },
  };
}

/** Levels: valleys stay in [start, 0.30], other peaks in [0.45, min(0.76, H - 0.06)], one peak at H. */
function assignLevels(layout: Layout, ctx: Context, ticketStrength: number): WavesSkeleton {
  const { knots, anchorIndex } = layout;
  const { draw } = ctx;
  const H = highestLevel(draw);
  const start = startLevel(ticketStrength);
  const peakIndexes = knots.map((k, i) => (k.kind === 'peak' ? i : -1)).filter((i) => i >= 0);
  const within = peakIndexes.filter((i) => knots[i].t <= ctx.D);
  let candidates = within.length > 0 ? within : [anchorIndex];
  if (candidates.length > 1 && draw(SHAPE_DRAW.HIGHEST_AVOID_FIRST) < S.AVOID_FIRST_HIGHEST) {
    candidates = candidates.slice(1);
  }
  const highestIndex = candidates[Math.floor(draw(SHAPE_DRAW.HIGHEST_PICK) * candidates.length)];
  const peakTop = Math.min(S.PEAK_HIGH, H - S.PEAK_GAP);
  let peakNo = 0;
  let valleyNo = 0;
  const levels = knots.map((k, i) => {
    if (k.kind === 'start') return start;
    if (k.kind === 'valley') return start + draw(SHAPE_DRAW.VALLEY_LEVEL + valleyNo++) * (S.VALLEY_HIGH - start);
    const level = S.PEAK_LOW + draw(SHAPE_DRAW.PEAK_LEVEL + peakNo++) * (peakTop - S.PEAK_LOW);
    return i === highestIndex ? H : level;
  });
  return {
    times: knots.map((k) => k.t),
    levels,
    kinds: knots.map((k) => k.kind),
    peakCount: layout.peakCount,
    highest: H,
    highestPeakSeconds: knots[highestIndex].t,
    anchor: layout.anchor,
    tempoSeconds: layout.tempo,
    baseTempoSeconds: ctx.baseTempo,
    prefixPeaks: layout.prefixPeaks,
  };
}

/** Normalized level at t (clamped to the knot range). Each segment uses a monotone eased blend. */
export function levelAt(skeleton: Pick<WavesSkeleton, 'times' | 'levels'>, t: number): number {
  const { times, levels } = skeleton;
  const last = times.length - 1;
  if (t <= times[0]) return levels[0];
  if (t >= times[last]) return levels[last];
  let lo = 0;
  let hi = last;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (times[mid] <= t) lo = mid;
    else hi = mid;
  }
  const s = (t - times[lo]) / (times[hi] - times[lo]);
  const eased = (1 - S.EASE) * s + S.EASE * s * s * (3 - 2 * s);
  return levels[lo] + (levels[hi] - levels[lo]) * eased;
}
