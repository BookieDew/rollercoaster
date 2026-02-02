export interface FinalBoostConfig {
  minBoostPct: number;
  maxBoostPct: number;
  maxBoostMinSelections: number | null;
  maxBoostMinCombinedOdds: number | null;
}

export interface FinalBoostInput {
  rideValue: number;
  ticketStrength: number;
  qualifyingSelections: number;
  combinedOdds: number;
  hasRideEnded: boolean;
  config: FinalBoostConfig;
}

/**
 * Combines ride value with ticket strength, clamps to operator min/max caps,
 * and applies crash-to-zero override if ride has ended.
 *
 * The final boost is calculated by:
 * 1) Adjusting ride amplitude based on ticket strength (higher strength = more volatility)
 * 2) Applying a strength multiplier so weaker tickets rarely reach max boost
 *
 * @param input - Input parameters for final boost calculation
 * @returns Final boost percentage (0 if ride ended)
 */
export function calculateFinalBoost(input: FinalBoostInput): number {
  const {
    rideValue,
    ticketStrength,
    qualifyingSelections,
    combinedOdds,
    hasRideEnded,
    config,
  } = input;

  // Crash to zero if ride has ended
  if (hasRideEnded) {
    return 0;
  }

  const effectiveMaxBoost = computeMaxEligibleBoostPct(
    qualifyingSelections,
    combinedOdds,
    config
  );
  const midPoint = (config.minBoostPct + effectiveMaxBoost) / 2;
  const volatilityMultiplier = 0.5 + ticketStrength * 0.8; // 0.5..1.3
  const adjustedRideValue = midPoint + (rideValue - midPoint) * volatilityMultiplier;

  // Strength multiplier keeps low-strength tickets from hitting max
  const strengthMultiplier = 0.4 + ticketStrength * 0.6; // 0.4..1.0
  const rawBoost = adjustedRideValue * strengthMultiplier;

  // Clamp to operator min/max bounds
  const clampedBoost = clampValue(rawBoost, config.minBoostPct, effectiveMaxBoost);

  return roundToDecimals(clampedBoost, 6);
}

/**
 * Computes the maximum eligible boost for this ticket based on max-boost thresholds.
 * When thresholds are met or exceeded, the effective max equals config.maxBoostPct.
 * Otherwise, the max is scaled down using a convex factor.
 */
export function computeMaxEligibleBoostPct(
  qualifyingSelections: number,
  combinedOdds: number,
  config: FinalBoostConfig
): number {
  const selectionTarget = config.maxBoostMinSelections ?? 0;
  const oddsTarget = config.maxBoostMinCombinedOdds ?? 0;

  if (selectionTarget <= 0 && oddsTarget <= 0) {
    return config.maxBoostPct;
  }

  const selectionRatio = selectionTarget > 0
    ? Math.max(0, Math.min(qualifyingSelections / selectionTarget, 1))
    : 1;
  const oddsRatio = oddsTarget > 0
    ? Math.max(0, Math.min(combinedOdds / oddsTarget, 1))
    : 1;

  const exponent = 1.2;
  const eligibilityFactor = Math.min(
    1,
    Math.pow(selectionRatio, exponent) * Math.pow(oddsRatio, exponent)
  );

  const effectiveMax = config.minBoostPct
    + (config.maxBoostPct - config.minBoostPct) * eligibilityFactor;

  return roundToDecimals(Math.max(config.minBoostPct, effectiveMax), 6);
}

/**
 * Calculates potential bonus amount based on winnings and boost percentage.
 *
 * @param winnings - The winnings amount
 * @param boostPct - The boost percentage (e.g., 0.25 for 25%)
 * @returns Bonus amount
 */
export function calculateBonusAmount(winnings: number, boostPct: number): number {
  if (winnings <= 0 || boostPct <= 0) {
    return 0;
  }
  return roundToDecimals(winnings * boostPct, 4);
}

/**
 * Clamps a value between min and max bounds.
 */
export function clampValue(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * Formats boost as a percentage string for display.
 *
 * @param boostPct - Boost as decimal (e.g., 0.25)
 * @returns Formatted string (e.g., "25%")
 */
export function formatBoostPercentage(boostPct: number): string {
  return `${(boostPct * 100).toFixed(1)}%`;
}

function roundToDecimals(value: number, decimals: number): number {
  const factor = Math.pow(10, decimals);
  return Math.round(value * factor) / factor;
}
