import {
  generateSeed,
  generateRide,
  interpolateRideValue,
  calculateElapsedPct,
  hasRideEnded,
} from '../../src/computations/deterministicRideGenerator';

describe('deterministicRideGenerator', () => {
  describe('generateSeed', () => {
    it('should generate consistent seed for same inputs', () => {
      const seed1 = generateSeed('reward-1', 'user-1', 'profile-1');
      const seed2 = generateSeed('reward-1', 'user-1', 'profile-1');

      expect(seed1).toBe(seed2);
    });

    it('should generate different seeds for different inputs', () => {
      const seed1 = generateSeed('reward-1', 'user-1', 'profile-1');
      const seed2 = generateSeed('reward-2', 'user-1', 'profile-1');
      const seed3 = generateSeed('reward-1', 'user-2', 'profile-1');

      expect(seed1).not.toBe(seed2);
      expect(seed1).not.toBe(seed3);
      expect(seed2).not.toBe(seed3);
    });

    it('should return a 64-character hex string', () => {
      const seed = generateSeed('reward-1', 'user-1', 'profile-1');

      expect(seed).toMatch(/^[a-f0-9]{64}$/);
    });
  });

  describe('generateRide', () => {
    const config = {
      checkpointCount: 10,
      volatility: 0.5,
      minBoostPct: 0.05,
      maxBoostPct: 0.5,
    };

    it('should generate deterministic ride for same seed', () => {
      const ride1 = generateRide('test-seed-123', config);
      const ride2 = generateRide('test-seed-123', config);

      expect(ride1.checkpoints).toEqual(ride2.checkpoints);
    });

    it('should generate different rides for different seeds', () => {
      const ride1 = generateRide('test-seed-1', config);
      const ride2 = generateRide('test-seed-2', config);

      expect(ride1.checkpoints).not.toEqual(ride2.checkpoints);
    });

    it('should generate correct number of checkpoints', () => {
      const ride = generateRide('test-seed', config);

      expect(ride.checkpoints).toHaveLength(config.checkpointCount);
    });

    it('should have checkpoints spanning 0 to 1 time offset', () => {
      const ride = generateRide('test-seed', config);

      expect(ride.checkpoints[0].timeOffsetPct).toBe(0);
      expect(ride.checkpoints[config.checkpointCount - 1].timeOffsetPct).toBe(1);
    });

    it('should crash to zero at the end', () => {
      const ride = generateRide('test-seed', config);
      const lastCheckpoint = ride.checkpoints[ride.checkpoints.length - 1];

      expect(lastCheckpoint.baseBoostValue).toBe(0);
    });

    it('should have values within min/max bounds (except crash)', () => {
      const ride = generateRide('test-seed', config);

      // All checkpoints except the last should be within bounds
      const nonCrashCheckpoints = ride.checkpoints.slice(0, -1);
      for (const cp of nonCrashCheckpoints) {
        expect(cp.baseBoostValue).toBeGreaterThanOrEqual(config.minBoostPct);
        expect(cp.baseBoostValue).toBeLessThanOrEqual(config.maxBoostPct);
      }
    });

    it('should show oscillation behavior', () => {
      const ride = generateRide('oscillation-test', {
        ...config,
        checkpointCount: 20,
        volatility: 0.8,
      });

      // Check that values go up and down (not monotonic)
      let increases = 0;
      let decreases = 0;

      for (let i = 1; i < ride.checkpoints.length - 1; i++) {
        const diff = ride.checkpoints[i].baseBoostValue - ride.checkpoints[i - 1].baseBoostValue;
        if (diff > 0) increases++;
        if (diff < 0) decreases++;
      }

      expect(increases).toBeGreaterThan(0);
      expect(decreases).toBeGreaterThan(0);
    });

    it('should bias opening direction upward for stronger tickets', () => {
      const samples = 3000;
      let weakStartsUp = 0;
      let strongStartsUp = 0;

      for (let i = 0; i < samples; i++) {
        const seed = `start-bias-${i}`;
        const weakRide = generateRide(seed, {
          ...config,
          ticketStrength: 0,
          durationSeconds: 10,
          crashPct: 0.8,
          minPeakDelaySeconds: 2,
        });
        const strongRide = generateRide(seed, {
          ...config,
          ticketStrength: 1,
          durationSeconds: 10,
          crashPct: 0.8,
          minPeakDelaySeconds: 2,
        });

        if (weakRide.checkpoints[1].baseBoostValue > weakRide.checkpoints[0].baseBoostValue) {
          weakStartsUp++;
        }
        if (strongRide.checkpoints[1].baseBoostValue > strongRide.checkpoints[0].baseBoostValue) {
          strongStartsUp++;
        }
      }

      expect(strongStartsUp).toBeGreaterThan(weakStartsUp);
    });

    it('should keep first peak at least 2 seconds from start when duration is provided', () => {
      const durationSeconds = 10;
      const crashPct = 0.85;
      const minPeakDelaySeconds = 2;
      const minAllowedPct = minPeakDelaySeconds / durationSeconds;

      for (let i = 0; i < 500; i++) {
        const ride = generateRide(`peak-delay-${i}`, {
          ...config,
          durationSeconds,
          crashPct,
          minPeakDelaySeconds,
        });

        const preCrash = ride.checkpoints.filter((cp) => cp.timeOffsetPct < crashPct);
        const maxValue = Math.max(...preCrash.map((cp) => cp.baseBoostValue));
        const earliestPeak = preCrash.find((cp) => cp.baseBoostValue === maxValue);

        expect(earliestPeak).toBeDefined();
        expect((earliestPeak?.timeOffsetPct ?? 0)).toBeGreaterThanOrEqual(minAllowedPct);
      }
    });
  });

  describe('interpolateRideValue', () => {
    const checkpoints = [
      { index: 0, timeOffsetPct: 0, baseBoostValue: 0.3 },
      { index: 1, timeOffsetPct: 0.5, baseBoostValue: 0.5 },
      { index: 2, timeOffsetPct: 1.0, baseBoostValue: 0 },
    ];

    it('should return first checkpoint value at time 0', () => {
      const value = interpolateRideValue(checkpoints, 0);

      expect(value).toBe(0.3);
    });

    it('should return last checkpoint value at time 1', () => {
      const value = interpolateRideValue(checkpoints, 1);

      expect(value).toBe(0);
    });

    it('should interpolate between checkpoints', () => {
      const value = interpolateRideValue(checkpoints, 0.25);

      // Linear interpolation between 0.3 and 0.5 at 50% of that segment
      expect(value).toBeCloseTo(0.4, 4);
    });

    it('should clamp values below 0', () => {
      const value = interpolateRideValue(checkpoints, -0.5);

      expect(value).toBe(0.3);
    });

    it('should clamp values above 1', () => {
      const value = interpolateRideValue(checkpoints, 1.5);

      expect(value).toBe(0);
    });

    it('should return 0 for empty checkpoints', () => {
      const value = interpolateRideValue([], 0.5);

      expect(value).toBe(0);
    });

    it('should handle single checkpoint', () => {
      const value = interpolateRideValue(
        [{ index: 0, timeOffsetPct: 0.5, baseBoostValue: 0.4 }],
        0.75
      );

      expect(value).toBe(0.4);
    });
  });

  describe('calculateElapsedPct', () => {
    it('should return 0 at start time', () => {
      const start = new Date('2024-01-01T12:00:00Z');
      const end = new Date('2024-01-01T13:00:00Z');
      const current = new Date('2024-01-01T12:00:00Z');

      const pct = calculateElapsedPct(start, end, current);

      expect(pct).toBe(0);
    });

    it('should return 1 at end time', () => {
      const start = new Date('2024-01-01T12:00:00Z');
      const end = new Date('2024-01-01T13:00:00Z');
      const current = new Date('2024-01-01T13:00:00Z');

      const pct = calculateElapsedPct(start, end, current);

      expect(pct).toBe(1);
    });

    it('should return 0.5 at midpoint', () => {
      const start = new Date('2024-01-01T12:00:00Z');
      const end = new Date('2024-01-01T13:00:00Z');
      const current = new Date('2024-01-01T12:30:00Z');

      const pct = calculateElapsedPct(start, end, current);

      expect(pct).toBe(0.5);
    });

    it('should handle ISO string inputs', () => {
      const pct = calculateElapsedPct(
        '2024-01-01T12:00:00Z',
        '2024-01-01T13:00:00Z',
        '2024-01-01T12:30:00Z'
      );

      expect(pct).toBe(0.5);
    });

    it('should return value > 1 after end time', () => {
      const start = new Date('2024-01-01T12:00:00Z');
      const end = new Date('2024-01-01T13:00:00Z');
      const current = new Date('2024-01-01T14:00:00Z');

      const pct = calculateElapsedPct(start, end, current);

      expect(pct).toBe(2);
    });

    it('should return 1 when start equals end', () => {
      const time = new Date('2024-01-01T12:00:00Z');

      const pct = calculateElapsedPct(time, time, time);

      expect(pct).toBe(1);
    });
  });

  describe('hasRideEnded', () => {
    it('should return false before end time', () => {
      const start = new Date('2024-01-01T12:00:00Z');
      const end = new Date('2024-01-01T13:00:00Z');
      const current = new Date('2024-01-01T12:30:00Z');

      expect(hasRideEnded(start, end, current)).toBe(false);
    });

    it('should return true at end time', () => {
      const start = new Date('2024-01-01T12:00:00Z');
      const end = new Date('2024-01-01T13:00:00Z');
      const current = new Date('2024-01-01T13:00:00Z');

      expect(hasRideEnded(start, end, current)).toBe(true);
    });

    it('should return true after end time', () => {
      const start = new Date('2024-01-01T12:00:00Z');
      const end = new Date('2024-01-01T13:00:00Z');
      const current = new Date('2024-01-01T14:00:00Z');

      expect(hasRideEnded(start, end, current)).toBe(true);
    });
  });
});
