import { LEGACY_BRAND_ID } from './brand';

export type UserRewardStatus = 'GRANTED' | 'ENTERED' | 'EXPIRED' | 'USED';

/**
 * The Phase 1a fields (brandId, validUntil, money snapshot, replacesRewardId) are
 * typed optional only so entities built by code that predates them still
 * type-check. Repositories always populate them; a missing brandId means
 * LEGACY_BRAND_ID and a missing validUntil means no expiry.
 */
export interface UserReward {
  id: string;
  brandId?: string;
  userId: string;
  profileVersionId: string;
  status: UserRewardStatus;
  startTime: string;
  endTime: string;
  seed: string;
  betId: string | null;
  ticketSnapshot: Record<string, unknown> | null;
  optedInAt: string | null;
  /** Reward unusable after this instant (null = no expiry, legacy rows). */
  validUntil?: string | null;
  /** Stake, currency and bonus cap are frozen at opt-in (null before opt-in). */
  stakeMinor?: number | null;
  currency?: string | null;
  bonusCapMinor?: number | null;
  /** Set when this reward replaces a cancelled bet's token. */
  replacesRewardId?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateUserRewardInput {
  brandId: string;
  validUntil?: string | null;
  /** Set for the replacement token of a cancelled bet. */
  replacesRewardId?: string | null;
  userId: string;
  profileVersionId: string;
  startTime: string;
  endTime: string;
  seed: string;
}

export interface UserRewardDTO {
  id: string;
  brand_id: string;
  user_id: string;
  profile_version_id: string;
  status: UserRewardStatus;
  start_time: string;
  /** Null while the reward is still playable (GRANTED/ENTERED): ride length is never a countdown. */
  end_time: string | null;
  opted_in_at: string | null;
  valid_until: string | null;
  bet_id: string | null;
  stake_minor: number | null;
  currency: string | null;
  bonus_cap_minor: number | null;
  replaces_reward_id: string | null;
  created_at: string;
  updated_at: string;
}

/** Ride end is revealed only once the reward can no longer be played. */
export function publicEndTime(reward: Pick<UserReward, 'status' | 'endTime'>): string | null {
  return reward.status === 'USED' || reward.status === 'EXPIRED' ? reward.endTime : null;
}

/** Public reward representation. Never includes the ride seed. */
export function toDTO(reward: UserReward): UserRewardDTO {
  return {
    id: reward.id,
    brand_id: reward.brandId ?? LEGACY_BRAND_ID,
    user_id: reward.userId,
    profile_version_id: reward.profileVersionId,
    status: reward.status,
    start_time: reward.startTime,
    end_time: publicEndTime(reward),
    opted_in_at: reward.optedInAt,
    valid_until: reward.validUntil ?? null,
    bet_id: reward.betId,
    stake_minor: reward.stakeMinor ?? null,
    currency: reward.currency ?? null,
    bonus_cap_minor: reward.bonusCapMinor ?? null,
    replaces_reward_id: reward.replacesRewardId ?? null,
    created_at: reward.createdAt,
    updated_at: reward.updatedAt,
  };
}

export interface GrantRewardRequest {
  user_id: string;
  profile_version_id: string;
  duration_seconds?: number;
}

export interface OptInResponse {
  reward_id: string;
  brand_id: string;
  status: UserRewardStatus;
  ride_started: boolean;
  stake_minor: number | null;
  currency: string | null;
  /** Bonus cap frozen from the profile at opt-in. */
  bonus_cap_minor: number | null;
  /** Always null for a live ride; see publicEndTime. */
  end_time: string | null;
}
