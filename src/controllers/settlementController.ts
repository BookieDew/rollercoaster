import { Request, Response, NextFunction } from 'express';
import { settlementService, type ServiceResult } from '../services/settlementService';
import {
  settlementRequestSchema,
  resettlementRequestSchema,
  betIdParamsSchema,
  brandQuerySchema,
} from '../validation/schemas';
import { createApiError } from '../middleware/errorHandler';
import { ReasonCode } from '../types/reasonCodes';
import type { SettlementResponse } from '../types/settlement';

function sendCreated(res: Response, result: ServiceResult<SettlementResponse>, fallback: string): void {
  if (!result.success || !result.data) {
    throw createApiError(
      result.error?.message ?? fallback,
      result.error?.code ?? ReasonCode.INTERNAL_ERROR,
      undefined,
      result.error?.details
    );
  }
  res.status(201).json(result.data);
}

/**
 * POST /settlement - Settle a locked bet (revision 1; identical replays return the current revision)
 */
export async function settleBet(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const validated = settlementRequestSchema.parse(req.body);

    const result = await settlementService.settleBet({
      brandId: validated.brand_id,
      betId: validated.bet_id,
      outcome: validated.outcome,
      legs: validated.legs,
    });

    sendCreated(res, result, 'Failed to settle bet');
  } catch (error) {
    next(error);
  }
}

/**
 * POST /settlement/resettle - Correct a settlement by creating the next revision
 */
export async function resettleBet(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const validated = resettlementRequestSchema.parse(req.body);

    const result = await settlementService.resettleBet({
      brandId: validated.brand_id,
      betId: validated.bet_id,
      outcome: validated.outcome,
      legs: validated.legs,
      reason: validated.reason,
    });

    sendCreated(res, result, 'Failed to resettle bet');
  } catch (error) {
    next(error);
  }
}

/**
 * GET /settlement/:betId?brand_id= - Current settlement revision of a bet
 */
export async function getSettlement(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const { betId } = betIdParamsSchema.parse(req.params);
    const { brand_id: brandId } = brandQuerySchema.parse(req.query);

    const result = await settlementService.getSettlementByBetId(brandId, betId);

    if (!result.success) {
      throw createApiError(
        result.error?.message ?? 'Failed to get settlement',
        result.error?.code ?? ReasonCode.INTERNAL_ERROR
      );
    }

    if (!result.data) {
      throw createApiError(`No settlement found for bet ${betId} in brand ${brandId}`, ReasonCode.SETTLEMENT_NOT_FOUND);
    }

    res.json(result.data);
  } catch (error) {
    next(error);
  }
}
