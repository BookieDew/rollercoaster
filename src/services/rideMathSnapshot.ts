import { types } from 'util';
import { createV4Ride, seedCommitment, type V4LinearPace, type V4Ride, type V4RideConfig } from '../computations/v4';
import type { RewardProfileVersion } from '../types/rewardProfile';
import type { RideMathProfile, RideMathSnapshotV4, RidePathPoint } from '../types/ride';
import type { UserReward } from '../types/userReward';
import type { TicketEvaluation } from './ticketEvaluation';

/**
 * V4 ride math for the live paths (opt-in, quote, lock, expiry). Math version 4 is the only one:
 * V1-V3 rides are never rebuilt. Their stored lock snapshots stay readable as stored data.
 */
export type { RideMathProfile, RideMathSnapshotV4 };

/** LINEAR climb pace (owner decision "V4 sign-off choices" item 3, kept by "LINEAR MEDIUM small-ticket cost"). */
export const LINEAR_PACE: V4LinearPace = 'MEDIUM';

/** Samples of a ride chart revealed after the ride is over (unchanged from V3). */
export const RIDE_PATH_SAMPLES = 60;

export interface RideLimits {
  minDurationSeconds: number;
  maxDurationSeconds: number;
  minCrashSeconds: number;
}

export interface ResolvedRide {
  math: RideMathSnapshotV4;
  ride: V4Ride;
}

export function toRideMathProfile(profile: RewardProfileVersion): RideMathProfile {
  return {
    id: profile.id,
    minSelections: profile.minSelections,
    minCombinedOdds: profile.minCombinedOdds,
    minSelectionOdds: profile.minSelectionOdds,
    minBoostPct: profile.minBoostPct,
    maxBoostPct: profile.maxBoostPct,
    maxBoostMinSelections: profile.maxBoostMinSelections,
    maxBoostMinCombinedOdds: profile.maxBoostMinCombinedOdds,
    maxEligibilitySelectionWeight: profile.maxEligibilitySelectionWeight,
    maxEligibilityOddsWeight: profile.maxEligibilityOddsWeight,
    effectiveMinFloorRate: profile.effectiveMinFloorRate,
    rideMode: profile.rideMode,
  };
}

function rideConfig(input: {
  rideMode: 'WAVES' | 'LINEAR';
  minBoostPct: number;
  maxBoostPct: number;
  effectiveMin: number;
  effectiveMax: number;
  ticketStrength: number;
  limits: RideLimits;
  linearPace: V4LinearPace | null;
}): V4RideConfig {
  return {
    mode: input.rideMode,
    minBoostPct: input.minBoostPct,
    maxBoostPct: input.maxBoostPct,
    effectiveMin: input.effectiveMin,
    effectiveMax: input.effectiveMax,
    ticketStrength: input.ticketStrength,
    minDurationSeconds: input.limits.minDurationSeconds,
    maxDurationSeconds: input.limits.maxDurationSeconds,
    minCrashSeconds: input.limits.minCrashSeconds,
    linearPace: input.rideMode === 'LINEAR' ? (input.linearPace ?? undefined) : undefined,
  };
}

/** Builds the V4 ride of an eligible ticket and the opt-in snapshot that freezes it. */
export function buildRideMath(
  seed: string,
  profile: RideMathProfile,
  ticket: TicketEvaluation,
  limits: RideLimits,
  startMs: number
): ResolvedRide {
  const ride = createV4Ride(seed, rideConfig({
    rideMode: profile.rideMode,
    minBoostPct: profile.minBoostPct,
    maxBoostPct: profile.maxBoostPct,
    effectiveMin: ticket.boostModel.effectiveMinBoost,
    effectiveMax: ticket.boostModel.effectiveMaxBoost,
    ticketStrength: ticket.ticketStrength,
    limits,
    linearPace: LINEAR_PACE,
  }));
  const p = ride.params;
  const math: RideMathSnapshotV4 = {
    version: 4,
    mathVersion: 'V4',
    profile: { ...profile },
    startTime: new Date(startMs).toISOString(),
    endTime: rideEndTime(new Date(startMs).toISOString(), p.durationSeconds),
    minDurationSeconds: limits.minDurationSeconds,
    maxDurationSeconds: limits.maxDurationSeconds,
    minCrashSeconds: limits.minCrashSeconds,
    qualifyingSelectionCount: ticket.qualifying.length,
    combinedOddsExact: ticket.combinedOddsExact,
    ticketStrength: ticket.ticketStrength,
    effectiveMinBoostPct: ticket.boostModel.effectiveMinBoost,
    effectiveMaxBoostPct: ticket.boostModel.effectiveMaxBoost,
    rideDurationSeconds: p.durationSeconds,
    outcome: p.outcome,
    crashAtSeconds: p.crashAtSeconds,
    crashBucket: p.crashBucket,
    crashPhase: p.crashPhase,
    linearPace: p.linearPace,
    bandMinPct: p.bandMin,
    bandMaxPct: p.bandMax,
    rideMaximumPct: p.rideMaximum,
    preCrashMaximumPct: ride.maximumBefore(terminalSeconds(p)),
    seedCommitment: seedCommitment(seed),
  };
  return { math, ride };
}

