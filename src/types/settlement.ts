export type SettlementOutcome = 'WIN' | 'LOSS' | 'VOID' | 'CASHOUT';

export interface SettlementRecord {
  id: string;
  betId: string;
  outcome: SettlementOutcome;
  winnings: number;
  bonusAmount: number;
  settledAt: string;
  createdAt: string;
}

export interface CreateSettlementInput {
  betId: string;
  outcome: SettlementOutcome;
  winnings: number;
  bonusAmount: number;
}

export interface SettlementRequest {
  bet_id: string;
  outcome: SettlementOutcome;
  winnings: number;
}

export interface SettlementResponse {
  settlement_id: string;
  bet_id: string;
  outcome: SettlementOutcome;
  winnings: number;
  bonus_amount: number;
  locked_boost_pct: number;
  settled_at: string;
}

export interface SettlementRecordDTO {
  id: string;
  bet_id: string;
  outcome: SettlementOutcome;
  winnings: number;
  bonus_amount: number;
  settled_at: string;
  created_at: string;
}

export function toDTO(record: SettlementRecord): SettlementRecordDTO {
  return {
    id: record.id,
    bet_id: record.betId,
    outcome: record.outcome,
    winnings: record.winnings,
    bonus_amount: record.bonusAmount,
    settled_at: record.settledAt,
    created_at: record.createdAt,
  };
}
