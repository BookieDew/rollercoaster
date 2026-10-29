import type { Selection } from '../types/ticket';
import {
  filterQualifyingSelections,
  meetsMinSelectionCount,
} from './qualifyingSelectionFilter';

/**
 * Pure settlement calculator (Phase 1a contract, sections 2 and 4).
 *
 * Deterministic: no database, clock or I/O. Money is computed with BigInt only.
 *
 * Arithmetic:
 * - Each odds value is read from its shortest decimal string (`String(odds)`),
 *   must be finite, positive and have at most 6 decimal places, and becomes a
 *   BigInt scaled by 10^6.
 * - The locked boost is a fraction (0.2 = 20%) with at most 6 decimal places,
 *   scaled by 10^6.
 * - total_return = roundHalfUp(stake * prod(odds_i) / 10^(6n)), one rounding.
 * - bonus = min(roundHalfUp(total_return * boost / 10^6), bonus_cap).
 * - Half-up rounding to the nearest minor unit (all values are non-negative,
 *   so half-up and half-away-from-zero coincide).
 * - The total return is returned as an exact BigInt of any size (sportsbook
 *   returns can exceed 2^53; max payout is the sportsbook's responsibility).
 *   The bonus is at most the cap, a safe integer, so it is returned as a number.
 */

export type SettlementOutcome = 'SETTLED' | 'CASHOUT' | 'CANCELLED';
export type SettlementLegResult = 'WON' | 'LOST' | 'PUSH' | 'CANCELLED';
export type SettlementBetResult =
  | 'WON'
  | 'WON_NO_BONUS'
  | 'LOST'
  | 'PUSHED'
  | 'CANCELLED'
  | 'CASHED_OUT';

export interface SettlementLeg {
  selection_id: string;
  result: SettlementLegResult;
}

/** Profile minimums snapshotted at opt-in (LockSnapshot / reward snapshot). */
export interface SettlementMinimums {
  minSelections: number;
  minCombinedOdds: number;
  minSelectionOdds: number;
}

export interface SettlementInput {
  outcome: SettlementOutcome;
  /** Required (one per bet leg) for SETTLED; must be absent or empty otherwise. */
  legs?: SettlementLeg[];
  /** Ticket selections exactly as stored at opt-in (odds, type, eligibility). */
  storedSelections: Selection[];
  /** Positive safe integer, minor units. */
  stakeMinor: number;
  /** Locked boost as a fraction (0.2 = 20%), at most 6 decimal places, >= 0. */
  lockedBoostPct: number;
  /** Non-negative safe integer, minor units. */
  bonusCapMinor: number;
  minimums: SettlementMinimums;
}

export interface SettlementCalculation {
  betResult: SettlementBetResult;
  /** Exact integer of any size; null for CANCELLED and CASHED_OUT; 0n for LOST. */
  totalReturnMinor: bigint | null;
  bonusMinor: number;
  /** True only when the uncapped bonus is strictly greater than the cap. */
  capApplied: boolean;
  /**
   * Result of the minimums re-check. null when it was not evaluated: it runs
   * only when at least one leg is CANCELLED and the bet reached the WON /
   * WON_NO_BONUS decision.
   */
  minimumsMet: boolean | null;
  /** True for CANCELLED (the token is returned as a replacement reward). */
  issueReplacement: boolean;
}

export type SettlementLegProblemCode =
  | 'NO_BET_LEGS'
  | 'AMBIGUOUS_STORED_SELECTION'
  | 'INVALID_LEG'
  | 'UNKNOWN_SELECTION'
  | 'SGP_LEG_NOT_A_BET_LEG'
  | 'DUPLICATE_LEG'
  | 'MISSING_LEG';

export interface SettlementLegProblem {
  code: SettlementLegProblemCode;
  /** The selection id concerned, or null when not applicable. */
  selection_id: string | null;
  message: string;
}

export type SettlementCalculationErrorCode = 'INVALID_INPUT' | 'INVALID_LEGS';

