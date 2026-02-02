import { Request, Response, NextFunction } from 'express';
import { settlementService } from '../services/settlementService';
import { settlementRequestSchema } from '../validation/schemas';
import { createApiError } from '../middleware/errorHandler';

/**
 * POST /settlement - Settle a bet outcome
 */
export async function settleBet(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const validated = settlementRequestSchema.parse(req.body);

    const result = await settlementService.settleBet({
      betId: validated.bet_id,
      outcome: validated.outcome,
      winnings: validated.winnings,
    });

    if (!result.success || !result.data) {
      throw createApiError(
        result.error?.message ?? 'Failed to settle bet',
        result.error?.code!
      );
    }

    res.status(201).json(result.data);
  } catch (error) {
    next(error);
  }
}

/**
 * GET /settlement/:betId - Get settlement record by bet ID
 */
export async function getSettlement(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const { betId } = req.params;

    const result = await settlementService.getSettlementByBetId(betId);

    if (!result.success) {
      throw createApiError(
        result.error?.message ?? 'Failed to get settlement',
        result.error?.code!
      );
    }

    if (!result.data) {
      res.status(404).json({
        error: 'Not Found',
        message: `No settlement found for bet ${betId}`,
      });
      return;
    }

    res.json(result.data);
  } catch (error) {
    next(error);
  }
}
