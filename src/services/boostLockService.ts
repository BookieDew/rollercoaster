import { userRewardRepository } from '../db/repositories/userRewardRepository';
import { betBoostLockRepository } from '../db/repositories/betBoostLockRepository';
import { auditLogRepository } from '../db/repositories/auditLogRepository';
import { runInTransaction, Rollback, isUniqueViolation } from '../db/repositories/transaction';
import {
  filterQualifyingSelections,
  meetsMinSelectionCount,
  calculateCombinedOdds,
  meetsCombinedOddsThreshold,
  computeTicketStrength,
  computeLinearModeMaxBoostPct,
  getMaxRideValue,
  interpolateRideValue,
  calculateElapsedPct,
  hasRideEnded as checkRideEnded,
  calculateFinalBoostDetails,
  computeBoostModelDetails,
  buildEffectiveRidePath,
  buildLinearEffectiveRidePath,
  calculateLinearBoostPctAtElapsed,
} from '../computations';
import type { BetBoostLock, LockResponse } from '../types/betBoostLock';
import type { UserReward } from '../types/userReward';
import type { Selection } from '../types/ticket';
import type { RidePathPoint } from '../types/ride';
import { ReasonCode } from '../types/reasonCodes';
import { resolveRideMathSnapshot, resolveRideCheckpoints } from './rideMathSnapshot';

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

  // Idempotency: an existing lock is replayed only to the same reward and its owner.
  const existingLock = await betBoostLockRepository.findByBetId(betId);
  if (existingLock) {
    return replayExistingLock(existingLock, input);
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
    // A concurrent lock may have committed after the idempotency check above:
    // re-read and apply the replay rule before reporting the reward as used.
    const lockForBet = await betBoostLockRepository.findByBetId(betId);
    if (lockForBet) {
      return replayExistingLock(lockForBet, input, reward);
    }
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

  // Prefer opt-in math inputs; old rides retain the explicit profile fallback.
  const rideMath = await resolveRideMathSnapshot(reward);
  if (!rideMath) {
    const malformedSnapshot = reward.ticketSnapshot?.rideMath != null;
    return {
      success: false,
      error: {
        code: malformedSnapshot ? ReasonCode.INVALID_CONFIGURATION : ReasonCode.PROFILE_NOT_FOUND,
        message: malformedSnapshot ? 'Invalid saved ride math' : 'Associated profile not found',
      },
    };
  }

  const profile = rideMath.profile;
  const evaluationTime = new Date(Date.now());
  const elapsedPct = calculateElapsedPct(rideMath.startTime, rideMath.endTime, evaluationTime);
  const { rideDurationSeconds, crashPct, checkpointCount, volatility } = rideMath;
  const crashOffsetSeconds = roundToDecimals(crashPct * rideDurationSeconds, 3);
  const endOffsetSeconds = roundToDecimals(rideDurationSeconds, 3);

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
  const finalBoostConfig = {
    minBoostPct: profile.minBoostPct,
    maxBoostPct: profile.maxBoostPct,
    maxBoostMinSelections: profile.maxBoostMinSelections,
    maxBoostMinCombinedOdds: profile.maxBoostMinCombinedOdds,
    maxEligibilitySelectionWeight: profile.maxEligibilitySelectionWeight,
    maxEligibilityOddsWeight: profile.maxEligibilityOddsWeight,
    effectiveMinFloorRate: profile.effectiveMinFloorRate,
  };
  const boostModelDetails = computeBoostModelDetails(
    qualifying.length,
    combinedOdds,
    finalBoostConfig
  );
  const boostModel = {
    selectionWeight: boostModelDetails.selectionWeight,
    oddsWeight: boostModelDetails.oddsWeight,
    maxEligibilityExponent: boostModelDetails.maxEligibilityExponent,
    effectiveMinFloorRate: boostModelDetails.effectiveMinFloorRate,
    selectionRatio: boostModelDetails.selectionRatio,
    oddsRatio: boostModelDetails.oddsRatio,
    eligibilityFactor: boostModelDetails.eligibilityFactor,
  };
  const effectiveMinBoostPct = boostModelDetails.effectiveMinBoost;
  const maxEligibleBoostPct = boostModelDetails.effectiveMaxBoost;
  const isLinearRide = profile.rideMode === 'LINEAR';

  let lockedBoostPct: number;
  let maxPossibleBoostPct: number;
  let rideValueForSnapshot: number;
  let maxRideValueForSnapshot: number;
  let ridePath: RidePathPoint[];

  if (isLinearRide) {
    const linearMaxBoostPct = computeLinearModeMaxBoostPct({
      seed: reward.seed,
      checkpointCount,
      volatility,
      rideDurationSeconds,
      minPeakDelaySeconds: rideMath.minPeakDelaySeconds,
      maximumModel: rideMath.maximumModel,
      crashPct,
      ticketStrength,
      qualifyingSelections: qualifying.length,
      combinedOdds,
      config: finalBoostConfig,
      minBoostPct: profile.minBoostPct,
      maxBoostPct: profile.maxBoostPct,
    });
    lockedBoostPct = calculateLinearBoostPctAtElapsed(
      elapsedPct,
      crashPct,
      effectiveMinBoostPct,
      linearMaxBoostPct
    );
    maxPossibleBoostPct = linearMaxBoostPct;
    rideValueForSnapshot = lockedBoostPct;
    maxRideValueForSnapshot = linearMaxBoostPct;
    ridePath = buildLinearEffectiveRidePath(
      60,
      crashPct,
      effectiveMinBoostPct,
      linearMaxBoostPct
    );
  } else {
    // Get ride checkpoints and current value
    const checkpoints = await resolveRideCheckpoints(rewardId, rideMath);
    const maxRideValue = getMaxRideValue(checkpoints, crashPct, rideMath.maximumModel);
    const rideValue = interpolateRideValue(
      checkpoints.map((cp) => ({
        ...cp, index: cp.checkpointIndex,
        timeOffsetPct: cp.timeOffsetPct,
        baseBoostValue: cp.baseBoostValue,
      })),
      elapsedPct
    );

    ridePath = buildEffectiveRidePath(
      checkpoints,
      60,
      crashPct,
      ticketStrength,
      finalBoostConfig,
      qualifying.length,
      combinedOdds
    );

    const lockedBoostDetails = calculateFinalBoostDetails({
      rideValue,
      ticketStrength,
      qualifyingSelections: qualifying.length,
      combinedOdds,
      hasRideEnded: false,
      config: finalBoostConfig,
    });

    lockedBoostPct = lockedBoostDetails.finalBoostPct;
    const maxBoostDetails = calculateFinalBoostDetails({
      rideValue: maxRideValue,
      ticketStrength,
      qualifyingSelections: qualifying.length,
      combinedOdds,
      hasRideEnded: false,
      config: finalBoostConfig,
    });
    maxPossibleBoostPct = maxBoostDetails.finalBoostPct;
    rideValueForSnapshot = rideValue;
    maxRideValueForSnapshot = maxRideValue;
  }

  const rideCrashed = elapsedPct >= crashPct && crashPct < 1;
  const rideEnded = checkRideEnded(rideMath.startTime, rideMath.endTime, evaluationTime);

  if (rideCrashed) {
    return {
      success: false,
      error: {
        code: ReasonCode.RIDE_CRASHED,
        message: 'Ride has crashed - boost is zero',
        details: {
          ride_elapsed_seconds: (evaluationTime.getTime() - new Date(rideMath.startTime).getTime()) / 1000,
          ride_end_at_offset_seconds: endOffsetSeconds,
          ride_crash_at_offset_seconds: crashOffsetSeconds,
          qualifying_selection_count: qualifying.length,
          total_selection_count: storedSelections.length,
          combined_odds: combinedOdds,
          current_boost_pct: 0,
          effective_min_boost_pct: effectiveMinBoostPct,
          effective_max_boost_pct: maxEligibleBoostPct,
          theoretical_max_boost_pct: maxPossibleBoostPct,
          maximum_model: rideMath.maximumModel,
          ticket_strength: ticketStrength,
          boost_model: toBoostModelResponse(boostModel),
          ride_path: ridePath,
        },
      },
    };
  }
  if (rideEnded) {
    return {
      success: false,
      error: {
        code: ReasonCode.RIDE_ENDED,
        message: 'Ride has ended - boost is zero',
        details: {
          ride_elapsed_seconds: (evaluationTime.getTime() - new Date(rideMath.startTime).getTime()) / 1000,
          ride_end_at_offset_seconds: endOffsetSeconds,
          ride_crash_at_offset_seconds: crashOffsetSeconds,
          qualifying_selection_count: qualifying.length,
          total_selection_count: storedSelections.length,
          combined_odds: combinedOdds,
          current_boost_pct: 0,
          effective_min_boost_pct: effectiveMinBoostPct,
          effective_max_boost_pct: maxEligibleBoostPct,
          theoretical_max_boost_pct: maxPossibleBoostPct,
          maximum_model: rideMath.maximumModel,
          ticket_strength: ticketStrength,
          boost_model: toBoostModelResponse(boostModel),
          ride_path: ridePath,
        },
      },
    };
  }

  // Insert lock, consume reward (ENTERED -> USED) and audit atomically.
  let lock: BetBoostLock | null;
  try {
    lock = await runInTransaction<BetBoostLock | null>(async (tx) => {
      const created = await betBoostLockRepository.create({
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
          rideMode: profile.rideMode,
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
          rideDurationSeconds,
          checkpointCount,
          volatility,
          seed: reward.seed,
          crashPct,
          totalSelectionCount: storedSelections.length,
          qualifyingSelectionCount: qualifying.length,
          combinedOdds,
          ticketStrength,
          rideValue: rideValueForSnapshot,
          maxRideValue: maxRideValueForSnapshot,
          elapsedPct,
          effectiveMinBoostPct,
          maxEligibleBoostPct,
          maxPossibleBoostPct,
          maximumModel: rideMath.maximumModel,
          mathSnapshotVersion: rideMath.version,
          phaseDiagnostics: rideMath.phaseDiagnostics,
          boostModel: {
            selectionWeight: boostModel.selectionWeight,
            oddsWeight: boostModel.oddsWeight,
            maxEligibilityExponent: boostModel.maxEligibilityExponent,
            effectiveMinFloorRate: boostModel.effectiveMinFloorRate,
            selectionRatio: boostModel.selectionRatio,
            oddsRatio: boostModel.oddsRatio,
            eligibilityFactor: boostModel.eligibilityFactor,
          },
          ridePath,
        },
      }, tx);

      const consumed = await userRewardRepository.updateStatus(rewardId, 'USED', undefined, {
        tx,
        fromStatus: 'ENTERED',
      });
      if (!consumed) {
        throw new Rollback(null);
      }

      await auditLogRepository.append({
        entityType: 'bet_boost_lock',
        entityId: created.id,
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
          maxRideValue: maxRideValueForSnapshot,
          maxEligibleBoostPct,
          maxPossibleBoostPct,
          minBoostPct: profile.minBoostPct,
          maxBoostPct: profile.maxBoostPct,
          maxBoostMinSelections: profile.maxBoostMinSelections,
          maxBoostMinCombinedOdds: profile.maxBoostMinCombinedOdds,
          maxEligibilitySelectionWeight: profile.maxEligibilitySelectionWeight,
          maxEligibilityOddsWeight: profile.maxEligibilityOddsWeight,
          effectiveMinFloorRate: profile.effectiveMinFloorRate,
          minSelections: profile.minSelections,
          minCombinedOdds: profile.minCombinedOdds,
          minSelectionOdds: profile.minSelectionOdds,
          checkpointCount,
          volatility,
          rideDurationSeconds,
          rideMode: profile.rideMode,
          seed: reward.seed,
          crashPct,
        },
      }, tx);

      return created;
    });
  } catch (error) {
    // A concurrent lock won the bet_id or reward_id unique key.
    if (!isUniqueViolation(error)) {
      throw error;
    }
    lock = null;
  }

  if (!lock) {
    return resolveLockConflict(input);
  }

  return {
    success: true,
    data: buildLockResponse(lock),
  };
}

