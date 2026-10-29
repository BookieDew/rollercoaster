/**
 * Engine adapter contract for the ride lab. Keep it small: an engine only has to turn
 * (seed, config) into a sampled ride. All measurement lives in metrics.ts / policies.ts.
 */
export type RideMode = 'WAVES' | 'LINEAR';
export type Outcome = 'CRASHED' | 'ENDED';
export type CrashPhase = 'UP' | 'PEAK' | 'DOWN';

export interface LabConfig {
  /** Short stable id, e.g. "WAVES/medium". */
  label: string;
  mode: RideMode;
  ticketLabel: 'weak' | 'medium' | 'strong';
  profile: {
    minBoostPct: number;
    maxBoostPct: number;
    minSelections: number;
    minCombinedOdds: number;
    maxBoostMinSelections: number | null;
    maxBoostMinCombinedOdds: number | null;
    maxEligibilitySelectionWeight: number;
    maxEligibilityOddsWeight: number;
    effectiveMinFloorRate: number;
  };
  ticket: { qualifyingSelections: number; combinedOdds: number; ticketStrength: number };
}

export interface SampledRide {
  durationSeconds: number;
  outcome: Outcome;
  /** Crash time (CRASHED) or the end of the ride (ENDED). boostAt(t >= terminalAtSeconds) is 0. */
  terminalAtSeconds: number;
  /** Phase as reported by the engine itself, when it knows (never inferred here). */
  reportedCrashPhase?: CrashPhase;
  /** Final payout rate (fraction, 6 dp) the player would lock at time t; 0 at/after terminal. */
  boostAt(tSeconds: number): number;
  /**
   * Optional: the same curve with the crash ignored (defined up to durationSeconds). Needed only
   * for the F8 baseline (crash time redrawn independently); without it that baseline is skipped.
   */
  uncrashedBoostAt?(tSeconds: number): number;
  effectiveMin: number;
  effectiveMax: number;
}

export interface EngineAdapter {
  name: string;
  /** seed: 64 hex characters. Must be deterministic. */
  sample(seed: string, config: LabConfig): SampledRide;
}
