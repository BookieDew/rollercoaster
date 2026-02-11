export type RideMode = 'WAVES' | 'LINEAR';

export interface RewardProfileVersion {
  id: string;
  name: string;
  description: string | null;
  minSelections: number;
  minCombinedOdds: number;
  minSelectionOdds: number;
  minBoostPct: number;
  maxBoostPct: number;
  maxBoostMinSelections: number | null;
  maxBoostMinCombinedOdds: number | null;
  maxEligibilitySelectionWeight: number;
  maxEligibilityOddsWeight: number;
  effectiveMinFloorRate: number;
  rideMode: RideMode;
  rideDurationSeconds: number;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CreateRewardProfileInput {
  name: string;
  description?: string;
  minSelections: number;
  minCombinedOdds: number;
  minSelectionOdds: number;
  minBoostPct: number;
  maxBoostPct: number;
  maxBoostMinSelections?: number | null;
  maxBoostMinCombinedOdds?: number | null;
  maxEligibilitySelectionWeight?: number;
  maxEligibilityOddsWeight?: number;
  effectiveMinFloorRate?: number;
  rideMode?: RideMode;
  rideDurationSeconds: number;
}

export interface UpdateRewardProfileInput {
  name?: string;
  description?: string;
  minSelections?: number;
  minCombinedOdds?: number;
  minSelectionOdds?: number;
  minBoostPct?: number;
  maxBoostPct?: number;
  maxBoostMinSelections?: number | null;
  maxBoostMinCombinedOdds?: number | null;
  maxEligibilitySelectionWeight?: number;
  maxEligibilityOddsWeight?: number;
  effectiveMinFloorRate?: number;
  rideMode?: RideMode;
  rideDurationSeconds?: number;
  isActive?: boolean;
}

export interface RewardProfileDTO {
  id: string;
  name: string;
  description: string | null;
  min_selections: number;
  min_combined_odds: number;
  min_selection_odds: number;
  min_boost_pct: number;
  max_boost_pct: number;
  max_boost_min_selections: number | null;
  max_boost_min_combined_odds: number | null;
  max_eligibility_selection_weight: number;
  max_eligibility_odds_weight: number;
  effective_min_floor_rate: number;
  ride_mode: RideMode;
  ride_duration_seconds: number;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export function toDTO(profile: RewardProfileVersion): RewardProfileDTO {
  return {
    id: profile.id,
    name: profile.name,
    description: profile.description,
    min_selections: profile.minSelections,
    min_combined_odds: profile.minCombinedOdds,
    min_selection_odds: profile.minSelectionOdds,
    min_boost_pct: profile.minBoostPct,
    max_boost_pct: profile.maxBoostPct,
    max_boost_min_selections: profile.maxBoostMinSelections,
    max_boost_min_combined_odds: profile.maxBoostMinCombinedOdds,
    max_eligibility_selection_weight: profile.maxEligibilitySelectionWeight,
    max_eligibility_odds_weight: profile.maxEligibilityOddsWeight,
    effective_min_floor_rate: profile.effectiveMinFloorRate,
    ride_mode: profile.rideMode,
    ride_duration_seconds: profile.rideDurationSeconds,
    is_active: profile.isActive,
    created_at: profile.createdAt,
    updated_at: profile.updatedAt,
  };
}
