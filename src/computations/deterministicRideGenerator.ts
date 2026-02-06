import { createHash } from 'crypto';

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

export interface GeneratedRide {
  checkpoints: RideCheckpoint[];
  seed: string;
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
  const rng = new SeededRandom(`crash:${seed}`);
  const alpha = 10;
  const beta = 5;
  const sample = betaSample(rng, alpha, beta);
  const crashSeconds = minCrash + sample * Math.max(durationSeconds - minCrash, 0);
  const crashPct = crashSeconds / durationSeconds;
  return roundToDecimals(clampValue(crashPct, 0.01, 0.99), 4);
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

  const effectiveCrashPct = clampValue(crashPct ?? 1, 0.01, 0.99);
  const preCrashLastIndex = getPreCrashLastCheckpointIndex(checkpoints, effectiveCrashPct);

  if (preCrashLastIndex >= 1) {
    const preCrashEndPct = checkpoints[preCrashLastIndex].timeOffsetPct;
    const initialClimbPct = getInitialClimbPct(durationSeconds, preCrashEndPct, 2);
    const minPeakDelayPct = getInitialClimbPct(durationSeconds, preCrashEndPct, minPeakDelaySeconds);
    const peakCapByPoints = Math.max(1, Math.floor((preCrashLastIndex + 1 - 1) / 2));
    const peakCount = randomInt(rng, 1, Math.min(4, peakCapByPoints));
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

  const lastIndex = checkpoints.length - 1;
  checkpoints[lastIndex].baseBoostValue = 0;

  return { checkpoints, seed };
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
  const minGap = Math.max(baseSegment * 0.35, preCrashEndPct * 0.01, 0.0005);
  const jitterSpan = baseSegment * 0.45;

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

  let highestPeakNode = peakNodeIndexes[0];
  const eligibleHighest = peakNodeIndexes.filter((index) => turningPointTimes[index] >= minPeakDelayPct);
  if (eligibleHighest.length > 0) {
    highestPeakNode = eligibleHighest[randomInt(rng, 0, eligibleHighest.length - 1)];
  }

  const peakLevels = new Map<number, number>();
  const highestLevel = 0.86 + (rng.next() * 0.12);
  for (const peakNodeIndex of peakNodeIndexes) {
    if (peakNodeIndex === highestPeakNode) {
      peakLevels.set(peakNodeIndex, highestLevel);
      continue;
    }

    const peakLevel = 0.52 + (rng.next() * 0.28);
    peakLevels.set(peakNodeIndex, Math.min(peakLevel, highestLevel - (0.03 + (rng.next() * 0.05))));
  }

  values[0] = startingFloorValue;

  for (let i = 1; i < nodeCount; i++) {
    if (i % 2 === 1) {
      const peakLevel = peakLevels.get(i) ?? 0.6;
      values[i] = minBoostPct + (peakLevel * range);
      continue;
    }

    const isFinalValley = i === nodeCount - 1;
    const valleyLevel = isFinalValley
      ? 0.1 + (rng.next() * 0.16)
      : 0.18 + (rng.next() * 0.18);
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
  const effectiveCrashPct = clampValue(options.crashPct ?? 1, 0.01, 0.99);
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

function normalSample(rng: SeededRandom, mean: number, stdDev: number): number {
  // Box-Muller transform
  let u = 0;
  let v = 0;
  while (u === 0) u = rng.next();
  while (v === 0) v = rng.next();
  const z = Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
  return mean + z * stdDev;
}

function gammaSample(rng: SeededRandom, shape: number): number {
  if (shape <= 0) {
    return 0;
  }

  if (shape < 1) {
    // Use boost: Gamma(k) = Gamma(k+1) * U^(1/k)
    const u = rng.next();
    return gammaSample(rng, shape + 1) * Math.pow(u, 1 / shape);
  }

  // Marsaglia and Tsang method for shape >= 1
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);

  while (true) {
    const x = normalSample(rng, 0, 1);
    const v = 1 + c * x;
    if (v <= 0) continue;
    const v3 = v * v * v;
    const u = rng.next();
    if (u < 1 - 0.0331 * x * x * x * x) {
      return d * v3;
    }
    if (Math.log(u) < 0.5 * x * x + d * (1 - v3 + Math.log(v3))) {
      return d * v3;
    }
  }
}

function betaSample(rng: SeededRandom, alpha: number, beta: number): number {
  const x = gammaSample(rng, alpha);
  const y = gammaSample(rng, beta);
  if (x + y === 0) {
    return 0.5;
  }
  return x / (x + y);
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

interface PeakDelayOptions {
  minBoostPct: number;
  maxBoostPct: number;
  durationSeconds?: number;
  crashPct?: number;
  minPeakDelaySeconds: number;
  seed?: string;
}

function enforceMinPeakDelay(
  checkpoints: RideCheckpoint[],
  options: PeakDelayOptions
): void {
  if (checkpoints.length < 2 || !options.durationSeconds || options.durationSeconds <= 0) {
    return;
  }

  if (options.minPeakDelaySeconds <= 0) {
    return;
  }

  const effectiveCrashPct = clampValue(options.crashPct ?? 1, 0.01, 0.99);
  const earliestPeakPct = options.minPeakDelaySeconds / options.durationSeconds;

  if (earliestPeakPct <= 0 || earliestPeakPct >= effectiveCrashPct) {
    return;
  }

  const earlyIndexes: number[] = [];
  const postIndexes: number[] = [];

  for (let i = 0; i < checkpoints.length; i++) {
    const timePct = checkpoints[i].timeOffsetPct;
    if (timePct >= effectiveCrashPct) {
      break;
    }
    if (timePct < earliestPeakPct) {
      earlyIndexes.push(i);
      continue;
    }
    postIndexes.push(i);
  }

  if (postIndexes.length === 0 || earlyIndexes.length === 0) {
    return;
  }

  const epsilon = Math.max((options.maxBoostPct - options.minBoostPct) * 0.005, 0.000001);

  let earlyMax = Number.NEGATIVE_INFINITY;
  for (const index of earlyIndexes) {
    earlyMax = Math.max(earlyMax, checkpoints[index].baseBoostValue);
  }

  let postPeakIndex = postIndexes[0];
  let postMax = checkpoints[postPeakIndex].baseBoostValue;
  for (const index of postIndexes) {
    if (checkpoints[index].baseBoostValue > postMax) {
      postMax = checkpoints[index].baseBoostValue;
      postPeakIndex = index;
    }
  }

  if (postIndexes.length > 1 && options.seed) {
    const peakRng = new SeededRandom(`peak-anchor:${options.seed}`);
    const targetPeakPct = earliestPeakPct + ((effectiveCrashPct - earliestPeakPct) * (0.2 + peakRng.next() * 0.75));
    let anchoredPeakIndex = postIndexes[0];
    let closestDistance = Math.abs(checkpoints[anchoredPeakIndex].timeOffsetPct - targetPeakPct);

    for (const index of postIndexes) {
      const distance = Math.abs(checkpoints[index].timeOffsetPct - targetPeakPct);
      if (distance < closestDistance) {
        closestDistance = distance;
        anchoredPeakIndex = index;
      }
    }

    const bump = Math.max((options.maxBoostPct - options.minBoostPct) * (0.01 + (peakRng.next() * 0.04)), epsilon);
    const anchoredValue = clampValue(
      Math.max(
        checkpoints[anchoredPeakIndex].baseBoostValue,
        postMax + bump,
        earlyMax + epsilon
      ),
      options.minBoostPct,
      options.maxBoostPct
    );
    checkpoints[anchoredPeakIndex].baseBoostValue = roundToDecimals(anchoredValue, 6);
    postPeakIndex = anchoredPeakIndex;
    postMax = checkpoints[postPeakIndex].baseBoostValue;
  }

  if (postMax <= earlyMax) {
    const promoted = clampValue(
      earlyMax + epsilon,
      options.minBoostPct,
      options.maxBoostPct
    );
    checkpoints[postPeakIndex].baseBoostValue = roundToDecimals(promoted, 6);
    postMax = checkpoints[postPeakIndex].baseBoostValue;
  }

  const earlyCap = postMax - epsilon;
  for (const index of earlyIndexes) {
    const capped = Math.min(checkpoints[index].baseBoostValue, earlyCap);
    checkpoints[index].baseBoostValue = roundToDecimals(
      clampValue(capped, options.minBoostPct, options.maxBoostPct),
      6
    );
  }
}

interface DirectionRuleOptions {
  minBoostPct: number;
  maxBoostPct: number;
  crashPct?: number;
  targetPeakCount?: number;
  minRunLength: number;
}

function enforceRideDirectionRules(
  checkpoints: RideCheckpoint[],
  options: DirectionRuleOptions
): void {
  if (checkpoints.length < 4 || options.minRunLength <= 1) {
    return;
  }

  const preCrashLastIndex = getPreCrashLastCheckpointIndex(checkpoints, options.crashPct);
  if (preCrashLastIndex < 2) {
    return;
  }

  const range = Math.max(options.maxBoostPct - options.minBoostPct, 0);
  const threshold = Math.max(range * 0.0005, 0.000001);
  const minStep = Math.max(range * 0.01, 0.00001);

  enforceDirectionRunPass(checkpoints, preCrashLastIndex, threshold, minStep, options);
  enforceSingleMaxPreCrash(checkpoints, preCrashLastIndex, minStep, threshold, options);
  enforcePeakCount(checkpoints, preCrashLastIndex, threshold, options);
  enforceDirectionRunPass(checkpoints, preCrashLastIndex, threshold, minStep, options);
}

function getPreCrashLastCheckpointIndex(
  checkpoints: RideCheckpoint[],
  crashPct?: number
): number {
  const effectiveCrashPct = clampValue(crashPct ?? 1, 0.01, 0.99);
  let lastIndex = checkpoints.length - 2; // Keep final crash endpoint out.

  for (let i = 0; i < checkpoints.length; i++) {
    if (checkpoints[i].timeOffsetPct >= effectiveCrashPct) {
      lastIndex = i - 1;
      break;
    }
  }

  return Math.max(1, Math.min(lastIndex, checkpoints.length - 2));
}

function enforceDirectionRunPass(
  checkpoints: RideCheckpoint[],
  preCrashLastIndex: number,
  threshold: number,
  minStep: number,
  options: DirectionRuleOptions
): void {
  let currentDirection = 0;
  let runLength = 0;

  for (let i = 1; i <= preCrashLastIndex; i++) {
    const prev = checkpoints[i - 1].baseBoostValue;
    const curr = checkpoints[i].baseBoostValue;
    let direction = directionOf(curr - prev, threshold);

    if (direction === 0) {
      direction = currentDirection !== 0
        ? currentDirection
        : inferDirection(checkpoints, i, preCrashLastIndex, threshold);
    }

    if (currentDirection === 0) {
      currentDirection = direction;
      runLength = 1;
    } else if (direction !== currentDirection) {
      const remainingMoves = preCrashLastIndex - i + 1;
      if (runLength < options.minRunLength || remainingMoves < options.minRunLength) {
        direction = currentDirection;
        runLength += 1;
      } else {
        currentDirection = direction;
        runLength = 1;
      }
    } else {
      runLength += 1;
    }

    const desiredDelta = Math.max(Math.abs(curr - prev), minStep);
    let adjusted = clampValue(
      prev + currentDirection * desiredDelta,
      options.minBoostPct,
      options.maxBoostPct
    );

    if (Math.abs(adjusted - prev) <= threshold) {
      adjusted = clampValue(
        prev + currentDirection * minStep,
        options.minBoostPct,
        options.maxBoostPct
      );
    }

    checkpoints[i].baseBoostValue = roundToDecimals(adjusted, 6);
  }
}

function enforceSingleMaxPreCrash(
  checkpoints: RideCheckpoint[],
  preCrashLastIndex: number,
  minStep: number,
  threshold: number,
  options: DirectionRuleOptions
): void {
  let maxValue = Number.NEGATIVE_INFINITY;
  for (let i = 0; i <= preCrashLastIndex; i++) {
    if (checkpoints[i].baseBoostValue > maxValue) {
      maxValue = checkpoints[i].baseBoostValue;
    }
  }

  let seenMax = false;
  let duplicateCount = 0;
  for (let i = 0; i <= preCrashLastIndex; i++) {
    const value = checkpoints[i].baseBoostValue;
    if (Math.abs(value - maxValue) > threshold) {
      continue;
    }

    if (!seenMax) {
      seenMax = true;
      continue;
    }

    duplicateCount += 1;
    const lowered = clampValue(
      maxValue - (minStep * 0.5 * duplicateCount),
      options.minBoostPct,
      options.maxBoostPct
    );
    checkpoints[i].baseBoostValue = roundToDecimals(lowered, 6);
  }
}

function enforcePeakCount(
  checkpoints: RideCheckpoint[],
  preCrashLastIndex: number,
  threshold: number,
  options: DirectionRuleOptions
): void {
  const targetPeakCount = Math.max(1, options.targetPeakCount ?? 4);
  if (preCrashLastIndex < 3) {
    return;
  }

  let peaks = getPeakIndexes(checkpoints, preCrashLastIndex, threshold);
  let safety = 0;
  while (peaks.length > targetPeakCount && safety < 200) {
    safety += 1;
    let weakestPeakIndex = peaks[0];
    let weakestProminence = Number.POSITIVE_INFINITY;

    for (const peakIndex of peaks) {
      const prominence = checkpoints[peakIndex].baseBoostValue
        - Math.max(
            checkpoints[peakIndex - 1].baseBoostValue,
            checkpoints[peakIndex + 1].baseBoostValue
          );
      if (prominence < weakestProminence) {
        weakestProminence = prominence;
        weakestPeakIndex = peakIndex;
      }
    }

    smoothWindowAroundIndex(
      checkpoints,
      weakestPeakIndex,
      1,
      preCrashLastIndex
    );

    peaks = getPeakIndexes(checkpoints, preCrashLastIndex, threshold);
  }
}

function getPeakIndexes(
  checkpoints: RideCheckpoint[],
  preCrashLastIndex: number,
  threshold: number,
  minTimePct = 0
): number[] {
  const peaks: number[] = [];
  for (let i = 1; i < preCrashLastIndex; i++) {
    if (checkpoints[i].timeOffsetPct < minTimePct) {
      continue;
    }
    const prev = checkpoints[i - 1].baseBoostValue;
    const current = checkpoints[i].baseBoostValue;
    const next = checkpoints[i + 1].baseBoostValue;
    if (current - prev > threshold && current - next > threshold) {
      peaks.push(i);
    }
  }
  return peaks;
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

  const effectiveCrashPct = clampValue(options.crashPct ?? 1, 0.01, 0.99);
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

interface FinalPeakCapOptions {
  minBoostPct: number;
  maxBoostPct: number;
  crashPct?: number;
  durationSeconds?: number;
  initialClimbSeconds: number;
  targetPeakCount: number;
}

function enforceFinalPeakCap(
  checkpoints: RideCheckpoint[],
  options: FinalPeakCapOptions
): void {
  if (checkpoints.length < 4) {
    return;
  }

  const targetPeakCount = Math.max(1, options.targetPeakCount);
  const preCrashLastIndex = getPreCrashLastCheckpointIndex(checkpoints, options.crashPct);
  if (preCrashLastIndex < 3) {
    return;
  }

  const range = Math.max(options.maxBoostPct - options.minBoostPct, 0);
  const threshold = Math.max(range * 0.0005, 0.000001);
  const minPeakPct = options.durationSeconds && options.durationSeconds > 0
    ? (options.initialClimbSeconds / options.durationSeconds)
    : 0;

  let peaks = getPeakIndexes(checkpoints, preCrashLastIndex, threshold, minPeakPct);
  let safety = 0;
  while (peaks.length > targetPeakCount && safety < 200) {
    safety += 1;
    let weakestPeakIndex = peaks[0];
    let weakestProminence = Number.POSITIVE_INFINITY;

    for (const peakIndex of peaks) {
      const prominence = checkpoints[peakIndex].baseBoostValue
        - Math.max(
            checkpoints[peakIndex - 1].baseBoostValue,
            checkpoints[peakIndex + 1].baseBoostValue
          );
      if (prominence < weakestProminence) {
        weakestProminence = prominence;
        weakestPeakIndex = peakIndex;
      }
    }

    smoothWindowAroundIndex(
      checkpoints,
      weakestPeakIndex,
      1,
      preCrashLastIndex
    );

    peaks = getPeakIndexes(checkpoints, preCrashLastIndex, threshold, minPeakPct);
  }
}

function smoothWindowAroundIndex(
  checkpoints: RideCheckpoint[],
  centerIndex: number,
  minIndex: number,
  maxIndex: number
): void {
  const leftIndex = Math.max(minIndex, centerIndex - 2);
  const rightIndex = Math.min(maxIndex, centerIndex + 2);
  if (rightIndex - leftIndex < 2) {
    return;
  }

  const leftValue = checkpoints[leftIndex].baseBoostValue;
  const rightValue = checkpoints[rightIndex].baseBoostValue;
  for (let i = leftIndex + 1; i < rightIndex; i++) {
    const ratio = (i - leftIndex) / (rightIndex - leftIndex);
    checkpoints[i].baseBoostValue = roundToDecimals(
      leftValue + ((rightValue - leftValue) * ratio),
      6
    );
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
  const step = Math.max(range * 0.002, 0.00001);
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
