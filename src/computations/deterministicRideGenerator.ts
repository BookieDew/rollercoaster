import { createHash } from 'crypto';
import type { RideMode } from '../types/rewardProfile';

export interface RideCheckpoint {
  index: number;
  timeOffsetPct: number;
  baseBoostValue: number;
}

export interface RideConfig {
  checkpointCount: number;
  volatility: number;
  minBoostPct: number;
  maxBoostPct: number;
  rideMode?: RideMode;
  ticketStrength?: number;
  durationSeconds?: number;
  crashPct?: number;
  minPeakDelaySeconds?: number;
}

export interface RideParams {
  checkpointCount: number;
  volatility: number;
  crashPct: number;
}

export type CrashPhase = 'UP' | 'PEAK' | 'DOWN';

export interface GeneratedRide {
  checkpoints: RideCheckpoint[];
  seed: string;
}

const CRASH_TIME_BUCKET_WEIGHTS = {
  EARLY: 0.10,
  MID: 0.65,
  LATE: 0.25,
} as const;

const CRASH_TIME_BUCKET_RANGES = {
  EARLY_END_PCT: 0.25,
  MID_END_PCT: 0.80,
} as const;

const CRASH_PHASE_WEIGHTS = {
  UP: 0.50,
  PEAK: 0.20,
  DOWN: 0.30,
} as const;

const NO_CRASH_END_WEIGHT = 0.08;

export function getCrashBiasConfig(): {
  timeBucketWeights: { early: number; mid: number; late: number };
  timeBucketRanges: { earlyEndPct: number; midEndPct: number };
  phaseWeights: { up: number; peak: number; down: number };
  noCrashEndWeight: number;
} {
  return {
    timeBucketWeights: {
      early: CRASH_TIME_BUCKET_WEIGHTS.EARLY,
      mid: CRASH_TIME_BUCKET_WEIGHTS.MID,
      late: CRASH_TIME_BUCKET_WEIGHTS.LATE,
    },
    timeBucketRanges: {
      earlyEndPct: CRASH_TIME_BUCKET_RANGES.EARLY_END_PCT,
      midEndPct: CRASH_TIME_BUCKET_RANGES.MID_END_PCT,
    },
    phaseWeights: {
      up: CRASH_PHASE_WEIGHTS.UP,
      peak: CRASH_PHASE_WEIGHTS.PEAK,
      down: CRASH_PHASE_WEIGHTS.DOWN,
    },
    noCrashEndWeight: NO_CRASH_END_WEIGHT,
  };
}

/**
 * Generates a deterministic seed from reward, user, and profile identifiers.
 * This ensures the same ride curve is generated for the same combination.
 */
export function generateSeed(rewardId: string, userId: string, profileVersionId: string): string {
  const input = `${rewardId}:${userId}:${profileVersionId}`;
  return createHash('sha256').update(input).digest('hex');
}

/**
 * Seeded pseudo-random number generator using a simple LCG algorithm.
 * Produces deterministic sequences from a seed string.
 */
class SeededRandom {
  private state: number;

  constructor(seed: string) {
    // Convert seed string to a number
    let hash = 0;
    for (let i = 0; i < seed.length; i++) {
      const char = seed.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32-bit integer
    }
    this.state = Math.abs(hash) || 1;
  }

  /** Returns a pseudo-random number between 0 and 1 */
  next(): number {
    // LCG parameters (same as glibc)
    this.state = (this.state * 1103515245 + 12345) & 0x7fffffff;
    return this.state / 0x7fffffff;
  }

  /** Returns a pseudo-random number between min and max */
  nextRange(min: number, max: number): number {
    return min + this.next() * (max - min);
  }
}

/**
 * Derives internal ride parameters from the seed.
 * These are intentionally not exposed as profile settings.
 */
export function deriveRideParams(
  seed: string,
  durationSeconds: number,
  minCrashSeconds: number
): RideParams {
  const rng = new SeededRandom(seed);
  const checkpointCount = Math.max(6, Math.round(rng.nextRange(8, 18)));
  const volatility = roundToDecimals(rng.nextRange(0.25, 0.85), 4);
  const crashPct = deriveCrashPct(seed, durationSeconds, minCrashSeconds);

  return { checkpointCount, volatility, crashPct };
}

/**
 * Applies a hard minimum crash time (seconds) by adjusting the crash percentage
 * upward when needed, while still clamping within 1%..95%.
 */

/**
 * Derives a deterministic ride duration (seconds) within a configured range.
 */
export function deriveRideDurationSeconds(
  seed: string,
  minSeconds: number,
  maxSeconds: number
): number {
  const rng = new SeededRandom(`duration:${seed}`);
  const duration = rng.nextRange(minSeconds, maxSeconds);
  return roundToDecimals(duration, 3);
}

/**
 * Derives a deterministic crash percentage using a scaled Beta distribution.
 * The crash time is sampled between minCrashSeconds and durationSeconds.
 */
export function deriveCrashPct(
  seed: string,
  durationSeconds: number,
  minCrashSeconds: number
): number {
  if (durationSeconds <= 0) {
    return 1;
  }

  const minCrash = Math.max(0, Math.min(minCrashSeconds, durationSeconds));
  const noCrashRng = new SeededRandom(`no-crash:${seed}`);
  if (noCrashRng.next() < NO_CRASH_END_WEIGHT) {
    return 1;
  }

  const rng = new SeededRandom(`crash:${seed}`);
  const crashSeconds = sampleCrashSecondsFromBuckets(
    rng,
    minCrash,
    durationSeconds
  );
  const crashPct = crashSeconds / durationSeconds;
  return roundToDecimals(clampValue(crashPct, 0.01, 0.9999), 4);
}

