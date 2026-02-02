import { userRewardRepository } from '../db/repositories/userRewardRepository';
import { rewardProfileRepository } from '../db/repositories/rewardProfileRepository';
import { rideDefinitionRepository } from '../db/repositories/rideDefinitionRepository';
import { betBoostLockRepository } from '../db/repositories/betBoostLockRepository';
import { auditLogRepository } from '../db/repositories/auditLogRepository';
import {
  filterQualifyingSelections,
  meetsMinSelectionCount,
  calculateCombinedOdds,
  meetsCombinedOddsThreshold,
  computeTicketStrength,
  interpolateRideValue,
  calculateElapsedPct,
  hasRideEnded as checkRideEnded,
  calculateFinalBoost,
  deriveRideParams,
  computeMaxEligibleBoostPct,
} from '../computations';
import type { BetBoostLock, LockResponse, RidePathPoint } from '../types/betBoostLock';
import type { Selection } from '../types/ticket';
import { ReasonCode } from '../types/reasonCodes';

export interface LockInput {
  userId: string;
  rewardId: string;
  betId: string;
}

export interface ServiceResult<T> {
  success: boolean;
  data?: T;
  error?: {
    code: ReasonCode;
    message: string;
    details?: unknown;
  };
}

/**
 * Handles bet placement: validates eligibility, computes and freezes boost at current instant,
 * stores immutable lock record, ensures idempotency per bet_id.
 */
