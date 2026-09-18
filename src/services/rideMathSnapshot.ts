import type { RewardProfileVersion } from '../types/rewardProfile';
import type { MaximumModel, PhaseModel, RidePhaseDiagnostics } from '../types/ride';
import type { RideCheckpoint } from '../computations/deterministicRideGenerator';
import type { UserReward } from '../types/userReward';
import { rewardProfileRepository } from '../db/repositories/rewardProfileRepository';
import { deriveRideParams } from '../computations';
import { config } from '../config';
import { rideDefinitionRepository } from '../db/repositories/rideDefinitionRepository';

export type RideMathProfile = Pick<RewardProfileVersion,
  'id' | 'minSelections' | 'minCombinedOdds' | 'minSelectionOdds' |
  'minBoostPct' | 'maxBoostPct' | 'maxBoostMinSelections' |
  'maxBoostMinCombinedOdds' | 'maxEligibilitySelectionWeight' |
  'maxEligibilityOddsWeight' | 'effectiveMinFloorRate' | 'rideMode'>;

export interface RideMathSnapshot {
  version: 1 | 2 | 3;
  maximumModel?: MaximumModel;
  phaseModel?: PhaseModel;
  phaseDiagnostics?: RidePhaseDiagnostics;
  /** V3 authoritative doubles. The legacy table's decimal(10,6) can round them. */
  checkpoints?: RideCheckpoint[];
  profile: RideMathProfile;
  startTime: string;
  endTime: string;
  rideDurationSeconds: number;
  checkpointCount: number;
  volatility: number;
  crashPct: number;
  minPeakDelaySeconds: number;
}

export function createRideMathSnapshot(
  profile: RewardProfileVersion,
  startTime: string,
  endTime: string,
  derived: { checkpointCount: number; volatility: number; crashPct: number },
  version: 1 | 2 | 3 = 3,
  phaseRide?: { checkpoints: RideCheckpoint[]; phaseDiagnostics: RidePhaseDiagnostics }
): RideMathSnapshot & { maximumModel: MaximumModel } {
  if (version === 3 && !phaseRide) throw new Error('V3 requires frozen authoritative ride checkpoints');
  return {
    version,
    maximumModel: version >= 2 ? 'WAVES_PRE_CRASH_SUPREMUM_V2' : 'LEGACY_CHECKPOINT_MAX_V1',
    ...(version === 3 && phaseRide ? {
      phaseModel: 'FEASIBLE_WAVES_PHASE_V3' as const,
      phaseDiagnostics: phaseRide.phaseDiagnostics,
      checkpoints: phaseRide.checkpoints,
    } : {}),
    profile: {
      id: profile.id,
      minSelections: profile.minSelections,
      minCombinedOdds: profile.minCombinedOdds,
      minSelectionOdds: profile.minSelectionOdds,
      minBoostPct: profile.minBoostPct,
      maxBoostPct: profile.maxBoostPct,
      maxBoostMinSelections: profile.maxBoostMinSelections,
      maxBoostMinCombinedOdds: profile.maxBoostMinCombinedOdds,
      maxEligibilitySelectionWeight: profile.maxEligibilitySelectionWeight,
      maxEligibilityOddsWeight: profile.maxEligibilityOddsWeight,
      effectiveMinFloorRate: profile.effectiveMinFloorRate,
      rideMode: profile.rideMode,
    },
    startTime,
    endTime,
    rideDurationSeconds: (new Date(endTime).getTime() - new Date(startTime).getTime()) / 1000,
    ...derived,
    minPeakDelaySeconds: 2,
  };
}

export async function resolveRideMathSnapshot(reward: UserReward): Promise<(RideMathSnapshot & { maximumModel: MaximumModel }) | null> {
  const frozen = reward.ticketSnapshot?.rideMath as RideMathSnapshot | undefined;
  if (frozen?.version === 3) {
    // Fail closed, never substitute rounded table points or a mutable profile.
    const diagnostics = frozen.phaseDiagnostics;
    if (frozen.phaseModel !== 'FEASIBLE_WAVES_PHASE_V3' ||
        diagnostics?.model !== 'FEASIBLE_WAVES_PHASE_V3' ||
        diagnostics.checkpointStorage !== 'MATH_SNAPSHOT_JSON_V3' ||
        !['REPAIRED', 'NO_CRASH_UNCHANGED', 'TIMING_CONSTRAINED', 'FLAT_OR_ROUNDING_DEGENERATE', 'NOT_APPLICABLE_LINEAR'].includes(diagnostics.status) ||
        !Number.isFinite(frozen.rideDurationSeconds) || frozen.rideDurationSeconds <= 0 ||
        !Number.isFinite(frozen.crashPct) || frozen.crashPct <= 0 || frozen.crashPct > 1 ||
        !validCheckpoints(frozen.checkpoints)) return null;
    return { ...frozen, maximumModel: 'WAVES_PRE_CRASH_SUPREMUM_V2' };
  }
  if (frozen?.version === 1 || frozen?.version === 2) {
    return {
      ...frozen,
      maximumModel: frozen.version === 2 ? 'WAVES_PRE_CRASH_SUPREMUM_V2' : 'LEGACY_CHECKPOINT_MAX_V1',
    };
  }
  if (frozen != null) return null; // Unknown explicit versions must not become legacy rides.

  // Explicit compatibility path for rides opted in before math snapshots existed.
  // Never reconstruct/overwrite their persisted checkpoints or existing locks.
  const profile = await rewardProfileRepository.findById(reward.profileVersionId);
  if (!profile) return null;
  const duration = (new Date(reward.endTime).getTime() - new Date(reward.startTime).getTime()) / 1000;
  return createRideMathSnapshot(profile, reward.startTime, reward.endTime,
    deriveRideParams(reward.seed, duration, config.ride.minCrashSeconds), 1);
}

function validCheckpoints(points: RideCheckpoint[] | undefined): points is RideCheckpoint[] {
  return Array.isArray(points) && points.length >= 3 && points.every((p, i) =>
      p != null && typeof p === 'object' && p.index === i && Number.isFinite(p.baseBoostValue) && Number.isFinite(p.timeOffsetPct) &&
      p.timeOffsetPct >= 0 && p.timeOffsetPct <= 1 && (i === 0 || p.timeOffsetPct >= points[i - 1].timeOffsetPct) &&
      (p.incomingSegmentEnd === undefined || (p.incomingSegmentEnd != null &&
        Number.isFinite(p.incomingSegmentEnd.baseBoostValue) && Number.isFinite(p.incomingSegmentEnd.timeOffsetPct) &&
        i > 0 && p.timeOffsetPct > points[i - 1].timeOffsetPct &&
        p.incomingSegmentEnd.timeOffsetPct >= p.timeOffsetPct && p.incomingSegmentEnd.timeOffsetPct <= 1))) &&
    points[0].timeOffsetPct === 0 && points[points.length - 1].timeOffsetPct === 1;
}

export async function resolveRideCheckpoints(rewardId: string, math: RideMathSnapshot) {
  if (math.version === 3) {
    if (!validCheckpoints(math.checkpoints)) throw new Error('Invalid V3 authoritative checkpoints');
    return math.checkpoints.map(cp => ({ ...cp, checkpointIndex: cp.index }));
  }
  return rideDefinitionRepository.findByRewardId(rewardId);
}