export class SettlementCalculationError extends Error {
  readonly code: SettlementCalculationErrorCode;
  readonly problems: SettlementLegProblem[];

  constructor(code: SettlementCalculationErrorCode, message: string, problems: SettlementLegProblem[] = []) {
    super(message);
    this.name = 'SettlementCalculationError';
    this.code = code;
    this.problems = problems;
  }
}

const SETTLEMENT_OUTCOMES: readonly SettlementOutcome[] = ['SETTLED', 'CASHOUT', 'CANCELLED'];
const LEG_RESULTS: readonly SettlementLegResult[] = ['WON', 'LOST', 'PUSH', 'CANCELLED'];

/** Fixed-point scale for odds and boost: 6 decimal places. */
export const SETTLEMENT_DECIMALS = 6;
const SCALE = 10n ** BigInt(SETTLEMENT_DECIMALS);

// ---------------------------------------------------------------------------
// Exact decimal helpers
// ---------------------------------------------------------------------------

interface ExactDecimal {
  /** value = digits / 10^decimals, digits >= 0. */
  digits: bigint;
  decimals: number;
}

const DECIMAL_PATTERN = /^(\d+)(?:\.(\d+))?(?:e([+-]\d+))?$/;

/**
 * Parses a non-negative finite number from its shortest round-trip decimal
 * string into an exact decimal. Returns null for negative, non-finite or
 * non-number input.
 */
function parseExactDecimal(value: unknown): ExactDecimal | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return null;
  }
  const match = DECIMAL_PATTERN.exec(String(value));
  /* istanbul ignore next -- String() of a finite non-negative number always matches */
  if (!match) {
    return null;
  }
  const fraction = match[2] ?? '';
  const exponent = match[3] === undefined ? 0 : Number(match[3]);
  let digits = BigInt(`${match[1]}${fraction}`);
  let decimals = fraction.length - exponent;
  if (decimals < 0) {
    digits *= 10n ** BigInt(-decimals);
    decimals = 0;
  }
  // The shortest round-trip string never has trailing fractional zeros, so
  // `decimals` is already the minimal number of decimal places.
  return { digits, decimals };
}

/**
 * Converts a number to a BigInt scaled by 10^6, requiring at most 6 decimal
 * places. Returns null when that is impossible.
 */
function toScaled6(value: unknown): bigint | null {
  const parsed = parseExactDecimal(value);
  if (parsed === null || parsed.decimals > SETTLEMENT_DECIMALS) {
    return null;
  }
  return parsed.digits * 10n ** BigInt(SETTLEMENT_DECIMALS - parsed.decimals);
}

/** Half-up rounding of numerator / denominator for numerator >= 0, denominator > 0. */
function roundHalfUpDiv(numerator: bigint, denominator: bigint): bigint {
  return (2n * numerator + denominator) / (2n * denominator);
}

function isSafeInteger(value: unknown, min: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min;
}

function isBetLeg(selection: Selection): boolean {
  return selection.selection_type !== 'SGP_LEG';
}

// ---------------------------------------------------------------------------
// Leg validation
// ---------------------------------------------------------------------------

/**
 * Checks settlement legs against the stored ticket.
 *
 * Bet legs are all stored selections except `SGP_LEG` (illustrative), including
 * excluded and ineligible selections. Every bet leg must be supplied exactly
 * once. Supplying an `SGP_LEG` id is rejected (SGP_LEG_NOT_A_BET_LEG) rather
 * than ignored, so a payload has exactly one normalized form.
 *
 * Returns a list of problems (empty when valid). Never throws.
 */