export function deriveCrashPhase(seed: string): CrashPhase {
  const rng = new SeededRandom(`crash-phase:${seed}`);
  const roll = rng.next();

  if (roll < CRASH_PHASE_WEIGHTS.UP) {
    return 'UP';
  }
  if (roll < CRASH_PHASE_WEIGHTS.UP + CRASH_PHASE_WEIGHTS.PEAK) {
    return 'PEAK';
  }
  return 'DOWN';
}

function sampleCrashSecondsFromBuckets(
  rng: SeededRandom,
  minCrashSeconds: number,
  durationSeconds: number
): number {
  if (durationSeconds <= 0) {
    return 0;
  }

  const minCrash = clampValue(minCrashSeconds, 0, durationSeconds);
  if (minCrash >= durationSeconds) {
    return durationSeconds;
  }

  const earlyEnd = durationSeconds * CRASH_TIME_BUCKET_RANGES.EARLY_END_PCT;
  const midEnd = durationSeconds * CRASH_TIME_BUCKET_RANGES.MID_END_PCT;

  const buckets: Array<{ start: number; end: number; weight: number }> = [
    {
      start: minCrash,
      end: Math.max(minCrash, Math.min(durationSeconds, earlyEnd)),
      weight: CRASH_TIME_BUCKET_WEIGHTS.EARLY,
    },
    {
      start: Math.max(minCrash, Math.min(durationSeconds, earlyEnd)),
      end: Math.max(Math.max(minCrash, earlyEnd), Math.min(durationSeconds, midEnd)),
      weight: CRASH_TIME_BUCKET_WEIGHTS.MID,
    },
    {
      start: Math.max(minCrash, Math.min(durationSeconds, midEnd)),
      end: durationSeconds,
      weight: CRASH_TIME_BUCKET_WEIGHTS.LATE,
    },
  ]
    .filter((bucket) => bucket.end - bucket.start > 0.000001);

  if (buckets.length === 0) {
    return minCrash;
  }

  const selected = pickWeightedBucket(rng, buckets);
  const span = selected.end - selected.start;
  if (span <= 0.000001) {
    return selected.start;
  }

  return selected.start + (rng.next() * span);
}

function pickWeightedBucket<T extends { weight: number }>(
  rng: SeededRandom,
  buckets: T[]
): T {
  const totalWeight = buckets.reduce((sum, bucket) => sum + bucket.weight, 0);
  if (totalWeight <= 0) {
    return buckets[buckets.length - 1];
  }

  let roll = rng.next() * totalWeight;
  for (const bucket of buckets) {
    roll -= bucket.weight;
    if (roll <= 0) {
      return bucket;
    }
  }

  return buckets[buckets.length - 1];
}

/**
 * Generates a deterministic ride curve with oscillating checkpoints.
 * The curve starts at a base value, oscillates up and down based on volatility,
 * and trends toward zero at the end (crash).
 *
 * @param seed - Deterministic seed for the random generator
 * @param config - Ride configuration parameters
 * @returns Generated ride with checkpoints
 */
export function generateRide(seed: string, config: RideConfig): GeneratedRide {
  const {
    checkpointCount,
    volatility,
    minBoostPct,
    maxBoostPct,
    rideMode = 'WAVES',
    ticketStrength = 0,
    durationSeconds,
    crashPct,
    minPeakDelaySeconds = 2,
  } = config;
  const normalizedCheckpointCount = Math.max(3, checkpointCount);
  const rng = new SeededRandom(`ride:${seed}`);
  const checkpoints = initializeCheckpoints(
    normalizedCheckpointCount,
    minBoostPct,
    maxBoostPct,
    ticketStrength
  );
  const startingFloorValue = checkpoints[0].baseBoostValue;

  const effectiveCrashPct = clampValue(crashPct ?? 1, 0.01, 1);
  const crashPhase = deriveCrashPhase(seed);
  if (rideMode === 'LINEAR') {
    generateLinearCheckpointValues(checkpoints, {
      crashPct: effectiveCrashPct,
      minBoostPct,
      maxBoostPct,
      startValue: startingFloorValue,
    });
    checkpoints[checkpoints.length - 1].baseBoostValue = 0;
    return { checkpoints, seed };
  }

  const preCrashLastIndex = getPreCrashLastCheckpointIndex(checkpoints, effectiveCrashPct);

  if (preCrashLastIndex >= 1) {
    const preCrashEndPct = checkpoints[preCrashLastIndex].timeOffsetPct;
    const initialClimbPct = getInitialClimbPct(durationSeconds, preCrashEndPct, 2);
    const minPeakDelayPct = getInitialClimbPct(durationSeconds, preCrashEndPct, minPeakDelaySeconds);
    const peakCapByPoints = Math.max(1, Math.floor((preCrashLastIndex + 1 - 1) / 2));
    const maxPeakCount = Math.min(4, peakCapByPoints);
    const minPeakCount = maxPeakCount >= 2 ? 2 : 1;
    const peakCount = randomInt(rng, minPeakCount, maxPeakCount);
    const turningPointTimes = buildTurningPointTimes(
      rng,
      peakCount,
      preCrashEndPct,
      Math.max(initialClimbPct, minPeakDelayPct)
    );
    const turningPointValues = buildTurningPointValues(
      rng,
      peakCount,
      minBoostPct,
      maxBoostPct,
      turningPointTimes,
      Math.max(initialClimbPct, minPeakDelayPct),
      startingFloorValue
    );

    fillCheckpointValuesFromTurningPoints(
      checkpoints,
      turningPointTimes,
      turningPointValues,
      preCrashLastIndex,
      minBoostPct,
      maxBoostPct
    );
    fillPostCrashTail(
      checkpoints,
      preCrashLastIndex,
      minBoostPct,
      maxBoostPct
    );
  }

  applyStartDirectionBias(checkpoints, seed, {
    minBoostPct,
    maxBoostPct,
    ticketStrength,
  });
  enforceInitialClimb(checkpoints, {
    minBoostPct,
    maxBoostPct,
    durationSeconds,
    crashPct,
    initialClimbSeconds: 2,
  });
  enforcePeakDelayWithoutFlattening(checkpoints, {
    minBoostPct,
    maxBoostPct,
    crashPct,
    durationSeconds,
    minPeakDelaySeconds,
    seed,
  });
  enforcePreCrashFloor(checkpoints, {
    minBoostPct,
    maxBoostPct,
    crashPct,
    floorValue: startingFloorValue,
  });
  enforceUniquePreCrashMaximum(checkpoints, {
    minBoostPct,
    maxBoostPct,
    crashPct,
  });
  enforceNoFlatSegmentsBeforeCrash(checkpoints, {
    minBoostPct,
    maxBoostPct,
    crashPct,
    minPreCrashValue: startingFloorValue,
  });
  enforceCrashPhaseNearBoundary(checkpoints, {
    minBoostPct,
    maxBoostPct,
    crashPct: effectiveCrashPct,
    floorValue: startingFloorValue,
    crashPhase,
  });

  const lastIndex = checkpoints.length - 1;
  checkpoints[lastIndex].baseBoostValue = 0;

  return { checkpoints, seed };
}

