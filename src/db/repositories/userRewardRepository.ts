import db from '../connection';
import { v4 as uuidv4 } from 'uuid';
import type { UserReward, UserRewardStatus, CreateUserRewardInput } from '../../types/userReward';

const TABLE = 'user_rewards';

export async function create(input: CreateUserRewardInput): Promise<UserReward> {
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

  await db(TABLE).insert(record);
  return mapToEntity(record);
}

export async function findById(id: string): Promise<UserReward | null> {
  const record = await db(TABLE).where({ id }).first();
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

export async function updateStatus(id: string, status: UserRewardStatus, optedInAt?: string): Promise<UserReward | null> {
  const updates: Record<string, unknown> = {
    status,
    updated_at: new Date().toISOString(),
  };

  if (optedInAt) {
    updates.opted_in_at = optedInAt;
  }

  await db(TABLE).where({ id }).update(updates);
  return findById(id);
}

export async function updateRideStart(
  id: string,
  startTime: string,
  endTime: string,
  betId: string,
  ticketSnapshot: Record<string, unknown>
): Promise<UserReward | null> {
  const updates: Record<string, unknown> = {
    start_time: startTime,
    end_time: endTime,
    bet_id: betId,
    ticket_snapshot: JSON.stringify(ticketSnapshot),
    updated_at: new Date().toISOString(),
  };

  await db(TABLE).where({ id }).update(updates);
  return findById(id);
}

export async function updateSeed(id: string, seed: string): Promise<UserReward | null> {
  const updates: Record<string, unknown> = {
    seed,
    updated_at: new Date().toISOString(),
  };

  await db(TABLE).where({ id }).update(updates);
  return findById(id);
}

export async function updateEndTime(id: string, endTime: string): Promise<UserReward | null> {
  const updates: Record<string, unknown> = {
    end_time: endTime,
    updated_at: new Date().toISOString(),
  };

  await db(TABLE).where({ id }).update(updates);
  return findById(id);
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
  updateSeed,
  updateEndTime,
  updateRideStart,
  markExpired,
};