export function validateSettlementLegs(
  storedSelections: readonly Selection[],
  legs: readonly SettlementLeg[]
): SettlementLegProblem[] {
  const problems: SettlementLegProblem[] = [];

  const betLegIds = new Set<string>();
  const ambiguousIds = new Set<string>();
  const sgpLegIds = new Set<string>();
  for (const selection of storedSelections) {
    if (isBetLeg(selection)) {
      if (betLegIds.has(selection.id)) {
        ambiguousIds.add(selection.id);
      }
      betLegIds.add(selection.id);
    } else {
      sgpLegIds.add(selection.id);
    }
  }

  if (betLegIds.size === 0) {
    problems.push({
      code: 'NO_BET_LEGS',
      selection_id: null,
      message: 'Stored ticket has no bet legs to settle',
    });
  }
  for (const id of ambiguousIds) {
    problems.push({
      code: 'AMBIGUOUS_STORED_SELECTION',
      selection_id: id,
      message: `Stored ticket has more than one bet leg with selection_id ${id}`,
    });
  }

  const seen = new Set<string>();
  const reportedDuplicates = new Set<string>();
  legs.forEach((leg, index) => {
    const candidate = leg as unknown as Partial<Record<keyof SettlementLeg, unknown>> | null;
    if (
      candidate === null
      || typeof candidate !== 'object'
      || typeof candidate.selection_id !== 'string'
      || !LEG_RESULTS.includes(candidate.result as SettlementLegResult)
    ) {
      problems.push({
        code: 'INVALID_LEG',
        selection_id: candidate !== null && typeof candidate === 'object'
          && typeof candidate.selection_id === 'string'
          ? candidate.selection_id
          : null,
        message: `legs[${index}] must have a string selection_id and a result of ${LEG_RESULTS.join(', ')}`,
      });
      return;
    }
    const id = candidate.selection_id;
    if (!betLegIds.has(id)) {
      problems.push(sgpLegIds.has(id)
        ? {
          code: 'SGP_LEG_NOT_A_BET_LEG',
          selection_id: id,
          message: `selection_id ${id} is an illustrative SGP_LEG and is not settled`,
        }
        : {
          code: 'UNKNOWN_SELECTION',
          selection_id: id,
          message: `selection_id ${id} is not on the stored ticket`,
        });
      return;
    }
    if (seen.has(id)) {
      if (!reportedDuplicates.has(id)) {
        reportedDuplicates.add(id);
        problems.push({
          code: 'DUPLICATE_LEG',
          selection_id: id,
          message: `selection_id ${id} is supplied more than once`,
        });
      }
      return;
    }
    seen.add(id);
  });

  for (const id of betLegIds) {
    if (!seen.has(id)) {
      problems.push({
        code: 'MISSING_LEG',
        selection_id: id,
        message: `Bet leg ${id} has no result`,
      });
    }
  }

  return problems;
}

// ---------------------------------------------------------------------------
// Minimums re-check
// ---------------------------------------------------------------------------

/**
 * Re-checks the opt-in minimums on the given (non-cancelled) bet legs at their
 * ORIGINAL odds, using the same qualifying filter as opt-in: excluded or
 * ineligible selections and SGP_LEG components never qualify, an SGP composite
 * counts once at its own price, and each selection must reach minSelectionOdds.
 *
 * The combined-odds comparison is exact (BigInt) rather than the float
 * product used at opt-in; an empty qualifying set has combined odds 0, as in
 * calculateCombinedOdds.
 */
function meetsMinimumsExactly(
  selections: Selection[],
  minimums: SettlementMinimums,
  minCombined: ExactDecimal,
  scaledOdds: Map<Selection, bigint>
): boolean {
  const { qualifying } = filterQualifyingSelections(selections, minimums.minSelectionOdds);
  if (!meetsMinSelectionCount(qualifying.length, minimums.minSelections)) {
    return false;
  }
  if (qualifying.length === 0) {
    // Mirrors calculateCombinedOdds([]) === 0.
    return minCombined.digits === 0n;
  }
  let product = 1n;
  for (const selection of qualifying) {
    // filterQualifyingSelections may return a copy only for disqualified
    // selections; qualifying entries are the original objects.
    product *= scaledOdds.get(selection) as bigint;
  }
  // product / 10^(6k) >= minDigits / 10^minDecimals
  const productScale = SCALE ** BigInt(qualifying.length);
  return product * 10n ** BigInt(minCombined.decimals) >= minCombined.digits * productScale;
}

