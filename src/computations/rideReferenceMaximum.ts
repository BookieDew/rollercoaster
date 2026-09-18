import type { MaximumModel } from '../types/ride';
import { generateRide, interpolateRideValue, type RideCheckpoint } from './deterministicRideGenerator';
import { calculateFinalBoostDetails } from './finalBoostCalculator';

// Preserve the checkpoint-only reference for historical rides. New rides use
// the existing WAVES curve's pre-crash supremum as their LINEAR endpoint.
export function computeLinearModeMaxBoostPct(input: {
  seed: string;
  checkpointCount: number;
  volatility: number;
  rideDurationSeconds: number;
  crashPct: number;
  ticketStrength: number;
  qualifyingSelections: number;
  combinedOdds: number;
  config: {
    minBoostPct: number;
    maxBoostPct: number;
    maxBoostMinSelections: number | null;
    maxBoostMinCombinedOdds: number | null;
    maxEligibilitySelectionWeight: number;
    maxEligibilityOddsWeight: number;
    effectiveMinFloorRate: number;
  };
  minBoostPct: number;
  maxBoostPct: number;
  minPeakDelaySeconds?: number;
  maximumModel?: MaximumModel;
}): number {
  const referenceWaveRide = generateRide(input.seed, {
    checkpointCount: input.checkpointCount,
    volatility: input.volatility,
    minBoostPct: input.minBoostPct,
    maxBoostPct: input.maxBoostPct,
    rideMode: 'WAVES',
    ticketStrength: input.ticketStrength,
    durationSeconds: input.rideDurationSeconds,
    crashPct: input.crashPct,
    minPeakDelaySeconds: input.minPeakDelaySeconds ?? 2,
  });

  const waveMaxRideValue = getMaxRideValue(referenceWaveRide.checkpoints, input.crashPct, input.maximumModel);
  const details = calculateFinalBoostDetails({
    rideValue: waveMaxRideValue,
    ticketStrength: input.ticketStrength,
    qualifyingSelections: input.qualifyingSelections,
    combinedOdds: input.combinedOdds,
    hasRideEnded: false,
    config: input.config,
  });

  return details.finalBoostPct;
}

export function getMaxRideValue(
  checkpoints: Pick<RideCheckpoint, 'timeOffsetPct' | 'baseBoostValue' | 'incomingSegmentEnd'>[],
  crashPct: number,
  maximumModel: MaximumModel = 'LEGACY_CHECKPOINT_MAX_V1'
): number {
  if (!checkpoints.length) {
    return 0;
  }

  if (maximumModel === 'WAVES_PRE_CRASH_SUPREMUM_V2') {
    const boundary = Math.min(1, Math.max(0, crashPct));
    if (boundary <= 0) return 0;
    // On each segment the curve is linear; V3's equal-time boundary pair keeps
    // both raw sides of an effectively continuous clamp transition. Its limit at
    // crash may exceed preceding checkpoints. Evaluate the interpolator,
    // not the terminal payout (which is zero at the boundary). Retain round6.
    const boundaryLimit = interpolateRideValue(
      checkpoints.map((cp, index) => ({ ...cp, index })), boundary
    );
    return Math.max(boundaryLimit, ...checkpoints
      .filter(cp => cp.timeOffsetPct <= boundary)
      .map(cp => cp.baseBoostValue));
  }

  const eligible = checkpoints.filter((cp) => cp.timeOffsetPct <= crashPct);
  if (!eligible.length) {
    return 0;
  }

  return Math.max(...eligible.map((cp) => cp.baseBoostValue));
}
