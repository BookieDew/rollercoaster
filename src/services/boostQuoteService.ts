import { userRewardRepository } from '../db/repositories/userRewardRepository';
import type { BoostModelReport, Selection, QuoteResponse } from '../types/ticket';
import { MAXIMUM_MODEL_V4 } from '../types/ride';
import { ReasonCode, type EligibilityReasonCode } from '../types/reasonCodes';
import type { UserReward } from '../types/userReward';
import {
  crashOffsetSeconds,
  hasRetiredRideMath,
  resolveRideMath,
  rideClock,
  sampleRidePath,
} from './rideMathSnapshot';
import { evaluateTicket, toBoostModelReport } from './ticketEvaluation';

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
  if (reward.status === 'USED') {
    return {
      success: true,
      data: buildIneligibleResponse(ReasonCode.REWARD_ALREADY_USED, 0, 0, 0),
    };
  }

  if (reward.status === 'EXPIRED') {
    return quoteExpiredReward(reward, betId);
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

  return quoteEnteredRide(reward, betId);
}

/** True when the reward was opted into: a bet and its ticket are bound to it. */
export function hasEnteredRide(reward: UserReward): boolean {
  return reward.betId !== null && reward.betId !== undefined && reward.ticketSnapshot !== null;
}

/**
 * An EXPIRED reward that entered a ride for this bet still reports that ride's
 * terminal result (RIDE_CRASHED / RIDE_ENDED, with the usual terminal details),
 * so expiry never hides a ride outcome. REWARD_EXPIRED is reported otherwise.
 */
async function quoteExpiredReward(
  reward: UserReward,
  betId: string
): Promise<ServiceResult<QuoteResponse>> {
  const expired: ServiceResult<QuoteResponse> = {
    success: true,
    data: buildIneligibleResponse(ReasonCode.REWARD_EXPIRED, 0, 0, 0),
  };
  if (!hasEnteredRide(reward) || reward.betId !== betId) {
    return expired;
  }
  const evaluated = await quoteEnteredRide(reward, betId);
  const code = evaluated.data?.reason_code;
  return evaluated.success && (code === ReasonCode.RIDE_CRASHED || code === ReasonCode.RIDE_ENDED)
    ? evaluated
    : expired;
}

/** Quote of a reward whose V4 ride was started. */
async function quoteEnteredRide(
  reward: UserReward,
  betId: string
): Promise<ServiceResult<QuoteResponse>> {
  if (!reward.betId || reward.betId !== betId || !reward.ticketSnapshot) {
    return {
      success: true,
      data: buildIneligibleResponse(ReasonCode.NOT_OPTED_IN, 0, 0, 0),
    };
  }

  // The frozen V4 ride; anything else (a retired V1-V3 ride, a damaged snapshot) fails closed.
  const resolved = resolveRideMath(reward);
  if (!resolved) {
    return {
      success: false,
      error: {
        code: ReasonCode.INVALID_CONFIGURATION,
        message: hasRetiredRideMath(reward)
          ? 'Ride uses a retired math version and cannot be quoted'
          : 'Invalid saved ride math',
      },
    };
  }
  const { math, ride } = resolved;

  const storedSelections = (reward.ticketSnapshot.selections as Selection[]) ?? [];
  const ticket = evaluateTicket(storedSelections, math.profile);
  const boostModel = toBoostModelReport(ticket.boostModel);
  const effectiveMinBoostPct = math.effectiveMinBoostPct;
  const effectiveMaxBoostPct = math.effectiveMaxBoostPct;

  if (ticket.reason !== ReasonCode.ELIGIBLE) {
    return {
      success: true,
      data: buildIneligibleResponse(
        ticket.reason,
        storedSelections.length,
        ticket.qualifying.length,
        ticket.combinedOddsDisplay,
        effectiveMinBoostPct,
        effectiveMaxBoostPct,
        null,
        null,
        math.ticketStrength,
        boostModel
      ),
    };
  }

  const clock = rideClock(math, Date.now());
  if (clock.crashed || clock.ended) {
    return {
      success: true,
      data: {
        eligible: false,
        reason_code: clock.crashed ? ReasonCode.RIDE_CRASHED : ReasonCode.RIDE_ENDED,
        qualifying_selection_count: ticket.qualifying.length,
        total_selection_count: storedSelections.length,
        combined_odds: ticket.combinedOddsDisplay,
        current_boost_pct: 0,
        ride_elapsed_seconds: clock.elapsedSeconds,
        effective_min_boost_pct: effectiveMinBoostPct,
        effective_max_boost_pct: effectiveMaxBoostPct,
        theoretical_max_boost_pct: math.preCrashMaximumPct,
        maximum_model: MAXIMUM_MODEL_V4,
        ticket_strength: math.ticketStrength,
        boost_model: boostModel,
        ride_end_at_offset_seconds: roundToDecimals(math.rideDurationSeconds, 3),
        ride_crash_at_offset_seconds: roundToDecimals(crashOffsetSeconds(math), 3),
        ride_path: sampleRidePath(resolved),
      },
    };
  }

  return {
    success: true,
    data: {
      eligible: true,
      reason_code: ReasonCode.ELIGIBLE,
      qualifying_selection_count: ticket.qualifying.length,
      total_selection_count: storedSelections.length,
      combined_odds: ticket.combinedOddsDisplay,
      current_boost_pct: ride.boostAt(clock.elapsedSeconds),
      effective_min_boost_pct: effectiveMinBoostPct,
      effective_max_boost_pct: effectiveMaxBoostPct,
      // Internal only: getPublicQuote withholds it while the ride is live.
      theoretical_max_boost_pct: math.preCrashMaximumPct,
      maximum_model: MAXIMUM_MODEL_V4,
      ticket_strength: math.ticketStrength,
      boost_model: boostModel,
      ride_elapsed_seconds: clock.elapsedSeconds,
      ride_end_at_offset_seconds: null,
      ride_crash_at_offset_seconds: null,
    },
  };
}

/**
 * Player-facing view of a quote. While a ride is live (eligible), the per-ride
 * reference maximum would reveal the outcome (for LINEAR, the exact crash time),
 * so it is withheld; terminal and ineligible quotes are returned unchanged.
 */
export function toPublicQuote(quote: QuoteResponse): QuoteResponse {
  return quote.eligible ? { ...quote, theoretical_max_boost_pct: null } : quote;
}

/**
 * Quote for the public API. `getQuote` remains the authoritative internal
 * computation (used by audit/parity checks); only this redacted view is served.
 */
export async function getPublicQuote(
  input: QuoteInput
): Promise<ServiceResult<QuoteResponse>> {
  const result = await getQuote(input);
  return result.success && result.data
    ? { ...result, data: toPublicQuote(result.data) }
    : result;
}

function buildIneligibleResponse(
  reasonCode: EligibilityReasonCode,
  totalCount: number,
  qualifyingCount: number,
  combinedOdds: number | string,
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

function roundToDecimals(value: number, decimals: number): number {
  const factor = Math.pow(10, decimals);
  return Math.round(value * factor) / factor;
}

export const boostQuoteService = {
  getQuote,
  getPublicQuote,
};
