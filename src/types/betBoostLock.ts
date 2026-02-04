import type { Selection } from './ticket';
import type { RidePathPoint } from './ride';

export interface BetBoostLock {
  id: string;
  betId: string;
  rewardId: string;
  lockedBoostPct: number;
  qualifyingSelections: number;
  qualifyingOdds: number;
  ticketStrength: number;
  snapshot: LockSnapshot;
  lockedAt: string;
  createdAt: string;
}

export interface LockSnapshot {
  selections: Selection[];
  disqualifiedSelections: Selection[];
  profileId: string;
  minSelections: number;
  minCombinedOdds: number;
  minSelectionOdds: number;
  minBoostPct: number;
  maxBoostPct: number;
  maxBoostMinSelections: number | null;
  maxBoostMinCombinedOdds: number | null;
  rideDurationSeconds: number;
  checkpointCount: number;
  volatility: number;
  seed: string;
  crashPct: number;
  totalSelectionCount: number;
  qualifyingSelectionCount: number;
  combinedOdds: number;
  ticketStrength: number;
  rideValue: number;
  maxRideValue: number;
  elapsedPct: number;
  maxEligibleBoostPct: number;
  maxPossibleBoostPct: number;
  ridePath: RidePathPoint[];
}

export interface CreateBetBoostLockInput {
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
  bet_id: string;
  reward_id: string;
  locked_boost_pct: number;
  qualifying_selections: number;
  qualifying_odds: number;
  ticket_strength: number;
  locked_at: string;
  theoretical_max_boost_pct: number;
  ride_end_at_offset_seconds: number;
  ride_crash_at_offset_seconds: number;
  ride_path: RidePathPoint[];
}

export interface BetBoostLockDTO {
  id: string;
  bet_id: string;
  reward_id: string;
  locked_boost_pct: number;
  qualifying_selections: number;
  qualifying_odds: number;
  ticket_strength: number;
  locked_at: string;
  created_at: string;
}

export function toDTO(lock: BetBoostLock): BetBoostLockDTO {
  return {
    id: lock.id,
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
