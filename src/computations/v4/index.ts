/**
 * V4 ride math (not wired yet; slice 1b-iii wires it after owner sign-off).
 * Pure: no I/O, no Math.random, no Date. Node crypto is used only for the keyed HMAC streams.
 */
export { createV4Ride } from './ride';
export { LINEAR_PACE_SECONDS, linearBoostAt } from './linear';
export { NO_CRASH_WEIGHT, CRASH_BUCKETS, CRASH_PHASES } from './outcome';
export { payoutBand, wavesFinalMapping } from './payout';
export { WAVES_SHAPE } from './waves';
export {
  combinedOddsExact,
  compareExact,
  meetsTarget,
  parseOdds,
  ratioToTarget,
  toDecimalString,
  toFiniteNumber,
  type ExactDecimal,
  type OddsInput,
} from './exactOdds';
export type {
  V4CrashBucket,
  V4CrashPhase,
  V4LinearPace,
  V4Mode,
  V4Outcome,
  V4Ride,
  V4RideConfig,
  V4RideParams,
} from './types';
