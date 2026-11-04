import { rewardProfileRepository } from '../db/repositories/rewardProfileRepository';
import { userRewardRepository } from '../db/repositories/userRewardRepository';
import { usedOpenBoost } from '../types/userReward';
import { runInTransaction, Rollback, type TransactionScope } from '../db/repositories/transaction';
import type { RewardProfileVersion } from '../types/rewardProfile';
import type { Selection } from '../types/ticket';
import { ReasonCode } from '../types/reasonCodes';
import { evaluateTicket, type TicketEvaluation } from './ticketEvaluation';
import { selectionTimingReasons } from './selectionTiming';
import { createGrantInTransaction } from './rewardEntitlementService';
import {
  enterRewardInTransaction,
  failure,
  isBetBindingError,
  planEntry,
  type OptInResult,
  type ServiceResult,
} from './rewardOptInService';

/**
 * Open boosts (owner decisions "Grant timing…" and "Open boosts: base-case rules", 2026-11-04): an OPEN profile
 * applies to every qualifying bet with no advance grant and no per-player limit. The reward is created at the
 * player's click and entered in the same transaction.
 */

export interface OpenProfileRequest {
  brandId: string;
  /** Player classes the operator says the player belongs to; we never store membership. */
  segments: readonly string[];
  /** Operator names the profile explicitly; otherwise the most specific, then newest, applies. */
  profileVersionId?: string;
}

/**
 * Most specific wins: a profile for one of the player's segments beats an everyone (segment null) profile;
 * still tied, the newest. `candidates` come newest first (created_at desc, id desc).
 */
export function pickOpenProfile(candidates: readonly RewardProfileVersion[]): RewardProfileVersion | null {
  return candidates.find((profile) => profile.segment != null) ?? candidates[0] ?? null;
}

/** The OPEN profile version that applies to this request, or the ReasonCode why none does. */
export async function resolveOpenProfile(
  request: OpenProfileRequest,
  tx?: TransactionScope
): Promise<ServiceResult<RewardProfileVersion>> {
  const { brandId, segments, profileVersionId } = request;

  if (profileVersionId === undefined) {
    const picked = pickOpenProfile(await rewardProfileRepository.findActiveOpen(brandId, segments, tx));
    return picked
      ? { success: true, data: picked }
      : failure(ReasonCode.NO_OPEN_PROFILE, 'No open boost applies to this player');
  }

  const profile = await rewardProfileRepository.findById(profileVersionId, tx);
  // Another brand's profile is reported exactly like a missing one.
  if (!profile || (profile.brandId ?? null) !== brandId) {
    return failure(ReasonCode.PROFILE_NOT_FOUND, `Profile with ID ${profileVersionId} not found`);
  }
  if (!profile.isActive) {
    return failure(ReasonCode.PROFILE_INACTIVE, 'Profile is not active');
  }
  if (profile.availability !== 'OPEN') {
    return failure(ReasonCode.PROFILE_NOT_OPEN, 'Profile is not an open boost');
  }
  if (profile.segment != null && !segments.includes(profile.segment)) {
    return failure(ReasonCode.PROFILE_SEGMENT_MISMATCH, 'Profile is for a segment the player is not in');
  }
  return { success: true, data: profile };
}

export interface OpenOfferInput {
  brandId: string;
  userId: string;
  segments: readonly string[];
  stakeMinor?: number;
  currency?: string;
  selections: Selection[];
}

export interface OpenOffer {
  profile: RewardProfileVersion | null;
  qualifies: boolean;
  /** Every failing reason, most important first; empty when the slip qualifies. */
  reasonCodes: ReasonCode[];
  /** Absent when no open profile applies. */
  ticket?: TicketEvaluation;
}

/**
 * Read-only preview for the bet slip: which open profile would apply and whether this slip qualifies now.
 * Applies the same checks as the open opt-in (currency, timing, minimums) but never writes anything.
 */
