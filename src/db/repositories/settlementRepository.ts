import db from '../connection';
import { executorFor, type TransactionScope } from './transaction';
import { parseMinorUnits } from '../../money/minorUnits';
import type {
  BetSettlement,
  CreateBetSettlementInput,
  SettlementBetResult,
  SettlementLeg,
  SettlementOutcome,
} from '../../types/settlement';

const TABLE = 'bet_settlements';

/** Inserts a revision as the current one. Unique (lock_id, revision) and one-current-per-lock back races. */
export async function create(input: CreateBetSettlementInput, tx?: TransactionScope): Promise<BetSettlement> {
  const now = new Date().toISOString();
  const record = {
    id: input.id,
    brand_id: input.brandId,
    bet_id: input.betId,
    lock_id: input.lockId,
    revision: input.revision,
    is_current: true,
    outcome: input.outcome,
    bet_result: input.betResult,
    legs: input.legs === null ? null : JSON.stringify(input.legs),
    currency: input.currency,
    stake_minor: input.stakeMinor,
    total_return_minor: input.totalReturnMinor,
    locked_boost_pct: input.lockedBoostPct,
    bonus_minor: input.bonusMinor,
    bonus_cap_minor: input.bonusCapMinor,
    cap_applied: input.capApplied,
    minimums_met: input.minimumsMet,
    replacement_reward_id: input.replacementRewardId,
    reason: input.reason,
    settled_at: input.settledAt,
    created_at: now,
  };

  const q = await executorFor(tx);
  await q(TABLE).insert(record);
  return mapToEntity(record);
}

/** The current revision of a lock's settlement, or null when the bet is unsettled. */
export async function findCurrentByLockId(lockId: string, tx?: TransactionScope): Promise<BetSettlement | null> {
  const q = await executorFor(tx);
  const record = await q(TABLE).where({ lock_id: lockId, is_current: true }).first();
  return record ? mapToEntity(record) : null;
}

/** The current revision of a bet, identified by (brand_id, bet_id). */
export async function findCurrentByBet(brandId: string, betId: string): Promise<BetSettlement | null> {
  const record = await db(TABLE).where({ brand_id: brandId, bet_id: betId, is_current: true }).first();
  return record ? mapToEntity(record) : null;
}

export async function findRevision(
  lockId: string,
  revision: number,
  tx?: TransactionScope
): Promise<BetSettlement | null> {
  const q = await executorFor(tx);
  const record = await q(TABLE).where({ lock_id: lockId, revision }).first();
  return record ? mapToEntity(record) : null;
}

/** Every revision of a lock's settlement, oldest first. */
export async function findAllByLockId(lockId: string): Promise<BetSettlement[]> {
  const records = await db(TABLE).where({ lock_id: lockId }).orderBy('revision', 'asc');
  return records.map(mapToEntity);
}

/**
 * Marks a revision as superseded. Conditional on it still being current, so of
 * two concurrent corrections only one can supersede it; returns false otherwise.
 */
export async function markSuperseded(id: string, tx: TransactionScope): Promise<boolean> {
  const q = await executorFor(tx);
  const updated = await q(TABLE).where({ id, is_current: true }).update({ is_current: false });
  return updated > 0;
}

function parseLegs(value: unknown): SettlementLeg[] | null {
  if (value === null || value === undefined) return null;
  return (typeof value === 'string' ? JSON.parse(value) : value) as SettlementLeg[];
}

/**
 * Reads total_return_minor, stored as an exact decimal-integer string (text
 * column) because sportsbook returns can exceed 2^53. A non-negative safe-integer
 * number is accepted too; anything else is rejected rather than rounded.
 */
function parseExactMinorUnits(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value)) return value;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value);
  throw new Error('Stored total return is not an exact non-negative integer');
}

function parseNullableBoolean(value: unknown): boolean | null {
  return value === null || value === undefined ? null : Boolean(value);
}

function mapToEntity(record: Record<string, unknown>): BetSettlement {
  return {
    id: record.id as string,
    brandId: record.brand_id as string,
    betId: record.bet_id as string,
    lockId: record.lock_id as string,
    revision: Number(record.revision),
    isCurrent: Boolean(record.is_current),
    outcome: record.outcome as SettlementOutcome,
    betResult: record.bet_result as SettlementBetResult,
    legs: parseLegs(record.legs),
    currency: record.currency as string,
    stakeMinor: parseMinorUnits(record.stake_minor) as number,
    totalReturnMinor: parseExactMinorUnits(record.total_return_minor),
    lockedBoostPct: Number(record.locked_boost_pct),
    bonusMinor: parseMinorUnits(record.bonus_minor) as number,
    bonusCapMinor: parseMinorUnits(record.bonus_cap_minor) as number,
    capApplied: Boolean(record.cap_applied),
    minimumsMet: parseNullableBoolean(record.minimums_met),
    replacementRewardId: (record.replacement_reward_id as string | null | undefined) ?? null,
    reason: (record.reason as string | null | undefined) ?? null,
    settledAt: record.settled_at as string,
    createdAt: record.created_at as string,
  };
}

export const settlementRepository = {
  create,
  findCurrentByLockId,
  findCurrentByBet,
  findRevision,
  findAllByLockId,
  markSuperseded,
};
