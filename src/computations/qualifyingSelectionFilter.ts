import type { Selection } from '../types/ticket';

export interface FilterResult {
  qualifying: Selection[];
  disqualified: Selection[];
}

const AUTO_DISQUALIFY_REASON_SGP_LEG = 'SGP_LEG_COMPONENT';
const AUTO_DISQUALIFY_REASON_DUPLICATE_SGP = 'DUPLICATE_SGP_COMPOSITE';

function disqualifyWithReason(selection: Selection, reason: string): Selection {
  if (selection.ineligible_reason) {
    return selection;
  }
  return {
    ...selection,
    eligible: false,
    ineligible_reason: reason,
  };
}

/**
 * Filters selections by minimum odds threshold.
 * Returns only qualifying selections that count toward boost eligibility.
 *
 * @param selections - Array of bet selections to filter
 * @param minSelectionOdds - Minimum odds threshold for a selection to qualify
 * @returns Object containing qualifying and disqualified selections
 */
export function filterQualifyingSelections(
  selections: Selection[],
  minSelectionOdds: number
): FilterResult {
  const qualifying: Selection[] = [];
  const disqualified: Selection[] = [];
  const seenSgpCompositeGroups = new Set<string>();

  for (const selection of selections) {
    const selectionType = selection.selection_type ?? 'STANDARD';

    if (selection.eligible === false || Boolean(selection.ineligible_reason)) {
      disqualified.push(selection);
      continue;
    }

    if (selectionType === 'SGP_LEG') {
      disqualified.push(disqualifyWithReason(selection, AUTO_DISQUALIFY_REASON_SGP_LEG));
      continue;
    }

    if (selectionType === 'SGP_COMPOSITE' && selection.sgp_group_id) {
      if (seenSgpCompositeGroups.has(selection.sgp_group_id)) {
        disqualified.push(disqualifyWithReason(selection, AUTO_DISQUALIFY_REASON_DUPLICATE_SGP));
        continue;
      }
      seenSgpCompositeGroups.add(selection.sgp_group_id);
    }

    if (selection.odds >= minSelectionOdds) {
      qualifying.push(selection);
    } else {
      disqualified.push(selection);
    }
  }

  return { qualifying, disqualified };
}

/**
 * Checks if the ticket meets the minimum selection count requirement.
 *
 * @param qualifyingCount - Number of qualifying selections
 * @param minSelections - Minimum required qualifying selections
 * @returns True if requirement is met
 */
export function meetsMinSelectionCount(
  qualifyingCount: number,
  minSelections: number
): boolean {
  return qualifyingCount >= minSelections;
}
