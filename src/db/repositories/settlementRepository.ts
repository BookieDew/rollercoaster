import db from '../connection';
import { v4 as uuidv4 } from 'uuid';
import type { SettlementRecord, SettlementOutcome, CreateSettlementInput } from '../../types/settlement';

const TABLE = 'settlement_records';

export async function create(input: CreateSettlementInput): Promise<SettlementRecord> {
  const id = uuidv4();
  const now = new Date().toISOString();

  const record = {
    id,
    bet_id: input.betId,
    outcome: input.outcome,
    winnings: input.winnings,
    bonus_amount: input.bonusAmount,
    settled_at: now,
    created_at: now,
  };

  await db(TABLE).insert(record);
  return mapToEntity(record);
}

export async function findByBetId(betId: string): Promise<SettlementRecord | null> {
  const record = await db(TABLE).where({ bet_id: betId }).first();
  return record ? mapToEntity(record) : null;
}

export async function findById(id: string): Promise<SettlementRecord | null> {
  const record = await db(TABLE).where({ id }).first();
  return record ? mapToEntity(record) : null;
}

export async function existsByBetId(betId: string): Promise<boolean> {
  const record = await db(TABLE).where({ bet_id: betId }).first();
  return !!record;
}

export async function findByDateRange(startDate: string, endDate: string): Promise<SettlementRecord[]> {
  const records = await db(TABLE)
    .where('settled_at', '>=', startDate)
    .where('settled_at', '<=', endDate)
    .orderBy('settled_at', 'desc');
  return records.map(mapToEntity);
}

export async function sumBonusByOutcome(outcome: SettlementOutcome): Promise<number> {
  const result = await db(TABLE)
    .where({ outcome })
    .sum('bonus_amount as total')
    .first();
  return Number(result?.total ?? 0);
}

function mapToEntity(record: Record<string, unknown>): SettlementRecord {
  return {
    id: record.id as string,
    betId: record.bet_id as string,
    outcome: record.outcome as SettlementOutcome,
    winnings: Number(record.winnings),
    bonusAmount: Number(record.bonus_amount),
    settledAt: record.settled_at as string,
    createdAt: record.created_at as string,
  };
}

export const settlementRepository = {
  create,
  findByBetId,
  findById,
  existsByBetId,
  findByDateRange,
  sumBonusByOutcome,
};
