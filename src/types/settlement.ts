import type {
  SettlementBetResult,
  SettlementLeg,
  SettlementOutcome,
} from '../computations/settlementCalculator';

export type { SettlementBetResult, SettlementLeg, SettlementOutcome };

/** Whether a cancelled bet returned its token (null when the bet is not CANCELLED). */
export type ReplacementStatus = 'ISSUED' | 'NOT_ISSUED_EXPIRED';

/** One settlement revision of a lock (table bet_settlements). Money is integer minor units. */
export interface BetSettlement {
  id: string;
  brandId: string;
  betId: string;
  lockId: string;
  revision: number;
  isCurrent: boolean;
  outcome: SettlementOutcome;
  betResult: SettlementBetResult;
  /** Normalized legs (sorted by selection_id) for SETTLED; null otherwise. */
  legs: SettlementLeg[] | null;
  currency: string;
  stakeMinor: number;
  /**
   * Exact decimal-integer string (sportsbook returns can exceed 2^53); null for
   * CANCELLED and CASHED_OUT, "0" for LOST.
   */
  totalReturnMinor: string | null;
  lockedBoostPct: number;
  bonusMinor: number;
  bonusCapMinor: number;
  capApplied: boolean;
  /** null when the minimums re-check did not run. */
  minimumsMet: boolean | null;
  replacementRewardId: string | null;
  /** Correction reason (null on revision 1). */
  reason: string | null;
  settledAt: string;
  createdAt: string;
}

export interface CreateBetSettlementInput {
  id: string;
  brandId: string;
  betId: string;
  lockId: string;
  revision: number;
  outcome: SettlementOutcome;
  betResult: SettlementBetResult;
  legs: SettlementLeg[] | null;
  currency: string;
  stakeMinor: number;
  /** Exact decimal-integer string; see BetSettlement.totalReturnMinor. */
  totalReturnMinor: string | null;
  lockedBoostPct: number;
  bonusMinor: number;
  bonusCapMinor: number;
  capApplied: boolean;
  minimumsMet: boolean | null;
  replacementRewardId: string | null;
  reason: string | null;
  settledAt: string;
}

/** Public settlement representation (POST /settlement, /settlement/resettle and GET). */
export interface SettlementResponse {
  settlement_id: string;
  brand_id: string;
  bet_id: string;
  lock_id: string;
  revision: number;
  outcome: SettlementOutcome;
  bet_result: SettlementBetResult;
  legs: SettlementLeg[] | null;
  currency: string;
  stake_minor: number;
  /**
   * Exact decimal-integer string of minor units: sportsbook returns can exceed
   * 2^53 and must not lose precision in JSON. null for CANCELLED and CASHED_OUT,
   * "0" for LOST.
   */
  total_return_minor: string | null;
  locked_boost_pct: number;
  bonus_minor: number;
  bonus_cap_minor: number;
  cap_applied: boolean;
  minimums_met: boolean | null;
  replacement_reward_id: string | null;
  replacement_status: ReplacementStatus | null;
  /** Correction reason of this revision (null on revision 1). */
  reason: string | null;
  /** Bonus of the previous revision; null on revision 1. */
  previous_bonus_minor: number | null;
  /** bonus_minor minus previous_bonus_minor; null on revision 1. */
  bonus_delta_minor: number | null;
  settled_at: string;
}

/** Replacement status is derived: a CANCELLED revision either carries a replacement or none was issued. */
export function replacementStatusOf(
  settlement: Pick<BetSettlement, 'betResult' | 'replacementRewardId'>
): ReplacementStatus | null {
  if (settlement.betResult !== 'CANCELLED') return null;
  return settlement.replacementRewardId ? 'ISSUED' : 'NOT_ISSUED_EXPIRED';
}

export function toSettlementResponse(
  settlement: BetSettlement,
  previousBonusMinor: number | null
): SettlementResponse {
  return {
    settlement_id: settlement.id,
    brand_id: settlement.brandId,
    bet_id: settlement.betId,
    lock_id: settlement.lockId,
    revision: settlement.revision,
    outcome: settlement.outcome,
    bet_result: settlement.betResult,
    legs: settlement.legs,
    currency: settlement.currency,
    stake_minor: settlement.stakeMinor,
    total_return_minor: settlement.totalReturnMinor,
    locked_boost_pct: settlement.lockedBoostPct,
    bonus_minor: settlement.bonusMinor,
    bonus_cap_minor: settlement.bonusCapMinor,
    cap_applied: settlement.capApplied,
    minimums_met: settlement.minimumsMet,
    replacement_reward_id: settlement.replacementRewardId,
    replacement_status: replacementStatusOf(settlement),
    reason: settlement.reason,
    previous_bonus_minor: previousBonusMinor,
    bonus_delta_minor: previousBonusMinor === null ? null : settlement.bonusMinor - previousBonusMinor,
    settled_at: settlement.settledAt,
  };
}
