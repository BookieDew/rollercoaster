/**
 * V4 ride math: public types. Pure data, no behaviour.
 * Rates are fractions (0.05 = 5 %), times are seconds since ride start.
 */
export type V4Mode = 'WAVES' | 'LINEAR';
export type V4Outcome = 'CRASHED' | 'ENDED';
export type V4CrashBucket = 'EARLY' | 'MID' | 'LATE';
export type V4CrashPhase = 'UP' | 'PEAK' | 'DOWN';
/** LINEAR climb presets: the band top would be reached at 6 s (FAST), 9 s (MEDIUM) or 12 s (SLOW); each ride stops earlier at its own cap. */
export type V4LinearPace = 'FAST' | 'MEDIUM' | 'SLOW';

export interface V4RideConfig {
  mode: V4Mode;
  /** Profile boost range: the ride-value range the V3 WAVES mapping is defined on. */
  minBoostPct: number;
  maxBoostPct: number;
  /** Ticket-adjusted floor and cap (computeBoostModelDetails, formula unchanged). */
  effectiveMin: number;
  effectiveMax: number;
  /** computeTicketStrength result, 0..1. */
  ticketStrength: number;
  minDurationSeconds: number;
  maxDurationSeconds: number;
  minCrashSeconds: number;
  /** Required for LINEAR, ignored for WAVES. */
  linearPace?: V4LinearPace;
}

/** Everything a payout depends on besides the seed and config. JSON-safe; never contains the seed. */
export interface V4RideParams {
  mathVersion: 'V4';
  mode: V4Mode;
  durationSeconds: number;
  outcome: V4Outcome;
  crashAtSeconds: number | null;
  /** Crash position in the crash window [minCrash, duration]: EARLY < 25 %, MID < 80 %, LATE. */
  crashBucket: V4CrashBucket | null;
  /** WAVES crashed rides only: the curve's direction at the crash (by construction). */
  crashPhase: V4CrashPhase | null;
  linearPace: V4LinearPace | null;
  /** Payout band: the V3 mapping's image of [minBoostPct, maxBoostPct], 6 dp. */
  bandMin: number;
  bandMax: number;
  /** WAVES ride maximum (highest peak of the full, uncrashed curve), 6 dp. Independent of the crash. */
  rideMaximum: number;
  /** LINEAR cap: equals rideMaximum of the same seed. */
  linearCap: number;
  /** LINEAR start value (effectiveMin), 6 dp. */
  linearStart: number;
  /** WAVES: peaks of the full curve within [0, duration]. LINEAR: null. */
  peakCount: number | null;
}

export interface V4Ride {
  readonly params: Readonly<V4RideParams>;
  /** Final payout rate at t seconds (6 dp); 0 at/after the crash or the end. */
  boostAt(tSeconds: number): number;
  /** Same curve with the crash ignored (still 0 at/after the end). For audit and the F8 baseline. */
  uncrashedBoostAt(tSeconds: number): number;
}
