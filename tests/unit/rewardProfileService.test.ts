import { rewardProfileService } from '../../src/services/rewardProfileService';
import { rewardProfileRepository } from '../../src/db/repositories/rewardProfileRepository';
import { auditLogRepository } from '../../src/db/repositories/auditLogRepository';
import { ReasonCode } from '../../src/types/reasonCodes';
import type { RewardProfileVersion } from '../../src/types/rewardProfile';

function makeProfile(overrides: Partial<RewardProfileVersion> = {}): RewardProfileVersion {
  const now = new Date().toISOString();
  return {
    id: 'profile-1',
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

describe('rewardProfileService', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('createProfile', () => {
    it('rejects invalid boost range', async () => {
      const result = await rewardProfileService.createProfile({
        name: 'Invalid',
        minSelections: 5,
        minCombinedOdds: 10,
        minSelectionOdds: 1.3,
        minBoostPct: 0.8,
        maxBoostPct: 0.5,
        rideDurationSeconds: 300,
      });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(ReasonCode.INVALID_CONFIGURATION);
    });

    it('rejects max-boost selection threshold lower than min selections', async () => {
      const result = await rewardProfileService.createProfile({
        name: 'Invalid',
        minSelections: 5,
        minCombinedOdds: 10,
        minSelectionOdds: 1.3,
        minBoostPct: 0.05,
        maxBoostPct: 1,
        maxBoostMinSelections: 4,
        rideDurationSeconds: 300,
      });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(ReasonCode.INVALID_CONFIGURATION);
    });

    it('rejects max-boost odds threshold lower than min combined odds', async () => {
      const result = await rewardProfileService.createProfile({
        name: 'Invalid',
        minSelections: 5,
        minCombinedOdds: 10,
        minSelectionOdds: 1.3,
        minBoostPct: 0.05,
        maxBoostPct: 1,
        maxBoostMinCombinedOdds: 9.5,
        rideDurationSeconds: 300,
      });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(ReasonCode.INVALID_CONFIGURATION);
    });

    it('rejects invalid selection/odds weight split', async () => {
      const result = await rewardProfileService.createProfile({
        name: 'Invalid',
        minSelections: 5,
        minCombinedOdds: 10,
        minSelectionOdds: 1.3,
        minBoostPct: 0.05,
        maxBoostPct: 1,
        maxEligibilitySelectionWeight: 0.8,
        maxEligibilityOddsWeight: 0.25,
        rideDurationSeconds: 300,
      });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(ReasonCode.INVALID_CONFIGURATION);
    });

    it('creates profile and writes audit entry', async () => {
      const created = makeProfile();
      const createSpy = jest.spyOn(rewardProfileRepository, 'create').mockResolvedValue(created);
      const auditSpy = jest.spyOn(auditLogRepository, 'append').mockResolvedValue({
        id: 'audit-1',
        entityType: 'reward_profile',
        entityId: created.id,
        action: 'CREATE',
        payload: {},
        timestamp: created.createdAt,
        createdAt: created.createdAt,
      });

      const result = await rewardProfileService.createProfile({
        name: 'Valid',
        minSelections: 5,
        minCombinedOdds: 10,
        minSelectionOdds: 1.3,
        minBoostPct: 0.05,
        maxBoostPct: 1,
        rideDurationSeconds: 300,
      });

      expect(result.success).toBe(true);
      expect(result.data?.id).toBe(created.id);
      expect(createSpy).toHaveBeenCalledTimes(1);
      expect(auditSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe('getProfileById', () => {
    it('returns not found when profile is missing', async () => {
      jest.spyOn(rewardProfileRepository, 'findById').mockResolvedValue(null);

      const result = await rewardProfileService.getProfileById('missing');
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(ReasonCode.PROFILE_NOT_FOUND);
    });

    it('returns profile when found', async () => {
      const profile = makeProfile();
      jest.spyOn(rewardProfileRepository, 'findById').mockResolvedValue(profile);

      const result = await rewardProfileService.getProfileById(profile.id);
      expect(result.success).toBe(true);
      expect(result.data?.id).toBe(profile.id);
    });
  });

  describe('list methods', () => {
    it('returns active profiles', async () => {
      const profile = makeProfile();
      jest.spyOn(rewardProfileRepository, 'findActive').mockResolvedValue([profile]);

      const result = await rewardProfileService.getActiveProfiles();
      expect(result.success).toBe(true);
      expect(result.data).toHaveLength(1);
    });

    it('returns all profiles', async () => {
      const profile = makeProfile();
      jest.spyOn(rewardProfileRepository, 'findAll').mockResolvedValue([profile]);

      const result = await rewardProfileService.getAllProfiles();
      expect(result.success).toBe(true);
      expect(result.data).toHaveLength(1);
    });
  });

  describe('updateProfile', () => {
    it('returns not found when profile does not exist', async () => {
      jest.spyOn(rewardProfileRepository, 'findById').mockResolvedValue(null);

      const result = await rewardProfileService.updateProfile('missing', { name: 'New Name' });
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(ReasonCode.PROFILE_NOT_FOUND);
    });

    it('rejects invalid updated boost range', async () => {
      const existing = makeProfile();
      jest.spyOn(rewardProfileRepository, 'findById').mockResolvedValue(existing);

      const result = await rewardProfileService.updateProfile(existing.id, {
        minBoostPct: 0.9,
        maxBoostPct: 0.5,
      });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(ReasonCode.INVALID_CONFIGURATION);
    });

    it('rejects min selections update that breaks max-boost threshold', async () => {
      const existing = makeProfile({ minSelections: 5, maxBoostMinSelections: 6 });
      jest.spyOn(rewardProfileRepository, 'findById').mockResolvedValue(existing);

      const result = await rewardProfileService.updateProfile(existing.id, {
        minSelections: 7,
      });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(ReasonCode.INVALID_CONFIGURATION);
    });

    it('rejects min combined odds update that breaks max-boost threshold', async () => {
      const existing = makeProfile({ minCombinedOdds: 10, maxBoostMinCombinedOdds: 12 });
      jest.spyOn(rewardProfileRepository, 'findById').mockResolvedValue(existing);

      const result = await rewardProfileService.updateProfile(existing.id, {
        minCombinedOdds: 13,
      });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(ReasonCode.INVALID_CONFIGURATION);
    });

    it('rejects invalid updated weight split', async () => {
      const existing = makeProfile();
      jest.spyOn(rewardProfileRepository, 'findById').mockResolvedValue(existing);

      const result = await rewardProfileService.updateProfile(existing.id, {
        maxEligibilitySelectionWeight: 0.7,
        maxEligibilityOddsWeight: 0.7,
      });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(ReasonCode.INVALID_CONFIGURATION);
    });

    it('returns internal error when repository update returns null', async () => {
      const existing = makeProfile();
      jest.spyOn(rewardProfileRepository, 'findById').mockResolvedValue(existing);
      jest.spyOn(rewardProfileRepository, 'update').mockResolvedValue(null);

      const result = await rewardProfileService.updateProfile(existing.id, {
        name: 'Updated',
      });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(ReasonCode.INTERNAL_ERROR);
    });

    it('updates profile and writes audit entry', async () => {
      const existing = makeProfile();
      const updated = makeProfile({ name: 'Updated' });
      jest.spyOn(rewardProfileRepository, 'findById').mockResolvedValue(existing);
      const updateSpy = jest.spyOn(rewardProfileRepository, 'update').mockResolvedValue(updated);
      const auditSpy = jest.spyOn(auditLogRepository, 'append').mockResolvedValue({
        id: 'audit-2',
        entityType: 'reward_profile',
        entityId: existing.id,
        action: 'UPDATE',
        payload: {},
        timestamp: updated.updatedAt,
        createdAt: updated.updatedAt,
      });

      const result = await rewardProfileService.updateProfile(existing.id, {
        name: 'Updated',
      });

      expect(result.success).toBe(true);
      expect(result.data?.name).toBe('Updated');
      expect(updateSpy).toHaveBeenCalledTimes(1);
      expect(auditSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe('deleteProfile', () => {
    it('returns not found when profile does not exist', async () => {
      jest.spyOn(rewardProfileRepository, 'findById').mockResolvedValue(null);

      const result = await rewardProfileService.deleteProfile('missing');
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(ReasonCode.PROFILE_NOT_FOUND);
    });

    it('returns internal error when remove fails', async () => {
      const existing = makeProfile();
      jest.spyOn(rewardProfileRepository, 'findById').mockResolvedValue(existing);
      jest.spyOn(rewardProfileRepository, 'remove').mockResolvedValue(false);

      const result = await rewardProfileService.deleteProfile(existing.id);
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(ReasonCode.INTERNAL_ERROR);
    });

    it('deletes profile and writes audit entry', async () => {
      const existing = makeProfile();
      jest.spyOn(rewardProfileRepository, 'findById').mockResolvedValue(existing);
      const removeSpy = jest.spyOn(rewardProfileRepository, 'remove').mockResolvedValue(true);
      const auditSpy = jest.spyOn(auditLogRepository, 'append').mockResolvedValue({
        id: 'audit-3',
        entityType: 'reward_profile',
        entityId: existing.id,
        action: 'DELETE',
        payload: {},
        timestamp: existing.updatedAt,
        createdAt: existing.updatedAt,
      });

      const result = await rewardProfileService.deleteProfile(existing.id);
      expect(result.success).toBe(true);
      expect(removeSpy).toHaveBeenCalledTimes(1);
      expect(auditSpy).toHaveBeenCalledTimes(1);
    });
  });
});
