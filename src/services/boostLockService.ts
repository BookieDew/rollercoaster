import { userRewardRepository } from '../db/repositories/userRewardRepository';
import { betBoostLockRepository } from '../db/repositories/betBoostLockRepository';
import { auditLogRepository } from '../db/repositories/auditLogRepository';
import { runInTransaction, Rollback, isUniqueViolation } from '../db/repositories/transaction';
import type { BetBoostLock, LockResponse, LockSnapshotV4 } from '../types/betBoostLock';
import type { UserReward } from '../types/userReward';
import type { Selection } from '../types/ticket';
import { MAXIMUM_MODEL_V4 } from '../types/ride';
import { ReasonCode } from '../types/reasonCodes';
import { LEGACY_BRAND_ID } from '../types/brand';
import {
  crashOffsetSeconds,
  hasRetiredRideMath,
  resolveRideMath,
  rideClock,
  sampleRidePath,
} from './rideMathSnapshot';
import { hasEnteredRide } from './boostQuoteService';
import { describeOdds, evaluateTicket, toBoostModelReport } from './ticketEvaluation';

function brandOf(reward: UserReward): string {
  return reward.brandId ?? LEGACY_BRAND_ID;
}

function rewardExpired<T>(): ServiceResult<T> {
  return {
    success: false,
    error: {
      code: ReasonCode.REWARD_EXPIRED,
      message: 'Reward has expired',
    },
  };
}

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

  // Fetch the reward: the brand of a bet comes from its reward.
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

  // Idempotency: an existing lock is replayed only to the same reward and its owner.
  const existingLock = await betBoostLockRepository.findByBetId(betId, brandOf(reward));
  if (existingLock) {
    return replayExistingLock(existingLock, input, reward);
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

  // Check reward status. An EXPIRED reward that entered a ride for this bet is
  // still evaluated, so its ride outcome (RIDE_CRASHED / RIDE_ENDED) is reported;
  // it can never be locked.
  const expiredRide = reward.status === 'EXPIRED';
  if (expiredRide && !(hasEnteredRide(reward) && reward.betId === betId)) {
    return rewardExpired();
  }

  if (reward.status === 'USED') {
    // A concurrent lock may have committed after the idempotency check above:
    // re-read and apply the replay rule before reporting the reward as used.
    const lockForBet = await betBoostLockRepository.findByBetId(betId, brandOf(reward));
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

  if (reward.status !== 'ENTERED' && !expiredRide) {
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

  // The frozen V4 ride; anything else (a retired V1-V3 ride, a damaged snapshot) fails closed.
  const resolved = resolveRideMath(reward);
  if (!resolved) {
    if (expiredRide) return rewardExpired();
    return {
      success: false,
      error: {
        code: ReasonCode.INVALID_CONFIGURATION,
        message: hasRetiredRideMath(reward)
          ? 'Ride uses a retired math version and cannot be locked'
          : 'Invalid saved ride math',
      },
    };
  }
  const { math, ride } = resolved;
  const profile = math.profile;
  const storedSelections = (reward.ticketSnapshot.selections as Selection[]) ?? [];
  const ticket = evaluateTicket(storedSelections, profile);

  if (ticket.reason === ReasonCode.MIN_SELECTIONS_NOT_MET) {
    if (expiredRide) return rewardExpired();
    return {
      success: false,
      error: {
        code: ReasonCode.MIN_SELECTIONS_NOT_MET,
        message: `Minimum ${profile.minSelections} qualifying selections required, got ${ticket.qualifying.length}`,
      },
    };
  }
  if (ticket.reason === ReasonCode.MIN_COMBINED_ODDS_NOT_MET) {
    if (expiredRide) return rewardExpired();
    return {
      success: false,
      error: {
        code: ReasonCode.MIN_COMBINED_ODDS_NOT_MET,
        message: `Minimum combined odds of ${profile.minCombinedOdds} required, got ${describeOdds(ticket)}`,
      },
    };
  }

  const clock = rideClock(math, Date.now());
  const ticketStrength = math.ticketStrength;
  const effectiveMinBoostPct = math.effectiveMinBoostPct;
  const maxEligibleBoostPct = math.effectiveMaxBoostPct;
  const maxPossibleBoostPct = math.preCrashMaximumPct;
  const boostModel = toBoostModelReport(ticket.boostModel);
  const endOffsetSeconds = roundToDecimals(math.rideDurationSeconds, 3);
  const crashOffset = roundToDecimals(crashOffsetSeconds(math), 3);

  if (clock.crashed || clock.ended) {
    return {
      success: false,
      error: {
        code: clock.crashed ? ReasonCode.RIDE_CRASHED : ReasonCode.RIDE_ENDED,
        message: clock.crashed ? 'Ride has crashed - boost is zero' : 'Ride has ended - boost is zero',
        details: {
          ride_elapsed_seconds: clock.elapsedSeconds,
          ride_end_at_offset_seconds: endOffsetSeconds,
          ride_crash_at_offset_seconds: crashOffset,
          qualifying_selection_count: ticket.qualifying.length,
          total_selection_count: storedSelections.length,
          combined_odds: ticket.combinedOddsDisplay,
          current_boost_pct: 0,
          effective_min_boost_pct: effectiveMinBoostPct,
          effective_max_boost_pct: maxEligibleBoostPct,
          theoretical_max_boost_pct: maxPossibleBoostPct,
          maximum_model: MAXIMUM_MODEL_V4,
          ticket_strength: ticketStrength,
          boost_model: boostModel,
          ride_path: sampleRidePath(resolved),
        },
      },
    };
  }

  // An expired reward whose ride has not crashed or ended is still expired.
  if (expiredRide) {
    return rewardExpired();
  }

  const lockedBoostPct = ride.boostAt(clock.elapsedSeconds);
  const snapshot: LockSnapshotV4 = {
    mathSnapshotVersion: 4,
    selections: ticket.qualifying,
    disqualifiedSelections: ticket.disqualified,
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
    rideDurationSeconds: math.rideDurationSeconds,
    crashPct: crashOffsetSeconds(math) / math.rideDurationSeconds,
    totalSelectionCount: storedSelections.length,
    qualifyingSelectionCount: ticket.qualifying.length,
    combinedOdds: ticket.combinedOddsDisplay,
    combinedOddsExact: ticket.combinedOddsExact,
    ticketStrength,
    elapsedPct: clock.elapsedSeconds / math.rideDurationSeconds,
    lockElapsedSeconds: clock.elapsedSeconds,
    boostAtLock: lockedBoostPct,
    effectiveMinBoostPct,
    maxEligibleBoostPct,
    maxPossibleBoostPct,
    maximumModel: MAXIMUM_MODEL_V4,
    rideMath: math,
    seedCommitment: math.seedCommitment,
    boostModel: {
      selectionWeight: ticket.boostModel.selectionWeight,
      oddsWeight: ticket.boostModel.oddsWeight,
      maxEligibilityExponent: ticket.boostModel.maxEligibilityExponent,
      effectiveMinFloorRate: ticket.boostModel.effectiveMinFloorRate,
      selectionRatio: ticket.boostModel.selectionRatio,
      oddsRatio: ticket.boostModel.oddsRatio,
      eligibilityFactor: ticket.boostModel.eligibilityFactor,
    },
    ridePath: sampleRidePath(resolved),
  };

  // Insert lock, consume reward (ENTERED -> USED) and audit atomically.
  let lock: BetBoostLock | null;
  try {
    lock = await runInTransaction<BetBoostLock | null>(async (tx) => {
      const created = await betBoostLockRepository.create({
        brandId: brandOf(reward),
        betId,
        rewardId,
        lockedBoostPct,
        qualifyingSelections: ticket.qualifying.length,
        // The legacy numeric column; the exact value is snapshot.combinedOddsExact.
        qualifyingOdds: typeof ticket.combinedOddsDisplay === 'number' ? ticket.combinedOddsDisplay : Number.MAX_VALUE,
        ticketStrength,
        snapshot,
      }, tx);

      const consumed = await userRewardRepository.updateStatus(rewardId, 'USED', undefined, {
        tx,
        fromStatus: 'ENTERED',
      });
      if (!consumed) {
        throw new Rollback(null);
      }

      // The audit row never carries the seed: only its SHA-256 commitment.
      await auditLogRepository.append({
        entityType: 'bet_boost_lock',
        entityId: created.id,
        action: 'LOCK',
        payload: {
          brandId: brandOf(reward),
          betId,
          rewardId,
          userId,
          lockedBoostPct,
          lockElapsedSeconds: clock.elapsedSeconds,
          qualifyingSelections: ticket.qualifying.length,
          combinedOdds: ticket.combinedOddsExact,
          ticketStrength,
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
          rideDurationSeconds: math.rideDurationSeconds,
          rideMode: profile.rideMode,
          mathSnapshotVersion: 4,
          seedCommitment: math.seedCommitment,
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
  const reward = await userRewardRepository.findById(input.rewardId);
  const existing = reward
    ? await betBoostLockRepository.findByBetId(input.betId, brandOf(reward))
    : null;
  if (existing) {
    return replayExistingLock(existing, input, reward ?? undefined);
  }

  if (reward?.status === 'EXPIRED') {
    return {
      success: false,
      error: { code: ReasonCode.REWARD_EXPIRED, message: 'Reward has expired' },
    };
  }

  // The insert rolled back and the reward is still playable: a lock for this
  // (brand_id, bet_id) exists that the re-read above could not see (defensive;
  // unique(brand_id, bet_id) and unique(reward_id) back the lock table).
  if (reward?.status === 'ENTERED') {
    return {
      success: false,
      error: {
        code: ReasonCode.BET_ALREADY_LOCKED,
        message: 'Bet is already locked for a different reward',
      },
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
 * Gets an existing lock by (brand_id, bet_id).
 */
export async function getLockByBetId(
  brandId: string,
  betId: string
): Promise<ServiceResult<BetBoostLock | null>> {
  const lock = await betBoostLockRepository.findByBetId(betId, brandId);
  return { success: true, data: lock ? withExactOdds(lock) : null };
}

/**
 * The stored lock with the combined odds as frozen in its V4 snapshot: an exact decimal string beyond the
 * double range, a number otherwise. The numeric column cannot hold such odds (it stores Number.MAX_VALUE),
 * so every read path serves the snapshot value. Locks stored under V1-V3 keep their column value.
 */
function withExactOdds(lock: BetBoostLock): BetBoostLock {
  const snapshot = lock.snapshot;
  return snapshot?.mathSnapshotVersion === 4 ? { ...lock, qualifyingOdds: snapshot.combinedOdds } : lock;
}

/** Lock response from the stored lock. V4 and stored V1-V3 locks are both read as stored, never recomputed. */
function buildLockResponse(stored: BetBoostLock): LockResponse {
  const lock = withExactOdds(stored);
  const snapshot = lock.snapshot;
  return {
    lock_id: lock.id,
    brand_id: lock.brandId,
    bet_id: lock.betId,
    reward_id: lock.rewardId,
    locked_boost_pct: lock.lockedBoostPct,
    qualifying_selections: lock.qualifyingSelections,
    qualifying_odds: lock.qualifyingOdds,
    ticket_strength: lock.ticketStrength,
    locked_at: lock.lockedAt,
    effective_min_boost_pct: snapshot.effectiveMinBoostPct,
    effective_max_boost_pct: snapshot.maxEligibleBoostPct,
    theoretical_max_boost_pct: snapshot.maxPossibleBoostPct,
    maximum_model: snapshot.maximumModel,
    boost_model: toBoostModelResponse(snapshot.boostModel),
    // Same arithmetic as the lock read endpoint (GET /boost/lock), so both answers are identical.
    ride_stop_at_offset_seconds: roundToDecimals(snapshot.rideDurationSeconds * snapshot.elapsedPct, 3),
    ride_end_at_offset_seconds: roundToDecimals(snapshot.rideDurationSeconds, 3),
    ride_crash_at_offset_seconds: roundToDecimals(snapshot.rideDurationSeconds * snapshot.crashPct, 3),
    ride_path: snapshot.ridePath,
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
