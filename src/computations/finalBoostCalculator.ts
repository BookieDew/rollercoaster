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

export interface FinalBoostDetails {
  finalBoostPct: number;
  rawBoost: number;
  effectiveMaxBoost: number;
  minBoost: number;
  isClampedToMax: boolean;
  isClampedToMin: boolean;
  boostModel: BoostModelDetails;
}

export interface BoostModelDetails {
  selectionWeight: number;
  oddsWeight: number;
  maxEligibilityExponent: number;
  effectiveMinFloorRate: number;
  selectionRatio: number | null;
  oddsRatio: number | null;
  eligibilityFactor: number;
  effectiveMinBoost: number;
  effectiveMaxBoost: number;
}

const MAX_ELIGIBILITY_EXPONENT = 1.2;
const MAX_ELIGIBILITY_SELECTION_WEIGHT = 0.75;
const MAX_ELIGIBILITY_ODDS_WEIGHT = 0.25;
const EFFECTIVE_MIN_FLOOR_RATE = 0.35;

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
  return calculateFinalBoostDetails(input).finalBoostPct;
}

export function calculateFinalBoostDetails(input: FinalBoostInput): FinalBoostDetails {
  const {
    rideValue,
    ticketStrength,
    qualifyingSelections,
    combinedOdds,
    hasRideEnded,
    config,
  } = input;

  const boostModel = computeBoostModelDetails(
    qualifyingSelections,
    combinedOdds,
    config
  );
  const effectiveMinBoost = boostModel.effectiveMinBoost;
  const effectiveMaxBoost = boostModel.effectiveMaxBoost;

  // Crash to zero if ride has ended
  if (hasRideEnded) {
    return {
      finalBoostPct: 0,
      rawBoost: 0,
      effectiveMaxBoost,
      minBoost: effectiveMinBoost,
      isClampedToMax: false,
      isClampedToMin: false,
      boostModel,
    };
  }

  const midPoint = (effectiveMinBoost + effectiveMaxBoost) / 2;
  const volatilityMultiplier = 0.5 + ticketStrength * 0.8; // 0.5..1.3
  const adjustedRideValue = midPoint + (rideValue - midPoint) * volatilityMultiplier;

  // Strength multiplier keeps low-strength tickets from hitting max
  const strengthMultiplier = 0.4 + ticketStrength * 0.6; // 0.4..1.0
  const rawBoost = adjustedRideValue * strengthMultiplier;

  // Clamp to operator min/max bounds
  const clampedBoost = clampValue(rawBoost, effectiveMinBoost, effectiveMaxBoost);

  return {
    finalBoostPct: roundToDecimals(clampedBoost, 6),
    rawBoost,
    effectiveMaxBoost,
    minBoost: effectiveMinBoost,
    isClampedToMax: rawBoost > effectiveMaxBoost,
    isClampedToMin: rawBoost < effectiveMinBoost,
    boostModel,
  };
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
  return computeBoostModelDetails(
    qualifyingSelections,
    combinedOdds,
    config
  ).effectiveMaxBoost;
}

export function computeBoostModelDetails(
  qualifyingSelections: number,
  combinedOdds: number,
  config: FinalBoostConfig
): BoostModelDetails {
  const selectionTarget = config.maxBoostMinSelections ?? 0;
  const oddsTarget = config.maxBoostMinCombinedOdds ?? 0;
  const hasSelectionTarget = selectionTarget > 0;
  const hasOddsTarget = oddsTarget > 0;
  const hasAnyTarget = hasSelectionTarget || hasOddsTarget;

  const selectionRatio = hasSelectionTarget
    ? Math.max(0, Math.min(qualifyingSelections / selectionTarget, 1))
    : null;
  const oddsRatio = hasOddsTarget
    ? Math.max(0, Math.min(combinedOdds / oddsTarget, 1))
    : null;

  let eligibilityFactor: number;
  if (!hasAnyTarget) {
    eligibilityFactor = 1;
  } else if (hasSelectionTarget && hasOddsTarget) {
    // With both thresholds present, bias max-boost discovery toward selections (75/25).
    const selectionComponent = Math.pow(selectionRatio!, MAX_ELIGIBILITY_EXPONENT);
    const oddsComponent = Math.pow(oddsRatio!, MAX_ELIGIBILITY_EXPONENT);
    eligibilityFactor = Math.min(
      1,
      Math.pow(selectionComponent, MAX_ELIGIBILITY_SELECTION_WEIGHT)
        * Math.pow(oddsComponent, MAX_ELIGIBILITY_ODDS_WEIGHT)
    );
  } else if (hasSelectionTarget) {
    // If only one threshold is configured, it should fully drive the cap.
    eligibilityFactor = Math.pow(selectionRatio!, MAX_ELIGIBILITY_EXPONENT);
  } else {
    eligibilityFactor = Math.pow(oddsRatio!, MAX_ELIGIBILITY_EXPONENT);
  }

  const minBoost = config.minBoostPct;
  const effectiveMax = config.minBoostPct
    + (config.maxBoostPct - config.minBoostPct) * eligibilityFactor;
  const boundedMax = Math.max(minBoost, effectiveMax);
  const floorLiftFactor = hasAnyTarget
    ? (eligibilityFactor * EFFECTIVE_MIN_FLOOR_RATE)
    : 0;
  const effectiveMin = minBoost + ((boundedMax - minBoost) * floorLiftFactor);
  const boundedMin = clampValue(effectiveMin, minBoost, boundedMax);

  return {
    selectionWeight: MAX_ELIGIBILITY_SELECTION_WEIGHT,
    oddsWeight: MAX_ELIGIBILITY_ODDS_WEIGHT,
    maxEligibilityExponent: MAX_ELIGIBILITY_EXPONENT,
    effectiveMinFloorRate: EFFECTIVE_MIN_FLOOR_RATE,
    selectionRatio: selectionRatio === null ? null : roundToDecimals(selectionRatio, 6),
    oddsRatio: oddsRatio === null ? null : roundToDecimals(oddsRatio, 6),
    eligibilityFactor: roundToDecimals(eligibilityFactor, 6),
    effectiveMinBoost: roundToDecimals(boundedMin, 6),
    effectiveMaxBoost: roundToDecimals(boundedMax, 6),
  };
}

export function getBoostModelConstants(): {
  selectionWeight: number;
  oddsWeight: number;
  maxEligibilityExponent: number;
  effectiveMinFloorRate: number;
} {
  return {
    selectionWeight: MAX_ELIGIBILITY_SELECTION_WEIGHT,
    oddsWeight: MAX_ELIGIBILITY_ODDS_WEIGHT,
    maxEligibilityExponent: MAX_ELIGIBILITY_EXPONENT,
    effectiveMinFloorRate: EFFECTIVE_MIN_FLOOR_RATE,
  };
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
