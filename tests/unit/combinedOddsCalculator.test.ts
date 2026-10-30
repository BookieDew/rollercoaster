import {
  calculateCombinedOddsExact,
  meetsCombinedOddsThreshold,
  roundOdds,
} from '../../src/computations/combinedOddsCalculator';
import { toDecimalString, toFiniteNumber, type ExactDecimal } from '../../src/computations/v4';
import type { Selection } from '../../src/types/ticket';

const odds = (...values: number[]): Selection[] => values.map((value, i) => ({ id: String(i + 1), odds: value }));
const exact = (...values: number[]): ExactDecimal => calculateCombinedOddsExact(odds(...values));
const text = (...values: number[]): string => toDecimalString(exact(...values));

describe('combinedOddsCalculator (exact, V4)', () => {
  describe('calculateCombinedOddsExact', () => {
    it('should calculate the exact product of all odds', () => {
      expect(text(2.0, 3.0, 1.5)).toBe('9');
    });

    it('should return 0 for empty selections', () => {
      expect(calculateCombinedOddsExact([])).toEqual({ units: 0n, scale: 0 });
      expect(toFiniteNumber(calculateCombinedOddsExact([]))).toBe(0);
    });

    it('should return the odds for single selection', () => {
      expect(text(2.5)).toBe('2.5');
    });

    it('should handle decimal odds exactly', () => {
      expect(text(1.25, 1.5)).toBe('1.875');
      // 1.1 x 1.15 x 1.15 = 1.45475 exactly; the float product is 1.4547499999999998.
      expect(1.1 * 1.15 * 1.15).not.toBe(1.45475);
      expect(text(1.1, 1.15, 1.15)).toBe('1.45475');
    });

    it('should handle large combined odds', () => {
      expect(text(10.0, 10.0, 10.0)).toBe('1000');
    });

    it('keeps combined odds beyond the double range exact and finite in comparisons', () => {
      const product = exact(...Array.from({ length: 100 }, () => 10000));
      expect(toDecimalString(product)).toBe('1' + '0'.repeat(400));
      expect(toFiniteNumber(product)).toBeNull();
      expect(meetsCombinedOddsThreshold(product, 3)).toBe(true);
    });

    it('should handle odds of 1 (no impact)', () => {
      expect(text(2.0, 1.0, 3.0)).toBe('6');
    });
  });

  describe('meetsCombinedOddsThreshold', () => {
    it('should return true when odds meet threshold', () => {
      expect(meetsCombinedOddsThreshold(exact(3.0), 3.0)).toBe(true);
    });

    it('should return true when odds exceed threshold', () => {
      expect(meetsCombinedOddsThreshold(exact(5.0), 3.0)).toBe(true);
    });

    it('should return false when odds are below threshold', () => {
      expect(meetsCombinedOddsThreshold(exact(2.5), 3.0)).toBe(false);
    });

    it('should handle zero odds', () => {
      expect(meetsCombinedOddsThreshold(calculateCombinedOddsExact([]), 3.0)).toBe(false);
    });

    it('should handle zero threshold', () => {
      expect(meetsCombinedOddsThreshold(exact(1.0), 0)).toBe(true);
    });

    it('compares exactly where the float product would miss the target', () => {
      expect(meetsCombinedOddsThreshold(exact(1.1, 1.15, 1.15), 1.45475)).toBe(true);
      expect(meetsCombinedOddsThreshold(exact(1.1, 1.15, 1.15), 1.454751)).toBe(false);
      // Targets with more than 6 decimals or in exponent notation are read exactly.
      expect(meetsCombinedOddsThreshold(exact(3), 2.9999999)).toBe(true);
      expect(meetsCombinedOddsThreshold(exact(3), 3.0000001)).toBe(false);
      const legs = (n: number) => exact(...Array.from({ length: n }, () => 10000));
      expect(meetsCombinedOddsThreshold(legs(5), 1e21)).toBe(false); // 1e20 < 1e21
      expect(meetsCombinedOddsThreshold(legs(6), 1e24)).toBe(true);
      expect(meetsCombinedOddsThreshold(legs(6), 1.0000001e24)).toBe(false);
    });
  });

  describe('roundOdds', () => {
    it('should round to 4 decimal places by default', () => {
      expect(roundOdds(1.23456789)).toBe(1.2346);
    });

    it('should round to specified decimal places', () => {
      expect(roundOdds(1.23456789, 2)).toBe(1.23);
    });

    it('should handle whole numbers', () => {
      expect(roundOdds(5.0, 2)).toBe(5.0);
    });

    it('should round up correctly', () => {
      expect(roundOdds(1.2355, 3)).toBe(1.236);
    });

    it('should round down correctly', () => {
      expect(roundOdds(1.2344, 3)).toBe(1.234);
    });
  });
});
