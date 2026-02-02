import db from '../connection';
import { v4 as uuidv4 } from 'uuid';

export interface RideCheckpoint {
  id: string;
  rewardId: string;
  checkpointIndex: number;
  timeOffsetPct: number;
  baseBoostValue: number;
  createdAt: string;
}

export interface CreateRideCheckpointInput {
  rewardId: string;
  checkpointIndex: number;
  timeOffsetPct: number;
  baseBoostValue: number;
}

const TABLE = 'ride_definitions';

export async function createMany(inputs: CreateRideCheckpointInput[]): Promise<RideCheckpoint[]> {
  const now = new Date().toISOString();

  const records = inputs.map((input) => ({
    id: uuidv4(),
    reward_id: input.rewardId,
    checkpoint_index: input.checkpointIndex,
    time_offset_pct: input.timeOffsetPct,
    base_boost_value: input.baseBoostValue,
    created_at: now,
  }));

  await db(TABLE).insert(records);
  return records.map(mapToEntity);
}

export async function findByRewardId(rewardId: string): Promise<RideCheckpoint[]> {
  const records = await db(TABLE)
    .where({ reward_id: rewardId })
    .orderBy('checkpoint_index', 'asc');
  return records.map(mapToEntity);
}

export async function deleteByRewardId(rewardId: string): Promise<number> {
  return db(TABLE).where({ reward_id: rewardId }).del();
}

function mapToEntity(record: Record<string, unknown>): RideCheckpoint {
  return {
    id: record.id as string,
    rewardId: record.reward_id as string,
    checkpointIndex: record.checkpoint_index as number,
    timeOffsetPct: Number(record.time_offset_pct),
    baseBoostValue: Number(record.base_boost_value),
    createdAt: record.created_at as string,
  };
}

export const rideDefinitionRepository = {
  createMany,
  findByRewardId,
  deleteByRewardId,
};
