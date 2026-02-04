import type { Selection } from '../types/ticket';

export interface FilterResult {
  qualifying: Selection[];
  disqualified: Selection[];
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

  for (const selection of selections) {
    if (selection.eligible === false || Boolean(selection.ineligible_reason)) {
      disqualified.push(selection);
      continue;
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