export async function getOpenOffer(input: OpenOfferInput): Promise<OpenOffer> {
  const resolved = await resolveOpenProfile({ brandId: input.brandId, segments: input.segments });
  if (!resolved.success || !resolved.data) {
    return { profile: null, qualifies: false, reasonCodes: [resolved.error!.code] };
  }
  const profile = resolved.data;

  const reasonCodes: ReasonCode[] = [];
  if (input.currency !== undefined && profile.maxBonusMinor?.[input.currency] === undefined) {
    reasonCodes.push(ReasonCode.CURRENCY_NOT_SUPPORTED);
  }
  reasonCodes.push(...selectionTimingReasons(input.selections, new Date(), { requireTiming: true }));
  const ticket = evaluateTicket(input.selections, profile);
  if (ticket.reason !== ReasonCode.ELIGIBLE) reasonCodes.push(ticket.reason);

  return { profile, qualifies: reasonCodes.length === 0, reasonCodes, ticket };
}

export interface OpenOptInInput extends OpenProfileRequest {
  userId: string;
  betId: string;
  stakeMinor: number;
  currency: string;
  selections: Selection[];
}

/**
 * The player's click on a placed qualifying bet. In ONE transaction: pick the open profile, apply the opt-in
 * checks (open timing rules: every selection needs starts_at or live), create the reward (GRANT audit, trigger
 * OPEN) and enter it (OPT_IN audit, trigger OPEN), starting the ride. Any failure leaves no trace. One boost
 * per (brand_id, bet_id) across personal and open rewards: a bet already bound answers BET_ALREADY_BOUND.
 */
export async function openOptIn(input: OpenOptInInput): Promise<ServiceResult<OptInResult>> {
  const { userId, betId, stakeMinor, currency, selections } = input;
  // A bet that already carries a boost answers before any other check, like a personal opt-in replay.
  const alreadyBound = await boundBetAnswer(input);
  if (alreadyBound) return alreadyBound;
  try {
    return await runInTransaction<ServiceResult<OptInResult>>(async (tx) => {
      const resolved = await resolveOpenProfile(input, tx);
      if (!resolved.success || !resolved.data) {
        throw new Rollback(failure<OptInResult>(resolved.error!.code, resolved.error!.message));
      }
      const profile = resolved.data;

      const plan = planEntry(profile, { stakeMinor, currency, selections }, new Date(), { requireTiming: true });
      if (!plan.success || !plan.data) {
        throw new Rollback(failure<OptInResult>(plan.error!.code, plan.error!.message));
      }

      // GRANTED exists only inside this transaction: it is entered before commit.
      const granted = await createGrantInTransaction(profile, userId, undefined, undefined, tx, 'OPEN');
      const entered = await enterRewardInTransaction(
        granted,
        profile,
        { userId, betId, selections },
        plan.data,
        tx,
        'OPEN'
      );
      return { success: true, data: { reward: entered, rideStarted: true } };
    });
  } catch (error) {
    if (isBetBindingError(error)) {
      // A concurrent call bound the bet first (it has committed by now): same answer as a sequential replay.
      return (await boundBetAnswer(input))
        ?? failure(ReasonCode.BET_ALREADY_BOUND, 'Bet is already bound to a different reward');
    }
    throw error;
  }
}

/**
 * The answer for a bet that already carries a boost, or null when it carries none. The same player repeating the
 * open opt-in for a bet entered by the open flow gets the personal-replay answer (409 ALREADY_OPTED_IN) with the
 * reward_id; another player's bet or a personal reward is 409 BET_ALREADY_BOUND. Never writes.
 */
async function boundBetAnswer(input: OpenOptInInput): Promise<ServiceResult<OptInResult> | null> {
  const bound = await userRewardRepository.findByBet(input.brandId, input.betId);
  if (!bound) return null;
  if (bound.userId === input.userId && usedOpenBoost(bound)) {
    return failure(ReasonCode.ALREADY_OPTED_IN, 'This bet already uses an open boost', { reward_id: bound.id });
  }
  return failure(ReasonCode.BET_ALREADY_BOUND, 'Bet is already bound to a different reward');
}

export const openBoostService = {
  getOpenOffer,
  openOptIn,
  resolveOpenProfile,
};
