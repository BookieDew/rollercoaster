import { userRewardRepository, BetAlreadyBoundError } from '../db/repositories/userRewardRepository';
import { rewardProfileRepository } from '../db/repositories/rewardProfileRepository';
import { rideDefinitionRepository } from '../db/repositories/rideDefinitionRepository';
import { auditLogRepository } from '../db/repositories/auditLogRepository';
import { runInTransaction, Rollback } from '../db/repositories/transaction';
import {
  deriveRideParams,
  deriveRideDurationSeconds,
} from '../computations/deterministicRideGenerator';
import {
  filterQualifyingSelections,
  calculateCombinedOdds,
  meetsMinSelectionCount,
  meetsCombinedOddsThreshold,
  computeTicketStrength,
  generatePhaseCorrectedRide,
} from '../computations';
import type { UserReward } from '../types/userReward';
import type { Selection } from '../types/ticket';
import { ReasonCode } from '../types/reasonCodes';
import { config } from '../config';
import { createRideMathSnapshot, resolveRideMathSnapshot, resolveRideCheckpoints } from './rideMathSnapshot';

export interface ServiceResult<T> {
  success: boolean;
  data?: T;
  error?: {
    code: ReasonCode;
    message: string;
  };
}

export interface OptInResult {
  reward: UserReward;
  rideStarted: boolean;
}

export interface OptInInput {
  userId: string;
  betId: string;
  selections: Selection[];
}

export interface EligibilityResult {
  eligible: boolean;
  reason_code: ReasonCode;
  qualifying_selection_count: number;
  total_selection_count: number;
  combined_odds: number;
  ticket_strength: number | null;
}

function buildEligibilityResponse(
  reasonCode: ReasonCode,
  totalCount: number,
  qualifyingCount: number,
  combinedOdds: number,
  ticketStrength: number | null
): EligibilityResult {
  return {
    eligible: reasonCode === ReasonCode.ELIGIBLE,
    reason_code: reasonCode,
    qualifying_selection_count: qualifyingCount,
    total_selection_count: totalCount,
    combined_odds: combinedOdds,
    ticket_strength: ticketStrength,
  };
}

export async function precheckEligibility(
  rewardId: string,
  userId: string,
  selections: Selection[]
): Promise<ServiceResult<EligibilityResult>> {
  const reward = await userRewardRepository.findById(rewardId);

  if (!reward || reward.userId !== userId) {
    return { success: true, data: buildEligibilityResponse(ReasonCode.REWARD_NOT_FOUND, selections.length, 0, 0, null) };
  }

  if (reward.status === 'USED') {
    return { success: true, data: buildEligibilityResponse(ReasonCode.REWARD_ALREADY_USED, selections.length, 0, 0, null) };
  }

  if (reward.status === 'EXPIRED') {
    return { success: true, data: buildEligibilityResponse(ReasonCode.REWARD_EXPIRED, selections.length, 0, 0, null) };
  }

  if (reward.status === 'ENTERED') {
    return { success: true, data: buildEligibilityResponse(ReasonCode.ALREADY_OPTED_IN, selections.length, 0, 0, null) };
  }

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

  const { qualifying } = filterQualifyingSelections(
    selections,
    profile.minSelectionOdds
  );

  const combinedOdds = calculateCombinedOdds(qualifying);
  const tentativeTicketStrength = computeTicketStrength(qualifying.length, combinedOdds, {
    minSelections: profile.minSelections,
  });

  if (!meetsMinSelectionCount(qualifying.length, profile.minSelections)) {
    return {
      success: true,
      data: buildEligibilityResponse(
        ReasonCode.MIN_SELECTIONS_NOT_MET,
        selections.length,
        qualifying.length,
        combinedOdds,
        tentativeTicketStrength
      ),
    };
  }

  if (!meetsCombinedOddsThreshold(combinedOdds, profile.minCombinedOdds)) {
    return {
      success: true,
      data: buildEligibilityResponse(
        ReasonCode.MIN_COMBINED_ODDS_NOT_MET,
        selections.length,
        qualifying.length,
        combinedOdds,
        tentativeTicketStrength
      ),
    };
  }

  const ticketStrength = tentativeTicketStrength;

  return {
    success: true,
    data: buildEligibilityResponse(ReasonCode.ELIGIBLE, selections.length, qualifying.length, combinedOdds, ticketStrength),
  };
}

/**
 * Handles user opt-in to a reward after bet placement.
 * Validates the reward and bet eligibility, starts the ride,
 * and generates ride checkpoints using the deterministic generator.
 */
