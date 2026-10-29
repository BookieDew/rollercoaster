import { computeTicketStrength } from '../../src/computations/ticketStrengthScorer';
import type { LabConfig, RideMode } from './adapter';

/**
 * One realistic profile (fractions: 0.05 = 5 %, 1 = 100 %): boost 5 %..100 %, a ticket needs 3
 * qualifying selections and combined odds 3.0 to ride, and reaches the full cap at 6 selections
 * and combined odds 20 (default weights .75/.25, floor rate .35).
 * Tickets: weak = minimum ticket (3 sel, odds 3.5); medium = 5 sel, odds 10; strong = 8 sel, odds 60
 * (both cap targets exceeded).
 */
export const PROFILE: LabConfig['profile'] = {
  minBoostPct: 0.05,
  maxBoostPct: 1.0,
  minSelections: 3,
  minCombinedOdds: 3.0,
  maxBoostMinSelections: 6,
  maxBoostMinCombinedOdds: 20,
  maxEligibilitySelectionWeight: 0.75,
  maxEligibilityOddsWeight: 0.25,
  effectiveMinFloorRate: 0.35,
};

export const TICKETS = {
  weak: { qualifyingSelections: 3, combinedOdds: 3.5 },
  medium: { qualifyingSelections: 5, combinedOdds: 10 },
  strong: { qualifyingSelections: 8, combinedOdds: 60 },
} as const;

export function buildConfigs(modes: RideMode[] = ['WAVES', 'LINEAR']): LabConfig[] {
  const out: LabConfig[] = [];
  for (const mode of modes) {
    for (const ticketLabel of ['weak', 'medium', 'strong'] as const) {
      const t = TICKETS[ticketLabel];
      out.push({
        label: `${mode}/${ticketLabel}`,
        mode,
        ticketLabel,
        profile: { ...PROFILE },
        ticket: {
          ...t,
          ticketStrength: computeTicketStrength(t.qualifyingSelections, t.combinedOdds, {
            minSelections: PROFILE.minSelections,
          }),
        },
      });
    }
  }
  return out;
}
