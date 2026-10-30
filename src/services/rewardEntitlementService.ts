import { randomBytes } from 'crypto';
import { userRewardRepository } from '../db/repositories/userRewardRepository';
import { rewardProfileRepository } from '../db/repositories/rewardProfileRepository';
import { auditLogRepository } from '../db/repositories/auditLogRepository';
import { runInTransaction, type TransactionScope } from '../db/repositories/transaction';
import { seedCommitment, v4RideDurationSeconds } from '../computations/v4';
import { config } from '../config';
import type { UserReward } from '../types/userReward';
import { ReasonCode } from '../types/reasonCodes';
import { LEGACY_BRAND_ID } from '../types/brand';

export interface GrantRewardInput {
  userId: string;
  profileVersionId: string;
  durationSeconds?: number;
}

export interface ServiceResult<T> {
  success: boolean;
  data?: T;
  error?: {
    code: ReasonCode;
    message: string;
  };
}

/** 32 random bytes from the OS CSPRNG, hex encoded. Not derivable from any public ID. */
export function createRideSeed(): string {
  return randomBytes(32).toString('hex');
}

/**
 * Grants a new reward entitlement to a user.
 * Creates a user reward instance with start/end times, assigns profile version, and
 * generates a random ride seed. The insert and its audit row are atomic.
 */
export async function grantReward(
  input: GrantRewardInput
): Promise<ServiceResult<UserReward>> {
  const { userId, profileVersionId, durationSeconds } = input;

  // Verify profile exists and is active
  const profile = await rewardProfileRepository.findById(profileVersionId);
  if (!profile) {
    return {
      success: false,
      error: {
        code: ReasonCode.PROFILE_NOT_FOUND,
        message: `Profile with ID ${profileVersionId} not found`,
      },
    };
  }

  if (!profile.isActive) {
    return {
      success: false,
      error: {
        code: ReasonCode.PROFILE_INACTIVE,
        message: 'Cannot grant reward with inactive profile',
      },
    };
  }

  // Calculate start and end times
  const now = new Date();
  const startTime = now.toISOString();
  const seed = createRideSeed();
  const duration = v4RideDurationSeconds(seed, config.ride);
  const endTime = new Date(now.getTime() + duration * 1000).toISOString();
  // Legacy profiles have no validity and their rewards never expire.
  const brandId = profile.brandId ?? LEGACY_BRAND_ID;
  const validUntil = profile.rewardValiditySeconds == null
    ? null
    : new Date(now.getTime() + profile.rewardValiditySeconds * 1000).toISOString();

  const reward = await runInTransaction(async (tx) => {
    const created = await userRewardRepository.create({
      brandId,
      validUntil,
      userId,
      profileVersionId,
      startTime,
      endTime,
      seed,
    }, tx);

    await auditLogRepository.append({
      entityType: 'user_reward',
      entityId: created.id,
      action: 'GRANT',
      payload: {
        brandId,
        userId,
        profileVersionId,
        validUntil,
        startTime,
        endTime,
        durationSeconds: duration,
        requestedDurationSeconds: durationSeconds,
        minDurationSeconds: config.ride.minDurationSeconds,
        maxDurationSeconds: config.ride.maxDurationSeconds,
        // Never the seed itself (contract §1): its SHA-256 commitment.
        seedCommitment: seedCommitment(seed),
      },
    }, tx);

    return created;
  });

  return { success: true, data: reward };
}

export interface ReplacementContext {
  settlementId: string;
  betId: string;
  trigger: 'SETTLE' | 'RESETTLE';
}

/**
 * Issues the replacement token of a cancelled bet inside the caller's
 * transaction: a new GRANTED reward for the same brand, user and profile, with a
 * fresh random seed, `replaces_reward_id` set and the original `valid_until`
 * copied (a legacy reward without validity gives a replacement without one).
 * The caller decides beforehand that the original validity has not passed.
 * Writes one GRANT_REPLACEMENT audit row.
 */
export async function issueReplacementReward(
  original: UserReward,
  context: ReplacementContext,
  tx: TransactionScope,
  now: Date = new Date()
): Promise<UserReward> {
  const seed = createRideSeed();
  const duration = v4RideDurationSeconds(seed, config.ride);
  const startTime = now.toISOString();
  const endTime = new Date(now.getTime() + duration * 1000).toISOString();
  const brandId = original.brandId ?? LEGACY_BRAND_ID;
  const validUntil = original.validUntil ?? null;

  const replacement = await userRewardRepository.create({
    brandId,
    validUntil,
    replacesRewardId: original.id,
    userId: original.userId,
    profileVersionId: original.profileVersionId,
    startTime,
    endTime,
    seed,
  }, tx);

  await auditLogRepository.append({
    entityType: 'user_reward',
    entityId: replacement.id,
    action: 'GRANT_REPLACEMENT',
    payload: {
      brandId,
      userId: original.userId,
      profileVersionId: original.profileVersionId,
      replacesRewardId: original.id,
      settlementId: context.settlementId,
      betId: context.betId,
      trigger: context.trigger,
      validUntil,
      startTime,
      endTime,
      durationSeconds: duration,
      seedCommitment: seedCommitment(seed),
    },
  }, tx);

  return replacement;
}

/**
 * Gets a user reward by ID.
 */
export async function getRewardById(
  rewardId: string
): Promise<ServiceResult<UserReward>> {
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

  return { success: true, data: reward };
}

/**
 * Gets all rewards for a player, identified by (brand_id, user_id).
 */
export async function getRewardsByUserId(
  brandId: string,
  userId: string
): Promise<ServiceResult<UserReward[]>> {
  const rewards = await userRewardRepository.findByUserId(brandId, userId);
  return { success: true, data: rewards };
}

/**
 * Gets the active reward for a user (if any).
 */
export async function getActiveRewardForUser(
  brandId: string,
  userId: string
): Promise<ServiceResult<UserReward | null>> {
  const reward = await userRewardRepository.findActiveByUserId(brandId, userId);
  return { success: true, data: reward };
}

/**
 * Marks expired rewards as EXPIRED status.
 */
export async function processExpiredRewards(): Promise<ServiceResult<number>> {
  const count = await userRewardRepository.markExpired();

  if (count > 0) {
    await auditLogRepository.append({
      entityType: 'system',
      entityId: 'batch_expiry',
      action: 'EXPIRE_REWARDS',
      payload: { expiredCount: count },
    });
  }

  return { success: true, data: count };
}

export const rewardEntitlementService = {
  grantReward,
  issueReplacementReward,
  getRewardById,
  getRewardsByUserId,
  getActiveRewardForUser,
  processExpiredRewards,
};
