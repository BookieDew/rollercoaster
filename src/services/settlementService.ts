import { betBoostLockRepository } from '../db/repositories/betBoostLockRepository';
import { settlementRepository } from '../db/repositories/settlementRepository';
import { auditLogRepository } from '../db/repositories/auditLogRepository';
import { calculateBonusAmount } from '../computations';
import type { SettlementOutcome, SettlementResponse } from '../types/settlement';
import { ReasonCode } from '../types/reasonCodes';

export interface SettleInput {
  betId: string;
  outcome: SettlementOutcome;
  winnings: number;
}

export interface ServiceResult<T> {
  success: boolean;
  data?: T;
  error?: {
    code: ReasonCode;
    message: string;
  };
}

/**
 * Handles bet outcomes: on win calculates bonus = winnings * locked_boost_pct,
 * on loss/void/cashout returns zero bonus, persists settlement record.
 */
export async function settleBet(
  input: SettleInput
): Promise<ServiceResult<SettlementResponse>> {
  const { betId, outcome, winnings } = input;

  // Check if already settled (idempotency)
  const existingSettlement = await settlementRepository.findByBetId(betId);
  if (existingSettlement) {
    const lock = await betBoostLockRepository.findByBetId(betId);
    return {
      success: true,
      data: {
        settlement_id: existingSettlement.id,
        bet_id: existingSettlement.betId,
        outcome: existingSettlement.outcome,
        winnings: existingSettlement.winnings,
        bonus_amount: existingSettlement.bonusAmount,
        locked_boost_pct: lock?.lockedBoostPct ?? 0,
        settled_at: existingSettlement.settledAt,
      },
    };
  }

  // Find the lock for this bet
  const lock = await betBoostLockRepository.findByBetId(betId);
  if (!lock) {
    return {
      success: false,
      error: {
        code: ReasonCode.LOCK_NOT_FOUND,
        message: `No boost lock found for bet ${betId}`,
      },
    };
  }

  // Calculate bonus amount
  let bonusAmount = 0;

  if (outcome === 'WIN' && winnings > 0) {
    // On win, calculate bonus based on locked boost percentage
    bonusAmount = calculateBonusAmount(winnings, lock.lockedBoostPct);
  }
  // On LOSS, VOID, CASHOUT - bonus is zero (configurable in future)

  // Create settlement record
  const settlement = await settlementRepository.create({
    betId,
    outcome,
    winnings,
    bonusAmount,
  });

  await auditLogRepository.append({
    entityType: 'settlement',
    entityId: settlement.id,
    action: 'SETTLE',
    payload: {
      betId,
      outcome,
      winnings,
      bonusAmount,
      lockedBoostPct: lock.lockedBoostPct,
      rewardId: lock.rewardId,
    },
  });

  return {
    success: true,
    data: {
      settlement_id: settlement.id,
      bet_id: settlement.betId,
      outcome: settlement.outcome,
      winnings: settlement.winnings,
      bonus_amount: settlement.bonusAmount,
      locked_boost_pct: lock.lockedBoostPct,
      settled_at: settlement.settledAt,
    },
  };
}

/**
 * Gets settlement record by bet ID.
 */
export async function getSettlementByBetId(
  betId: string
): Promise<ServiceResult<SettlementResponse | null>> {
  const settlement = await settlementRepository.findByBetId(betId);
  if (!settlement) {
    return { success: true, data: null };
  }

  const lock = await betBoostLockRepository.findByBetId(betId);

  return {
    success: true,
    data: {
      settlement_id: settlement.id,
      bet_id: settlement.betId,
      outcome: settlement.outcome,
      winnings: settlement.winnings,
      bonus_amount: settlement.bonusAmount,
      locked_boost_pct: lock?.lockedBoostPct ?? 0,
      settled_at: settlement.settledAt,
    },
  };
}

export const settlementService = {
  settleBet,
  getSettlementByBetId,
};
