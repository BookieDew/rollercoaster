import type { Selection } from '../types/ticket';

/**
 * Calculates combined (multiplied) odds from an array of qualifying selections.
 * For parlay/combo bets, the combined odds is the product of all individual odds.
 *
 * @param selections - Array of qualifying selections
 * @returns Combined odds (product of all selection odds)
 */
export function calculateCombinedOdds(selections: Selection[]): number {
  if (selections.length === 0) {
    return 0;
  }

  return selections.reduce((product, selection) => product * selection.odds, 1);
}

/**
 * Checks if combined odds meets the minimum threshold.
 *
 * @param combinedOdds - The calculated combined odds
 * @param minCombinedOdds - Minimum required combined odds
 * @returns True if the combined odds meets or exceeds the minimum
 */
export function meetsCombinedOddsThreshold(
  combinedOdds: number,
  minCombinedOdds: number
): boolean {
  return combinedOdds >= minCombinedOdds;
}

/**
 * Rounds combined odds to a specified number of decimal places.
 *
 * @param odds - The odds value to round
 * @param decimals - Number of decimal places (default: 4)
 * @returns Rounded odds value
 */
export function roundOdds(odds: number, decimals = 4): number {
  const factor = Math.pow(10, decimals);
  return Math.round(odds * factor) / factor;
}
