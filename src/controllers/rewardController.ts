import { Request, Response, NextFunction } from 'express';
import { rewardEntitlementService } from '../services/rewardEntitlementService';
import { rewardOptInService } from '../services/rewardOptInService';
import { grantRewardSchema, startRideSchema, eligibilityRequestSchema } from '../validation/schemas';
import { toDTO } from '../types/userReward';
import { createApiError } from '../middleware/errorHandler';
import { ReasonCode } from '../types/reasonCodes';

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
 * GET /rewards/:id - Get a reward by ID
 */
export async function getReward(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const { id } = req.params;

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
    const { userId } = req.params;

    const result = await rewardEntitlementService.getRewardsByUserId(userId);

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
    const { id } = req.params;
    const validated = startRideSchema.parse(req.body);

    const result = await rewardOptInService.optIn(id, {
      userId: validated.user_id,
      betId: validated.bet_id,
      selections: validated.ticket.selections,
    });

    if (!result.success || !result.data) {
      throw createApiError(
        result.error?.message ?? 'Failed to opt in',
        result.error?.code!
      );
    }

    res.json({
      reward_id: result.data.reward.id,
      status: result.data.reward.status,
      ride_started: result.data.rideStarted,
      end_time: result.data.reward.endTime,
    });
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
    const { userId } = req.params;

    const result = await rewardEntitlementService.getActiveRewardForUser(userId);

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
    const { id } = req.params;
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