// ---------------------------------------------------------------------------
// Settlement
// ---------------------------------------------------------------------------

function assertInput(input: SettlementInput): {
  stake: bigint;
  boost: bigint;
  cap: bigint;
  minCombined: ExactDecimal;
} {
  if (input === null || typeof input !== 'object') {
    throw new SettlementCalculationError('INVALID_INPUT', 'input must be an object');
  }
  if (!SETTLEMENT_OUTCOMES.includes(input.outcome)) {
    throw new SettlementCalculationError('INVALID_INPUT', `outcome must be one of ${SETTLEMENT_OUTCOMES.join(', ')}`);
  }
  if (!Array.isArray(input.storedSelections)) {
    throw new SettlementCalculationError('INVALID_INPUT', 'storedSelections must be an array');
  }
  if (input.legs !== undefined && !Array.isArray(input.legs)) {
    throw new SettlementCalculationError('INVALID_INPUT', 'legs must be an array when supplied');
  }
  if (!isSafeInteger(input.stakeMinor, 1)) {
    throw new SettlementCalculationError('INVALID_INPUT', 'stakeMinor must be a positive safe integer');
  }
  if (!isSafeInteger(input.bonusCapMinor, 0)) {
    throw new SettlementCalculationError('INVALID_INPUT', 'bonusCapMinor must be a non-negative safe integer');
  }
  const boost = toScaled6(input.lockedBoostPct);
  if (boost === null) {
    throw new SettlementCalculationError(
      'INVALID_INPUT',
      'lockedBoostPct must be a finite non-negative number with at most 6 decimal places'
    );
  }
  const minimums = input.minimums;
  if (minimums === null || typeof minimums !== 'object') {
    throw new SettlementCalculationError('INVALID_INPUT', 'minimums must be an object');
  }
  if (typeof minimums.minSelections !== 'number' || !Number.isFinite(minimums.minSelections)) {
    throw new SettlementCalculationError('INVALID_INPUT', 'minimums.minSelections must be a finite number');
  }
  if (typeof minimums.minSelectionOdds !== 'number' || !Number.isFinite(minimums.minSelectionOdds)) {
    throw new SettlementCalculationError('INVALID_INPUT', 'minimums.minSelectionOdds must be a finite number');
  }
  const minCombined = parseExactDecimal(minimums.minCombinedOdds);
  if (minCombined === null) {
    throw new SettlementCalculationError(
      'INVALID_INPUT',
      'minimums.minCombinedOdds must be a finite non-negative number'
    );
  }
  return {
    stake: BigInt(input.stakeMinor),
    boost,
    cap: BigInt(input.bonusCapMinor),
    minCombined,
  };
}

/**
 * Calculates a settlement from validated legs and the opt-in snapshot.
 *
 * Rule order (contract section 4):
 * 1. outcome CASHOUT -> CASHED_OUT (return null, bonus 0).
 * 2. outcome CANCELLED -> CANCELLED (return null, bonus 0, replacement).
 * 3. any leg LOST -> LOST (return 0, bonus 0).
 * 4. every leg CANCELLED -> CANCELLED (return null, bonus 0, replacement).
 * 5. total_return = stake * prod(odds), WON legs at original odds and
 *    PUSH/CANCELLED legs at 1.00.
 * 6. no leg WON -> PUSHED (return = stake, bonus 0, minimums not re-checked).
 * 7. any leg CANCELLED -> re-check minimums on non-cancelled bet legs at
 *    original odds; failure -> WON_NO_BONUS (bonus 0).
 * 8. WON: bonus = min(roundHalfUp(total_return * boost), cap).
 *
 * Throws SettlementCalculationError for malformed input (INVALID_INPUT) or
 * invalid legs (INVALID_LEGS, with problems). Any total return is exact, so
 * there is no size limit on the result.
 */
