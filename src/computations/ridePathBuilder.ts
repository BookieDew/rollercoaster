import type { RidePathPoint } from '../types/ride';
import { interpolateRideValue, type RideCheckpoint } from './deterministicRideGenerator';
import {
  calculateFinalBoostDetails,
  type FinalBoostConfig,
} from './finalBoostCalculator';

export function buildEffectiveRidePath(
  checkpoints: (Pick<RideCheckpoint, 'timeOffsetPct' | 'baseBoostValue' | 'incomingSegmentEnd'> & { checkpointIndex: number })[],
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
    ...cp, index: cp.checkpointIndex,
    timeOffsetPct: cp.timeOffsetPct,
    baseBoostValue: cp.baseBoostValue,
  }));

  const points: RidePathPoint[] = [];
  for (let i = 0; i < sampleCount; i++) {
    const timePct = i / (sampleCount - 1);
    const hasEnded = timePct >= crashPct || timePct >= 1;
    const details = calculateFinalBoostDetails({
      rideValue: hasEnded ? 0 : interpolateRideValue(normalizedCheckpoints, timePct),
      ticketStrength,
      qualifyingSelections,
      combinedOdds,
      hasRideEnded: hasEnded,
      config,
    });
    points.push({ timePct, baseBoostValue: details.finalBoostPct });
  }
  return points;
}
