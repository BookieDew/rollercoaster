import type { EligibilityReasonCode } from './reasonCodes';
import type { RidePathPoint, MaximumModel } from './ride';

export interface Selection {
  id: string;
  odds: number;
  name?: string;
  market?: string;
  event?: string;
  selection_type?: 'STANDARD' | 'SGP_COMPOSITE' | 'SGP_LEG';
  sgp_group_id?: string;
  eligible?: boolean;
  ineligible_reason?: string;
}

export interface Ticket {
  selections: Selection[];
  stake?: number;
}

export interface QuoteRequest {
  user_id: string;
  reward_id: string;
  bet_id: string;
}

export interface BoostModelReport {
  selection_weight: number;
  odds_weight: number;
  max_eligibility_exponent: number;
  effective_min_floor_rate: number;
  selection_ratio: number | null;
  odds_ratio: number | null;
  eligibility_factor: number;
}

export interface QuoteResponse {
  eligible: boolean;
  reason_code: EligibilityReasonCode;
  qualifying_selection_count: number;
  total_selection_count: number;
  combined_odds: number;
  current_boost_pct: number | null;
  effective_min_boost_pct: number | null;
  effective_max_boost_pct: number | null;
  theoretical_max_boost_pct: number | null;
  maximum_model?: MaximumModel;
  ticket_strength: number | null;
  boost_model?: BoostModelReport | null;
  /** Authoritative elapsed sample offset in seconds; does not reveal ride duration. */
  ride_elapsed_seconds?: number | null;
  ride_end_at_offset_seconds?: number | null;
  ride_crash_at_offset_seconds?: number | null;
  ride_path?: RidePathPoint[];
}

export interface QualifyingResult {
  qualifyingSelections: Selection[];
  disqualifiedSelections: Selection[];
  combinedOdds: number;
}
