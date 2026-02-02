import { Request, Response, NextFunction } from 'express';
import { simulationService } from '../services/simulationService';
import { simulationRequestSchema } from '../validation/schemas';
import { createApiError } from '../middleware/errorHandler';

/**
 * POST /simulation - Simulate a ride curve (admin only)
 */
export async function simulateRide(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const validated = simulationRequestSchema.parse(req.body);

    const result = await simulationService.simulateRide({
      profileId: validated.profile_id,
      seed: validated.seed,
      minBoostPct: validated.min_boost_pct,
      maxBoostPct: validated.max_boost_pct,
      samplePoints: validated.sample_points,
      ticket: validated.ticket,
    });

    if (!result.success || !result.data) {
      throw createApiError(
        result.error?.message ?? 'Failed to simulate ride',
        result.error?.code!
      );
    }

    res.json(result.data);
  } catch (error) {
    next(error);
  }
}
