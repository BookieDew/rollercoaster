import type { V4CrashBucket, V4CrashPhase, V4LinearPace } from '../computations/v4/types';

/** One sample of a ride chart: time as a fraction of the ride, value = payout rate at that time. */
export interface RidePathPoint {
  timePct: number;
  baseBoostValue: number;
}

/**
 * How `theoretical_max_boost_pct` was computed.
 * - PRE_CRASH_SUPREMUM_V4: the exact highest payout of the V4 ride before its crash or end (every new ride).
 * - LEGACY_*: labels stored on locks made under the retired V1-V3 math; read back as stored, never recomputed.
 */
export type MaximumModel = 'PRE_CRASH_SUPREMUM_V4' | LegacyMaximumModel;
export type LegacyMaximumModel = 'LEGACY_CHECKPOINT_MAX_V1' | 'WAVES_PRE_CRASH_SUPREMUM_V2';

export const RIDE_MATH_VERSION = 4 as const;
export const MAXIMUM_MODEL_V4: MaximumModel = 'PRE_CRASH_SUPREMUM_V4';

/** Ride-math profile inputs frozen at opt-in (later profile edits never change an in-flight ride). */
export interface RideMathProfile {
  id: string;
  minSelections: number;
  minCombinedOdds: number;
  minSelectionOdds: number;
  minBoostPct: number;
  maxBoostPct: number;
  maxBoostMinSelections: number | null;
  maxBoostMinCombinedOdds: number | null;
  maxEligibilitySelectionWeight: number;
  maxEligibilityOddsWeight: number;
  effectiveMinFloorRate: number;
  rideMode: 'WAVES' | 'LINEAR';
}

/**
 * Opt-in ride snapshot (`user_rewards.ticket_snapshot.rideMath`), math version 4. It freezes every payout
 * input: with the stored seed it rebuilds exactly one ride, and the rebuilt ride must match the frozen
 * outcome fields or the ride fails closed. Server-side only: never part of a live response. It holds a
 * SHA-256 commitment of the seed, never the seed.
 */
export interface RideMathSnapshotV4 {
  version: 4;
  mathVersion: 'V4';
  profile: RideMathProfile;
  startTime: string;
  endTime: string;
  /** Ride bounds from the service config at opt-in. */
  minDurationSeconds: number;
  maxDurationSeconds: number;
  minCrashSeconds: number;
  /** Ticket inputs. */
  qualifyingSelectionCount: number;
  /** Exact decimal string of the combined odds of the qualifying selections. */
  combinedOddsExact: string;
  ticketStrength: number;
  effectiveMinBoostPct: number;
  effectiveMaxBoostPct: number;
  /** Ride parameters (V4RideParams). */
  rideDurationSeconds: number;
  outcome: 'CRASHED' | 'ENDED';
  crashAtSeconds: number | null;
  crashBucket: V4CrashBucket | null;
  crashPhase: V4CrashPhase | null;
  linearPace: V4LinearPace | null;
  bandMinPct: number;
  bandMaxPct: number;
  rideMaximumPct: number;
  /** Highest payout before the crash or end (theoretical_max_boost_pct once the ride is over). */
  preCrashMaximumPct: number;
  /** SHA-256 hex of the seed bytes. */
  seedCommitment: string;
}