function generateLinearCheckpointValues(
  checkpoints: RideCheckpoint[],
  options: {
    crashPct: number;
    minBoostPct: number;
    maxBoostPct: number;
    startValue: number;
  }
): void {
  if (checkpoints.length < 2) {
    return;
  }

  const preCrashLastIndex = getPreCrashLastCheckpointIndex(checkpoints, options.crashPct);
  const firstTimePct = checkpoints[0].timeOffsetPct;
  const preCrashTimePct = checkpoints[preCrashLastIndex].timeOffsetPct;
  const preCrashDenominator = Math.max(preCrashTimePct - firstTimePct, 0.000001);
  const startValue = clampValue(options.startValue, options.minBoostPct, options.maxBoostPct);
  const peakValue = options.maxBoostPct;

  for (let i = 0; i <= preCrashLastIndex; i++) {
    const progress = clampValue(
      (checkpoints[i].timeOffsetPct - firstTimePct) / preCrashDenominator,
      0,
      1
    );
    const target = startValue + ((peakValue - startValue) * progress);
    checkpoints[i].baseBoostValue = roundToDecimals(
      clampValue(target, options.minBoostPct, options.maxBoostPct),
      6
    );
  }

  for (let i = preCrashLastIndex + 1; i < checkpoints.length - 1; i++) {
    checkpoints[i].baseBoostValue = 0;
  }
}

function initializeCheckpoints(
  checkpointCount: number,
  minBoostPct: number,
  maxBoostPct: number,
  ticketStrength: number
): RideCheckpoint[] {
  const startValue = deriveStartBoostValue(minBoostPct, maxBoostPct, ticketStrength);
  const checkpoints: RideCheckpoint[] = [];

  for (let i = 0; i < checkpointCount; i++) {
    checkpoints.push({
      index: i,
      timeOffsetPct: roundToDecimals(i / (checkpointCount - 1), 6),
      baseBoostValue: i === checkpointCount - 1
        ? 0
        : roundToDecimals(startValue, 6),
    });
  }

  return checkpoints;
}

function deriveStartBoostValue(
  minBoostPct: number,
  maxBoostPct: number,
  ticketStrength: number
): number {
  const range = Math.max(maxBoostPct - minBoostPct, 0);
  const strength = clampValue(ticketStrength, 0, 1);
  // Keep start close to min boost while still allowing stronger tickets a slightly higher launch point.
  const startOffsetPct = 0.01 + (Math.pow(strength, 0.85) * 0.14);
  return roundToDecimals(minBoostPct + (range * startOffsetPct), 6);
}

function getInitialClimbPct(
  durationSeconds: number | undefined,
  preCrashEndPct: number,
  seconds: number
): number {
  if (!durationSeconds || durationSeconds <= 0 || seconds <= 0) {
    return 0;
  }

  const rawPct = seconds / durationSeconds;
  const cap = Math.max(preCrashEndPct - 0.000001, 0);
  return clampValue(rawPct, 0, cap);
}

