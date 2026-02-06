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
  const rng = new SeededRandom(seed);

  const checkpoints: RideCheckpoint[] = [];
  const range = maxBoostPct - minBoostPct;
  const midPoint = (minBoostPct + maxBoostPct) / 2;

  // Generate checkpoints with oscillating values
  for (let i = 0; i < checkpointCount; i++) {
    const timeOffsetPct = i / (checkpointCount - 1);

    // Base oscillation using sine wave with random phase shifts
    const frequency = 2 + rng.next() * 3; // 2-5 oscillations
    const phase = rng.next() * Math.PI * 2;
    const oscillation = Math.sin(timeOffsetPct * Math.PI * frequency + phase);

    // Apply volatility to control oscillation amplitude
    const volatilityFactor = oscillation * volatility * range * 0.5;

    // Trend toward lower values as time progresses (approaching crash)
    const trendDown = timeOffsetPct * range * 0.3;

    // Random noise component
    const noise = (rng.next() - 0.5) * volatility * range * 0.2;

    // Calculate base boost value
    let value = midPoint + volatilityFactor - trendDown + noise;

    // Ensure crash to zero at the very end
    if (i === checkpointCount - 1) {
      value = 0;
    } else {
      // Clamp to min/max bounds
      value = Math.max(minBoostPct, Math.min(maxBoostPct, value));
    }

    checkpoints.push({
      index: i,
      timeOffsetPct: roundToDecimals(timeOffsetPct, 6),
      baseBoostValue: roundToDecimals(value, 6),
    });
  }

  applyStartDirectionBias(checkpoints, seed, {
    minBoostPct,
    maxBoostPct,
    ticketStrength,
  });
  enforceRideDirectionRules(checkpoints, {
    minBoostPct,
    maxBoostPct,
    crashPct,
    minRunLength: 3,
  });
  enforceMinPeakDelay(checkpoints, {
    minBoostPct,
    maxBoostPct,
    durationSeconds,
    crashPct,
    minPeakDelaySeconds,
  });

  return { checkpoints, seed };
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

  const peakIdx = checkpoints.findIndex(
    (cp) => cp.timeOffsetPct >= earliestPeakPct && cp.timeOffsetPct < effectiveCrashPct
  );
  if (peakIdx < 0) {
    return;
  }

  const epsilon = Math.max((options.maxBoostPct - options.minBoostPct) * 0.005, 0.000001);
  const forcedPeak = roundToDecimals(options.maxBoostPct, 6);

  for (let i = 0; i < checkpoints.length; i++) {
    const cp = checkpoints[i];
    if (cp.timeOffsetPct < earliestPeakPct) {
      const capped = Math.min(cp.baseBoostValue, options.maxBoostPct - epsilon);
      cp.baseBoostValue = roundToDecimals(
        Math.max(options.minBoostPct, capped),
        6
      );
    }
  }

  if (peakIdx < checkpoints.length - 1) {
    checkpoints[peakIdx].baseBoostValue = forcedPeak;
  }
}

interface DirectionRuleOptions {
  minBoostPct: number;
  maxBoostPct: number;
  crashPct?: number;
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
