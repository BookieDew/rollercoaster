import type { Selection } from './ticket';
import type { RidePathPoint, MaximumModel, LegacyMaximumModel, RideMathSnapshotV4 } from './ride';
import type { RideMode } from './rewardProfile';

export interface BoostModelSnapshot {
  selectionWeight: number;
  oddsWeight: number;
  maxEligibilityExponent: number;
  effectiveMinFloorRate: number;
  selectionRatio: number | null;
  oddsRatio: number | null;
  eligibilityFactor: number;
}

export interface BetBoostLock {
  id: string;
  brandId: string;
  betId: string;
  rewardId: string;
  lockedBoostPct: number;
  qualifyingSelections: number;
  /**
   * Combined odds of the qualifying selections. The service read path (boostLockService) returns the V4
   * snapshot's value: an exact decimal string beyond the double range, a number otherwise. The table column
   * itself is numeric (see CreateBetBoostLockInput).
   */
  qualifyingOdds: number | string;
  ticketStrength: number;
  snapshot: LockSnapshot;
  lockedAt: string;
  createdAt: string;
}

/** Fields every lock snapshot has (read by settlement and by the lock read endpoints). */
interface LockSnapshotCommon {
  selections: Selection[];
  disqualifiedSelections: Selection[];
  profileId: string;
  rideMode: RideMode;
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
  rideDurationSeconds: number;
  /** Crash time as a fraction of the ride (1 = no crash before the end). */
  crashPct: number;
  totalSelectionCount: number;
  qualifyingSelectionCount: number;
  ticketStrength: number;
  /** Lock time as a fraction of the ride. */
  elapsedPct: number;
  effectiveMinBoostPct: number;
  maxEligibleBoostPct: number;
  maxPossibleBoostPct: number;
  boostModel: BoostModelSnapshot;
  ridePath: RidePathPoint[];
}

/**
 * Lock snapshot of math version 4: freezes every payout input (the opt-in ride snapshot, which holds
 * the seed commitment, never the seed) plus the boost and time at lock.
 */
export interface LockSnapshotV4 extends LockSnapshotCommon {
  mathSnapshotVersion: 4;
  maximumModel: MaximumModel;
  /** Nearest double, or the exact decimal string when the product is beyond the double range. */
  combinedOdds: number | string;
  combinedOddsExact: string;
  rideMath: RideMathSnapshotV4;
  seedCommitment: string;
  lockElapsedSeconds: number;
  boostAtLock: number;
}

/**
 * Lock snapshot written under the retired V1-V3 math. Stored data only: read back as stored by the lock
 * and settlement endpoints, never recomputed.
 */
export interface LegacyLockSnapshot extends LockSnapshotCommon {
  mathSnapshotVersion?: 1 | 2 | 3;
  maximumModel?: LegacyMaximumModel;
  combinedOdds: number;
  checkpointCount: number;
  volatility: number;
  seed: string;
  rideValue: number;
  maxRideValue: number;
  phaseDiagnostics?: unknown;
}

export type LockSnapshot = LockSnapshotV4 | LegacyLockSnapshot;

export interface CreateBetBoostLockInput {
  brandId: string;
  betId: string;
  rewardId: string;
  lockedBoostPct: number;
  qualifyingSelections: number;
  qualifyingOdds: number;
  ticketStrength: number;
  snapshot: LockSnapshot;
}

export interface LockRequest {
  user_id: string;
  reward_id: string;
  bet_id: string;
}

export interface LockResponse {
  lock_id: string;
  brand_id: string;
  bet_id: string;
  reward_id: string;
  locked_boost_pct: number;
  qualifying_selections: number;
  /** Exact decimal string when the combined odds are beyond the double range. */
  qualifying_odds: number | string;
  ticket_strength: number;
  locked_at: string;
  effective_min_boost_pct: number;
  effective_max_boost_pct: number;
  theoretical_max_boost_pct: number;
  maximum_model?: MaximumModel;
  boost_model: {
    selection_weight: number;
    odds_weight: number;
    max_eligibility_exponent: number;
    effective_min_floor_rate: number;
    selection_ratio: number | null;
    odds_ratio: number | null;
    eligibility_factor: number;
  };
  ride_stop_at_offset_seconds: number;
  ride_end_at_offset_seconds: number;
  ride_crash_at_offset_seconds: number;
  ride_path: RidePathPoint[];
}

export interface BetBoostLockDTO {
  id: string;
  brand_id: string;
  bet_id: string;
  reward_id: string;
  locked_boost_pct: number;
  qualifying_selections: number;
  qualifying_odds: number | string;
  ticket_strength: number;
  locked_at: string;
  created_at: string;
}

export function toDTO(lock: BetBoostLock): BetBoostLockDTO {
  return {
    id: lock.id,
    brand_id: lock.brandId,
    bet_id: lock.betId,
    reward_id: lock.rewardId,
    locked_boost_pct: lock.lockedBoostPct,
    qualifying_selections: lock.qualifyingSelections,
    qualifying_odds: lock.qualifyingOdds,
    ticket_strength: lock.ticketStrength,
    locked_at: lock.lockedAt,
    created_at: lock.createdAt,
  };
}
