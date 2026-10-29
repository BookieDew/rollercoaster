import { rewardEntitlementService, createRideSeed } from '../../src/services/rewardEntitlementService';
import { generateSeed, deriveRideDurationSeconds } from '../../src/computations/deterministicRideGenerator';
import { config } from '../../src/config';
import { rewardProfileRepository } from '../../src/db/repositories/rewardProfileRepository';
import { userRewardRepository } from '../../src/db/repositories/userRewardRepository';
import { auditLogRepository } from '../../src/db/repositories/auditLogRepository';
import { ReasonCode } from '../../src/types/reasonCodes';
import type { RewardProfileVersion } from '../../src/types/rewardProfile';
import type { UserReward } from '../../src/types/userReward';

function makeProfile(overrides: Partial<RewardProfileVersion> = {}): RewardProfileVersion {
  const now = new Date().toISOString();
  return {
    id: 'profile-ent',
    name: 'Profile',
    description: null,
    minSelections: 5,
    minCombinedOdds: 10,
    minSelectionOdds: 1.3,
    minBoostPct: 0.05,
    maxBoostPct: 1,
    maxBoostMinSelections: 10,
    maxBoostMinCombinedOdds: 50,
    maxEligibilitySelectionWeight: 0.75,
    maxEligibilityOddsWeight: 0.25,
    effectiveMinFloorRate: 0.35,
    rideMode: 'WAVES',
    rideDurationSeconds: 3600,
    isActive: true,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function makeReward(overrides: Partial<UserReward> = {}): UserReward {
  const now = new Date().toISOString();
  return {
    id: 'reward-1',
    userId: 'user-1',
    profileVersionId: 'profile-ent',
    status: 'GRANTED',
    startTime: now,
    endTime: now,
    seed: 'pending',
    optedInAt: null,
    betId: null,
    ticketSnapshot: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe('rewardEntitlementService', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('grantReward', () => {
    it('returns PROFILE_NOT_FOUND when profile is missing', async () => {
      jest.spyOn(rewardProfileRepository, 'findById').mockResolvedValue(null);

      const result = await rewardEntitlementService.grantReward({
        userId: 'user-x',
        profileVersionId: 'missing',
      });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(ReasonCode.PROFILE_NOT_FOUND);
    });

    it('returns PROFILE_INACTIVE for inactive profile', async () => {
      jest.spyOn(rewardProfileRepository, 'findById').mockResolvedValue(makeProfile({ isActive: false }));

      const result = await rewardEntitlementService.grantReward({
        userId: 'user-x',
        profileVersionId: 'profile-ent',
      });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(ReasonCode.PROFILE_INACTIVE);
    });

    it('creates the reward with a random seed in one insert and audits it in the same scope', async () => {
      const createdReward = makeReward({ seed: 'a'.repeat(64) });

      jest.spyOn(rewardProfileRepository, 'findById').mockResolvedValue(makeProfile());
      const createSpy = jest.spyOn(userRewardRepository, 'create').mockResolvedValue(createdReward);
      const auditSpy = jest.spyOn(auditLogRepository, 'append').mockResolvedValue({
        id: 'audit-1',
        entityType: 'user_reward',
        entityId: createdReward.id,
        action: 'GRANT',
        payload: {},
        timestamp: createdReward.createdAt,
        createdAt: createdReward.createdAt,
      });

      const result = await rewardEntitlementService.grantReward({
        userId: createdReward.userId,
        profileVersionId: createdReward.profileVersionId,
        durationSeconds: 999,
      });

      expect(result.success).toBe(true);
      expect(result.data).toBe(createdReward);
      expect(createSpy).toHaveBeenCalledTimes(1);
      expect(auditSpy).toHaveBeenCalledTimes(1);

      const [createInput, tx] = createSpy.mock.calls[0];
      expect(tx).toBeDefined();
      expect(auditSpy.mock.calls[0][1]).toBe(tx);
      expect(createInput.seed).toMatch(/^[0-9a-f]{64}$/);
      expect(createInput.seed).not.toBe(generateSeed(createdReward.id, createdReward.userId, createdReward.profileVersionId));
      // Stored end time still follows the unchanged seed-derived duration.
      const duration = deriveRideDurationSeconds(
        createInput.seed,
        config.ride.minDurationSeconds,
        config.ride.maxDurationSeconds
      );
      const storedMs = Date.parse(createInput.endTime) - Date.parse(createInput.startTime);
      expect(Math.abs(storedMs - duration * 1000)).toBeLessThan(1);
      expect(auditSpy.mock.calls[0][0].payload).toMatchObject({ seed: createInput.seed, requestedDurationSeconds: 999 });
    });

    it('createRideSeed returns distinct 32-byte hex values', () => {
      const seeds = new Set(Array.from({ length: 50 }, () => createRideSeed()));
      expect(seeds.size).toBe(50);
      for (const seed of seeds) expect(seed).toMatch(/^[0-9a-f]{64}$/);
    });
  });

  describe('read methods', () => {
    it('getRewardById returns not found', async () => {
      jest.spyOn(userRewardRepository, 'findById').mockResolvedValue(null);
      const result = await rewardEntitlementService.getRewardById('missing');
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(ReasonCode.REWARD_NOT_FOUND);
    });

    it('getRewardById returns reward', async () => {
      const reward = makeReward();
      jest.spyOn(userRewardRepository, 'findById').mockResolvedValue(reward);
      const result = await rewardEntitlementService.getRewardById(reward.id);
      expect(result.success).toBe(true);
      expect(result.data?.id).toBe(reward.id);
    });

    it('getRewardsByUserId returns rewards', async () => {
      const reward = makeReward();
      jest.spyOn(userRewardRepository, 'findByUserId').mockResolvedValue([reward]);
      const result = await rewardEntitlementService.getRewardsByUserId('default', reward.userId);
      expect(result.success).toBe(true);
      expect(result.data).toHaveLength(1);
    });

    it('getActiveRewardForUser returns null when none exists', async () => {
      jest.spyOn(userRewardRepository, 'findActiveByUserId').mockResolvedValue(null);
      const result = await rewardEntitlementService.getActiveRewardForUser('default', 'user-empty');
      expect(result.success).toBe(true);
      expect(result.data).toBeNull();
    });
  });

  describe('processExpiredRewards', () => {
    it('returns count without audit when nothing expired', async () => {
      const markExpiredSpy = jest.spyOn(userRewardRepository, 'markExpired').mockResolvedValue(0);
      const auditSpy = jest.spyOn(auditLogRepository, 'append');

      const result = await rewardEntitlementService.processExpiredRewards();
      expect(result.success).toBe(true);
      expect(result.data).toBe(0);
      expect(markExpiredSpy).toHaveBeenCalledTimes(1);
      expect(auditSpy).not.toHaveBeenCalled();
    });

    it('writes audit entry when rewards expire', async () => {
      jest.spyOn(userRewardRepository, 'markExpired').mockResolvedValue(3);
      const auditSpy = jest.spyOn(auditLogRepository, 'append').mockResolvedValue({
        id: 'audit-expiry',
        entityType: 'system',
        entityId: 'batch_expiry',
        action: 'EXPIRE_REWARDS',
        payload: { expiredCount: 3 },
        timestamp: new Date().toISOString(),
        createdAt: new Date().toISOString(),
      });

      const result = await rewardEntitlementService.processExpiredRewards();
      expect(result.success).toBe(true);
      expect(result.data).toBe(3);
      expect(auditSpy).toHaveBeenCalledTimes(1);
    });
  });
});