export function calculateSettlement(input: SettlementInput): SettlementCalculation {
  const { stake, boost, cap, minCombined } = assertInput(input);
  const legs = input.legs ?? [];

  if (input.outcome !== 'SETTLED') {
    if (legs.length > 0) {
      throw new SettlementCalculationError('INVALID_INPUT', `legs are not allowed for outcome ${input.outcome}`);
    }
    const cancelled = input.outcome === 'CANCELLED';
    return {
      betResult: cancelled ? 'CANCELLED' : 'CASHED_OUT',
      totalReturnMinor: null,
      bonusMinor: 0,
      capApplied: false,
      minimumsMet: null,
      issueReplacement: cancelled,
    };
  }

  const problems = validateSettlementLegs(input.storedSelections, legs);
  if (problems.length > 0) {
    throw new SettlementCalculationError('INVALID_LEGS', 'Settlement legs do not match the stored ticket', problems);
  }

  const betLegs = input.storedSelections.filter(isBetLeg);
  const scaledOdds = new Map<Selection, bigint>();
  for (const selection of betLegs) {
    const scaled = toScaled6(selection.odds);
    if (scaled === null || scaled === 0n) {
      throw new SettlementCalculationError(
        'INVALID_INPUT',
        `odds of selection ${selection.id} must be a finite positive number with at most 6 decimal places`
      );
    }
    scaledOdds.set(selection, scaled);
  }

  const resultById = new Map<string, SettlementLegResult>();
  for (const leg of legs) {
    resultById.set(leg.selection_id, leg.result);
  }
  const results = betLegs.map((selection) => resultById.get(selection.id) as SettlementLegResult);

  if (results.includes('LOST')) {
    return {
      betResult: 'LOST',
      totalReturnMinor: 0n,
      bonusMinor: 0,
      capApplied: false,
      minimumsMet: null,
      issueReplacement: false,
    };
  }

  if (results.every((result) => result === 'CANCELLED')) {
    return {
      betResult: 'CANCELLED',
      totalReturnMinor: null,
      bonusMinor: 0,
      capApplied: false,
      minimumsMet: null,
      issueReplacement: true,
    };
  }

  let wonCount = 0;
  let numerator = stake;
  for (let index = 0; index < betLegs.length; index += 1) {
    if (results[index] === 'WON') {
      numerator *= scaledOdds.get(betLegs[index]) as bigint;
      wonCount += 1;
    }
  }
  // PUSH and CANCELLED legs contribute exactly 1.00 and are left out of the product.
  const totalReturn = roundHalfUpDiv(numerator, SCALE ** BigInt(wonCount));
  const totalReturnMinor = totalReturn;

  if (wonCount === 0) {
    return {
      betResult: 'PUSHED',
      totalReturnMinor,
      bonusMinor: 0,
      capApplied: false,
      minimumsMet: null,
      issueReplacement: false,
    };
  }

  let minimumsMet: boolean | null = null;
  if (results.includes('CANCELLED')) {
    const remaining = betLegs.filter((_, index) => results[index] !== 'CANCELLED');
    minimumsMet = meetsMinimumsExactly(remaining, input.minimums, minCombined, scaledOdds);
    if (!minimumsMet) {
      return {
        betResult: 'WON_NO_BONUS',
        totalReturnMinor,
        bonusMinor: 0,
        capApplied: false,
        minimumsMet,
        issueReplacement: false,
      };
    }
  }

  const uncappedBonus = roundHalfUpDiv(totalReturn * boost, SCALE);
  const capApplied = uncappedBonus > cap;
  // bonus <= cap, and cap is a safe integer, so the conversion is exact.
  const bonus = capApplied ? cap : uncappedBonus;

  return {
    betResult: 'WON',
    totalReturnMinor,
    bonusMinor: Number(bonus),
    capApplied,
    minimumsMet,
    issueReplacement: false,
  };
}
