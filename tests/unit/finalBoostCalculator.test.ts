import {
  calculateFinalBoost,
  calculateBonusAmount,
  clampValue,
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
