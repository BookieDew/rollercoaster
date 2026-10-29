import { Request, Response, NextFunction } from 'express';
import { rewardExpiryService } from '../services/rewardExpiryService';

/**
 * POST /admin/rewards/expire - Run the reward expiry job once (admin only)
 */
export async function expireRewards(
  _req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const result = await rewardExpiryService.expireRewards();
    res.json(result);
  } catch (error) {
    next(error);
  }
}