function buildTurningPointTimes(
  rng: SeededRandom,
  peakCount: number,
  preCrashEndPct: number,
  minFirstPeakPct: number
): number[] {
  const nodeCount = peakCount * 2 + 1;
  const lastNodeIndex = nodeCount - 1;
  const times: number[] = new Array(nodeCount).fill(0);
  times[0] = 0;
  times[lastNodeIndex] = preCrashEndPct;

  if (nodeCount <= 2) {
    return times;
  }

  const baseSegment = preCrashEndPct / (nodeCount - 1);
  // Keep turning points reasonably separated to avoid repeated "horn" micro-peaks.
  const minGap = Math.max(baseSegment * 0.5, preCrashEndPct * 0.015, 0.001);
  const jitterSpan = baseSegment * 0.28;

  for (let i = 1; i < lastNodeIndex; i++) {
    const base = baseSegment * i;
    const jitter = (rng.next() - 0.5) * jitterSpan;
    times[i] = base + jitter;
  }

  enforceSortedTimes(times, minGap, preCrashEndPct);

  if (nodeCount > 2) {
    const firstPeakMin = clampValue(
      minFirstPeakPct + 0.000001,
      minGap,
      preCrashEndPct - (minGap * (lastNodeIndex - 1))
    );
    if (times[1] < firstPeakMin) {
      times[1] = firstPeakMin;
      for (let i = 2; i < lastNodeIndex; i++) {
        times[i] = Math.max(times[i], times[i - 1] + minGap);
      }
      for (let i = lastNodeIndex - 1; i >= 1; i--) {
        const maxAllowed = preCrashEndPct - (minGap * (lastNodeIndex - i));
        times[i] = Math.min(times[i], maxAllowed);
      }
      enforceSortedTimes(times, minGap, preCrashEndPct);
    }
  }

  times[0] = 0;
  times[lastNodeIndex] = preCrashEndPct;
  return times;
}

function enforceSortedTimes(times: number[], minGap: number, maxValue: number): void {
  const lastNodeIndex = times.length - 1;
  for (let i = 1; i < lastNodeIndex; i++) {
    const minAllowed = times[i - 1] + minGap;
    const maxAllowed = maxValue - (minGap * (lastNodeIndex - i));
    times[i] = clampValue(times[i], minAllowed, Math.max(minAllowed, maxAllowed));
  }

  for (let i = lastNodeIndex - 1; i >= 1; i--) {
    const maxAllowed = times[i + 1] - minGap;
    times[i] = Math.min(times[i], maxAllowed);
    const minAllowed = times[i - 1] + minGap;
    times[i] = Math.max(times[i], minAllowed);
  }
}

function buildTurningPointValues(
  rng: SeededRandom,
  peakCount: number,
  minBoostPct: number,
  maxBoostPct: number,
  turningPointTimes: number[],
  minPeakDelayPct: number,
  startingFloorValue: number
): number[] {
  const nodeCount = turningPointTimes.length;
  const values: number[] = new Array(nodeCount).fill(minBoostPct);
  const range = Math.max(maxBoostPct - minBoostPct, 0);
  const minDelta = Math.max(range * 0.05, 0.0005);

  if (range <= 0) {
    return values;
  }

  const peakNodeIndexes: number[] = [];
  for (let i = 1; i < nodeCount; i += 2) {
    peakNodeIndexes.push(i);
  }

  const highestPeakNode = pickHighestPeakNode(
    rng,
    peakNodeIndexes,
    turningPointTimes,
    minPeakDelayPct
  );

  const peakLevels = new Map<number, number>();
  // Pull max-peak away from the hard ceiling to reduce early cap hugging.
  const highestLevel = 0.68 + (rng.next() * 0.24);
  for (const peakNodeIndex of peakNodeIndexes) {
    if (peakNodeIndex === highestPeakNode) {
      peakLevels.set(peakNodeIndex, highestLevel);
      continue;
    }

    const peakLevel = 0.42 + (rng.next() * 0.34);
    peakLevels.set(peakNodeIndex, Math.min(peakLevel, highestLevel - (0.05 + (rng.next() * 0.08))));
  }

  values[0] = startingFloorValue;

  for (let i = 1; i < nodeCount; i++) {
    if (i % 2 === 1) {
      const peakLevel = peakLevels.get(i) ?? 0.6;
      values[i] = minBoostPct + (peakLevel * range);
      continue;
    }

    const isFinalValley = i === nodeCount - 1;
    // Allow deeper and more varied valleys so downswings are visibly volatile.
    const valleyLevel = isFinalValley
      ? 0.02 + (rng.next() * 0.18)
      : 0.04 + (rng.next() * 0.34);
    values[i] = Math.max(startingFloorValue, minBoostPct + (valleyLevel * range));
  }

  for (let i = 0; i < nodeCount - 1; i++) {
    const expectedUp = i % 2 === 0;
    if (expectedUp && values[i + 1] <= values[i] + minDelta) {
      values[i + 1] = Math.min(maxBoostPct, values[i] + minDelta);
    }
    if (!expectedUp && values[i + 1] >= values[i] - minDelta) {
      values[i + 1] = Math.max(minBoostPct, values[i] - minDelta);
    }
  }

  let peakMax = Number.NEGATIVE_INFINITY;
  for (const peakNodeIndex of peakNodeIndexes) {
    peakMax = Math.max(peakMax, values[peakNodeIndex]);
  }
  const tieThreshold = Math.max(range * 0.0001, 0.000001);
  let hasSeenMax = false;
  for (const peakNodeIndex of peakNodeIndexes) {
    if (Math.abs(values[peakNodeIndex] - peakMax) > tieThreshold) {
      continue;
    }
    if (!hasSeenMax) {
      hasSeenMax = true;
      continue;
    }
    values[peakNodeIndex] = Math.max(minBoostPct, values[peakNodeIndex] - (range * 0.01));
  }

  return values.map((value) => roundToDecimals(clampValue(value, minBoostPct, maxBoostPct), 6));
}

