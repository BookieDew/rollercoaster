import type { RidePathPoint } from '../types/ride';
import { interpolateRideValue } from './deterministicRideGenerator';
import { calculateFinalBoost, type FinalBoostConfig } from './finalBoostCalculator';

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
      : calculateFinalBoost({
          rideValue: baseRideValue,
          ticketStrength,
          qualifyingSelections,
          combinedOdds,
          hasRideEnded: false,
          config,
        });
    points.push({ timePct, baseBoostValue: effectiveBoost });
  }

  return points;
}
