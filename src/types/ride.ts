export interface RidePathPoint {
  timePct: number;
  baseBoostValue: number;
}

export type MaximumModel = 'LEGACY_CHECKPOINT_MAX_V1' | 'WAVES_PRE_CRASH_SUPREMUM_V2';

export type PhaseModel = 'FEASIBLE_WAVES_PHASE_V3';
export interface RidePhaseDiagnostics {
  model: PhaseModel;
  status: 'REPAIRED' | 'NO_CRASH_UNCHANGED' | 'TIMING_CONSTRAINED' |
    'FLAT_OR_ROUNDING_DEGENERATE' | 'NOT_APPLICABLE_LINEAR';
  phase?: 'UP' | 'PEAK' | 'DOWN';
  baselineMaximumBoostPct?: number;
  reachableLowerBoostPct?: number;
  suffixStartSeconds?: number;
  phaseWindowSeconds?: number;
  maximumAnchorSeconds?: number;
  checkpointStorage: 'MATH_SNAPSHOT_JSON_V3';
}
