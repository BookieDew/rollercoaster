import { betBoostLockRepository } from '../db/repositories/betBoostLockRepository';
import { settlementRepository } from '../db/repositories/settlementRepository';
import { auditLogRepository } from '../db/repositories/auditLogRepository';
import { runInTransaction, isUniqueViolation } from '../db/repositories/transaction';
import { calculateBonusAmount } from '../computations';
import type { SettlementOutcome, SettlementRecord, SettlementResponse } from '../types/settlement';
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

/** Stored precision of settlement_records.winnings (decimal(14,4)). */
const WINNINGS_DECIMALS = 4;

/**
 * Rounds half-up to the stored 4 decimal places, scaling the decimal text rather
 * than the binary value so exact half-way inputs (e.g. 1.00005) round like the
 * database column does.
 */
export function roundToStoredWinnings(value: number): number {
  const text = String(value);
  if (/e/i.test(text)) {
    const factor = 10 ** WINNINGS_DECIMALS;
    return Math.round(value * factor) / factor;
  }
  return Number(`${Math.round(Number(`${text}e${WINNINGS_DECIMALS}`))}e-${WINNINGS_DECIMALS}`);
}

/**
 * Handles bet outcomes: on win calculates bonus = winnings * locked_boost_pct,
 * on loss/void/cashout returns zero bonus, persists settlement record.
 *
 * Replays: the same bet with the same outcome and (rounded) winnings returns the
 * existing record; a different outcome or amount is rejected with
 * BET_ALREADY_SETTLED instead of being silently ignored.
 */
export async function settleBet(
  input: SettleInput
): Promise<ServiceResult<SettlementResponse>> {
  const { betId, outcome, winnings } = input;

  const existingSettlement = await settlementRepository.findByBetId(betId);
  if (existingSettlement) {
    return replaySettlement(existingSettlement, input);
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

  let settlement: SettlementRecord;
  try {
    // Settlement record and its audit row are atomic.
    settlement = await runInTransaction(async (tx) => {
      const created = await settlementRepository.create({
        betId,
        outcome,
        winnings,
        bonusAmount,
      }, tx);

      await auditLogRepository.append({
        entityType: 'settlement',
        entityId: created.id,
        action: 'SETTLE',
        payload: {
          betId,
          outcome,
          winnings,
          bonusAmount,
          lockedBoostPct: lock.lockedBoostPct,
          rewardId: lock.rewardId,
        },
      }, tx);

      return created;
    });
  } catch (error) {
    // A concurrent settlement won the bet_id unique key: re-read and apply the replay rule.
    if (isUniqueViolation(error)) {
      const concurrent = await settlementRepository.findByBetId(betId);
      if (concurrent) {
        return replaySettlement(concurrent, input);
      }
    }
    throw error;
  }

  return {
    success: true,
    data: toSettlementResponse(settlement, lock.lockedBoostPct),
  };
}

async function replaySettlement(
  existing: SettlementRecord,
  input: SettleInput
): Promise<ServiceResult<SettlementResponse>> {
  const sameResult = existing.outcome === input.outcome
    && roundToStoredWinnings(existing.winnings) === roundToStoredWinnings(input.winnings);

  if (!sameResult) {
    return {
      success: false,
      error: {
        code: ReasonCode.BET_ALREADY_SETTLED,
        message: 'Bet is already settled with a different outcome or winnings',
      },
    };
  }

  const lock = await betBoostLockRepository.findByBetId(existing.betId);
  return {
    success: true,
    data: toSettlementResponse(existing, lock?.lockedBoostPct ?? 0),
  };
}

function toSettlementResponse(settlement: SettlementRecord, lockedBoostPct: number): SettlementResponse {
  return {
    settlement_id: settlement.id,
    bet_id: settlement.betId,
    outcome: settlement.outcome,
    winnings: settlement.winnings,
    bonus_amount: settlement.bonusAmount,
    locked_boost_pct: lockedBoostPct,
    settled_at: settlement.settledAt,
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
    data: toSettlementResponse(settlement, lock?.lockedBoostPct ?? 0),
  };
}

export const settlementService = {
  settleBet,
  getSettlementByBetId,
};
