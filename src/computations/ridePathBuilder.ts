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

  const precomputed: {
    timePct: number;
    details: FinalBoostDetails;
  }[] = [];

  let maxOvershoot = 0;
  let maxUndershoot = 0;

  for (let i = 0; i < sampleCount; i++) {
    const timePct = i / (sampleCount - 1);
    const baseRideValue = timePct >= crashPct
      ? 0
      : interpolateRideValue(normalizedCheckpoints, timePct);
    const details = calculateFinalBoostDetails({
      rideValue: baseRideValue,
      ticketStrength,
      qualifyingSelections,
      combinedOdds,
      hasRideEnded: false,
      config,
    });

    if (timePct < crashPct && details.isClampedToMax) {
      maxOvershoot = Math.max(maxOvershoot, Math.max(details.rawBoost - details.effectiveMaxBoost, 0));
    }
    if (timePct < crashPct && details.isClampedToMin) {
      maxUndershoot = Math.max(maxUndershoot, Math.max(details.minBoost - details.rawBoost, 0));
    }

    precomputed.push({ timePct, details });
  }

  const points: RidePathPoint[] = [];
  for (let i = 0; i < precomputed.length; i++) {
    const { timePct, details } = precomputed[i];
    const effectiveBoost = timePct >= crashPct
      ? 0
      : buildDisplayBoost(details, maxOvershoot, maxUndershoot);
    points.push({ timePct, baseBoostValue: effectiveBoost });
  }

  return points;
}

function buildDisplayBoost(
  details: FinalBoostDetails,
  maxOvershoot: number,
  maxUndershoot: number
): number {
  if (!details.isClampedToMax && !details.isClampedToMin) {
    return details.finalBoostPct;
  }

  const capRange = Math.max(details.effectiveMaxBoost - details.minBoost, 0);
  if (capRange <= 0) {
    return details.finalBoostPct;
  }

  if (details.isClampedToMax) {
    const overshoot = Math.max(details.rawBoost - details.effectiveMaxBoost, 0);
    if (maxOvershoot <= 0 || overshoot <= 0) {
      return details.finalBoostPct;
    }

    // Map overshoot proportionally into cap headroom so clamped regions still preserve wave shape.
    const capHeadroom = Math.max(capRange * 0.35, 0.001);
    const normalizedOvershoot = clampValue(overshoot / maxOvershoot, 0, 1);
    const normalizedDisplay = Math.pow(normalizedOvershoot, 0.65);
    const display = (
      details.effectiveMaxBoost
      - capHeadroom
      + (normalizedDisplay * capHeadroom)
    );
    const bounded = Math.max(details.minBoost, Math.min(details.effectiveMaxBoost, display));
    return roundToDecimals(bounded, 6);
  }

  const undershoot = Math.max(details.minBoost - details.rawBoost, 0);
  if (maxUndershoot <= 0 || undershoot <= 0) {
    return details.finalBoostPct;
  }

  // Mirror floor-clamp shaping so low-capped sections do not become long flat lines.
  const floorHeadroom = Math.max(capRange * 0.35, 0.001);
  const normalizedUndershoot = clampValue(undershoot / maxUndershoot, 0, 1);
  const normalizedDisplay = 1 - Math.pow(normalizedUndershoot, 0.65);
  const display = details.minBoost + (normalizedDisplay * floorHeadroom);
  const bounded = Math.max(details.minBoost, Math.min(details.effectiveMaxBoost, display));
  return roundToDecimals(bounded, 6);
}

function clampValue(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function roundToDecimals(value: number, decimals: number): number {
  const factor = Math.pow(10, decimals);
  return Math.round(value * factor) / factor;
}
