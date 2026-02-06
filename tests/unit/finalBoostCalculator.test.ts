import {
  calculateFinalBoost,
  calculateBonusAmount,
  calculateFinalBoostDetails,
  clampValue,
  computeBoostModelDetails,
  computeMaxEligibleBoostPct,
  formatBoostPercentage,
} from '../../src/computations/finalBoostCalculator';

describe('finalBoostCalculator', () => {
  describe('calculateFinalBoost', () => {
    const baseConfig = {
      minBoostPct: 0.05,
      maxBoostPct: 0.5,
      maxBoostMinSelections: null,
      maxBoostMinCombinedOdds: null,
    };
    const baseTicket = {
      qualifyingSelections: 3,
      combinedOdds: 10,
    };

    it('should return 0 when ride has ended', () => {
      const result = calculateFinalBoost({
        rideValue: 0.3,
        ticketStrength: 0.8,
        ...baseTicket,
        hasRideEnded: true,
        config: baseConfig,
      });

      expect(result).toBe(0);
    });

    it('should dampen ride value at minimum ticket strength', () => {
      const result = calculateFinalBoost({
        rideValue: 0.4,
        ticketStrength: 0,
        ...baseTicket,
        hasRideEnded: false,
        config: baseConfig,
      });

      expect(result).toBeCloseTo(0.135, 3);
    });

    it('should allow stronger tickets to reach higher boosts', () => {
      const result = calculateFinalBoost({
        rideValue: 0.4,
        ticketStrength: 1,
        ...baseTicket,
        hasRideEnded: false,
        config: baseConfig,
      });

      expect(result).toBeCloseTo(0.4375, 4);
    });

    it('should scale between low and high ticket strength', () => {
      const result = calculateFinalBoost({
        rideValue: 0.4,
        ticketStrength: 0.5,
        ...baseTicket,
        hasRideEnded: false,
        config: baseConfig,
      });

      expect(result).toBeCloseTo(0.2713, 4);
    });

    it('should clamp to minimum boost', () => {
      const result = calculateFinalBoost({
        rideValue: 0,
        ticketStrength: 0,
        ...baseTicket,
        hasRideEnded: false,
        config: {
          minBoostPct: 0.2,
          maxBoostPct: 0.5,
          maxBoostMinSelections: null,
          maxBoostMinCombinedOdds: null,
        },
      });

      expect(result).toBe(0.2);
    });

    it('should clamp to maximum boost', () => {
      const result = calculateFinalBoost({
        rideValue: 0.8,
        ticketStrength: 1,
        ...baseTicket,
        hasRideEnded: false,
        config: baseConfig,
      });

      // Raw = 0.8 * 1.0 = 0.8, but max is 0.5
      expect(result).toBe(0.5);
    });

    it('should handle edge case of zero ride value', () => {
      const result = calculateFinalBoost({
        rideValue: 0,
        ticketStrength: 0.8,
        ...baseTicket,
        hasRideEnded: false,
        config: baseConfig,
      });

      expect(result).toBe(0.05); // Clamped to min
    });
  });

  describe('calculateBonusAmount', () => {
    it('should calculate bonus as winnings * boost percentage', () => {
      const bonus = calculateBonusAmount(100, 0.25);

      expect(bonus).toBe(25);
    });

    it('should return 0 for zero winnings', () => {
      const bonus = calculateBonusAmount(0, 0.25);

      expect(bonus).toBe(0);
    });

    it('should return 0 for zero boost', () => {
      const bonus = calculateBonusAmount(100, 0);

      expect(bonus).toBe(0);
    });

    it('should return 0 for negative winnings', () => {
      const bonus = calculateBonusAmount(-100, 0.25);

      expect(bonus).toBe(0);
    });

    it('should return 0 for negative boost', () => {
      const bonus = calculateBonusAmount(100, -0.25);

      expect(bonus).toBe(0);
    });

    it('should handle decimal results', () => {
      const bonus = calculateBonusAmount(33.33, 0.15);

      expect(bonus).toBeCloseTo(4.9995, 4);
    });

    it('should round to 4 decimal places', () => {
      const bonus = calculateBonusAmount(100, 0.123456789);

      expect(bonus).toBe(12.3457);
    });
  });

  describe('computeMaxEligibleBoostPct', () => {
    it('returns configured max when no max-boost thresholds are set', () => {
      const effectiveMax = computeMaxEligibleBoostPct(8, 25, {
        minBoostPct: 0.05,
        maxBoostPct: 1.0,
        maxBoostMinSelections: null,
        maxBoostMinCombinedOdds: null,
      });

      expect(effectiveMax).toBe(1.0);
    });

    it('uses 75/25 weighting when both thresholds are configured', () => {
      const cfg = {
        minBoostPct: 0.05,
        maxBoostPct: 1.0,
        maxBoostMinSelections: 20,
        maxBoostMinCombinedOdds: 100,
      };

      const base = computeMaxEligibleBoostPct(8, 20, cfg);
      const improvedSelections = computeMaxEligibleBoostPct(10, 20, cfg); // +25% selection ratio
      const improvedOdds = computeMaxEligibleBoostPct(8, 25, cfg); // +25% odds ratio

      expect(improvedSelections).toBeGreaterThan(base);
      expect(improvedOdds).toBeGreaterThan(base);
      expect(improvedSelections - base).toBeGreaterThan(improvedOdds - base);
    });

    it('fully uses selections when only selection threshold is configured', () => {
      const cfg = {
        minBoostPct: 0.05,
        maxBoostPct: 1.0,
        maxBoostMinSelections: 20,
        maxBoostMinCombinedOdds: null,
      };

      const lowSelections = computeMaxEligibleBoostPct(8, 1_000, cfg);
      const highSelections = computeMaxEligibleBoostPct(16, 1_000, cfg);

      expect(highSelections).toBeGreaterThan(lowSelections);
    });

    it('fully uses odds when only odds threshold is configured', () => {
      const cfg = {
        minBoostPct: 0.05,
        maxBoostPct: 1.0,
        maxBoostMinSelections: null,
        maxBoostMinCombinedOdds: 100,
      };

      const lowOdds = computeMaxEligibleBoostPct(99, 20, cfg);
      const highOdds = computeMaxEligibleBoostPct(99, 80, cfg);

      expect(highOdds).toBeGreaterThan(lowOdds);
    });
  });

  describe('effective minimum boost floor', () => {
    it('lifts effective minimum for stronger tickets when thresholds are configured', () => {
      const cfg = {
        minBoostPct: 0.05,
        maxBoostPct: 1.0,
        maxBoostMinSelections: 20,
        maxBoostMinCombinedOdds: 100,
      };
      const weakModel = computeBoostModelDetails(6, 15, cfg);
      const strongModel = computeBoostModelDetails(14, 60, cfg);

      expect(weakModel.effectiveMinBoost).toBeGreaterThanOrEqual(cfg.minBoostPct);
      expect(strongModel.effectiveMinBoost).toBeGreaterThan(weakModel.effectiveMinBoost);
      expect(strongModel.effectiveMinBoost).toBeLessThanOrEqual(strongModel.effectiveMaxBoost);
    });

    it('keeps effective minimum at configured minimum when no thresholds are configured', () => {
      const cfg = {
        minBoostPct: 0.05,
        maxBoostPct: 1.0,
        maxBoostMinSelections: null,
        maxBoostMinCombinedOdds: null,
      };

      const model = computeBoostModelDetails(99, 10_000, cfg);
      expect(model.effectiveMinBoost).toBe(cfg.minBoostPct);
      expect(model.effectiveMaxBoost).toBe(cfg.maxBoostPct);
    });

    it('uses effective minimum in final boost clamping', () => {
      const cfg = {
        minBoostPct: 0.05,
        maxBoostPct: 1.0,
        maxBoostMinSelections: 20,
        maxBoostMinCombinedOdds: 100,
      };
      const details = calculateFinalBoostDetails({
        rideValue: 0,
        ticketStrength: 0,
        qualifyingSelections: 16,
        combinedOdds: 80,
        hasRideEnded: false,
        config: cfg,
      });

      expect(details.finalBoostPct).toBe(details.minBoost);
      expect(details.minBoost).toBeGreaterThan(cfg.minBoostPct);
    });
  });

  describe('clampValue', () => {
    it('should return value when within bounds', () => {
      expect(clampValue(0.5, 0, 1)).toBe(0.5);
    });

    it('should return min when value is below', () => {
      expect(clampValue(-0.5, 0, 1)).toBe(0);
    });

    it('should return max when value is above', () => {
      expect(clampValue(1.5, 0, 1)).toBe(1);
    });

    it('should return min when value equals min', () => {
      expect(clampValue(0, 0, 1)).toBe(0);
    });

    it('should return max when value equals max', () => {
      expect(clampValue(1, 0, 1)).toBe(1);
    });
  });

  describe('formatBoostPercentage', () => {
    it('should format 0.25 as 25.0%', () => {
      expect(formatBoostPercentage(0.25)).toBe('25.0%');
    });

    it('should format 0.123 as 12.3%', () => {
      expect(formatBoostPercentage(0.123)).toBe('12.3%');
    });

    it('should format 1.0 as 100.0%', () => {
      expect(formatBoostPercentage(1.0)).toBe('100.0%');
    });

    it('should format 0 as 0.0%', () => {
      expect(formatBoostPercentage(0)).toBe('0.0%');
    });

    it('should format 0.055 as 5.5%', () => {
      expect(formatBoostPercentage(0.055)).toBe('5.5%');
    });
  });
});