/**
 * Ride end: start plus the duration, truncated to whole milliseconds (Date keeps integer milliseconds).
 * Throws on an unparsable start (the rebuild then fails closed).
 */
function rideEndTime(startTime: string, durationSeconds: number): string {
  const startMs = Date.parse(startTime);
  if (!Number.isFinite(startMs)) throw new Error('Invalid ride start time');
  return new Date(startMs + durationSeconds * 1000).toISOString();
}

/**
 * Epoch milliseconds of a stored instant, or null when the value is not one. A timestamp column comes back
 * as an ISO string (SQLite, as written), a Date (pg's default parser; the repository's `as string` cast does
 * not convert it) or epoch milliseconds (node-sqlite3 stores a bound Date as a number).
 */
function instantMs(value: unknown): number | null {
  let ms = Number.NaN;
  if (types.isDate(value)) ms = value.getTime();
  else if (typeof value === 'string') ms = Date.parse(value);
  else if (typeof value === 'number') ms = value;
  return Number.isFinite(ms) ? ms : null;
}

/** True when both values are valid instants at the same millisecond (a stored row time vs a snapshot time). */
function sameInstant(stored: unknown, expected: unknown): boolean {
  const storedMs = instantMs(stored);
  return storedMs !== null && storedMs === instantMs(expected);
}

function terminalSeconds(p: { crashAtSeconds: number | null; durationSeconds: number }): number {
  return p.crashAtSeconds ?? p.durationSeconds;
}

/** True when the reward carries a ride snapshot of a retired math version (V1-V3, or unknown). */
export function hasRetiredRideMath(reward: UserReward): boolean {
  const frozen = reward.ticketSnapshot?.rideMath as { version?: unknown } | undefined | null;
  return frozen != null && frozen.version !== 4;
}

/**
 * Rebuilds the frozen V4 ride of an opted-in reward from its seed and snapshot. Fails closed (null) when
 * there is no V4 snapshot, the seed does not match the commitment, or the rebuilt ride differs from any
 * frozen ride field. Never falls back to the mutable profile or to a retired math version.
 */
export function resolveRideMath(reward: UserReward): ResolvedRide | null {
  const math = reward.ticketSnapshot?.rideMath as RideMathSnapshotV4 | undefined | null;
  if (math == null || math.version !== 4 || math.mathVersion !== 'V4' || math.profile == null) return null;
  try {
    if (seedCommitment(reward.seed) !== math.seedCommitment) return null;
    const ride = createV4Ride(reward.seed, rideConfig({
      rideMode: math.profile.rideMode,
      minBoostPct: math.profile.minBoostPct,
      maxBoostPct: math.profile.maxBoostPct,
      effectiveMin: math.effectiveMinBoostPct,
      effectiveMax: math.effectiveMaxBoostPct,
      ticketStrength: math.ticketStrength,
      limits: math,
      linearPace: math.linearPace,
    }));
    const p = ride.params;
    const matches =
      p.durationSeconds === math.rideDurationSeconds &&
      p.outcome === math.outcome &&
      p.crashAtSeconds === math.crashAtSeconds &&
      p.crashBucket === math.crashBucket &&
      p.crashPhase === math.crashPhase &&
      p.linearPace === math.linearPace &&
      p.bandMin === math.bandMinPct &&
      p.bandMax === math.bandMaxPct &&
      p.rideMaximum === math.rideMaximumPct &&
      ride.maximumBefore(terminalSeconds(p)) === math.preCrashMaximumPct &&
      math.endTime === rideEndTime(math.startTime, p.durationSeconds) &&
      sameInstant(reward.endTime, math.endTime);
    return matches ? { math, ride } : null;
  } catch {
    return null;
  }
}

export interface RideClock {
  elapsedSeconds: number;
  crashed: boolean;
  ended: boolean;
}

/** Where the ride is at `nowMs`, from the frozen snapshot only. */
export function rideClock(math: RideMathSnapshotV4, nowMs: number): RideClock {
  const elapsedSeconds = (nowMs - Date.parse(math.startTime)) / 1000;
  return {
    elapsedSeconds,
    crashed: math.crashAtSeconds !== null && elapsedSeconds >= math.crashAtSeconds,
    ended: nowMs >= Date.parse(math.endTime) || elapsedSeconds >= math.rideDurationSeconds,
  };
}

/** Crash offset reported once the ride is over: the crash time, or the end for a ride that never crashed. */
export function crashOffsetSeconds(math: RideMathSnapshotV4): number {
  return terminalSeconds({ crashAtSeconds: math.crashAtSeconds, durationSeconds: math.rideDurationSeconds });
}

/** The ride chart (payout at evenly spaced times, 0 at/after the crash and at the end). Post-ride only. */
export function sampleRidePath(resolved: ResolvedRide, samples = RIDE_PATH_SAMPLES): RidePathPoint[] {
  const duration = resolved.math.rideDurationSeconds;
  return Array.from({ length: samples }, (_, i) => {
    const timePct = i / (samples - 1);
    return { timePct, baseBoostValue: resolved.ride.boostAt(timePct * duration) };
  });
}
