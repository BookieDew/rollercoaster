import { Request, Response, NextFunction } from 'express';
import { rewardProfileService } from '../services/rewardProfileService';
import { createRewardProfileSchema, updateRewardProfileSchema } from '../validation/schemas';
import { toDTO } from '../types/rewardProfile';
import { createApiError } from '../middleware/errorHandler';

/**
 * POST /profiles - Create a new reward profile
 */
export async function createProfile(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const validated = createRewardProfileSchema.parse(req.body);

    const result = await rewardProfileService.createProfile({
      name: validated.name,
      description: validated.description,
      minSelections: validated.min_selections,
      minCombinedOdds: validated.min_combined_odds,
      minSelectionOdds: validated.min_selection_odds,
      minBoostPct: validated.min_boost_pct,
      maxBoostPct: validated.max_boost_pct,
      maxBoostMinSelections: validated.max_boost_min_selections ?? null,
      maxBoostMinCombinedOdds: validated.max_boost_min_combined_odds ?? null,
      rideDurationSeconds: validated.ride_duration_seconds,
    });

    if (!result.success || !result.data) {
      throw createApiError(
        result.error?.message ?? 'Failed to create profile',
        result.error?.code!
      );
    }

    res.status(201).json(toDTO(result.data));
  } catch (error) {
    next(error);
  }
}

/**
 * GET /profiles/:id - Get a reward profile by ID
 */
export async function getProfile(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const { id } = req.params;

    const result = await rewardProfileService.getProfileById(id);

    if (!result.success || !result.data) {
      throw createApiError(
        result.error?.message ?? 'Profile not found',
        result.error?.code!,
        404
      );
    }

    res.json(toDTO(result.data));
  } catch (error) {
    next(error);
  }
}

/**
 * GET /profiles - Get all reward profiles
 */
export async function getAllProfiles(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const activeOnly = req.query.active === 'true';

    const result = activeOnly
      ? await rewardProfileService.getActiveProfiles()
      : await rewardProfileService.getAllProfiles();

    if (!result.success || !result.data) {
      throw createApiError(
        result.error?.message ?? 'Failed to fetch profiles',
        result.error?.code!
      );
    }

    res.json({
      profiles: result.data.map(toDTO),
      count: result.data.length,
    });
  } catch (error) {
    next(error);
  }
}

/**
 * PUT /profiles/:id - Update a reward profile
 */
export async function updateProfile(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const { id } = req.params;
    const validated = updateRewardProfileSchema.parse(req.body);

    const result = await rewardProfileService.updateProfile(id, {
      name: validated.name,
      description: validated.description ?? undefined,
      minSelections: validated.min_selections,
      minCombinedOdds: validated.min_combined_odds,
      minSelectionOdds: validated.min_selection_odds,
      minBoostPct: validated.min_boost_pct,
      maxBoostPct: validated.max_boost_pct,
      maxBoostMinSelections: validated.max_boost_min_selections,
      maxBoostMinCombinedOdds: validated.max_boost_min_combined_odds,
      rideDurationSeconds: validated.ride_duration_seconds,
      isActive: validated.is_active,
    });

    if (!result.success || !result.data) {
      throw createApiError(
        result.error?.message ?? 'Failed to update profile',
        result.error?.code!
      );
    }

    res.json(toDTO(result.data));
  } catch (error) {
    next(error);
  }
}

/**
 * DELETE /profiles/:id - Delete a reward profile
 */
export async function deleteProfile(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const { id } = req.params;

    const result = await rewardProfileService.deleteProfile(id);

    if (!result.success) {
      throw createApiError(
        result.error?.message ?? 'Failed to delete profile',
        result.error?.code!
      );
    }

    res.status(204).send();
  } catch (error) {
    next(error);
  }
}
