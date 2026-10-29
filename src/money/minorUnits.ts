/**
 * Money is always an integer count of minor units (cents) plus an ISO-4217
 * currency code. Floating-point money is never used.
 *
 * Rounding rule for any derived amount (settlement slice): half-up to the
 * nearest minor unit, e.g. 2.5 -> 3 and 1234.5 -> 1235.
 */

/** Largest stake accepted by opt-in (1e12 minor units, e.g. 10 billion EUR). */
export const MAX_STAKE_MINOR = 1_000_000_000_000;

/** Largest amount a profile bonus cap may hold. Values stay exactly representable. */
export const MAX_BONUS_CAP_MINOR = Number.MAX_SAFE_INTEGER;

export const CURRENCY_PATTERN = /^[A-Z]{3}$/;

/**
 * Reads a bigint money column. SQLite returns numbers, PostgreSQL returns
 * strings; both become a safe integer, anything else is rejected rather than
 * silently rounded.
 */
export function parseMinorUnits(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = typeof value === 'bigint'
    ? Number(value)
    : typeof value === 'string' && /^-?\d+$/.test(value)
      ? Number(value)
      : value;
  if (typeof parsed !== 'number' || !Number.isSafeInteger(parsed)) {
    throw new Error('Stored money amount is not a safe integer');
  }
  return parsed;
}

/** Parses the stored bonus-cap map (JSON text or an already parsed object). */
export function parseBonusCapMap(value: unknown): Record<string, number> {
  if (value === null || value === undefined || value === '') return {};
  const raw = typeof value === 'string' ? JSON.parse(value) : value;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const result: Record<string, number> = {};
  for (const [currency, amount] of Object.entries(raw as Record<string, unknown>)) {
    result[currency] = parseMinorUnits(amount) as number;
  }
  return result;
}
