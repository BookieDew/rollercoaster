import db from '../connection';
import { v4 as uuidv4 } from 'uuid';
import type { RewardProfileVersion, CreateRewardProfileInput, UpdateRewardProfileInput } from '../../types/rewardProfile';

const TABLE = 'reward_profile_versions';
const INTERNAL_CHECKPOINT_COUNT = 12;
const INTERNAL_VOLATILITY = 0.5;
const DEFAULT_MAX_ELIGIBILITY_SELECTION_WEIGHT = 0.75;
const DEFAULT_MAX_ELIGIBILITY_ODDS_WEIGHT = 0.25;
const DEFAULT_EFFECTIVE_MIN_FLOOR_RATE = 0.35;
const DEFAULT_RIDE_MODE = 'WAVES';

export async function create(input: CreateRewardProfileInput): Promise<RewardProfileVersion> {
  const id = uuidv4();
  const now = new Date().toISOString();

  const record = {
    id,
    name: input.name,
    description: input.description ?? null,
    min_selections: input.minSelections,
    min_combined_odds: input.minCombinedOdds,
    min_selection_odds: input.minSelectionOdds,
    min_boost_pct: input.minBoostPct,
    max_boost_pct: input.maxBoostPct,
    max_boost_min_selections: input.maxBoostMinSelections ?? null,
    max_boost_min_combined_odds: input.maxBoostMinCombinedOdds ?? null,
    max_eligibility_selection_weight: input.maxEligibilitySelectionWeight
      ?? DEFAULT_MAX_ELIGIBILITY_SELECTION_WEIGHT,
    max_eligibility_odds_weight: input.maxEligibilityOddsWeight
      ?? DEFAULT_MAX_ELIGIBILITY_ODDS_WEIGHT,
    effective_min_floor_rate: input.effectiveMinFloorRate
      ?? DEFAULT_EFFECTIVE_MIN_FLOOR_RATE,
    ride_mode: input.rideMode ?? DEFAULT_RIDE_MODE,
    ride_duration_seconds: input.rideDurationSeconds,
    checkpoint_count: INTERNAL_CHECKPOINT_COUNT,
    volatility: INTERNAL_VOLATILITY,
    is_active: true,
    created_at: now,
    updated_at: now,
  };

  await db(TABLE).insert(record);
  return mapToEntity(record);
}

export async function findById(id: string): Promise<RewardProfileVersion | null> {
  const record = await db(TABLE).where({ id }).first();
  return record ? mapToEntity(record) : null;
}

export async function findActive(): Promise<RewardProfileVersion[]> {
  const records = await db(TABLE).where({ is_active: true }).orderBy('created_at', 'desc');
  return records.map(mapToEntity);
}

export async function findAll(): Promise<RewardProfileVersion[]> {
  const records = await db(TABLE).orderBy('created_at', 'desc');
  return records.map(mapToEntity);
}

export async function update(id: string, input: UpdateRewardProfileInput): Promise<RewardProfileVersion | null> {
  const existing = await findById(id);
  if (!existing) return null;

  const updates: Record<string, unknown> = {
    updated_at: new Date().toISOString(),
  };

  if (input.name !== undefined) updates.name = input.name;
  if (input.description !== undefined) updates.description = input.description;
  if (input.minSelections !== undefined) updates.min_selections = input.minSelections;
  if (input.minCombinedOdds !== undefined) updates.min_combined_odds = input.minCombinedOdds;
  if (input.minSelectionOdds !== undefined) updates.min_selection_odds = input.minSelectionOdds;
  if (input.minBoostPct !== undefined) updates.min_boost_pct = input.minBoostPct;
  if (input.maxBoostPct !== undefined) updates.max_boost_pct = input.maxBoostPct;
  if (input.maxBoostMinSelections !== undefined) {
    updates.max_boost_min_selections = input.maxBoostMinSelections;
  }
  if (input.maxBoostMinCombinedOdds !== undefined) {
    updates.max_boost_min_combined_odds = input.maxBoostMinCombinedOdds;
  }
  if (input.maxEligibilitySelectionWeight !== undefined) {
    updates.max_eligibility_selection_weight = input.maxEligibilitySelectionWeight;
  }
  if (input.maxEligibilityOddsWeight !== undefined) {
    updates.max_eligibility_odds_weight = input.maxEligibilityOddsWeight;
  }
  if (input.effectiveMinFloorRate !== undefined) {
    updates.effective_min_floor_rate = input.effectiveMinFloorRate;
  }
  if (input.rideMode !== undefined) {
    updates.ride_mode = input.rideMode;
  }
  if (input.rideDurationSeconds !== undefined) updates.ride_duration_seconds = input.rideDurationSeconds;
  if (input.isActive !== undefined) updates.is_active = input.isActive;

  await db(TABLE).where({ id }).update(updates);
  return findById(id);
}

export async function remove(id: string): Promise<boolean> {
  const deleted = await db(TABLE).where({ id }).del();
  return deleted > 0;
}

function mapToEntity(record: Record<string, unknown>): RewardProfileVersion {
  return {
    id: record.id as string,
    name: record.name as string,
    description: record.description as string | null,
    minSelections: record.min_selections as number,
    minCombinedOdds: Number(record.min_combined_odds),
    minSelectionOdds: Number(record.min_selection_odds),
    minBoostPct: Number(record.min_boost_pct),
    maxBoostPct: Number(record.max_boost_pct),
    maxBoostMinSelections: record.max_boost_min_selections === null
      ? null
      : Number(record.max_boost_min_selections),
    maxBoostMinCombinedOdds: record.max_boost_min_combined_odds === null
      ? null
      : Number(record.max_boost_min_combined_odds),
    maxEligibilitySelectionWeight: record.max_eligibility_selection_weight === undefined
      ? DEFAULT_MAX_ELIGIBILITY_SELECTION_WEIGHT
      : Number(record.max_eligibility_selection_weight),
    maxEligibilityOddsWeight: record.max_eligibility_odds_weight === undefined
      ? DEFAULT_MAX_ELIGIBILITY_ODDS_WEIGHT
      : Number(record.max_eligibility_odds_weight),
    effectiveMinFloorRate: record.effective_min_floor_rate === undefined
      ? DEFAULT_EFFECTIVE_MIN_FLOOR_RATE
      : Number(record.effective_min_floor_rate),
    rideMode: record.ride_mode === undefined
      ? DEFAULT_RIDE_MODE
      : record.ride_mode as 'WAVES' | 'LINEAR',
    rideDurationSeconds: record.ride_duration_seconds as number,
    isActive: Boolean(record.is_active),
    createdAt: record.created_at as string,
    updatedAt: record.updated_at as string,
  };
}

export const rewardProfileRepository = {
  create,
  findById,
  findActive,
  findAll,
  update,
  remove,
};