export async function optIn(
  rewardId: string,
  input: OptInInput
): Promise<ServiceResult<OptInResult>> {
  const { userId, betId, selections } = input;
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

  // Verify the reward belongs to this user
  if (reward.userId !== userId) {
    return {
      success: false,
      error: {
        code: ReasonCode.REWARD_NOT_FOUND,
        message: 'Reward not found for this user',
      },
    };
  }

  // Check if already opted in
  if (reward.status === 'ENTERED') {
    return {
      success: false,
      error: {
        code: ReasonCode.ALREADY_OPTED_IN,
        message: 'User has already opted into this reward',
      },
    };
  }

  // Check if reward is already used or expired
  if (reward.status === 'USED') {
    return {
      success: false,
      error: {
        code: ReasonCode.REWARD_ALREADY_USED,
        message: 'Reward has already been used',
      },
    };
  }

  if (reward.status === 'EXPIRED') {
    return {
      success: false,
      error: {
        code: ReasonCode.REWARD_EXPIRED,
        message: 'Reward has expired',
      },
    };
  }

  // Get the profile to generate ride checkpoints
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

  // Validate eligibility based on ticket (bet already placed)
  const { qualifying, disqualified } = filterQualifyingSelections(
    selections,
    profile.minSelectionOdds
  );

  const combinedOdds = calculateCombinedOdds(qualifying);

  if (!meetsMinSelectionCount(qualifying.length, profile.minSelections)) {
    return {
      success: false,
      error: {
        code: ReasonCode.MIN_SELECTIONS_NOT_MET,
        message: `Minimum ${profile.minSelections} qualifying selections required, got ${qualifying.length}`,
      },
    };
  }

  if (!meetsCombinedOddsThreshold(combinedOdds, profile.minCombinedOdds)) {
    return {
      success: false,
      error: {
        code: ReasonCode.MIN_COMBINED_ODDS_NOT_MET,
        message: `Minimum combined odds of ${profile.minCombinedOdds} required, got ${combinedOdds.toFixed(2)}`,
      },
    };
  }

  const ticketStrength = computeTicketStrength(qualifying.length, combinedOdds, {
    minSelections: profile.minSelections,
  });

  // Generate deterministic seed and ride
  const seed = reward.seed;
  const durationSeconds = deriveRideDurationSeconds(
    seed,
    config.ride.minDurationSeconds,
    config.ride.maxDurationSeconds
  );
  const derived = deriveRideParams(seed, durationSeconds, config.ride.minCrashSeconds);
  const ride = generatePhaseCorrectedRide(seed, {
    checkpointCount: derived.checkpointCount,
    volatility: derived.volatility,
    minBoostPct: profile.minBoostPct,
    maxBoostPct: profile.maxBoostPct,
    rideMode: profile.rideMode,
    ticketStrength,
    durationSeconds,
    crashPct: derived.crashPct,
    minPeakDelaySeconds: 2,
    qualifyingSelections: qualifying.length,
    combinedOdds,
    finalBoostConfig: profile,
  });

  // Start ride timing now (short duration)
  const now = new Date();
  const startTime = now.toISOString();
  const endTime = new Date(now.getTime() + durationSeconds * 1000).toISOString();

  // Ride checkpoints to persist (legacy table copy; V3 JSON in the snapshot is authoritative)
  const checkpointInputs = ride.checkpoints.map((cp) => ({
    rewardId,
    checkpointIndex: cp.index,
    timeOffsetPct: cp.timeOffsetPct,
    baseBoostValue: cp.baseBoostValue,
  }));

  const optedInAt = now.toISOString();
  const ticketSnapshot = {
    rideMath: createRideMathSnapshot(profile, startTime, endTime, derived, 3, ride),
    selections,
    qualifyingSelections: qualifying,
    disqualifiedSelections: disqualified,
    combinedOdds,
    ticketStrength,
    minSelectionOdds: profile.minSelectionOdds,
    minSelections: profile.minSelections,
    minCombinedOdds: profile.minCombinedOdds,
  };

  try {
    // Claim (GRANTED -> ENTERED), bet binding, checkpoints and audit are atomic.
    return await runInTransaction<ServiceResult<OptInResult>>(async (tx) => {
      const claimed = await userRewardRepository.updateStatus(rewardId, 'ENTERED', optedInAt, {
        tx,
        fromStatus: 'GRANTED',
      });
      if (!claimed) {
        throw new Rollback(failure(ReasonCode.ALREADY_OPTED_IN, 'User has already opted into this reward'));
      }

      const enteredReward = await userRewardRepository.updateRideStart(
        rewardId,
        startTime,
        endTime,
        betId,
        ticketSnapshot,
        tx
      );
      if (!enteredReward) {
        throw new Rollback(failure(ReasonCode.INTERNAL_ERROR, 'Failed to start ride'));
      }

      await rideDefinitionRepository.createMany(checkpointInputs, tx);

      await auditLogRepository.append({
        entityType: 'user_reward',
        entityId: rewardId,
        action: 'OPT_IN',
        payload: {
          userId,
          betId,
          optedInAt,
          checkpointCount: ride.checkpoints.length,
          volatility: derived.volatility,
          rideMode: profile.rideMode,
          crashPct: derived.crashPct,
          seed,
          durationSeconds,
          combinedOdds,
          ticketStrength,
          mathSnapshotVersion: 3,
          phaseDiagnostics: ride.phaseDiagnostics,
        },
      }, tx);

      return {
        success: true,
        data: {
          reward: enteredReward,
          rideStarted: true,
        },
      };
    });
  } catch (error) {
    if (error instanceof BetAlreadyBoundError) {
      return failure(ReasonCode.BET_ALREADY_BOUND, 'Bet is already bound to a different reward');
    }
    throw error;
  }
}

function failure<T>(code: ReasonCode, message: string): ServiceResult<T> {
  return { success: false, error: { code, message } };
}

/**
 * Gets the ride checkpoints for a reward.
 */
export async function getRideCheckpoints(rewardId: string) {
  const reward = await userRewardRepository.findById(rewardId);
  if (reward?.ticketSnapshot?.rideMath != null) {
    const math = await resolveRideMathSnapshot(reward!);
    if (!math) throw new Error('Invalid saved ride math snapshot');
    return resolveRideCheckpoints(rewardId, math);
  }
  return rideDefinitionRepository.findByRewardId(rewardId);
}

export const rewardOptInService = {
  optIn,
  getRideCheckpoints,
  precheckEligibility,
};
