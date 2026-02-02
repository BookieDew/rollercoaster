import { rewardProfileRepository } from '../db/repositories/rewardProfileRepository';
import { auditLogRepository } from '../db/repositories/auditLogRepository';
import type {
  RewardProfileVersion,
  CreateRewardProfileInput,
  UpdateRewardProfileInput,
} from '../types/rewardProfile';
import { ReasonCode } from '../types/reasonCodes';

export interface ServiceResult<T> {
  success: boolean;
  data?: T;
  error?: {
    code: ReasonCode;
    message: string;
  };
}

/**
 * Creates a new reward profile version.
 */
export async function createProfile(
  input: CreateRewardProfileInput
): Promise<ServiceResult<RewardProfileVersion>> {
  // Validate configuration constraints
  if (input.minBoostPct > input.maxBoostPct) {
    return {
      success: false,
      error: {
        code: ReasonCode.INVALID_CONFIGURATION,
        message: 'minBoostPct must be less than or equal to maxBoostPct',
      },
    };
  }
  if (
    input.maxBoostMinSelections !== undefined &&
    input.maxBoostMinSelections !== null &&
    input.maxBoostMinSelections < input.minSelections
  ) {
    return {
      success: false,
      error: {
        code: ReasonCode.INVALID_CONFIGURATION,
        message: 'maxBoostMinSelections must be greater than or equal to minSelections',
      },
    };
  }
  if (
    input.maxBoostMinCombinedOdds !== undefined &&
    input.maxBoostMinCombinedOdds !== null &&
    input.maxBoostMinCombinedOdds < input.minCombinedOdds
  ) {
    return {
      success: false,
      error: {
        code: ReasonCode.INVALID_CONFIGURATION,
        message: 'maxBoostMinCombinedOdds must be greater than or equal to minCombinedOdds',
      },
    };
  }

  const profile = await rewardProfileRepository.create(input);

  await auditLogRepository.append({
    entityType: 'reward_profile',
    entityId: profile.id,
    action: 'CREATE',
    payload: { input },
  });

  return { success: true, data: profile };
}

/**
 * Retrieves a reward profile by ID.
 */
export async function getProfileById(
  id: string
): Promise<ServiceResult<RewardProfileVersion>> {
  const profile = await rewardProfileRepository.findById(id);

  if (!profile) {
    return {
      success: false,
      error: {
        code: ReasonCode.PROFILE_NOT_FOUND,
        message: `Profile with ID ${id} not found`,
      },
    };
  }

  return { success: true, data: profile };
}

/**
 * Retrieves all active reward profiles.
 */
export async function getActiveProfiles(): Promise<ServiceResult<RewardProfileVersion[]>> {
  const profiles = await rewardProfileRepository.findActive();
  return { success: true, data: profiles };
}

/**
 * Retrieves all reward profiles (including inactive).
 */
export async function getAllProfiles(): Promise<ServiceResult<RewardProfileVersion[]>> {
  const profiles = await rewardProfileRepository.findAll();
  return { success: true, data: profiles };
}

/**
 * Updates an existing reward profile.
 */
export async function updateProfile(
  id: string,
  input: UpdateRewardProfileInput
): Promise<ServiceResult<RewardProfileVersion>> {
  const existing = await rewardProfileRepository.findById(id);

  if (!existing) {
    return {
      success: false,
      error: {
        code: ReasonCode.PROFILE_NOT_FOUND,
        message: `Profile with ID ${id} not found`,
      },
    };
  }

  // Validate min/max boost relationship if either is being updated
  const newMin = input.minBoostPct ?? existing.minBoostPct;
  const newMax = input.maxBoostPct ?? existing.maxBoostPct;
  if (newMin > newMax) {
    return {
      success: false,
      error: {
        code: ReasonCode.INVALID_CONFIGURATION,
        message: 'minBoostPct must be less than or equal to maxBoostPct',
      },
    };
  }
  const newMaxBoostMinSelections = input.maxBoostMinSelections ?? existing.maxBoostMinSelections;
  const newMaxBoostMinCombinedOdds = input.maxBoostMinCombinedOdds ?? existing.maxBoostMinCombinedOdds;
  const effectiveMinSelections = input.minSelections ?? existing.minSelections;
  const effectiveMinCombinedOdds = input.minCombinedOdds ?? existing.minCombinedOdds;
  if (
    newMaxBoostMinSelections !== null &&
    newMaxBoostMinSelections !== undefined &&
    newMaxBoostMinSelections < effectiveMinSelections
  ) {
    return {
      success: false,
      error: {
        code: ReasonCode.INVALID_CONFIGURATION,
        message: 'maxBoostMinSelections must be greater than or equal to minSelections',
      },
    };
  }
  if (
    newMaxBoostMinCombinedOdds !== null &&
    newMaxBoostMinCombinedOdds !== undefined &&
    newMaxBoostMinCombinedOdds < effectiveMinCombinedOdds
  ) {
    return {
      success: false,
      error: {
        code: ReasonCode.INVALID_CONFIGURATION,
        message: 'maxBoostMinCombinedOdds must be greater than or equal to minCombinedOdds',
      },
    };
  }

  const updated = await rewardProfileRepository.update(id, input);

  if (!updated) {
    return {
      success: false,
      error: {
        code: ReasonCode.INTERNAL_ERROR,
        message: 'Failed to update profile',
      },
    };
  }

  await auditLogRepository.append({
    entityType: 'reward_profile',
    entityId: id,
    action: 'UPDATE',
    payload: { input, previousValues: existing },
  });

  return { success: true, data: updated };
}

/**
 * Deletes a reward profile.
 */
export async function deleteProfile(id: string): Promise<ServiceResult<void>> {
  const existing = await rewardProfileRepository.findById(id);

  if (!existing) {
    return {
      success: false,
      error: {
        code: ReasonCode.PROFILE_NOT_FOUND,
        message: `Profile with ID ${id} not found`,
      },
    };
  }

  const deleted = await rewardProfileRepository.remove(id);

  if (!deleted) {
    return {
      success: false,
      error: {
        code: ReasonCode.INTERNAL_ERROR,
        message: 'Failed to delete profile',
      },
    };
  }

  await auditLogRepository.append({
    entityType: 'reward_profile',
    entityId: id,
    action: 'DELETE',
    payload: { deletedProfile: existing },
  });

  return { success: true };
}

export const rewardProfileService = {
  createProfile,
  getProfileById,
  getActiveProfiles,
  getAllProfiles,
  updateProfile,
  deleteProfile,
};
