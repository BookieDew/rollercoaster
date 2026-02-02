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
export function deriveRideParams(seed: string): RideParams {
  const rng = new SeededRandom(seed);
  const checkpointCount = Math.max(6, Math.round(rng.nextRange(8, 18)));
  const volatility = roundToDecimals(rng.nextRange(0.25, 0.85), 4);
  const crashPct = roundToDecimals(
    clampValue(normalSample(rng, 0.55, 0.15), 0.01, 0.95),
    4
  );

  return { checkpointCount, volatility, crashPct };
}

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
 * Generates a deterministic ride curve with oscillating checkpoints.
 * The curve starts at a base value, oscillates up and down based on volatility,
 * and trends toward zero at the end (crash).
 *
 * @param seed - Deterministic seed for the random generator
 * @param config - Ride configuration parameters
 * @returns Generated ride with checkpoints
 */
export function generateRide(seed: string, config: RideConfig): GeneratedRide {
  const { checkpointCount, volatility, minBoostPct, maxBoostPct } = config;
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

function clampValue(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
