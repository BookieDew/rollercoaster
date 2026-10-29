import db from '../connection';
import { v4 as uuidv4 } from 'uuid';
import type { UserReward, UserRewardStatus, CreateUserRewardInput } from '../../types/userReward';
import { executorFor, type TransactionScope } from './transaction';
import { parseMinorUnits } from '../../money/minorUnits';

const TABLE = 'user_rewards';

/**
 * Raised when a bet is bound to a reward while another reward in the same brand
 * already holds it. The unique index on (brand_id, bet_id) backs this check;
 * a violation of the index itself surfaces as a unique-constraint error.
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
  /** Only update when valid_until is set and earlier than this ISO instant. */
  validUntilBefore?: string;
}

/** Money snapshot frozen on the reward when the ride starts. */
export interface OptInMoney {
  stakeMinor: number;
  currency: string;
  bonusCapMinor: number;
}

export async function create(input: CreateUserRewardInput, tx?: TransactionScope): Promise<UserReward> {
  const id = uuidv4();
  const now = new Date().toISOString();

  const record = {
    id,
    brand_id: input.brandId,
    user_id: input.userId,
    profile_version_id: input.profileVersionId,
    status: 'GRANTED' as const,
    start_time: input.startTime,
    end_time: input.endTime,
    seed: input.seed,
    bet_id: null,
    ticket_snapshot: null,
    opted_in_at: null,
    valid_until: input.validUntil ?? null,
    stake_minor: null,
    currency: null,
    bonus_cap_minor: null,
    replaces_reward_id: input.replacesRewardId ?? null,
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

/** A player is identified by (brand_id, user_id). */
export async function findByUserId(brandId: string, userId: string): Promise<UserReward[]> {
  const records = await db(TABLE)
    .where({ brand_id: brandId, user_id: userId })
    .orderBy('created_at', 'desc');
  return records.map(mapToEntity);
}

export async function findActiveByUserId(brandId: string, userId: string): Promise<UserReward | null> {
  const now = new Date().toISOString();
  const record = await db(TABLE)
    .where({ brand_id: brandId, user_id: userId })
    .andWhere((qb) => {
      qb.where((granted) => {
        granted.where('status', 'GRANTED').andWhere((validity) => {
          validity.whereNull('valid_until').orWhere('valid_until', '>=', now);
        });
      }).orWhere((sub) => {
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
  if (options.validUntilBefore) {
    query.whereNotNull('valid_until').andWhere('valid_until', '<', options.validUntilBefore);
  }
  const updated = await query.update(updates);
  if (!updated) return null;
  return findById(id, options.tx);
}

/**
 * Binds the bet, frozen ride timing and (when given) the stake/currency/cap
 * snapshot to the reward. Throws BetAlreadyBoundError when the bet is already
 * attached to a different reward of the same brand (any status).
 */
export async function updateRideStart(
  id: string,
  startTime: string,
  endTime: string,
  betId: string,
  ticketSnapshot: Record<string, unknown>,
  tx?: TransactionScope,
  money?: OptInMoney
): Promise<UserReward | null> {
  const q = await executorFor(tx);
  const owner = await q(TABLE).where({ id }).first('brand_id');
  if (!owner) return null;
  const boundElsewhere = await q(TABLE)
    .where({ brand_id: owner.brand_id, bet_id: betId })
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
  if (money) {
    updates.stake_minor = money.stakeMinor;
    updates.currency = money.currency;
    updates.bonus_cap_minor = money.bonusCapMinor;
  }

  await q(TABLE).where({ id }).update(updates);
  return findById(id, tx);
}

/** GRANTED rewards whose validity has elapsed (valid_until earlier than `now`), oldest first. */
export async function findGrantedPastValidity(now: string, limit: number): Promise<UserReward[]> {
  const records = await db(TABLE)
    .where({ status: 'GRANTED' })
    .whereNotNull('valid_until')
    .andWhere('valid_until', '<', now)
    .orderBy('valid_until', 'asc')
    .limit(limit);
  return records.map(mapToEntity);
}

/** Every reward whose ride is running (status ENTERED). */
export async function findEntered(): Promise<UserReward[]> {
  const records = await db(TABLE).where({ status: 'ENTERED' }).orderBy('created_at', 'asc');
  return records.map(mapToEntity);
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
    brandId: (record.brand_id as string | undefined) ?? 'default',
    userId: record.user_id as string,
    profileVersionId: record.profile_version_id as string,
    status: record.status as UserRewardStatus,
    startTime: record.start_time as string,
    endTime: record.end_time as string,
    seed: record.seed as string,
    betId: record.bet_id as string | null,
    ticketSnapshot: snapshot as Record<string, unknown> | null,
    optedInAt: record.opted_in_at as string | null,
    validUntil: (record.valid_until as string | null | undefined) ?? null,
    stakeMinor: parseMinorUnits(record.stake_minor),
    currency: (record.currency as string | null | undefined) ?? null,
    bonusCapMinor: parseMinorUnits(record.bonus_cap_minor),
    replacesRewardId: (record.replaces_reward_id as string | null | undefined) ?? null,
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
  findGrantedPastValidity,
  findEntered,
  markExpired,
};
