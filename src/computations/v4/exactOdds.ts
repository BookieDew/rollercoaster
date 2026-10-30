/**
 * Exact combined odds (contract §4). Decimal odds with up to 6 decimals become integers scaled by
 * 10^6; their product is an exact BigInt with scale 6 * legs. No floats are multiplied, so 100 legs
 * at 10,000 (10^400) stay exact, comparisons with profile targets are exact, and the target ratio
 * is always a finite number in [0, 1].
 */
export interface ExactDecimal {
  /** value = units / 10^scale */
  readonly units: bigint;
  readonly scale: number;
}

export type OddsInput = number | string;

const ODDS_DECIMALS = 6;
const ODDS_FACTOR = 1_000_000;
const DECIMAL_PATTERN = /^(\d+)(?:\.(\d{1,6}))?$/;
const RATIO_DIGITS = 20;
const LARGEST_BELOW_ONE = 1 - Number.EPSILON / 2;

/** One decimal odds value as units of 10^-6. Strings must be plain decimals; numbers at most 6 dp. */
export function parseOdds(value: OddsInput): bigint {
  let units: bigint;
  if (typeof value === 'string') {
    const match = DECIMAL_PATTERN.exec(value);
    if (!match) throw new Error('Odds must be a plain decimal with at most 6 decimals');
    units = BigInt(match[1]) * BigInt(ODDS_FACTOR) + BigInt((match[2] ?? '').padEnd(ODDS_DECIMALS, '0'));
  } else {
    const scaled = Math.round(value * ODDS_FACTOR);
    if (!Number.isFinite(value) || !Number.isSafeInteger(scaled) || scaled / ODDS_FACTOR !== value) {
      throw new Error('Odds must be a finite number with at most 6 decimals (use a string above 9e9)');
    }
    units = BigInt(scaled);
  }
  if (units <= 0n) throw new Error('Odds must be positive');
  return units;
}

/** Exact product. No legs gives 0, matching the existing "no qualifying selections" value. */
export function combinedOddsExact(odds: readonly OddsInput[]): ExactDecimal {
  if (odds.length === 0) return { units: 0n, scale: 0 };
  let units = 1n;
  for (const leg of odds) units *= parseOdds(leg);
  return { units, scale: ODDS_DECIMALS * odds.length };
}

export function compareExact(a: ExactDecimal, b: ExactDecimal): -1 | 0 | 1 {
  const left = a.units * 10n ** BigInt(b.scale);
  const right = b.units * 10n ** BigInt(a.scale);
  return left === right ? 0 : left > right ? 1 : -1;
}

function targetDecimal(target: OddsInput): ExactDecimal {
  return { units: parseOdds(target), scale: ODDS_DECIMALS };
}

/** True when the exact product of the odds is at or above the target. */
export function meetsTarget(odds: readonly OddsInput[], target: OddsInput): boolean {
  return compareExact(combinedOddsExact(odds), targetDecimal(target)) >= 0;
}

/** min(1, product / target): exactly 1 at or above the target, otherwise finite and below 1. */
export function ratioToTarget(odds: readonly OddsInput[], target: OddsInput): number {
  return exactRatio(combinedOddsExact(odds), targetDecimal(target));
}

/**
 * min(1, value / goal) for exact decimals (goal > 0): exactly 1 when the exact comparison says the goal
 * is met, otherwise finite and strictly below 1 (never NaN or Infinity, whatever the magnitudes).
 */
export function exactRatio(product: ExactDecimal, goal: ExactDecimal): number {
  if (goal.units <= 0n) throw new Error('Target must be positive');
  if (compareExact(product, goal) >= 0) return 1;
  const numerator = product.units * 10n ** BigInt(goal.scale);
  if (numerator === 0n) return 0;
  const denominator = goal.units * 10n ** BigInt(product.scale);
  // ~20 significant digits whatever the magnitude; the decimal parse rounds correctly (and
  // underflows to 0, never to NaN). A ratio just below 1 must not round up to 1.
  const shift = denominator.toString().length - numerator.toString().length + RATIO_DIGITS;
  const quotient = (numerator * 10n ** BigInt(shift)) / denominator;
  return Math.min(Number(`${quotient}e-${shift}`), LARGEST_BELOW_ONE);
}

/** Exact decimal string, trailing zeros removed (e.g. "4.095", "1048576"). */
export function toDecimalString(value: ExactDecimal): string {
  const digits = value.units.toString();
  if (value.scale === 0) return digits;
  const padded = digits.padStart(value.scale + 1, '0');
  const whole = padded.slice(0, padded.length - value.scale);
  const fraction = padded.slice(padded.length - value.scale).replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole;
}

/** Nearest double, or null when the value is beyond the double range (render the string instead). */
export function toFiniteNumber(value: ExactDecimal): number | null {
  const approx = Number(toDecimalString(value));
  return Number.isFinite(approx) ? approx : null;
}

const SHORTEST_NUMBER_PATTERN = /^(\d+)(?:\.(\d+))?(?:e([+-]\d+))?$/;

/**
 * The exact decimal a finite non-negative number stands for, read from its shortest round-trip string
 * (`String(value)`, as the settlement calculator reads odds). Any number of decimals and exponent
 * notation are accepted, so profile targets such as 1e21 or 3.1234567 compare exactly.
 */
export function exactFromNumber(value: number): ExactDecimal {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error('Expected a finite non-negative number');
  }
  const match = SHORTEST_NUMBER_PATTERN.exec(String(value));
  if (!match) throw new Error('Expected a finite non-negative number');
  const fraction = match[2] ?? '';
  const exponent = match[3] === undefined ? 0 : Number(match[3]);
  const units = BigInt(match[1] + fraction);
  const scale = fraction.length - exponent;
  return scale >= 0 ? { units, scale } : { units: units * 10n ** BigInt(-scale), scale: 0 };
}

/** True when the exact value is at or above the exact target. */
export function meetsExactTarget(value: ExactDecimal, target: ExactDecimal): boolean {
  return compareExact(value, target) >= 0;
}

/**
 * Natural log of a positive exact decimal as a finite double, also beyond the double range
 * (1e400 gives 921.03...). Inside the double range it is Math.log of the nearest double.
 */
export function lnExact(value: ExactDecimal): number {
  if (value.units <= 0n) throw new Error('lnExact needs a positive value');
  const approx = toFiniteNumber(value);
  if (approx !== null && approx > 0) return Math.log(approx);
  const digits = value.units.toString();
  const lead = digits.slice(0, 17);
  return Math.log(Number(`0.${lead}`)) + (digits.length - value.scale) * Math.LN10;
}

/** Display form: the nearest double, or the exact decimal string when no finite double exists. */
export function toDisplayNumber(value: ExactDecimal): number | string {
  return toFiniteNumber(value) ?? toDecimalString(value);
}
