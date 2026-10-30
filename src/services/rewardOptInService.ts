import { userRewardRepository, BetAlreadyBoundError, type OptInMoney } from '../db/repositories/userRewardRepository';
import { rewardProfileRepository } from '../db/repositories/rewardProfileRepository';
import { auditLogRepository } from '../db/repositories/auditLogRepository';
import { runInTransaction, Rollback, isUniqueViolation } from '../db/repositories/transaction';
import type { UserReward } from '../types/userReward';
import type { Selection } from '../types/ticket';
import { ReasonCode } from '../types/reasonCodes';
import { LEGACY_BRAND_ID } from '../types/brand';
import { config } from '../config';
import { buildRideMath, toRideMathProfile } from './rideMathSnapshot';
import { describeOdds, evaluateTicket } from './ticketEvaluation';
import { expireGrantedReward } from './rewardExpiryService';

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
  /**
   * Stake in integer minor units (e.g. 1000 = 10.00) and ISO-4217 currency. The
   * HTTP schema requires both; they are optional here only for internal callers
   * that predate Phase 1a. When both are given, the currency must be a key of
   * the profile's max_bonus_minor map and the stake/currency/cap are frozen on
   * the reward.
   */
  stakeMinor?: number;
  currency?: string;
  selections: Selection[];
}

export interface EligibilityResult {
  eligible: boolean;
  reason_code: ReasonCode;
  qualifying_selection_count: number;
  total_selection_count: number;
  /** Exact decimal string when the combined odds are beyond the double range. */
  combined_odds: number | string;
  ticket_strength: number | null;
}

function buildEligibilityResponse(
  reasonCode: ReasonCode,
  totalCount: number,
  qualifyingCount: number,
  combinedOdds: number | string,
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

/** True once the reward's validity window has elapsed (legacy rewards never expire). */
function isPastValidity(reward: UserReward, now: Date): boolean {
  return reward.validUntil != null && now.getTime() > new Date(reward.validUntil).getTime();
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

  if (isPastValidity(reward, new Date())) {
    return { success: true, data: buildEligibilityResponse(ReasonCode.REWARD_EXPIRED, selections.length, 0, 0, null) };
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

  const ticket = evaluateTicket(selections, profile);
  return {
    success: true,
    data: buildEligibilityResponse(
      ticket.reason,
      selections.length,
      ticket.qualifying.length,
      ticket.combinedOddsDisplay,
      ticket.ticketStrength
    ),
  };
}

/**
 * Handles user opt-in to a reward after bet placement.
 * Validates the reward and bet eligibility (exact combined odds), starts the V4 ride and freezes
 * its payout inputs in the reward's ticket snapshot.
 */
export async function optIn(
  rewardId: string,
  input: OptInInput
): Promise<ServiceResult<OptInResult>> {
  const { userId, betId, stakeMinor, currency, selections } = input;
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

  // Validity: a reward opted into after valid_until is expired (conditionally, with audit).
  if (isPastValidity(reward, new Date())) {
    await expireGrantedReward(reward, new Date(), 'OPT_IN');
    return failure(ReasonCode.REWARD_EXPIRED, 'Reward has expired');
  }

  // Get the profile: its ride-math fields are frozen into the ride snapshot
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

  // The bonus cap is copied from the profile now, so later profile edits never
  // change an in-flight bet.
  let money: OptInMoney | undefined;
  if (stakeMinor !== undefined && currency !== undefined) {
    const bonusCapMinor = profile.maxBonusMinor?.[currency];
    if (bonusCapMinor === undefined) {
      return failure(
        ReasonCode.CURRENCY_NOT_SUPPORTED,
        `Currency ${currency} is not supported by this reward profile`
      );
    }
    money = { stakeMinor, currency, bonusCapMinor };
  }

  // Validate eligibility based on ticket (bet already placed): exact combined odds.
  const ticket = evaluateTicket(selections, profile);
  if (ticket.reason === ReasonCode.MIN_SELECTIONS_NOT_MET) {
    return failure(
      ReasonCode.MIN_SELECTIONS_NOT_MET,
      `Minimum ${profile.minSelections} qualifying selections required, got ${ticket.qualifying.length}`
    );
  }
  if (ticket.reason === ReasonCode.MIN_COMBINED_ODDS_NOT_MET) {
    return failure(
      ReasonCode.MIN_COMBINED_ODDS_NOT_MET,
      `Minimum combined odds of ${profile.minCombinedOdds} required, got ${describeOdds(ticket)}`
    );
  }

  // Build the V4 ride from the secret seed and freeze every payout input. The ride starts now.
  const now = new Date();
  const { math: rideMath } = buildRideMath(
    reward.seed,
    toRideMathProfile(profile),
    ticket,
    config.ride,
    now.getTime()
  );
  const { startTime, endTime } = rideMath;

  const optedInAt = now.toISOString();
  const ticketSnapshot = {
    rideMath,
    selections,
    qualifyingSelections: ticket.qualifying,
    disqualifiedSelections: ticket.disqualified,
    combinedOdds: ticket.combinedOddsDisplay,
    combinedOddsExact: ticket.combinedOddsExact,
    ticketStrength: ticket.ticketStrength,
    minSelectionOdds: profile.minSelectionOdds,
    minSelections: profile.minSelections,
    minCombinedOdds: profile.minCombinedOdds,
  };

  try {
    // Claim (GRANTED -> ENTERED), bet binding with the ride snapshot, and audit are atomic.
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
        tx,
        money
      );
      if (!enteredReward) {
        throw new Rollback(failure(ReasonCode.INTERNAL_ERROR, 'Failed to start ride'));
      }

      // The audit row never carries the seed: only its SHA-256 commitment.
      await auditLogRepository.append({
        entityType: 'user_reward',
        entityId: rewardId,
        action: 'OPT_IN',
        payload: {
          brandId: reward.brandId ?? LEGACY_BRAND_ID,
          userId,
          betId,
          stakeMinor: money?.stakeMinor,
          currency: money?.currency,
          bonusCapMinor: money?.bonusCapMinor,
          optedInAt,
          rideMode: profile.rideMode,
          mathSnapshotVersion: rideMath.version,
          seedCommitment: rideMath.seedCommitment,
          durationSeconds: rideMath.rideDurationSeconds,
          combinedOdds: ticket.combinedOddsExact,
          ticketStrength: ticket.ticketStrength,
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
    // The application check and the unique (brand_id, bet_id) index both mean 409.
    if (error instanceof BetAlreadyBoundError || isBetBindingViolation(error)) {
      return failure(ReasonCode.BET_ALREADY_BOUND, 'Bet is already bound to a different reward');
    }
    throw error;
  }
}

/** A unique violation on user_rewards (brand_id, bet_id) from SQLite or PostgreSQL. */
function isBetBindingViolation(error: unknown): boolean {
  if (!isUniqueViolation(error)) return false;
  const message = String((error as { message?: unknown }).message ?? '');
  return /user_rewards/.test(message) && /bet_id/.test(message);
}

function failure<T>(code: ReasonCode, message: string): ServiceResult<T> {
  return { success: false, error: { code, message } };
}

export const rewardOptInService = {
  optIn,
  precheckEligibility,
};
