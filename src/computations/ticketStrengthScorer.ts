/**
 * Computes a non-linear (parabolic/convex) strength factor from qualifying selection count
 * and combined odds. Higher values yield disproportionately higher scores.
 *
 * The formula uses a convex curve that rewards:
 * 1. More qualifying selections
 * 2. Higher combined odds
 *
 * Score = selectionFactor^exponent * oddsFactor^exponent
 *
 * Where:
 * - selectionFactor = (qualifyingCount - minSelections + 1) / normalizer
 * - oddsFactor = log(combinedOdds) / log(baseOdds)
 * - exponent = 1.5 (creates convex/parabolic curve)
 */

export interface TicketStrengthConfig {
  /** Minimum selections required (used for normalization) */
  minSelections: number;
  /** Base odds for logarithmic normalization (default: 3.0) */
  baseOdds?: number;
  /** Exponent for convex curve (default: 1.5) */
  exponent?: number;
  /** Maximum selection bonus factor (default: 10) */
  maxSelectionBonus?: number;
}

/**
 * Computes the ticket strength score using a non-linear convex curve.
 *
 * @param qualifyingCount - Number of qualifying selections
 * @param combinedOdds - Combined odds of qualifying selections
 * @param config - Configuration parameters
 * @returns Ticket strength score (0 to ~1, can exceed 1 for very strong tickets)
 */
export function computeTicketStrength(
  qualifyingCount: number,
  combinedOdds: number,
  config: TicketStrengthConfig
): number {
  const {
    minSelections,
    baseOdds = 3.0,
    exponent = 1.5,
    maxSelectionBonus = 10,
  } = config;

  if (qualifyingCount < minSelections || combinedOdds <= 1) {
    return 0;
  }

  // Selection factor: normalized count above minimum
  // More selections = higher factor, capped at maxSelectionBonus
  const selectionBonus = Math.min(qualifyingCount - minSelections + 1, maxSelectionBonus);
  const selectionFactor = selectionBonus / maxSelectionBonus;

  // Odds factor: logarithmic scaling for combined odds
  // Higher odds = higher factor, using log to prevent extreme values
  const oddsFactor = Math.log(combinedOdds) / Math.log(baseOdds * 100);

  // Combine factors with convex curve (exponent > 1)
  const rawStrength = Math.pow(selectionFactor, exponent) * Math.pow(Math.max(oddsFactor, 0.1), exponent);

  // Normalize to 0-1 range (approximately)
  const normalizedStrength = Math.min(rawStrength, 1);

  return roundToDecimals(normalizedStrength, 6);
}

/**
 * Computes a simple linear ticket strength (for comparison/testing).
 *
 * @param qualifyingCount - Number of qualifying selections
 * @param combinedOdds - Combined odds of qualifying selections
 * @param minSelections - Minimum selections required
 * @returns Linear strength score
 */
export function computeLinearStrength(
  qualifyingCount: number,
  combinedOdds: number,
  minSelections: number
): number {
  if (qualifyingCount < minSelections || combinedOdds <= 1) {
    return 0;
  }

  const selectionScore = (qualifyingCount - minSelections + 1) / 10;
  const oddsScore = Math.log10(combinedOdds) / 4; // log10(10000) = 4

  return roundToDecimals(Math.min(selectionScore * oddsScore, 1), 6);
}

function roundToDecimals(value: number, decimals: number): number {
  const factor = Math.pow(10, decimals);
  return Math.round(value * factor) / factor;
}