/**
 * Replays an existing lock only when it belongs to the requested reward and that
 * reward belongs to the caller's user; any other bet/reward/user combination is a conflict.
 */
async function replayExistingLock(
  existing: BetBoostLock,
  input: LockInput,
  loadedReward?: UserReward
): Promise<ServiceResult<LockResponse>> {
  if (existing.rewardId === input.rewardId) {
    const reward = loadedReward ?? await userRewardRepository.findById(input.rewardId);
    if (reward && reward.userId === input.userId) {
      return { success: true, data: buildLockResponse(existing) };
    }
  }

  return {
    success: false,
    error: {
      code: ReasonCode.BET_ALREADY_LOCKED,
      message: 'Bet is already locked for a different reward',
    },
  };
}

/** After a lost race (unique violation or reward no longer ENTERED), re-read and apply the replay rule. */
async function resolveLockConflict(input: LockInput): Promise<ServiceResult<LockResponse>> {
  const existing = await betBoostLockRepository.findByBetId(input.betId);
  if (existing) {
    return replayExistingLock(existing, input);
  }

  const reward = await userRewardRepository.findById(input.rewardId);
  if (reward?.status === 'EXPIRED') {
    return {
      success: false,
      error: { code: ReasonCode.REWARD_EXPIRED, message: 'Reward has expired' },
    };
  }

  return {
    success: false,
    error: {
      code: ReasonCode.REWARD_ALREADY_USED,
      message: 'Reward has already been used',
    },
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
    effective_min_boost_pct: lock.snapshot.effectiveMinBoostPct,
    effective_max_boost_pct: lock.snapshot.maxEligibleBoostPct,
    theoretical_max_boost_pct: lock.snapshot.maxPossibleBoostPct,
    maximum_model: lock.snapshot.maximumModel,
    boost_model: toBoostModelResponse(lock.snapshot.boostModel),
    ride_stop_at_offset_seconds: roundToDecimals(
      lock.snapshot.rideDurationSeconds * lock.snapshot.elapsedPct,
      3
    ),
    ride_end_at_offset_seconds: roundToDecimals(lock.snapshot.rideDurationSeconds, 3),
    ride_crash_at_offset_seconds: roundToDecimals(
      lock.snapshot.rideDurationSeconds * lock.snapshot.crashPct,
      3
    ),
    ride_path: lock.snapshot.ridePath,
  };
}

function toBoostModelResponse(model: {
  selectionWeight: number;
  oddsWeight: number;
  maxEligibilityExponent: number;
  effectiveMinFloorRate: number;
  selectionRatio: number | null;
  oddsRatio: number | null;
  eligibilityFactor: number;
}): LockResponse['boost_model'] {
  return {
    selection_weight: model.selectionWeight,
    odds_weight: model.oddsWeight,
    max_eligibility_exponent: model.maxEligibilityExponent,
    effective_min_floor_rate: model.effectiveMinFloorRate,
    selection_ratio: model.selectionRatio,
    odds_ratio: model.oddsRatio,
    eligibility_factor: model.eligibilityFactor,
  };
}

function roundToDecimals(value: number, decimals: number): number {
  const factor = Math.pow(10, decimals);
  return Math.round(value * factor) / factor;
}

export const boostLockService = {
  lockBoost,
  getLockByBetId,
};
