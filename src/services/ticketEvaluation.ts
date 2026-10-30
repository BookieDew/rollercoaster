import {
  filterQualifyingSelections,
  meetsMinSelectionCount,
  calculateCombinedOddsExact,
  meetsCombinedOddsThreshold,
  computeTicketStrength,
  computeBoostModelDetails,
  type BoostModelDetails,
} from '../computations';
import { toDecimalString, toDisplayNumber, type ExactDecimal } from '../computations/v4';
import type { BoostModelReport, Selection } from '../types/ticket';
import type { RideMathProfile } from '../types/ride';
import { ReasonCode } from '../types/reasonCodes';

export type TicketReason =
  | ReasonCode.ELIGIBLE
  | ReasonCode.MIN_SELECTIONS_NOT_MET
  | ReasonCode.MIN_COMBINED_ODDS_NOT_MET;

/** Profile fields the ticket evaluation reads. */
export type TicketProfile = Omit<RideMathProfile, 'id' | 'rideMode'>;

export interface TicketEvaluation {
  qualifying: Selection[];
  disqualified: Selection[];
  /** Exact product of the qualifying odds (0 when none qualify). */
  combinedOdds: ExactDecimal;
  /** Exact decimal string of combinedOdds. */
  combinedOddsExact: string;
  /** Response form: the nearest double, or the exact string beyond the double range. */
  combinedOddsDisplay: number | string;
  ticketStrength: number;
  boostModel: BoostModelDetails;
  reason: TicketReason;
}

/**
 * Qualifying filter, exact combined odds, eligibility against the profile minimums (exact comparison,
 * no float product), ticket strength and the ticket-adjusted floor/cap. Pure.
 */
export function evaluateTicket(selections: Selection[], profile: TicketProfile): TicketEvaluation {
  const { qualifying, disqualified } = filterQualifyingSelections(selections, profile.minSelectionOdds);
  const combinedOdds = calculateCombinedOddsExact(qualifying);
  const ticketStrength = computeTicketStrength(qualifying.length, combinedOdds, {
    minSelections: profile.minSelections,
  });
  const boostModel = computeBoostModelDetails(qualifying.length, combinedOdds, {
    minBoostPct: profile.minBoostPct,
    maxBoostPct: profile.maxBoostPct,
    maxBoostMinSelections: profile.maxBoostMinSelections,
    maxBoostMinCombinedOdds: profile.maxBoostMinCombinedOdds,
    maxEligibilitySelectionWeight: profile.maxEligibilitySelectionWeight,
    maxEligibilityOddsWeight: profile.maxEligibilityOddsWeight,
    effectiveMinFloorRate: profile.effectiveMinFloorRate,
  });
  const reason: TicketReason = !meetsMinSelectionCount(qualifying.length, profile.minSelections)
    ? ReasonCode.MIN_SELECTIONS_NOT_MET
    : !meetsCombinedOddsThreshold(combinedOdds, profile.minCombinedOdds)
      ? ReasonCode.MIN_COMBINED_ODDS_NOT_MET
      : ReasonCode.ELIGIBLE;
  return {
    qualifying,
    disqualified,
    combinedOdds,
    combinedOddsExact: toDecimalString(combinedOdds),
    combinedOddsDisplay: toDisplayNumber(combinedOdds),
    ticketStrength,
    boostModel,
    reason,
  };
}

/** Human-readable combined odds for error messages (2 dp, or the exact string beyond the double range). */
export function describeOdds(evaluation: TicketEvaluation): string {
  const display = evaluation.combinedOddsDisplay;
  return typeof display === 'number' ? display.toFixed(2) : display;
}

export function toBoostModelReport(details: BoostModelDetails): BoostModelReport {
  return {
    selection_weight: details.selectionWeight,
    odds_weight: details.oddsWeight,
    max_eligibility_exponent: details.maxEligibilityExponent,
    effective_min_floor_rate: details.effectiveMinFloorRate,
    selection_ratio: details.selectionRatio,
    odds_ratio: details.oddsRatio,
    eligibility_factor: details.eligibilityFactor,
  };
}
