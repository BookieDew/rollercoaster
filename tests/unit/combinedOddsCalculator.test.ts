import {
  calculateCombinedOdds,
  meetsCombinedOddsThreshold,
  roundOdds,
} from '../../src/computations/combinedOddsCalculator';
import type { Selection } from '../../src/types/ticket';

describe('combinedOddsCalculator', () => {
  describe('calculateCombinedOdds', () => {
    it('should calculate product of all odds', () => {
      const selections: Selection[] = [
        { id: '1', odds: 2.0 },
        { id: '2', odds: 3.0 },
        { id: '3', odds: 1.5 },
      ];

      const result = calculateCombinedOdds(selections);

      expect(result).toBe(9.0); // 2.0 * 3.0 * 1.5 = 9.0
    });

    it('should return 0 for empty selections', () => {
      const result = calculateCombinedOdds([]);

      expect(result).toBe(0);
    });

    it('should return the odds for single selection', () => {
      const selections: Selection[] = [{ id: '1', odds: 2.5 }];

      const result = calculateCombinedOdds(selections);

      expect(result).toBe(2.5);
    });

    it('should handle decimal odds correctly', () => {
      const selections: Selection[] = [
        { id: '1', odds: 1.25 },
        { id: '2', odds: 1.50 },
      ];

      const result = calculateCombinedOdds(selections);

      expect(result).toBeCloseTo(1.875, 4);
    });

    it('should handle large combined odds', () => {
      const selections: Selection[] = [
        { id: '1', odds: 10.0 },
        { id: '2', odds: 10.0 },
        { id: '3', odds: 10.0 },
      ];

      const result = calculateCombinedOdds(selections);

      expect(result).toBe(1000);
    });

    it('should handle odds of 1 (no impact)', () => {
      const selections: Selection[] = [
        { id: '1', odds: 2.0 },
        { id: '2', odds: 1.0 },
        { id: '3', odds: 3.0 },
      ];

      const result = calculateCombinedOdds(selections);

      expect(result).toBe(6.0);
    });
  });

  describe('meetsCombinedOddsThreshold', () => {
    it('should return true when odds meet threshold', () => {
      expect(meetsCombinedOddsThreshold(3.0, 3.0)).toBe(true);
    });

    it('should return true when odds exceed threshold', () => {
      expect(meetsCombinedOddsThreshold(5.0, 3.0)).toBe(true);
    });

    it('should return false when odds are below threshold', () => {
      expect(meetsCombinedOddsThreshold(2.5, 3.0)).toBe(false);
    });

    it('should handle zero odds', () => {
      expect(meetsCombinedOddsThreshold(0, 3.0)).toBe(false);
    });

    it('should handle zero threshold', () => {
      expect(meetsCombinedOddsThreshold(1.0, 0)).toBe(true);
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
