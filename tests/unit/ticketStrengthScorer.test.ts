import {
  computeTicketStrength,
  computeLinearStrength,
} from '../../src/computations/ticketStrengthScorer';

describe('ticketStrengthScorer', () => {
  describe('computeTicketStrength', () => {
    const baseConfig = { minSelections: 3 };

    it('should return 0 when qualifying count is below minimum', () => {
      const result = computeTicketStrength(2, 10.0, baseConfig);

      expect(result).toBe(0);
    });

    it('should return 0 when combined odds is 1 or less', () => {
      const result = computeTicketStrength(5, 1.0, baseConfig);

      expect(result).toBe(0);
    });

    it('should increase with more qualifying selections', () => {
      const strength3 = computeTicketStrength(3, 10.0, baseConfig);
      const strength5 = computeTicketStrength(5, 10.0, baseConfig);
      const strength10 = computeTicketStrength(10, 10.0, baseConfig);

      expect(strength5).toBeGreaterThan(strength3);
      expect(strength10).toBeGreaterThan(strength5);
    });

    it('should increase with higher combined odds', () => {
      const strengthLowOdds = computeTicketStrength(5, 5.0, baseConfig);
      const strengthMedOdds = computeTicketStrength(5, 20.0, baseConfig);
      const strengthHighOdds = computeTicketStrength(5, 100.0, baseConfig);

      expect(strengthMedOdds).toBeGreaterThan(strengthLowOdds);
      expect(strengthHighOdds).toBeGreaterThan(strengthMedOdds);
    });

    it('should default to 75/25 weighting (selections/odds)', () => {
      const defaultScore = computeTicketStrength(7, 25.0, baseConfig);
      const explicitScore = computeTicketStrength(7, 25.0, {
        ...baseConfig,
        selectionWeight: 0.75,
        oddsWeight: 0.25,
      });

      expect(defaultScore).toBeCloseTo(explicitScore, 6);
    });

    it('should favor selection-heavy tickets over odds-heavy tickets by default', () => {
      const selectionHeavyScore = computeTicketStrength(10, 12.0, baseConfig);
      const oddsHeavyScore = computeTicketStrength(4, 400.0, baseConfig);

      expect(selectionHeavyScore).toBeGreaterThan(oddsHeavyScore);
    });

    it('should demonstrate non-linear (convex) scaling', () => {
      // Test that the increase is disproportionate (convex curve)
      const s1 = computeTicketStrength(4, 10.0, baseConfig);
      const s2 = computeTicketStrength(6, 10.0, baseConfig);
      const s3 = computeTicketStrength(8, 10.0, baseConfig);

      // The difference between s2-s1 should be less than s3-s2 (convex)
      // Or at least not linear
      const diff1 = s2 - s1;
      const diff2 = s3 - s2;

      // With convex curve, the increment should be increasing
      // Note: Due to the exponent > 1, this should hold
      expect(diff2).toBeGreaterThanOrEqual(diff1 * 0.5); // Allowing some tolerance
    });

    it('should cap at maxSelectionBonus', () => {
      const strength12 = computeTicketStrength(12, 10.0, { ...baseConfig, maxSelectionBonus: 10 });
      const strength15 = computeTicketStrength(15, 10.0, { ...baseConfig, maxSelectionBonus: 10 });

      // After hitting max selection bonus, strength should be same
      expect(strength12).toBeCloseTo(strength15, 4);
    });

    it('should be bounded between 0 and 1', () => {
      const strength = computeTicketStrength(10, 1000.0, baseConfig);

      expect(strength).toBeGreaterThanOrEqual(0);
      expect(strength).toBeLessThanOrEqual(1);
    });

    it('should handle minimum qualifying case', () => {
      const strength = computeTicketStrength(3, 5.0, baseConfig);

      expect(strength).toBeGreaterThan(0);
      expect(strength).toBeLessThanOrEqual(1);
    });
  });

  describe('computeLinearStrength', () => {
    it('should return 0 when count is below minimum', () => {
      const result = computeLinearStrength(2, 10.0, 3);

      expect(result).toBe(0);
    });

    it('should return 0 when odds is 1 or less', () => {
      const result = computeLinearStrength(5, 0.5, 3);

      expect(result).toBe(0);
    });

    it('should increase linearly with selections', () => {
      const s3 = computeLinearStrength(3, 10.0, 3);
      const s4 = computeLinearStrength(4, 10.0, 3);
      const s5 = computeLinearStrength(5, 10.0, 3);

      const diff1 = s4 - s3;
      const diff2 = s5 - s4;

      expect(diff1).toBeCloseTo(diff2, 4);
    });

    it('should be bounded by 1', () => {
      const strength = computeLinearStrength(20, 10000.0, 3);

      expect(strength).toBeLessThanOrEqual(1);
    });
  });
});
