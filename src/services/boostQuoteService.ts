import { userRewardRepository } from '../db/repositories/userRewardRepository';
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
import type { BoostModelReport, Selection, QuoteResponse } from '../types/ticket';
import type { RidePathPoint, MaximumModel } from '../types/ride';
import { ReasonCode, type EligibilityReasonCode } from '../types/reasonCodes';
import { resolveRideMathSnapshot, resolveRideCheckpoints } from './rideMathSnapshot';

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
  const boostModelDetails = computeBoostModelDetails(
    qualifying.length,
    combinedOdds,
    {
      minBoostPct: profile.minBoostPct,
      maxBoostPct: profile.maxBoostPct,
      maxBoostMinSelections: profile.maxBoostMinSelections,
      maxBoostMinCombinedOdds: profile.maxBoostMinCombinedOdds,
      maxEligibilitySelectionWeight: profile.maxEligibilitySelectionWeight,
      maxEligibilityOddsWeight: profile.maxEligibilityOddsWeight,
      effectiveMinFloorRate: profile.effectiveMinFloorRate,
    }
  );
  const boostModel = toBoostModelReport(boostModelDetails);
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
        boostModelDetails.effectiveMinBoost,
        boostModelDetails.effectiveMaxBoost,
        null,
        null,
        tentativeTicketStrength,
        boostModel
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
        boostModelDetails.effectiveMinBoost,
        boostModelDetails.effectiveMaxBoost,
        null,
        null,
        tentativeTicketStrength,
        boostModel
      ),
    };
  }

  // Compute ticket strength
  const ticketStrength = tentativeTicketStrength;

  const evaluationTime = new Date(Date.now());
  const elapsedPct = calculateElapsedPct(rideMath.startTime, rideMath.endTime, evaluationTime);
  const rideElapsedSeconds = (evaluationTime.getTime() - new Date(rideMath.startTime).getTime()) / 1000;
  const { rideDurationSeconds, crashPct, checkpointCount, volatility } = rideMath;
  const crashOffsetSeconds = roundToDecimals(crashPct * rideDurationSeconds, 3);
  const endOffsetSeconds = roundToDecimals(rideDurationSeconds, 3);

  const finalBoostConfig = {
    minBoostPct: profile.minBoostPct,
    maxBoostPct: profile.maxBoostPct,
    maxBoostMinSelections: profile.maxBoostMinSelections,
    maxBoostMinCombinedOdds: profile.maxBoostMinCombinedOdds,
    maxEligibilitySelectionWeight: profile.maxEligibilitySelectionWeight,
    maxEligibilityOddsWeight: profile.maxEligibilityOddsWeight,
    effectiveMinFloorRate: profile.effectiveMinFloorRate,
  };
  const isLinearRide = profile.rideMode === 'LINEAR';
  let currentBoostPct: number;
  let theoreticalMaxBoostPct: number;
  let effectiveMinBoostPct: number;
  let effectiveMaxBoostPct: number;
  let ridePath: RidePathPoint[];

  if (isLinearRide) {
    effectiveMinBoostPct = boostModelDetails.effectiveMinBoost;
    effectiveMaxBoostPct = boostModelDetails.effectiveMaxBoost;
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
    currentBoostPct = calculateLinearBoostPctAtElapsed(
      elapsedPct,
      crashPct,
      effectiveMinBoostPct,
      linearMaxBoostPct
    );
    theoreticalMaxBoostPct = linearMaxBoostPct;
    ridePath = buildLinearEffectiveRidePath(
      60,
      crashPct,
      effectiveMinBoostPct,
      linearMaxBoostPct
    );
  } else {
    // Get ride checkpoints and current value for wave mode.
    const checkpoints = await resolveRideCheckpoints(rewardId, rideMath);
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

    const currentBoostDetails = calculateFinalBoostDetails({
      rideValue,
      ticketStrength,
      qualifyingSelections: qualifying.length,
      combinedOdds,
      hasRideEnded: false,
      config: finalBoostConfig,
    });
    currentBoostPct = currentBoostDetails.finalBoostPct;
    effectiveMinBoostPct = currentBoostDetails.minBoost;
    effectiveMaxBoostPct = currentBoostDetails.effectiveMaxBoost;
    const theoreticalMaxBoostDetails = calculateFinalBoostDetails({
      rideValue: getMaxRideValue(checkpoints, crashPct, rideMath.maximumModel),
      ticketStrength,
      qualifyingSelections: qualifying.length,
      combinedOdds,
      hasRideEnded: false,
      config: finalBoostConfig,
    });
    theoreticalMaxBoostPct = theoreticalMaxBoostDetails.finalBoostPct;
  }

  // Check if ride has crashed or ended
  const rideCrashed = elapsedPct >= crashPct && crashPct < 1;
  const rideEnded = checkRideEnded(rideMath.startTime, rideMath.endTime, evaluationTime);

  if (rideCrashed) {
    return {
      success: true,
      data: buildRideEndedResponse(
        ReasonCode.RIDE_CRASHED,
        storedSelections.length,
        qualifying.length,
        combinedOdds,
        effectiveMinBoostPct,
        effectiveMaxBoostPct,
        ticketStrength,
        theoreticalMaxBoostPct,
        boostModel,
        ridePath,
        endOffsetSeconds,
        crashOffsetSeconds,
        rideElapsedSeconds,
        rideMath.maximumModel
      ),
    };
  }
  if (rideEnded) {
    return {
      success: true,
      data: buildRideEndedResponse(
        ReasonCode.RIDE_ENDED,
        storedSelections.length,
        qualifying.length,
        combinedOdds,
        effectiveMinBoostPct,
        effectiveMaxBoostPct,
        ticketStrength,
        theoreticalMaxBoostPct,
        boostModel,
        ridePath,
        endOffsetSeconds,
        crashOffsetSeconds,
        rideElapsedSeconds,
        rideMath.maximumModel
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
      effective_min_boost_pct: effectiveMinBoostPct,
      effective_max_boost_pct: effectiveMaxBoostPct,
      theoretical_max_boost_pct: theoreticalMaxBoostPct,
      maximum_model: rideMath.maximumModel,
      ticket_strength: ticketStrength,
      boost_model: boostModel,
      ride_elapsed_seconds: rideElapsedSeconds,
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
  effectiveMinBoostPct: number | null = null,
  effectiveMaxBoostPct: number | null = null,
  endOffsetSeconds: number | null = null,
  crashOffsetSeconds: number | null = null,
  ticketStrength: number | null = null,
  boostModel: BoostModelReport | null = null
): QuoteResponse {
  return {
    eligible: false,
    reason_code: reasonCode,
    qualifying_selection_count: qualifyingCount,
    total_selection_count: totalCount,
    combined_odds: combinedOdds,
    current_boost_pct: null,
    effective_min_boost_pct: effectiveMinBoostPct,
    effective_max_boost_pct: effectiveMaxBoostPct,
    theoretical_max_boost_pct: null,
    ticket_strength: ticketStrength,
    boost_model: boostModel,
    ride_end_at_offset_seconds: endOffsetSeconds,
    ride_crash_at_offset_seconds: crashOffsetSeconds,
  };
}

function buildRideEndedResponse(
  reasonCode: EligibilityReasonCode,
  totalCount: number,
  qualifyingCount: number,
  combinedOdds: number,
  effectiveMinBoostPct: number,
  effectiveMaxBoostPct: number,
  ticketStrength: number,
  theoreticalMaxBoostPct: number,
  boostModel: BoostModelReport,
  ridePath: RidePathPoint[],
  endOffsetSeconds: number,
  crashOffsetSeconds: number,
  rideElapsedSeconds: number,
  maximumModel: MaximumModel
): QuoteResponse {
  return {
    eligible: false,
    reason_code: reasonCode,
    qualifying_selection_count: qualifyingCount,
    total_selection_count: totalCount,
    combined_odds: combinedOdds,
    current_boost_pct: 0,
    ride_elapsed_seconds: rideElapsedSeconds,
    effective_min_boost_pct: effectiveMinBoostPct,
    effective_max_boost_pct: effectiveMaxBoostPct,
    theoretical_max_boost_pct: theoreticalMaxBoostPct,
    maximum_model: maximumModel,
    ticket_strength: ticketStrength,
    boost_model: boostModel,
    ride_end_at_offset_seconds: endOffsetSeconds,
    ride_crash_at_offset_seconds: crashOffsetSeconds,
    ride_path: ridePath,
  };
}

function toBoostModelReport(details: {
  selectionWeight: number;
  oddsWeight: number;
  maxEligibilityExponent: number;
  effectiveMinFloorRate: number;
  selectionRatio: number | null;
  oddsRatio: number | null;
  eligibilityFactor: number;
}): BoostModelReport {
  return {
    selection_weight: details.selectionWeight,
    odds_weight: details.oddsWeight,
    max_eligibility_exponent: details.maxEligibilityExponent,
    effective_min_floor_rate: details.effectiveMinFloorRate,
    selection_ratio: details.selectionRatio,
    odds_ratio: details.oddsRatio,
    eligibility_factor: details.eligibilityFactor,
  };
}

function roundToDecimals(value: number, decimals: number): number {
  const factor = Math.pow(10, decimals);
  return Math.round(value * factor) / factor;
}

export const boostQuoteService = {
  getQuote,
};