function pickHighestPeakNode(
  rng: SeededRandom,
  peakNodeIndexes: number[],
  turningPointTimes: number[],
  minPeakDelayPct: number
): number {
  if (peakNodeIndexes.length === 0) {
    return 0;
  }

  const eligibleHighest = peakNodeIndexes.filter((index) => turningPointTimes[index] >= minPeakDelayPct);
  let candidates = eligibleHighest.length > 0 ? eligibleHighest : peakNodeIndexes;

  // Bias away from the first peak so "stop immediately" isn't consistently dominant.
  if (candidates.length > 1) {
    const firstPeakIndex = peakNodeIndexes[0];
    const nonFirst = candidates.filter((index) => index !== firstPeakIndex);
    if (nonFirst.length > 0 && rng.next() < 0.75) {
      candidates = nonFirst;
    }
  }

  return candidates[randomInt(rng, 0, candidates.length - 1)];
}

function fillCheckpointValuesFromTurningPoints(
  checkpoints: RideCheckpoint[],
  turningPointTimes: number[],
  turningPointValues: number[],
  preCrashLastIndex: number,
  minBoostPct: number,
  maxBoostPct: number
): void {
  for (let i = 0; i <= preCrashLastIndex; i++) {
    const timePct = checkpoints[i].timeOffsetPct;
    const value = interpolateTurningPointValue(
      turningPointTimes,
      turningPointValues,
      timePct
    );
    checkpoints[i].baseBoostValue = roundToDecimals(
      clampValue(value, minBoostPct, maxBoostPct),
      6
    );
  }
}

function interpolateTurningPointValue(
  turningPointTimes: number[],
  turningPointValues: number[],
  timePct: number
): number {
  const lastNodeIndex = turningPointTimes.length - 1;
  if (timePct <= turningPointTimes[0]) {
    return turningPointValues[0];
  }
  if (timePct >= turningPointTimes[lastNodeIndex]) {
    return turningPointValues[lastNodeIndex];
  }

  for (let i = 0; i < lastNodeIndex; i++) {
    const start = turningPointTimes[i];
    const end = turningPointTimes[i + 1];
    if (timePct < start || timePct > end) {
      continue;
    }
    const segmentPct = (timePct - start) / Math.max(end - start, 0.000001);
    const eased = 0.5 - (0.5 * Math.cos(Math.PI * segmentPct));
    const from = turningPointValues[i];
    const to = turningPointValues[i + 1];
    return from + ((to - from) * eased);
  }

  return turningPointValues[lastNodeIndex];
}

function fillPostCrashTail(
  checkpoints: RideCheckpoint[],
  preCrashLastIndex: number,
  minBoostPct: number,
  maxBoostPct: number
): void {
  if (preCrashLastIndex >= checkpoints.length - 2) {
    return;
  }

  const startValue = checkpoints[preCrashLastIndex].baseBoostValue;
  const startTimePct = checkpoints[preCrashLastIndex].timeOffsetPct;
  for (let i = preCrashLastIndex + 1; i < checkpoints.length - 1; i++) {
    const denom = Math.max(1 - startTimePct, 0.000001);
    const progress = (checkpoints[i].timeOffsetPct - startTimePct) / denom;
    const eased = progress * progress;
    const target = startValue * (1 - eased);
    checkpoints[i].baseBoostValue = roundToDecimals(
      clampValue(target, minBoostPct * 0.1, maxBoostPct),
      6
    );
  }
}

interface PeakDelayEnforcementOptions {
  minBoostPct: number;
  maxBoostPct: number;
  durationSeconds?: number;
  crashPct?: number;
  minPeakDelaySeconds: number;
  seed?: string;
}

function enforcePeakDelayWithoutFlattening(
  checkpoints: RideCheckpoint[],
  options: PeakDelayEnforcementOptions
): void {
  if (checkpoints.length < 3 || !options.durationSeconds || options.durationSeconds <= 0) {
    return;
  }

  const minPeakDelayPct = options.minPeakDelaySeconds / options.durationSeconds;
  const effectiveCrashPct = clampValue(options.crashPct ?? 1, 0.01, 1);
  if (minPeakDelayPct <= 0 || minPeakDelayPct >= effectiveCrashPct) {
    return;
  }

  let maxIndex = -1;
  let maxValue = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < checkpoints.length; i++) {
    const checkpoint = checkpoints[i];
    if (checkpoint.timeOffsetPct >= effectiveCrashPct) {
      break;
    }
    if (checkpoint.baseBoostValue > maxValue) {
      maxValue = checkpoint.baseBoostValue;
      maxIndex = i;
    }
  }

  if (maxIndex < 0 || checkpoints[maxIndex].timeOffsetPct >= minPeakDelayPct) {
    return;
  }

  const candidateIndexes: number[] = [];
  for (let i = 0; i < checkpoints.length; i++) {
    const timePct = checkpoints[i].timeOffsetPct;
    if (timePct >= effectiveCrashPct) {
      break;
    }
    if (timePct >= minPeakDelayPct) {
      candidateIndexes.push(i);
    }
  }

  if (candidateIndexes.length === 0) {
    return;
  }

  const range = Math.max(options.maxBoostPct - options.minBoostPct, 0);
  const epsilon = Math.max(range * 0.01, 0.0005);
  const rng = new SeededRandom(`peak-delay-promote:${options.seed ?? ''}`);
  const promoteIndex = candidateIndexes[randomInt(rng, 0, candidateIndexes.length - 1)];
  const promoted = clampValue(maxValue + epsilon, options.minBoostPct, options.maxBoostPct);
  checkpoints[promoteIndex].baseBoostValue = roundToDecimals(promoted, 6);
}

