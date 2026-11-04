import { toIsoTimestamp, toIsoTimestampOrNull } from '../../src/db/repositories/columns';

describe('timestamp column reader', () => {
  it('turns a Date (PostgreSQL timestamptz) into an ISO-8601 UTC string', () => {
    expect(toIsoTimestamp(new Date('2026-02-03T09:30:00.123+02:00'))).toBe('2026-02-03T07:30:00.123Z');
  });

  it('passes ISO strings (SQLite, as written by the repositories) through unchanged', () => {
    expect(toIsoTimestamp('2026-10-29T00:00:00.000Z')).toBe('2026-10-29T00:00:00.000Z');
    expect(toIsoTimestamp('2026-10-29T00:00:00Z')).toBe('2026-10-29T00:00:00Z');
  });

  it('reads the SQLite CURRENT_TIMESTAMP default form as UTC', () => {
    expect(toIsoTimestamp('2026-02-03 07:00:00')).toBe('2026-02-03T07:00:00.000Z');
    expect(toIsoTimestamp('2026-02-03 07:00:00.250')).toBe('2026-02-03T07:00:00.250Z');
  });

  it('rejects anything that is not a timestamp, and maps null to null for nullable columns', () => {
    expect(() => toIsoTimestamp(12345)).toThrow('neither a Date nor a string');
    expect(() => toIsoTimestamp(null)).toThrow('neither a Date nor a string');
    expect(toIsoTimestampOrNull(null)).toBeNull();
    expect(toIsoTimestampOrNull(undefined)).toBeNull();
    expect(toIsoTimestampOrNull(new Date('2026-02-03T07:00:00.000Z'))).toBe('2026-02-03T07:00:00.000Z');
  });
});
