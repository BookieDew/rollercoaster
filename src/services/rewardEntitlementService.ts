import { randomBytes } from 'crypto';
import { userRewardRepository } from '../db/repositories/userRewardRepository';
import { rewardProfileRepository } from '../db/repositories/rewardProfileRepository';
import { auditLogRepository } from '../db/repositories/auditLogRepository';
import { runInTransaction } from '../db/repositories/transaction';
import { deriveRideDurationSeconds } from '../computations/deterministicRideGenerator';
import { config } from '../config';
import type { UserReward } from '../types/userReward';
import { ReasonCode } from '../types/reasonCodes';

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
  const duration = deriveRideDurationSeconds(
    seed,
    config.ride.minDurationSeconds,
    config.ride.maxDurationSeconds
  );
  const endTime = new Date(now.getTime() + duration * 1000).toISOString();

  const reward = await runInTransaction(async (tx) => {
    const created = await userRewardRepository.create({
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
        userId,
        profileVersionId,
        startTime,
        endTime,
        durationSeconds: duration,
        requestedDurationSeconds: durationSeconds,
        minDurationSeconds: config.ride.minDurationSeconds,
        maxDurationSeconds: config.ride.maxDurationSeconds,
        seed,
      },
    }, tx);

    return created;
  });

  return { success: true, data: reward };
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
 * Gets all rewards for a user.
 */
export async function getRewardsByUserId(
  userId: string
): Promise<ServiceResult<UserReward[]>> {
  const rewards = await userRewardRepository.findByUserId(userId);
  return { success: true, data: rewards };
}

/**
 * Gets the active reward for a user (if any).
 */
export async function getActiveRewardForUser(
  userId: string
): Promise<ServiceResult<UserReward | null>> {
  const reward = await userRewardRepository.findActiveByUserId(userId);
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
  getRewardById,
  getRewardsByUserId,
  getActiveRewardForUser,
  processExpiredRewards,
};
