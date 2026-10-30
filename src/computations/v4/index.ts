/**
 * V4 ride math: the only ride math (math version 4; slice 1b-iii-a wired it into every live path).
 * Pure: no I/O, no Math.random, no Date. Node crypto is used only for the keyed HMAC streams.
 */
export { createV4Ride, seedCommitment, v4RideDurationSeconds } from './ride';
export { LINEAR_PACE_SECONDS, linearBoostAt } from './linear';
export { NO_CRASH_WEIGHT, CRASH_BUCKETS, CRASH_PHASES } from './outcome';
export { payoutBand, wavesFinalMapping } from './payout';
export { WAVES_SHAPE } from './waves';
export {
  combinedOddsExact,
  compareExact,
  exactFromNumber,
  exactRatio,
  lnExact,
  meetsExactTarget,
  meetsTarget,
  parseOdds,
  ratioToTarget,
  toDecimalString,
  toDisplayNumber,
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
