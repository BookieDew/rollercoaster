import { randomBytes } from 'crypto';
import { userRewardRepository } from '../db/repositories/userRewardRepository';
import { rewardProfileRepository } from '../db/repositories/rewardProfileRepository';
import { auditLogRepository } from '../db/repositories/auditLogRepository';
import { runInTransaction, type TransactionScope } from '../db/repositories/transaction';
import { seedCommitment, v4RideDurationSeconds } from '../computations/v4';
import { config } from '../config';
import type { UserReward } from '../types/userReward';
import type { RewardProfileVersion } from '../types/rewardProfile';
import { ReasonCode } from '../types/reasonCodes';
import { LEGACY_BRAND_ID } from '../types/brand';

export interface GrantRewardInput {
  userId: string;
  profileVersionId: string;
  durationSeconds?: number;
  /** Undefined = the profile version's segment; null = no segment. */
  segment?: string | null;
}

export interface BulkGrantRewardInput {
  userIds: string[];
  profileVersionId: string;
  durationSeconds?: number;
  /** Undefined = the profile version's segment; null = no segment. */
  segment?: string | null;
}

export interface BulkGrantResult {
  profileVersionId: string;
  segment: string | null;
  rewards: UserReward[];
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

/** Loads the profile version a grant refers to; it must exist and be active. */
async function findGrantableProfile(
  profileVersionId: string
): Promise<ServiceResult<RewardProfileVersion>> {
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

  return { success: true, data: profile };
}

/**
 * Creates one reward and its GRANT audit row inside the caller's transaction.
 * The single and the bulk grant both go through here, so they apply identical rules.
 */
async function createGrantInTransaction(
  profile: RewardProfileVersion,
  userId: string,
  durationSeconds: number | undefined,
  segmentOverride: string | null | undefined,
  tx: TransactionScope
): Promise<UserReward> {
  // Calculate start and end times
  const now = new Date();
  const startTime = now.toISOString();
  const seed = createRideSeed();
  const duration = v4RideDurationSeconds(seed, config.ride);
  const endTime = new Date(now.getTime() + duration * 1000).toISOString();
  // Legacy profiles have no validity and their rewards never expire.
  const brandId = profile.brandId ?? LEGACY_BRAND_ID;
  const profileVersionId = profile.id;
  const validUntil = profile.rewardValiditySeconds == null
    ? null
    : new Date(now.getTime() + profile.rewardValiditySeconds * 1000).toISOString();
  const segment = resolveSegment(profile, segmentOverride);

  const created = await userRewardRepository.create({
    brandId,
    validUntil,
    userId,
    profileVersionId,
    segment,
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
      segment,
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
}

/** An explicit segment (including null = none) wins; otherwise the reward takes the profile version's label. */
function resolveSegment(profile: RewardProfileVersion, override: string | null | undefined): string | null {
  return override === undefined ? (profile.segment ?? null) : override;
}

/**
 * Grants a new reward entitlement to a user.
 * Creates a user reward instance with start/end times, assigns profile version, and
 * generates a random ride seed. The insert and its audit row are atomic.
 */
export async function grantReward(
  input: GrantRewardInput
): Promise<ServiceResult<UserReward>> {
  const { userId, profileVersionId, durationSeconds, segment } = input;

  const found = await findGrantableProfile(profileVersionId);
  if (!found.success || !found.data) {
    return { success: false, error: found.error };
  }
  const profile = found.data;

  const reward = await runInTransaction((tx) =>
    createGrantInTransaction(profile, userId, durationSeconds, segment, tx));

  return { success: true, data: reward };
}

/**
 * Grants one profile version to many players in a single transaction: either every
 * reward and audit row is written or nothing is. Same profile checks and same per-reward
 * logic as grantReward; rewards come back in input order.
 */
export async function grantRewardsBulk(
  input: BulkGrantRewardInput
): Promise<ServiceResult<BulkGrantResult>> {
  const { userIds, profileVersionId, durationSeconds, segment } = input;

  const found = await findGrantableProfile(profileVersionId);
  if (!found.success || !found.data) {
    return { success: false, error: found.error };
  }
  const profile = found.data;

  const rewards = await runInTransaction(async (tx) => {
    const created: UserReward[] = [];
    for (const userId of userIds) {
      created.push(await createGrantInTransaction(profile, userId, durationSeconds, segment, tx));
    }
    return created;
  });

  return {
    success: true,
    data: {
      profileVersionId,
      segment: resolveSegment(profile, segment),
      rewards,
    },
  };
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
    segment: original.segment ?? null,
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
  userId: string,
  segment?: string
): Promise<ServiceResult<UserReward[]>> {
  const rewards = await userRewardRepository.findByUserId(brandId, userId, segment);
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
  grantRewardsBulk,
  issueReplacementReward,
  getRewardById,
  getRewardsByUserId,
  getActiveRewardForUser,
  processExpiredRewards,
};
