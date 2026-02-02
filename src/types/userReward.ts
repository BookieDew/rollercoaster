export type UserRewardStatus = 'GRANTED' | 'ENTERED' | 'EXPIRED' | 'USED';

export interface UserReward {
  id: string;
  userId: string;
  profileVersionId: string;
  status: UserRewardStatus;
  startTime: string;
  endTime: string;
  seed: string;
  betId: string | null;
  ticketSnapshot: Record<string, unknown> | null;
  optedInAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateUserRewardInput {
  userId: string;
  profileVersionId: string;
  startTime: string;
  endTime: string;
  seed: string;
}

export interface UserRewardDTO {
  id: string;
  user_id: string;
  profile_version_id: string;
  status: UserRewardStatus;
  start_time: string;
  end_time: string;
  opted_in_at: string | null;
  bet_id: string | null;
  created_at: string;
  updated_at: string;
}

export function toDTO(reward: UserReward): UserRewardDTO {
  return {
    id: reward.id,
    user_id: reward.userId,
    profile_version_id: reward.profileVersionId,
    status: reward.status,
    start_time: reward.startTime,
    end_time: reward.endTime,
    opted_in_at: reward.optedInAt,
    bet_id: reward.betId,
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
  status: UserRewardStatus;
  ride_started: boolean;
  end_time: string;
}
