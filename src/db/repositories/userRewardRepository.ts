import db from '../connection';
import { v4 as uuidv4 } from 'uuid';
import type { UserReward, UserRewardStatus, CreateUserRewardInput } from '../../types/userReward';
import { executorFor, type TransactionScope } from './transaction';

const TABLE = 'user_rewards';

/**
 * Raised when a bet is bound to a reward while another reward already holds it.
 * Interim guard until brand-scoped bet uniqueness becomes a database constraint.
 */
export class BetAlreadyBoundError extends Error {
  constructor(readonly betId: string) {
    super('Bet is already bound to a different reward');
    this.name = 'BetAlreadyBoundError';
  }
}

export interface StatusUpdateOptions {
  tx?: TransactionScope;
  /** Only update when the row is currently in this status (compare-and-set). */
  fromStatus?: UserRewardStatus;
}

export async function create(input: CreateUserRewardInput, tx?: TransactionScope): Promise<UserReward> {
  const id = uuidv4();
  const now = new Date().toISOString();

  const record = {
    id,
    user_id: input.userId,
    profile_version_id: input.profileVersionId,
    status: 'GRANTED' as const,
    start_time: input.startTime,
    end_time: input.endTime,
    seed: input.seed,
    bet_id: null,
    ticket_snapshot: null,
    opted_in_at: null,
    created_at: now,
    updated_at: now,
  };

  const q = await executorFor(tx);
  await q(TABLE).insert(record);
  return mapToEntity(record);
}

export async function findById(id: string, tx?: TransactionScope): Promise<UserReward | null> {
  const q = await executorFor(tx);
  const record = await q(TABLE).where({ id }).first();
  return record ? mapToEntity(record) : null;
}

export async function findByUserId(userId: string): Promise<UserReward[]> {
  const records = await db(TABLE).where({ user_id: userId }).orderBy('created_at', 'desc');
  return records.map(mapToEntity);
}

export async function findActiveByUserId(userId: string): Promise<UserReward | null> {
  const now = new Date().toISOString();
  const record = await db(TABLE)
    .where({ user_id: userId })
    .andWhere((qb) => {
      qb.where('status', 'GRANTED').orWhere((sub) => {
        sub.where('status', 'ENTERED').andWhere('end_time', '>', now);
      });
    })
    .orderBy('created_at', 'desc')
    .first();
  return record ? mapToEntity(record) : null;
}

/**
 * Sets the status. With `fromStatus` the update is conditional
 * (`WHERE id = ? AND status = ?`); returns null when no row was updated.
 */
export async function updateStatus(
  id: string,
  status: UserRewardStatus,
  optedInAt?: string,
  options: StatusUpdateOptions = {}
): Promise<UserReward | null> {
  const updates: Record<string, unknown> = {
    status,
    updated_at: new Date().toISOString(),
  };

  if (optedInAt) {
    updates.opted_in_at = optedInAt;
  }

  const q = await executorFor(options.tx);
  const query = q(TABLE).where({ id });
  if (options.fromStatus) {
    query.andWhere({ status: options.fromStatus });
  }
  const updated = await query.update(updates);
  if (!updated) return null;
  return findById(id, options.tx);
}

/**
 * Binds the bet and frozen ride timing to the reward. Throws BetAlreadyBoundError
 * when the bet is already attached to a different reward (any status).
 */
export async function updateRideStart(
  id: string,
  startTime: string,
  endTime: string,
  betId: string,
  ticketSnapshot: Record<string, unknown>,
  tx?: TransactionScope
): Promise<UserReward | null> {
  const q = await executorFor(tx);
  const boundElsewhere = await q(TABLE)
    .where({ bet_id: betId })
    .whereNot({ id })
    .first('id');
  if (boundElsewhere) {
    throw new BetAlreadyBoundError(betId);
  }

  const updates: Record<string, unknown> = {
    start_time: startTime,
    end_time: endTime,
    bet_id: betId,
    ticket_snapshot: JSON.stringify(ticketSnapshot),
    updated_at: new Date().toISOString(),
  };

  await q(TABLE).where({ id }).update(updates);
  return findById(id, tx);
}

export async function markExpired(): Promise<number> {
  const now = new Date().toISOString();
  const updated = await db(TABLE)
    .whereIn('status', ['ENTERED'])
    .where('end_time', '<=', now)
    .update({ status: 'EXPIRED', updated_at: now });
  return updated;
}

function mapToEntity(record: Record<string, unknown>): UserReward {
  const snapshot = record.ticket_snapshot
    ? (typeof record.ticket_snapshot === 'string'
        ? JSON.parse(record.ticket_snapshot)
        : record.ticket_snapshot)
    : null;

  return {
    id: record.id as string,
    userId: record.user_id as string,
    profileVersionId: record.profile_version_id as string,
    status: record.status as UserRewardStatus,
    startTime: record.start_time as string,
    endTime: record.end_time as string,
    seed: record.seed as string,
    betId: record.bet_id as string | null,
    ticketSnapshot: snapshot as Record<string, unknown> | null,
    optedInAt: record.opted_in_at as string | null,
    createdAt: record.created_at as string,
    updatedAt: record.updated_at as string,
  };
}

export const userRewardRepository = {
  create,
  findById,
  findByUserId,
  findActiveByUserId,
  updateStatus,
  updateRideStart,
  markExpired,
};
