/**
 * Shared column readers for the repositories, so SQLite and PostgreSQL rows map to the same API values.
 */

/** SQLite's CURRENT_TIMESTAMP default form: UTC, space-separated, no zone. */
const SQLITE_CURRENT_TIMESTAMP = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}(?:\.\d+)?)$/;

/**
 * Reads a timestamp column as an ISO-8601 UTC string. PostgreSQL (timestamptz) returns a Date; SQLite
 * returns the ISO string the repositories wrote, or CURRENT_TIMESTAMP text for a column default.
 * Strings in ISO form pass through untouched, so SQLite output does not change.
 */
export function toIsoTimestamp(value: unknown): string {
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value === 'string') {
    const sqliteDefault = SQLITE_CURRENT_TIMESTAMP.exec(value);
    return sqliteDefault ? new Date(`${sqliteDefault[1]}T${sqliteDefault[2]}Z`).toISOString() : value;
  }
  throw new Error('Stored timestamp is neither a Date nor a string');
}

/** Same as toIsoTimestamp for a nullable column. */
export function toIsoTimestampOrNull(value: unknown): string | null {
  return value === null || value === undefined ? null : toIsoTimestamp(value);
}
