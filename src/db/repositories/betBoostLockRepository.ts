import db from '../connection';
import { v4 as uuidv4 } from 'uuid';
import type { BetBoostLock, CreateBetBoostLockInput } from '../../types/betBoostLock';

const TABLE = 'bet_boost_locks';

export async function create(input: CreateBetBoostLockInput): Promise<BetBoostLock> {
  const id = uuidv4();
  const now = new Date().toISOString();

  const record = {
    id,
    bet_id: input.betId,
    reward_id: input.rewardId,
    locked_boost_pct: input.lockedBoostPct,
    qualifying_selections: input.qualifyingSelections,
    qualifying_odds: input.qualifyingOdds,
    ticket_strength: input.ticketStrength,
    snapshot: JSON.stringify(input.snapshot),
    locked_at: now,
    created_at: now,
  };

  await db(TABLE).insert(record);
  return mapToEntity(record);
}

export async function findByBetId(betId: string): Promise<BetBoostLock | null> {
  const record = await db(TABLE).where({ bet_id: betId }).first();
  return record ? mapToEntity(record) : null;
}

export async function findById(id: string): Promise<BetBoostLock | null> {
  const record = await db(TABLE).where({ id }).first();
  return record ? mapToEntity(record) : null;
}

export async function findByRewardId(rewardId: string): Promise<BetBoostLock[]> {
  const records = await db(TABLE).where({ reward_id: rewardId }).orderBy('locked_at', 'desc');
  return records.map(mapToEntity);
}

export async function existsByBetId(betId: string): Promise<boolean> {
  const record = await db(TABLE).where({ bet_id: betId }).first();
  return !!record;
}

function mapToEntity(record: Record<string, unknown>): BetBoostLock {
  const snapshot = typeof record.snapshot === 'string'
    ? JSON.parse(record.snapshot)
    : record.snapshot;

  return {
    id: record.id as string,
    betId: record.bet_id as string,
    rewardId: record.reward_id as string,
    lockedBoostPct: Number(record.locked_boost_pct),
    qualifyingSelections: record.qualifying_selections as number,
    qualifyingOdds: Number(record.qualifying_odds),
    ticketStrength: Number(record.ticket_strength),
    snapshot,
    lockedAt: record.locked_at as string,
    createdAt: record.created_at as string,
  };
}

export const betBoostLockRepository = {
  create,
  findByBetId,
  findById,
  findByRewardId,
  existsByBetId,
};
