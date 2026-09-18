import { buildEffectiveRidePath } from '../../src/computations/ridePathBuilder';
import { calculateFinalBoostDetails, interpolateRideValue } from '../../src/computations';

describe('ridePathBuilder', () => {
  const config = {
    minBoostPct: 0.05,
    maxBoostPct: 0.5,
    maxBoostMinSelections: null,
    maxBoostMinCombinedOdds: null,
  };

  it('should return empty path for invalid inputs', () => {
    expect(buildEffectiveRidePath([], 60, 0.8, 0.4, config, 6, 20)).toEqual([]);
    expect(
      buildEffectiveRidePath(
        [{ checkpointIndex: 0, timeOffsetPct: 0, baseBoostValue: 0.2 }],
        1,
        0.8,
        0.4,
        config,
        6,
        20
      )
    ).toEqual([]);
  });

  it('should keep crash-zone values at zero', () => {
    const checkpoints = [
      { checkpointIndex: 0, timeOffsetPct: 0, baseBoostValue: 0.3 },
      { checkpointIndex: 1, timeOffsetPct: 0.5, baseBoostValue: 0.4 },
      { checkpointIndex: 2, timeOffsetPct: 1, baseBoostValue: 0 },
    ];

    const crashPct = 0.6;
    const path = buildEffectiveRidePath(
      checkpoints,
      30,
      crashPct,
      0.5,
      config,
      6,
      20
    );

    for (const point of path) {
      if (point.timePct >= crashPct) {
        expect(point.baseBoostValue).toBe(0);
      }
    }
  });

  it('preserves authoritative clamped plateaus instead of inventing wave detail', () => {
    const checkpoints = [
      { checkpointIndex: 0, timeOffsetPct: 0, baseBoostValue: 0.44 },
      { checkpointIndex: 1, timeOffsetPct: 0.2, baseBoostValue: 0.49 },
      { checkpointIndex: 2, timeOffsetPct: 0.4, baseBoostValue: 0.46 },
      { checkpointIndex: 3, timeOffsetPct: 0.6, baseBoostValue: 0.495 },
      { checkpointIndex: 4, timeOffsetPct: 0.8, baseBoostValue: 0.47 },
      { checkpointIndex: 5, timeOffsetPct: 1, baseBoostValue: 0 },
    ];

    const crashPct = 0.9;
    const path = buildEffectiveRidePath(
      checkpoints,
      60,
      crashPct,
      1,
      config,
      10,
      50
    );

    const normalized = checkpoints.map(cp => ({ ...cp, index: cp.checkpointIndex }));
    for (const point of path) {
      const expected = calculateFinalBoostDetails({
        rideValue: interpolateRideValue(normalized, point.timePct),
        ticketStrength: 1,
        qualifyingSelections: 10,
        combinedOdds: 50,
        hasRideEnded: point.timePct >= crashPct,
        config,
      });
      expect(point.baseBoostValue).toBe(expected.finalBoostPct);
    }
    expect(path.filter(p => p.baseBoostValue === config.maxBoostPct).length).toBeGreaterThan(2);
  });
});