export async function lockBoost(
  input: LockInput
): Promise<ServiceResult<LockResponse>> {
  const { userId, rewardId, betId } = input;

  // Check idempotency - if bet already locked, return existing lock
  const existingLock = await betBoostLockRepository.findByBetId(betId);
  if (existingLock) {
    return {
      success: true,
      data: buildLockResponse(existingLock),
    };
  }

  // Fetch the reward
  const reward = await userRewardRepository.findById(rewardId);
  if (!reward) {
    return {
      success: false,
      error: {
        code: ReasonCode.REWARD_NOT_FOUND,
        message: `Reward with ID ${rewardId} not found`,
      },
    };
  }

  // Verify ownership
  if (reward.userId !== userId) {
    return {
      success: false,
      error: {
        code: ReasonCode.REWARD_NOT_FOUND,
        message: 'Reward not found for this user',
      },
    };
  }

  // Check reward status
  if (reward.status === 'EXPIRED') {
    return {
      success: false,
      error: {
        code: ReasonCode.REWARD_EXPIRED,
        message: 'Reward has expired',
      },
    };
  }

  if (reward.status === 'USED') {
    return {
      success: false,
      error: {
        code: ReasonCode.REWARD_ALREADY_USED,
        message: 'Reward has already been used',
      },
    };
  }

  if (reward.status !== 'ENTERED') {
    return {
      success: false,
      error: {
        code: ReasonCode.NOT_OPTED_IN,
        message: 'User has not opted into this reward',
      },
    };
  }

  if (!reward.betId || reward.betId !== betId || !reward.ticketSnapshot) {
    return {
      success: false,
      error: {
        code: ReasonCode.NOT_OPTED_IN,
        message: 'Ride not started for this bet',
      },
    };
  }

  const storedSelections = (reward.ticketSnapshot.selections as Selection[]) ?? [];

  const elapsedPct = calculateElapsedPct(reward.startTime, reward.endTime);
  const { crashPct, checkpointCount, volatility } = deriveRideParams(reward.seed);
  const rideDurationSeconds =
    (new Date(reward.endTime).getTime() - new Date(reward.startTime).getTime()) / 1000;
  const crashOffsetSeconds = roundToDecimals(crashPct * rideDurationSeconds, 3);
  const endOffsetSeconds = roundToDecimals(rideDurationSeconds, 3);

  // Check if ride has crashed or ended
  if (elapsedPct >= crashPct) {
    return {
      success: false,
      error: {
        code: ReasonCode.RIDE_CRASHED,
        message: 'Ride has crashed - boost is zero',
        details: {
          ride_end_at_offset_seconds: endOffsetSeconds,
          ride_crash_at_offset_seconds: crashOffsetSeconds,
        },
      },
    };
  }
  if (checkRideEnded(reward.startTime, reward.endTime)) {
    return {
      success: false,
      error: {
        code: ReasonCode.RIDE_ENDED,
        message: 'Ride has ended - boost is zero',
        details: {
          ride_end_at_offset_seconds: endOffsetSeconds,
          ride_crash_at_offset_seconds: crashOffsetSeconds,
        },
      },
    };
  }

  // Get profile for eligibility thresholds
  const profile = await rewardProfileRepository.findById(reward.profileVersionId);
  if (!profile) {
    return {
      success: false,
      error: {
        code: ReasonCode.PROFILE_NOT_FOUND,
        message: 'Associated profile not found',
      },
    };
  }

  // Filter qualifying selections
  const { qualifying, disqualified } = filterQualifyingSelections(
    storedSelections,
    profile.minSelectionOdds
  );

  // Calculate combined odds
  const combinedOdds = calculateCombinedOdds(qualifying);

  // Check minimum selection count
  if (!meetsMinSelectionCount(qualifying.length, profile.minSelections)) {
    return {
      success: false,
      error: {
        code: ReasonCode.MIN_SELECTIONS_NOT_MET,
        message: `Minimum ${profile.minSelections} qualifying selections required, got ${qualifying.length}`,
      },
    };
  }

  // Check minimum combined odds
  if (!meetsCombinedOddsThreshold(combinedOdds, profile.minCombinedOdds)) {
    return {
      success: false,
      error: {
        code: ReasonCode.MIN_COMBINED_ODDS_NOT_MET,
        message: `Minimum combined odds of ${profile.minCombinedOdds} required, got ${combinedOdds.toFixed(2)}`,
      },
    };
  }

  // Compute ticket strength
  const ticketStrength = computeTicketStrength(qualifying.length, combinedOdds, {
    minSelections: profile.minSelections,
  });

  // Get ride checkpoints and current value
  const checkpoints = await rideDefinitionRepository.findByRewardId(rewardId);
  const maxRideValue = getMaxRideValue(checkpoints, crashPct);
  const rideValue = interpolateRideValue(
    checkpoints.map((cp) => ({
      index: cp.checkpointIndex,
      timeOffsetPct: cp.timeOffsetPct,
      baseBoostValue: cp.baseBoostValue,
    })),
    elapsedPct
  );

  const ridePath = buildRidePath(checkpoints, 60, crashPct);

  // Calculate final boost
  const lockedBoostPct = calculateFinalBoost({
    rideValue,
    ticketStrength,
    qualifyingSelections: qualifying.length,
    combinedOdds,
    hasRideEnded: false,
    config: {
      minBoostPct: profile.minBoostPct,
      maxBoostPct: profile.maxBoostPct,
      maxBoostMinSelections: profile.maxBoostMinSelections,
      maxBoostMinCombinedOdds: profile.maxBoostMinCombinedOdds,
    },
  });

  const maxPossibleBoostPct = calculateFinalBoost({
    rideValue: maxRideValue,
    ticketStrength,
    qualifyingSelections: qualifying.length,
    combinedOdds,
    hasRideEnded: false,
    config: {
      minBoostPct: profile.minBoostPct,
      maxBoostPct: profile.maxBoostPct,
      maxBoostMinSelections: profile.maxBoostMinSelections,
      maxBoostMinCombinedOdds: profile.maxBoostMinCombinedOdds,
    },
  });
  const maxEligibleBoostPct = computeMaxEligibleBoostPct(
    qualifying.length,
    combinedOdds,
    {
      minBoostPct: profile.minBoostPct,
      maxBoostPct: profile.maxBoostPct,
      maxBoostMinSelections: profile.maxBoostMinSelections,
      maxBoostMinCombinedOdds: profile.maxBoostMinCombinedOdds,
    }
  );

  // Create the lock record
  const lock = await betBoostLockRepository.create({
    betId,
    rewardId,
    lockedBoostPct,
    qualifyingSelections: qualifying.length,
    qualifyingOdds: combinedOdds,
    ticketStrength,
    snapshot: {
      selections: qualifying,
      disqualifiedSelections: disqualified,
      profileId: profile.id,
      minSelections: profile.minSelections,
      minCombinedOdds: profile.minCombinedOdds,
      minSelectionOdds: profile.minSelectionOdds,
      minBoostPct: profile.minBoostPct,
      maxBoostPct: profile.maxBoostPct,
      maxBoostMinSelections: profile.maxBoostMinSelections,
      maxBoostMinCombinedOdds: profile.maxBoostMinCombinedOdds,
      rideDurationSeconds,
      checkpointCount,
      volatility,
      seed: reward.seed,
      crashPct,
      totalSelectionCount: storedSelections.length,
      qualifyingSelectionCount: qualifying.length,
      combinedOdds,
      ticketStrength,
      rideValue,
      maxRideValue,
      elapsedPct,
      maxEligibleBoostPct,
      maxPossibleBoostPct,
      ridePath,
    },
  });

  // Mark reward as used
  await userRewardRepository.updateStatus(rewardId, 'USED');

  await auditLogRepository.append({
    entityType: 'bet_boost_lock',
    entityId: lock.id,
    action: 'LOCK',
    payload: {
      betId,
      rewardId,
      userId,
      lockedBoostPct,
      qualifyingSelections: qualifying.length,
      combinedOdds,
      ticketStrength,
      elapsedPct,
      maxRideValue,
      maxEligibleBoostPct,
      maxPossibleBoostPct,
      minBoostPct: profile.minBoostPct,
      maxBoostPct: profile.maxBoostPct,
      maxBoostMinSelections: profile.maxBoostMinSelections,
      maxBoostMinCombinedOdds: profile.maxBoostMinCombinedOdds,
      minSelections: profile.minSelections,
      minCombinedOdds: profile.minCombinedOdds,
      minSelectionOdds: profile.minSelectionOdds,
      checkpointCount,
      volatility,
      rideDurationSeconds,
      seed: reward.seed,
      crashPct,
    },
  });

  return {
    success: true,
    data: buildLockResponse(lock),
  };
}

