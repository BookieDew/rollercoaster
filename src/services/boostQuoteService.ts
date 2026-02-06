import { userRewardRepository } from '../db/repositories/userRewardRepository';
import { rewardProfileRepository } from '../db/repositories/rewardProfileRepository';
import { rideDefinitionRepository } from '../db/repositories/rideDefinitionRepository';
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
  deriveCrashPct,
  buildEffectiveRidePath,
} from '../computations';
import type { Selection, QuoteResponse } from '../types/ticket';
import type { RidePathPoint } from '../types/ride';
import { ReasonCode, type EligibilityReasonCode } from '../types/reasonCodes';
import { config } from '../config';

export interface QuoteInput {
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
  };
}

/**
 * Computes current boost for a prospective slip.
 * Filters selections, computes combined odds, checks eligibility thresholds,
 * computes ticket strength, gets current ride value, and calculates final boost.
 * Note: Time remaining is not exposed in the response.
 */
export async function getQuote(
  input: QuoteInput
): Promise<ServiceResult<QuoteResponse>> {
  const { userId, rewardId, betId } = input;

  // Fetch the reward
  const reward = await userRewardRepository.findById(rewardId);
  if (!reward) {
    return {
      success: true,
      data: buildIneligibleResponse(
        ReasonCode.REWARD_NOT_FOUND,
        0,
        0,
        0
      ),
    };
  }

  // Verify ownership
  if (reward.userId !== userId) {
    return {
      success: true,
      data: buildIneligibleResponse(
        ReasonCode.REWARD_NOT_FOUND,
        0,
        0,
        0
      ),
    };
  }

  // Check reward status
  if (reward.status === 'EXPIRED' || reward.status === 'USED') {
    const code = reward.status === 'EXPIRED'
      ? ReasonCode.REWARD_EXPIRED
      : ReasonCode.REWARD_ALREADY_USED;
    return {
      success: true,
      data: buildIneligibleResponse(code, 0, 0, 0),
    };
  }

  // Check if opted in
  if (reward.status !== 'ENTERED') {
    return {
      success: true,
      data: buildIneligibleResponse(
        ReasonCode.NOT_OPTED_IN,
        0,
        0,
        0
      ),
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

  if (!reward.betId || reward.betId !== betId || !reward.ticketSnapshot) {
    return {
      success: true,
      data: buildIneligibleResponse(
        ReasonCode.NOT_OPTED_IN,
        0,
        0,
        0
      ),
    };
  }

  const storedSelections = (reward.ticketSnapshot.selections as Selection[]) ?? [];
  const { qualifying } = filterQualifyingSelections(
    storedSelections,
    profile.minSelectionOdds
  );

  const combinedOdds = calculateCombinedOdds(qualifying);
  const tentativeTicketStrength = computeTicketStrength(qualifying.length, combinedOdds, {
    minSelections: profile.minSelections,
  });

  // Check minimum selection count
  if (!meetsMinSelectionCount(qualifying.length, profile.minSelections)) {
    return {
      success: true,
      data: buildIneligibleResponse(
        ReasonCode.MIN_SELECTIONS_NOT_MET,
        storedSelections.length,
        qualifying.length,
        combinedOdds,
        null,
        null,
        tentativeTicketStrength
      ),
    };
  }

  // Check minimum combined odds
  if (!meetsCombinedOddsThreshold(combinedOdds, profile.minCombinedOdds)) {
    return {
      success: true,
      data: buildIneligibleResponse(
        ReasonCode.MIN_COMBINED_ODDS_NOT_MET,
        storedSelections.length,
        qualifying.length,
        combinedOdds,
        null,
        null,
        tentativeTicketStrength
      ),
    };
  }

  // Compute ticket strength
  const ticketStrength = tentativeTicketStrength;

  const elapsedPct = calculateElapsedPct(reward.startTime, reward.endTime);
  const rideDurationSeconds =
    (new Date(reward.endTime).getTime() - new Date(reward.startTime).getTime()) / 1000;
  const crashPct = deriveCrashPct(
    reward.seed,
    rideDurationSeconds,
    config.ride.minCrashSeconds
  );
  const crashOffsetSeconds = roundToDecimals(crashPct * rideDurationSeconds, 3);
  const endOffsetSeconds = roundToDecimals(rideDurationSeconds, 3);

  // Get ride checkpoints and current value
  const checkpoints = await rideDefinitionRepository.findByRewardId(rewardId);
  const rideValue = interpolateRideValue(
    checkpoints.map((cp) => ({
      index: cp.checkpointIndex,
      timeOffsetPct: cp.timeOffsetPct,
      baseBoostValue: cp.baseBoostValue,
    })),
    elapsedPct
  );
  const maxRideValue = getMaxRideValue(checkpoints, crashPct);
  const ridePath = buildEffectiveRidePath(
    checkpoints,
    60,
    crashPct,
    ticketStrength,
    {
      minBoostPct: profile.minBoostPct,
      maxBoostPct: profile.maxBoostPct,
      maxBoostMinSelections: profile.maxBoostMinSelections,
      maxBoostMinCombinedOdds: profile.maxBoostMinCombinedOdds,
    },
    qualifying.length,
    combinedOdds
  );

  // Calculate final boost
  const currentBoostPct = calculateFinalBoost({
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
  const theoreticalMaxBoostPct = calculateFinalBoost({
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

  // Check if ride has crashed or ended
  if (elapsedPct >= crashPct) {
    return {
      success: true,
      data: buildRideEndedResponse(
        ReasonCode.RIDE_CRASHED,
        storedSelections.length,
        qualifying.length,
        combinedOdds,
        ticketStrength,
        theoreticalMaxBoostPct,
        ridePath,
        endOffsetSeconds,
        crashOffsetSeconds
      ),
    };
  }
  if (checkRideEnded(reward.startTime, reward.endTime)) {
    return {
      success: true,
      data: buildRideEndedResponse(
        ReasonCode.RIDE_ENDED,
        storedSelections.length,
        qualifying.length,
        combinedOdds,
        ticketStrength,
        theoreticalMaxBoostPct,
        ridePath,
        endOffsetSeconds,
        crashOffsetSeconds
      ),
    };
  }

  return {
    success: true,
    data: {
      eligible: true,
      reason_code: ReasonCode.ELIGIBLE,
      qualifying_selection_count: qualifying.length,
      total_selection_count: storedSelections.length,
      combined_odds: combinedOdds,
      current_boost_pct: currentBoostPct,
      theoretical_max_boost_pct: theoreticalMaxBoostPct,
      ticket_strength: ticketStrength,
      ride_end_at_offset_seconds: null,
      ride_crash_at_offset_seconds: null,
    },
  };
}

function buildIneligibleResponse(
  reasonCode: EligibilityReasonCode,
  totalCount: number,
  qualifyingCount: number,
  combinedOdds: number,
  endOffsetSeconds: number | null = null,
  crashOffsetSeconds: number | null = null,
  ticketStrength: number | null = null
): QuoteResponse {
  return {
    eligible: false,
    reason_code: reasonCode,
    qualifying_selection_count: qualifyingCount,
    total_selection_count: totalCount,
    combined_odds: combinedOdds,
    current_boost_pct: null,
    theoretical_max_boost_pct: null,
    ticket_strength: ticketStrength,
    ride_end_at_offset_seconds: endOffsetSeconds,
    ride_crash_at_offset_seconds: crashOffsetSeconds,
  };
}

function buildRideEndedResponse(
  reasonCode: EligibilityReasonCode,
  totalCount: number,
  qualifyingCount: number,
  combinedOdds: number,
  ticketStrength: number,
  theoreticalMaxBoostPct: number,
  ridePath: RidePathPoint[],
  endOffsetSeconds: number,
  crashOffsetSeconds: number
): QuoteResponse {
  return {
    eligible: false,
    reason_code: reasonCode,
    qualifying_selection_count: qualifyingCount,
    total_selection_count: totalCount,
    combined_odds: combinedOdds,
    current_boost_pct: 0,
    theoretical_max_boost_pct: theoreticalMaxBoostPct,
    ticket_strength: ticketStrength,
    ride_end_at_offset_seconds: endOffsetSeconds,
    ride_crash_at_offset_seconds: crashOffsetSeconds,
    ride_path: ridePath,
  };
}

function roundToDecimals(value: number, decimals: number): number {
  const factor = Math.pow(10, decimals);
  return Math.round(value * factor) / factor;
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

export const boostQuoteService = {
  getQuote,
};
