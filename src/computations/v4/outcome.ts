import type { V4StreamLabel } from './rng';
import type { V4CrashBucket, V4CrashPhase } from './types';

/**
 * Duration and outcome draws (contract §2). Each decision has its own stream, and none of the
 * outcome draws (no-crash, bucket, position in bucket, phase) reads the duration, so the outcome
 * mix is identical for every duration (F3).
 *
 * Buckets are positions in the crash window [minCrash, duration] (EARLY < 25 %, MID < 80 %,
 * LATE), so every bucket is feasible for every duration above minCrash and nothing is
 * reweighted. See the handback for why "25 %/80 % of duration" cannot be duration-independent.
 */
export const NO_CRASH_WEIGHT = 0.08;
export const CRASH_BUCKETS: readonly { bucket: V4CrashBucket; upTo: number; from: number; to: number }[] = [
  { bucket: 'EARLY', upTo: 0.1, from: 0, to: 0.25 },
  { bucket: 'MID', upTo: 0.75, from: 0.25, to: 0.8 },
  { bucket: 'LATE', upTo: 1, from: 0.8, to: 1 },
];
export const CRASH_PHASES: readonly { phase: V4CrashPhase; upTo: number }[] = [
  { phase: 'UP', upTo: 0.5 },
  { phase: 'PEAK', upTo: 0.7 },
  { phase: 'DOWN', upTo: 1 },
];

export interface V4OutcomeDraws {
  durationSeconds: number;
  /** False for the 8 % no-crash draw (and for the measure-zero duration == minCrash). */
  crashes: boolean;
  bucket: V4CrashBucket;
  /** Crash time if the ride crashes; otherwise the same-law anchor the shape is still built on. */
  anchorSeconds: number;
  phase: V4CrashPhase;
  /** Uniform position of the anchor inside its phase zone, [0, 1). */
  phasePosition: number;
}

export function drawOutcome(
  draw: (label: V4StreamLabel, counter: number) => number,
  limits: { minDurationSeconds: number; maxDurationSeconds: number; minCrashSeconds: number }
): V4OutcomeDraws {
  const { minDurationSeconds: lo, maxDurationSeconds: hi, minCrashSeconds: minCrash } = limits;
  const durationSeconds = lo + draw('duration', 0) * (hi - lo);
  const noCrash = draw('outcome', 0) < NO_CRASH_WEIGHT;
  const bucketRoll = draw('outcome', 1);
  const band = CRASH_BUCKETS.find((b) => bucketRoll < b.upTo) ?? CRASH_BUCKETS[2];
  const fraction = band.from + draw('crash-time', 0) * (band.to - band.from);
  const phaseRoll = draw('crash-phase', 0);
  const phase = (CRASH_PHASES.find((p) => phaseRoll < p.upTo) ?? CRASH_PHASES[2]).phase;
  // The config check guarantees minCrash <= minDuration, so the window is never negative.
  const window = durationSeconds - minCrash;
  return {
    durationSeconds,
    crashes: window > 0 && !noCrash,
    bucket: band.bucket,
    anchorSeconds: minCrash + fraction * window,
    phase,
    phasePosition: draw('crash-phase', 1),
  };
}
