export enum ReasonCode {
  // Eligibility reason codes
  ELIGIBLE = 'ELIGIBLE',
  MIN_SELECTIONS_NOT_MET = 'MIN_SELECTIONS_NOT_MET',
  MIN_ODDS_NOT_MET = 'MIN_ODDS_NOT_MET',
  MIN_COMBINED_ODDS_NOT_MET = 'MIN_COMBINED_ODDS_NOT_MET',

  // Reward state reason codes
  REWARD_NOT_FOUND = 'REWARD_NOT_FOUND',
  REWARD_EXPIRED = 'REWARD_EXPIRED',
  REWARD_ALREADY_USED = 'REWARD_ALREADY_USED',
  NOT_OPTED_IN = 'NOT_OPTED_IN',
  ALREADY_OPTED_IN = 'ALREADY_OPTED_IN',
  RIDE_ENDED = 'RIDE_ENDED',
  RIDE_CRASHED = 'RIDE_CRASHED',

  // Opt-in reason codes
  BET_ALREADY_BOUND = 'BET_ALREADY_BOUND',
  CURRENCY_NOT_SUPPORTED = 'CURRENCY_NOT_SUPPORTED',

  // Lock reason codes
  BET_ALREADY_LOCKED = 'BET_ALREADY_LOCKED',
  LOCK_NOT_FOUND = 'LOCK_NOT_FOUND',

  // Settlement reason codes
  BET_ALREADY_SETTLED = 'BET_ALREADY_SETTLED',
  SETTLEMENT_NOT_FOUND = 'SETTLEMENT_NOT_FOUND',
  /** A resettlement would revoke a replacement reward that has already been used. */
  REPLACEMENT_ALREADY_USED = 'REPLACEMENT_ALREADY_USED',
  /** The bet has no complete stake/currency/cap or ticket snapshot (legacy data). */
  SETTLEMENT_UNAVAILABLE = 'SETTLEMENT_UNAVAILABLE',

  // Profile reason codes
  PROFILE_NOT_FOUND = 'PROFILE_NOT_FOUND',
  PROFILE_INACTIVE = 'PROFILE_INACTIVE',
  INVALID_CONFIGURATION = 'INVALID_CONFIGURATION',

  // General errors
  VALIDATION_ERROR = 'VALIDATION_ERROR',
  ROUTE_NOT_FOUND = 'ROUTE_NOT_FOUND',
  INTERNAL_ERROR = 'INTERNAL_ERROR',
}

const REASON_CODE_VALUES: ReadonlySet<string> = new Set(Object.values(ReasonCode));

/** True only for values of the ReasonCode enum (never driver codes such as SQLITE_* or 23505). */
export function isReasonCode(value: unknown): value is ReasonCode {
  return typeof value === 'string' && REASON_CODE_VALUES.has(value);
}

export type EligibilityReasonCode =
  | ReasonCode.ELIGIBLE
  | ReasonCode.MIN_SELECTIONS_NOT_MET
  | ReasonCode.MIN_ODDS_NOT_MET
  | ReasonCode.MIN_COMBINED_ODDS_NOT_MET
  | ReasonCode.REWARD_NOT_FOUND
  | ReasonCode.REWARD_EXPIRED
  | ReasonCode.REWARD_ALREADY_USED
  | ReasonCode.NOT_OPTED_IN
  | ReasonCode.RIDE_ENDED
  | ReasonCode.RIDE_CRASHED;
