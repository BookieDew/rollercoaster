import { Request, Response, NextFunction } from 'express';
import { boostQuoteService } from '../services/boostQuoteService';
import { boostLockService } from '../services/boostLockService';
import { quoteRequestSchema, lockRequestSchema } from '../validation/schemas';
import { createApiError } from '../middleware/errorHandler';

/**
 * POST /boost/quote - Get a boost quote for a prospective ticket
 */
export async function getQuote(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const validated = quoteRequestSchema.parse(req.body);

    const result = await boostQuoteService.getQuote({
      userId: validated.user_id,
      rewardId: validated.reward_id,
      betId: validated.bet_id,
    });

    if (!result.success || !result.data) {
      throw createApiError(
        result.error?.message ?? 'Failed to get quote',
        result.error?.code!
      );
    }

    res.json(result.data);
  } catch (error) {
    next(error);
  }
}

/**
 * POST /boost/lock - Lock a boost for a bet
 */
export async function lockBoost(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const validated = lockRequestSchema.parse(req.body);

    const result = await boostLockService.lockBoost({
      userId: validated.user_id,
      rewardId: validated.reward_id,
      betId: validated.bet_id,
    });

    if (!result.success || !result.data) {
      throw createApiError(
        result.error?.message ?? 'Failed to lock boost',
        result.error?.code!,
        undefined,
        result.error?.details
      );
    }

    res.status(201).json(result.data);
  } catch (error) {
    next(error);
  }
}

/**
 * GET /boost/lock/:betId - Get an existing lock by bet ID
 */
export async function getLock(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const { betId } = req.params;

    const result = await boostLockService.getLockByBetId(betId);

    if (!result.success) {
      throw createApiError(
        result.error?.message ?? 'Failed to get lock',
        result.error?.code!
      );
    }

    if (!result.data) {
      res.status(404).json({
        error: 'Not Found',
        message: `No lock found for bet ${betId}`,
      });
      return;
    }

    res.json({
      lock_id: result.data.id,
      bet_id: result.data.betId,
      reward_id: result.data.rewardId,
      locked_boost_pct: result.data.lockedBoostPct,
      qualifying_selections: result.data.qualifyingSelections,
      qualifying_odds: result.data.qualifyingOdds,
      ticket_strength: result.data.ticketStrength,
      locked_at: result.data.lockedAt,
      theoretical_max_boost_pct: result.data.snapshot.maxPossibleBoostPct,
      ride_end_at_offset_seconds: roundToDecimals(result.data.snapshot.rideDurationSeconds, 3),
      ride_crash_at_offset_seconds: roundToDecimals(
        result.data.snapshot.rideDurationSeconds * result.data.snapshot.crashPct,
        3
      ),
      ride_path: result.data.snapshot.ridePath,
    });
  } catch (error) {
    next(error);
  }
}

function roundToDecimals(value: number, decimals: number): number {
  const factor = Math.pow(10, decimals);
  return Math.round(value * factor) / factor;
}
