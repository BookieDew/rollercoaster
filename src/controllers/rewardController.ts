import { Request, Response, NextFunction } from 'express';
import { rewardEntitlementService } from '../services/rewardEntitlementService';
import { rewardOptInService } from '../services/rewardOptInService';
import {
  grantRewardSchema,
  startRideSchema,
  eligibilityRequestSchema,
  idParamsSchema,
  userIdParamsSchema,
  brandQuerySchema,
  brandSegmentQuerySchema,
  bulkGrantRewardSchema,
} from '../validation/schemas';
import { toDTO, toOptInResponse, type BulkGrantRewardResponse } from '../types/userReward';
import { createApiError } from '../middleware/errorHandler';

/**
 * POST /rewards - Grant a reward entitlement to a user
 */
export async function grantReward(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const validated = grantRewardSchema.parse(req.body);

    const result = await rewardEntitlementService.grantReward({
      userId: validated.user_id,
      profileVersionId: validated.profile_version_id,
      durationSeconds: validated.duration_seconds,
      segment: validated.segment,
    });

    if (!result.success || !result.data) {
      throw createApiError(
        result.error?.message ?? 'Failed to grant reward',
        result.error?.code!
      );
    }

    res.status(201).json(toDTO(result.data));
  } catch (error) {
    next(error);
  }
}

/**
 * POST /rewards/bulk - Grant one profile version to many players, all or nothing
 */
export async function grantRewardsBulk(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const validated = bulkGrantRewardSchema.parse(req.body);

    const result = await rewardEntitlementService.grantRewardsBulk({
      userIds: validated.user_ids,
      profileVersionId: validated.profile_version_id,
      durationSeconds: validated.duration_seconds,
      segment: validated.segment,
    });

    if (!result.success || !result.data) {
      throw createApiError(
        result.error?.message ?? 'Failed to grant rewards',
        result.error?.code!
      );
    }

    const response: BulkGrantRewardResponse = {
      profile_version_id: result.data.profileVersionId,
      segment: result.data.segment,
      count: result.data.rewards.length,
      rewards: result.data.rewards.map(toDTO),
    };
    res.status(201).json(response);
  } catch (error) {
    next(error);
  }
}

/**
 * GET /rewards/:id - Get a reward by ID
 */
export async function getReward(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const { id } = idParamsSchema.parse(req.params);

    const result = await rewardEntitlementService.getRewardById(id);

    if (!result.success || !result.data) {
      throw createApiError(
        result.error?.message ?? 'Reward not found',
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
 * GET /rewards/user/:userId - Get all rewards for a user
 */
export async function getRewardsByUser(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const { userId } = userIdParamsSchema.parse(req.params);
    const { brand_id: brandId, segment } = brandSegmentQuerySchema.parse(req.query);

    const result = await rewardEntitlementService.getRewardsByUserId(brandId, userId, segment);

    if (!result.success || !result.data) {
      throw createApiError(
        result.error?.message ?? 'Failed to fetch rewards',
        result.error?.code!
      );
    }

    res.json({
      rewards: result.data.map(toDTO),
      count: result.data.length,
    });
  } catch (error) {
    next(error);
  }
}

/**
 * POST /rewards/:id/opt-in - User starts the ride after bet placement
 */
export async function optInToReward(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const { id } = idParamsSchema.parse(req.params);
    const validated = startRideSchema.parse(req.body);

    const result = await rewardOptInService.optIn(id, {
      userId: validated.user_id,
      betId: validated.bet_id,
      stakeMinor: validated.stake_minor,
      currency: validated.currency,
      selections: validated.ticket.selections,
    });

    if (!result.success || !result.data) {
      throw createApiError(
        result.error?.message ?? 'Failed to opt in',
        result.error?.code!
      );
    }

    res.json(toOptInResponse(result.data.reward, result.data.rideStarted));
  } catch (error) {
    next(error);
  }
}

/**
 * GET /rewards/user/:userId/active - Get active reward for a user
 */
export async function getActiveReward(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const { userId } = userIdParamsSchema.parse(req.params);
    const { brand_id: brandId } = brandQuerySchema.parse(req.query);

    const result = await rewardEntitlementService.getActiveRewardForUser(brandId, userId);

    if (!result.success) {
      throw createApiError(
        result.error?.message ?? 'Failed to fetch active reward',
        result.error?.code!
      );
    }

    if (!result.data) {
      res.json({ active_reward: null });
      return;
    }

    res.json({ active_reward: toDTO(result.data) });
  } catch (error) {
    next(error);
  }
}

/**
 * POST /rewards/:id/eligibility - Precheck ticket eligibility before starting ride
 */
export async function precheckEligibility(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const { id } = idParamsSchema.parse(req.params);
    const validated = eligibilityRequestSchema.parse(req.body);

    const result = await rewardOptInService.precheckEligibility(
      id,
      validated.user_id,
      validated.ticket.selections
    );

    if (!result.success || !result.data) {
      throw createApiError(
        result.error?.message ?? 'Failed to precheck eligibility',
        result.error?.code!
      );
    }

    res.json(result.data);
  } catch (error) {
    next(error);
  }
}