/**
 * Gets an existing lock by bet ID.
 */
export async function getLockByBetId(
  betId: string
): Promise<ServiceResult<BetBoostLock | null>> {
  const lock = await betBoostLockRepository.findByBetId(betId);
  return { success: true, data: lock };
}

function buildLockResponse(lock: BetBoostLock): LockResponse {
  return {
    lock_id: lock.id,
    bet_id: lock.betId,
    reward_id: lock.rewardId,
    locked_boost_pct: lock.lockedBoostPct,
    qualifying_selections: lock.qualifyingSelections,
    qualifying_odds: lock.qualifyingOdds,
    ticket_strength: lock.ticketStrength,
    locked_at: lock.lockedAt,
    theoretical_max_boost_pct: lock.snapshot.maxPossibleBoostPct,
    ride_end_at_offset_seconds: roundToDecimals(lock.snapshot.rideDurationSeconds, 3),
    ride_crash_at_offset_seconds: roundToDecimals(
      lock.snapshot.rideDurationSeconds * lock.snapshot.crashPct,
      3
    ),
    ride_path: lock.snapshot.ridePath,
  };
}

function buildRidePath(
  checkpoints: { checkpointIndex: number; timeOffsetPct: number; baseBoostValue: number }[],
  sampleCount: number,
  crashPct: number
): RidePathPoint[] {
  if (!checkpoints.length || sampleCount < 2) {
    return [];
  }

  const normalizedCheckpoints = checkpoints.map((cp) => ({
    index: cp.checkpointIndex,
    timeOffsetPct: cp.timeOffsetPct,
    baseBoostValue: cp.baseBoostValue,
  }));

  const points: RidePathPoint[] = [];
  for (let i = 0; i < sampleCount; i++) {
    const timePct = i / (sampleCount - 1);
    const baseBoostValue = timePct >= crashPct
      ? 0
      : interpolateRideValue(normalizedCheckpoints, timePct);
    points.push({ timePct, baseBoostValue });
  }

  return points;
}

function getMaxRideValue(
  checkpoints: { checkpointIndex: number; timeOffsetPct: number; baseBoostValue: number }[],
  crashPct: number
): number {
  if (!checkpoints.length) {
    return 0;
  }

  const eligible = checkpoints.filter((cp) => cp.timeOffsetPct <= crashPct);
  if (!eligible.length) {
    return 0;
  }

  return Math.max(...eligible.map((cp) => cp.baseBoostValue));
}

function roundToDecimals(value: number, decimals: number): number {
  const factor = Math.pow(10, decimals);
  return Math.round(value * factor) / factor;
}

export const boostLockService = {
  lockBoost,
  getLockByBetId,
};
