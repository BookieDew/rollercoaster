import type { Selection } from '../types/ticket';
import {
  combinedOddsExact,
  exactFromNumber,
  meetsExactTarget,
  type ExactDecimal,
} from './v4/exactOdds';

/**
 * Combined (multiplied) odds of the qualifying selections, exact (V4, contract §4): each leg is read
 * as an integer count of 10^-6 and the product is a BigInt, so no float product is ever formed and
 * 100 legs at 10,000 stay exact. No selections give 0.
 */
export function calculateCombinedOddsExact(selections: Selection[]): ExactDecimal {
  return combinedOddsExact(selections.map((selection) => selection.odds));
}

/** True when the exact combined odds are at or above the profile minimum (exact comparison). */
export function meetsCombinedOddsThreshold(
  combinedOdds: ExactDecimal,
  minCombinedOdds: number
): boolean {
  return meetsExactTarget(combinedOdds, exactFromNumber(minCombinedOdds));
}

/**
 * Rounds odds to a number of decimal places (display helper).
 *
 * @param odds - The odds value to round
 * @param decimals - Number of decimal places (default: 4)
 */
export function roundOdds(odds: number, decimals = 4): number {
  const factor = Math.pow(10, decimals);
  return Math.round(odds * factor) / factor;
}
