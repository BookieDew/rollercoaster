import type { EligibilityReasonCode } from './reasonCodes';
import type { RidePathPoint } from './ride';

export interface Selection {
  id: string;
  odds: number;
  name?: string;
  market?: string;
  event?: string;
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

export interface QuoteResponse {
  eligible: boolean;
  reason_code: EligibilityReasonCode;
  qualifying_selection_count: number;
  total_selection_count: number;
  combined_odds: number;
  current_boost_pct: number | null;
  theoretical_max_boost_pct: number | null;
  ticket_strength: number | null;
  ride_end_at_offset_seconds?: number | null;
  ride_crash_at_offset_seconds?: number | null;
  ride_path?: RidePathPoint[];
}

export interface QualifyingResult {
  qualifyingSelections: Selection[];
  disqualifiedSelections: Selection[];
  combinedOdds: number;
}
