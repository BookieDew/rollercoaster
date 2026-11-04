import { userRewardRepository, BetAlreadyBoundError, type OptInMoney } from '../db/repositories/userRewardRepository';
import { rewardProfileRepository } from '../db/repositories/rewardProfileRepository';
import { auditLogRepository } from '../db/repositories/auditLogRepository';
import { runInTransaction, Rollback, isUniqueViolation, type TransactionScope } from '../db/repositories/transaction';
import type { UserReward } from '../types/userReward';
import type { RewardProfileVersion } from '../types/rewardProfile';
import type { Selection } from '../types/ticket';
import { ReasonCode } from '../types/reasonCodes';
import { LEGACY_BRAND_ID } from '../types/brand';
import { config } from '../config';
import { buildRideMath, toRideMathProfile } from './rideMathSnapshot';
import { describeOdds, evaluateTicket, type TicketEvaluation } from './ticketEvaluation';
import { selectionTimingMessage, selectionTimingReasons, type SelectionTimingOptions } from './selectionTiming';
import { expireGrantedReward } from './rewardExpiryService';

export interface ServiceResult<T> {
  success: boolean;
  data?: T;
  error?: {
    code: ReasonCode;
    message: string;
    /** Extra public data for the error response (e.g. the reward_id of an open-boost replay). */
    details?: Record<string, unknown>;
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

  // Personal opt-in checks slip timing only for the fields the caller sent; a GRANTED reward on an OPEN profile
  // (e.g. a replacement token, or a profile switched to OPEN after the grant) gets the open-boost timing rules.
  const plan = planEntry(profile, { stakeMinor, currency, selections }, new Date(), {
    requireTiming: profile.availability === 'OPEN',
  });
  if (!plan.success || !plan.data) {
    return { success: false, error: plan.error };
  }
  const entryPlan = plan.data;

  try {
    // Claim (GRANTED -> ENTERED), bet binding with the ride snapshot, and audit are atomic.
    return await runInTransaction<ServiceResult<OptInResult>>(async (tx) => {
      const enteredReward = await enterRewardInTransaction(reward, profile, { userId, betId, selections }, entryPlan, tx);
      return {
        success: true,
        data: {
          reward: enteredReward,
          rideStarted: true,
        },
      };
    });
  } catch (error) {
    if (isBetBindingError(error)) {
      return failure(ReasonCode.BET_ALREADY_BOUND, 'Bet is already bound to a different reward');
    }
    throw error;
  }
}

/** Checked ticket and money snapshot of an opt-in that may proceed. */
export interface EntryPlan {
  money?: OptInMoney;
  ticket: TicketEvaluation;
}

export interface EntryInput {
  stakeMinor?: number;
  currency?: string;
  selections: Selection[];
}

/**
 * The opt-in checks shared by personal and open boosts, in order: currency supported by the profile cap map,
 * slip timing, minimum qualifying selections, minimum exact combined odds. The bonus cap is copied from the
 * profile now, so later profile edits never change an in-flight bet.
 */
export function planEntry(
  profile: RewardProfileVersion,
  input: EntryInput,
  now: Date,
  timing: SelectionTimingOptions
): ServiceResult<EntryPlan> {
  const { stakeMinor, currency, selections } = input;
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

  const [timingReason] = selectionTimingReasons(selections, now, timing);
  if (timingReason !== undefined) {
    return failure(timingReason, selectionTimingMessage(timingReason));
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
  return { success: true, data: { money, ticket } };
}

export interface EntryBinding {
  userId: string;
  betId: string;
  selections: Selection[];
}

/**
 * Enters a GRANTED reward inside the caller's transaction: conditional GRANTED -> ENTERED claim, bet binding
 * with the frozen V4 ride snapshot (the ride starts now), and the OPT_IN audit row. Throws Rollback with
 * ALREADY_OPTED_IN when the claim loses a race, BetAlreadyBoundError (or a unique violation) when the bet is
 * already bound in the brand. `trigger` is recorded on the audit row of open boosts only.
 */
export async function enterRewardInTransaction(
  reward: UserReward,
  profile: RewardProfileVersion,
  binding: EntryBinding,
  plan: EntryPlan,
  tx: TransactionScope,
  trigger?: 'OPEN'
): Promise<UserReward> {
  const { userId, betId, selections } = binding;
  const { money, ticket } = plan;
  const rewardId = reward.id;

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
    // Frozen marker of a bet that used an open boost (cancellation returns no token for it).
    ...(trigger === undefined ? {} : { grantTrigger: trigger }),
  };

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
      ...(trigger === undefined ? {} : { trigger }),
    },
  }, tx);

  return enteredReward;
}

/** The application check and the unique (brand_id, bet_id) index both mean 409 BET_ALREADY_BOUND. */
export function isBetBindingError(error: unknown): boolean {
  return error instanceof BetAlreadyBoundError || isBetBindingViolation(error);
}

/** A unique violation on user_rewards (brand_id, bet_id) from SQLite or PostgreSQL. */
function isBetBindingViolation(error: unknown): boolean {
  if (!isUniqueViolation(error)) return false;
  const message = String((error as { message?: unknown }).message ?? '');
  return /user_rewards/.test(message) && /bet_id/.test(message);
}

export function failure<T>(code: ReasonCode, message: string, details?: Record<string, unknown>): ServiceResult<T> {
  return { success: false, error: details === undefined ? { code, message } : { code, message, details } };
}

export const rewardOptInService = {
  optIn,
  precheckEligibility,
};