interface UniqueMaxOptions {
  minBoostPct: number;
  maxBoostPct: number;
  crashPct?: number;
}

interface PreCrashFloorOptions {
  minBoostPct: number;
  maxBoostPct: number;
  crashPct?: number;
  floorValue: number;
}

function enforcePreCrashFloor(
  checkpoints: RideCheckpoint[],
  options: PreCrashFloorOptions
): void {
  if (checkpoints.length < 2) {
    return;
  }

  const preCrashLastIndex = getPreCrashLastCheckpointIndex(checkpoints, options.crashPct);
  if (preCrashLastIndex < 1) {
    return;
  }

  const floor = clampValue(options.floorValue, options.minBoostPct, options.maxBoostPct);
  for (let i = 1; i <= preCrashLastIndex; i++) {
    if (checkpoints[i].baseBoostValue < floor) {
      checkpoints[i].baseBoostValue = roundToDecimals(floor, 6);
    }
  }
}

function enforceUniquePreCrashMaximum(
  checkpoints: RideCheckpoint[],
  options: UniqueMaxOptions
): void {
  if (checkpoints.length < 3) {
    return;
  }

  const preCrashLastIndex = getPreCrashLastCheckpointIndex(checkpoints, options.crashPct);
  if (preCrashLastIndex < 1) {
    return;
  }

  let maxValue = Number.NEGATIVE_INFINITY;
  for (let i = 0; i <= preCrashLastIndex; i++) {
    maxValue = Math.max(maxValue, checkpoints[i].baseBoostValue);
  }

  const range = Math.max(options.maxBoostPct - options.minBoostPct, 0);
  const threshold = Math.max(range * 0.0001, 0.000001);
  const epsilon = Math.max(range * 0.008, 0.0002);
  let seenMax = false;
  let duplicateOrder = 0;

  for (let i = 0; i <= preCrashLastIndex; i++) {
    if (Math.abs(checkpoints[i].baseBoostValue - maxValue) > threshold) {
      continue;
    }
    if (!seenMax) {
      seenMax = true;
      continue;
    }

    duplicateOrder += 1;
    const lowered = clampValue(
      maxValue - (epsilon * duplicateOrder),
      options.minBoostPct,
      options.maxBoostPct
    );
    checkpoints[i].baseBoostValue = roundToDecimals(lowered, 6);
  }
}

function randomInt(rng: SeededRandom, min: number, max: number): number {
  if (max <= min) {
    return min;
  }
  return Math.floor(rng.nextRange(min, max + 1));
}

/**
 * Interpolates the current boost value given elapsed time percentage.
 * Uses linear interpolation between checkpoints.
 *
 * @param checkpoints - Array of ride checkpoints
 * @param elapsedPct - Elapsed time as percentage (0-1)
 * @returns Interpolated boost value
 */
export function interpolateRideValue(
  checkpoints: RideCheckpoint[],
  elapsedPct: number
): number {
  if (checkpoints.length === 0) {
    return 0;
  }

  // Clamp elapsed percentage
  const pct = Math.max(0, Math.min(1, elapsedPct));

  // Handle edge cases
  if (pct <= checkpoints[0].timeOffsetPct) {
    return checkpoints[0].baseBoostValue;
  }

  if (pct >= checkpoints[checkpoints.length - 1].timeOffsetPct) {
    return checkpoints[checkpoints.length - 1].baseBoostValue;
  }

  // Find surrounding checkpoints for interpolation
  let lowerIdx = 0;
  for (let i = 0; i < checkpoints.length - 1; i++) {
    if (checkpoints[i].timeOffsetPct <= pct && checkpoints[i + 1].timeOffsetPct > pct) {
      lowerIdx = i;
      break;
    }
  }

  const lower = checkpoints[lowerIdx];
  const upper = checkpoints[lowerIdx + 1];

  // Linear interpolation
  const segmentPct = (pct - lower.timeOffsetPct) / (upper.timeOffsetPct - lower.timeOffsetPct);
  const interpolatedValue = lower.baseBoostValue + segmentPct * (upper.baseBoostValue - lower.baseBoostValue);

  return roundToDecimals(interpolatedValue, 6);
}

/**
 * Calculates the elapsed time percentage for a reward.
 *
 * @param startTime - Ride start time (ISO string or Date)
 * @param endTime - Ride end time (ISO string or Date)
 * @param currentTime - Current time (ISO string or Date), defaults to now
 * @returns Elapsed percentage (0-1+, can exceed 1 if past end time)
 */
export function calculateElapsedPct(
  startTime: string | Date,
  endTime: string | Date,
  currentTime?: string | Date
): number {
  const start = new Date(startTime).getTime();
  const end = new Date(endTime).getTime();
  const current = currentTime ? new Date(currentTime).getTime() : Date.now();

  const totalDuration = end - start;
  if (totalDuration <= 0) {
    return 1;
  }

  const elapsed = current - start;
  return elapsed / totalDuration;
}

/**
 * Checks if the ride has ended (elapsed >= 100%).
 */
export function hasRideEnded(
  startTime: string | Date,
  endTime: string | Date,
  currentTime?: string | Date
): boolean {
  return calculateElapsedPct(startTime, endTime, currentTime) >= 1;
}

function roundToDecimals(value: number, decimals: number): number {
  const factor = Math.pow(10, decimals);
  return Math.round(value * factor) / factor;
}

