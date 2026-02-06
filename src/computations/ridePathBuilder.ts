import type { RidePathPoint } from '../types/ride';
import { interpolateRideValue } from './deterministicRideGenerator';
import {
  calculateFinalBoostDetails,
  type FinalBoostConfig,
  type FinalBoostDetails,
} from './finalBoostCalculator';

export function buildEffectiveRidePath(
  checkpoints: { checkpointIndex: number; timeOffsetPct: number; baseBoostValue: number }[],
  sampleCount: number,
  crashPct: number,
  ticketStrength: number,
  config: FinalBoostConfig,
  qualifyingSelections: number,
  combinedOdds: number
): RidePathPoint[] {
  if (!checkpoints.length || sampleCount < 2) {
    return [];
  }

  const normalizedCheckpoints = checkpoints.map((cp) => ({
    index: cp.checkpointIndex,
    timeOffsetPct: cp.timeOffsetPct,
    baseBoostValue: cp.baseBoostValue,
  }));

  const points: RidePathPoint[] = [];
  for (let i = 0; i < sampleCount; i++) {
    const timePct = i / (sampleCount - 1);
    const baseRideValue = timePct >= crashPct
      ? 0
      : interpolateRideValue(normalizedCheckpoints, timePct);
    const effectiveBoost = timePct >= crashPct
      ? 0
      : buildDisplayBoost(
          calculateFinalBoostDetails({
            rideValue: baseRideValue,
            ticketStrength,
            qualifyingSelections,
            combinedOdds,
            hasRideEnded: false,
            config,
          }),
          i
        );
    points.push({ timePct, baseBoostValue: effectiveBoost });
  }

  return points;
}

function buildDisplayBoost(details: FinalBoostDetails, pointIndex: number): number {
  if (!details.isClampedToMax) {
    return details.finalBoostPct;
  }

  const capRange = Math.max(details.effectiveMaxBoost - details.minBoost, 0);
  if (capRange <= 0) {
    return details.finalBoostPct;
  }

  // Compress cap plateaus so top sections still show motion tied to overshoot magnitude.
  const overshoot = Math.max(details.rawBoost - details.effectiveMaxBoost, 0);
  const overshootScale = Math.max(capRange * 0.5, 0.0005);
  const capHeadroom = Math.max(capRange * 0.12, 0.0005);
  const compression = (1 - Math.exp(-overshoot / overshootScale)) * capHeadroom;
  const tieBreaker = (pointIndex % 2 === 0 ? 1 : -1) * 0.000001;

  const display = details.effectiveMaxBoost - compression + tieBreaker;
  const bounded = Math.max(details.minBoost, Math.min(details.effectiveMaxBoost, display));
  return roundToDecimals(bounded, 6);
}

function roundToDecimals(value: number, decimals: number): number {
  const factor = Math.pow(10, decimals);
  return Math.round(value * factor) / factor;
}