function clampValue(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

interface StartBiasOptions {
  minBoostPct: number;
  maxBoostPct: number;
  ticketStrength: number;
}

function applyStartDirectionBias(
  checkpoints: RideCheckpoint[],
  seed: string,
  options: StartBiasOptions
): void {
  if (checkpoints.length < 2) {
    return;
  }

  const strength = clampValue(options.ticketStrength, 0, 1);
  if (strength <= 0) {
    return;
  }

  const first = checkpoints[0];
  const second = checkpoints[1];
  if (second.baseBoostValue > first.baseBoostValue) {
    return;
  }

  // Stronger tickets get a higher chance to flip an opening downswing into an upswing.
  const rng = new SeededRandom(`start-bias:${seed}`);
  const flipChance = 0.7 * strength;
  if (rng.next() >= flipChance) {
    return;
  }

  const range = Math.max(options.maxBoostPct - options.minBoostPct, 0);
  const step = Math.max(range * 0.03, 0.000001);

  let newFirst = first.baseBoostValue;
  let newSecond = Math.min(options.maxBoostPct, first.baseBoostValue + step);

  if (newSecond <= newFirst) {
    newFirst = Math.max(options.minBoostPct, first.baseBoostValue - step);
    newSecond = Math.min(options.maxBoostPct, newFirst + step);
  }

  checkpoints[0].baseBoostValue = roundToDecimals(newFirst, 6);
  checkpoints[1].baseBoostValue = roundToDecimals(newSecond, 6);
}

function getPreCrashLastCheckpointIndex(
  checkpoints: RideCheckpoint[],
  crashPct?: number
): number {
  const effectiveCrashPct = clampValue(crashPct ?? 1, 0.01, 1);
  let lastIndex = checkpoints.length - 2; // Keep final crash endpoint out.

  for (let i = 0; i < checkpoints.length; i++) {
    if (checkpoints[i].timeOffsetPct >= effectiveCrashPct) {
      lastIndex = i - 1;
      break;
    }
  }

  return Math.max(1, Math.min(lastIndex, checkpoints.length - 2));
}

function inferDirection(
  checkpoints: RideCheckpoint[],
  startIndex: number,
  preCrashLastIndex: number,
  threshold: number
): number {
  for (let i = startIndex + 1; i <= preCrashLastIndex; i++) {
    const direction = directionOf(
      checkpoints[i].baseBoostValue - checkpoints[i - 1].baseBoostValue,
      threshold
    );
    if (direction !== 0) {
      return direction;
    }
  }
  return 1;
}

function directionOf(delta: number, threshold: number): number {
  if (delta > threshold) return 1;
  if (delta < -threshold) return -1;
  return 0;
}

interface InitialClimbOptions {
  minBoostPct: number;
  maxBoostPct: number;
  durationSeconds?: number;
  crashPct?: number;
  initialClimbSeconds: number;
}

function enforceInitialClimb(
  checkpoints: RideCheckpoint[],
  options: InitialClimbOptions
): void {
  if (checkpoints.length < 2 || !options.durationSeconds || options.durationSeconds <= 0) {
    return;
  }

  if (options.initialClimbSeconds <= 0) {
    return;
  }

  const effectiveCrashPct = clampValue(options.crashPct ?? 1, 0.01, 1);
  const initialClimbPct = options.initialClimbSeconds / options.durationSeconds;
  const climbEndPct = Math.min(initialClimbPct, effectiveCrashPct - 0.000001);
  if (climbEndPct <= 0) {
    return;
  }

  const range = Math.max(options.maxBoostPct - options.minBoostPct, 0);
  const preBoundaryCap = Math.max(options.minBoostPct, options.maxBoostPct - Math.max(range * 0.005, 0.000001));
  const beforeBoundaryIndexes: number[] = [];
  let boundaryIndex = -1;

  for (let i = 1; i < checkpoints.length; i++) {
    const timePct = checkpoints[i].timeOffsetPct;
    if (timePct >= effectiveCrashPct) {
      break;
    }
    if (timePct < climbEndPct) {
      beforeBoundaryIndexes.push(i);
      continue;
    }
    boundaryIndex = i;
    break;
  }

  if (beforeBoundaryIndexes.length === 0 && boundaryIndex < 1) {
    return;
  }

  const defaultStep = Math.max(range * 0.004, 0.00001);
  const availableHeadroom = Math.max(preBoundaryCap - checkpoints[0].baseBoostValue, 0);
  const adaptiveStep = beforeBoundaryIndexes.length > 0
    ? Math.max(Math.min(defaultStep, availableHeadroom / (beforeBoundaryIndexes.length + 1)), 0.000001)
    : defaultStep;

  if (beforeBoundaryIndexes.length > 0) {
    const requiredHeadroom = adaptiveStep * (beforeBoundaryIndexes.length + 1);
    const maxStart = preBoundaryCap - requiredHeadroom;
    if (checkpoints[0].baseBoostValue > maxStart) {
      checkpoints[0].baseBoostValue = roundToDecimals(
        clampValue(maxStart, options.minBoostPct, preBoundaryCap - adaptiveStep),
        6
      );
    }

    let prev = checkpoints[0].baseBoostValue;
    for (let i = 0; i < beforeBoundaryIndexes.length; i++) {
      const checkpointIndex = beforeBoundaryIndexes[i];
      const remaining = beforeBoundaryIndexes.length - i - 1;
      const minForPoint = prev + adaptiveStep;
      const maxForPoint = preBoundaryCap - adaptiveStep * (remaining + 1);
      const upperBound = Math.max(minForPoint, maxForPoint);
      const target = clampValue(
        checkpoints[checkpointIndex].baseBoostValue,
        minForPoint,
        upperBound
      );
      checkpoints[checkpointIndex].baseBoostValue = roundToDecimals(target, 6);
      prev = checkpoints[checkpointIndex].baseBoostValue;
    }
  }

  if (boundaryIndex > 0) {
    const prev = checkpoints[boundaryIndex - 1].baseBoostValue;
    let boundaryTarget = Math.max(
      checkpoints[boundaryIndex].baseBoostValue,
      prev + adaptiveStep
    );
    boundaryTarget = clampValue(boundaryTarget, options.minBoostPct, options.maxBoostPct);

    if (boundaryTarget <= prev) {
      const nudge = Math.min(options.maxBoostPct - prev, 0.000001);
      boundaryTarget = nudge > 0 ? prev + nudge : prev;
    }

    checkpoints[boundaryIndex].baseBoostValue = roundToDecimals(boundaryTarget, 6);
  }
}

interface FlatSegmentOptions {
  minBoostPct: number;
  maxBoostPct: number;
  crashPct?: number;
  minPreCrashValue?: number;
}

function enforceNoFlatSegmentsBeforeCrash(
  checkpoints: RideCheckpoint[],
  options: FlatSegmentOptions
): void {
  if (checkpoints.length < 3) {
    return;
  }

  const preCrashLastIndex = getPreCrashLastCheckpointIndex(checkpoints, options.crashPct);
  if (preCrashLastIndex < 1) {
    return;
  }

  const range = Math.max(options.maxBoostPct - options.minBoostPct, 0);
  const threshold = Math.max(range * 0.0005, 0.000001);
  const step = Math.max(range * 0.006, 0.00001);
  const minPreCrashValue = clampValue(
    options.minPreCrashValue ?? options.minBoostPct,
    options.minBoostPct,
    options.maxBoostPct
  );

  for (let i = 1; i <= preCrashLastIndex; i++) {
    const prev = checkpoints[i - 1].baseBoostValue;
    const curr = checkpoints[i].baseBoostValue;
    if (Math.abs(curr - prev) > threshold) {
      continue;
    }

    let direction = inferDirection(checkpoints, i, preCrashLastIndex, threshold);
    if (direction === 0) {
      direction = 1;
    }

    let adjusted = clampValue(
      prev + (direction * step),
      minPreCrashValue,
      options.maxBoostPct
    );

    if (Math.abs(adjusted - prev) <= threshold) {
      adjusted = clampValue(
        prev - (direction * step),
        minPreCrashValue,
        options.maxBoostPct
      );
    }

    if (Math.abs(adjusted - prev) <= threshold) {
      const nudge = direction > 0 ? 0.000001 : -0.000001;
      adjusted = clampValue(prev + nudge, minPreCrashValue, options.maxBoostPct);
    }

    checkpoints[i].baseBoostValue = roundToDecimals(adjusted, 6);
  }
}

interface CrashPhaseBoundaryOptions {
  minBoostPct: number;
  maxBoostPct: number;
  crashPct?: number;
  floorValue: number;
  crashPhase: CrashPhase;
}

function enforceCrashPhaseNearBoundary(
  checkpoints: RideCheckpoint[],
  options: CrashPhaseBoundaryOptions
): void {
  if (checkpoints.length < 3) {
    return;
  }

  const preCrashLastIndex = getPreCrashLastCheckpointIndex(checkpoints, options.crashPct);
  if (preCrashLastIndex < 1) {
    return;
  }

  const previousIndex = preCrashLastIndex - 1;
  const range = Math.max(options.maxBoostPct - options.minBoostPct, 0);
  const floor = clampValue(options.floorValue, options.minBoostPct, options.maxBoostPct);
  const step = Math.max(range * 0.015, 0.00025);
  const peakStep = Math.max(range * 0.002, 0.00005);

  let previousValue = checkpoints[previousIndex].baseBoostValue;
  let currentValue = checkpoints[preCrashLastIndex].baseBoostValue;

  if (options.crashPhase === 'UP') {
    if (currentValue <= previousValue + peakStep) {
      if (previousValue >= options.maxBoostPct - step) {
        previousValue = clampValue(previousValue - step, floor, options.maxBoostPct);
        checkpoints[previousIndex].baseBoostValue = roundToDecimals(previousValue, 6);
      }
      currentValue = clampValue(previousValue + step, floor, options.maxBoostPct);
      checkpoints[preCrashLastIndex].baseBoostValue = roundToDecimals(currentValue, 6);
    }
    return;
  }

  if (options.crashPhase === 'DOWN') {
    if (currentValue >= previousValue - peakStep) {
      if (previousValue <= floor + step) {
        previousValue = clampValue(previousValue + step, floor, options.maxBoostPct);
        checkpoints[previousIndex].baseBoostValue = roundToDecimals(previousValue, 6);
      }
      currentValue = clampValue(previousValue - step, floor, options.maxBoostPct);
      checkpoints[preCrashLastIndex].baseBoostValue = roundToDecimals(currentValue, 6);
    }
    return;
  }

  // PEAK zone: keep pre-crash value very close to the previous point (near top zone),
  // while avoiding an exact flat segment.
  const target = clampValue(previousValue + peakStep, floor, options.maxBoostPct);
  checkpoints[preCrashLastIndex].baseBoostValue = roundToDecimals(target, 6);
}
