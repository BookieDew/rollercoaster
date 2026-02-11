import {
  buildLinearEffectiveRidePath,
  calculateLinearBoostPctAtElapsed,
} from '../../src/computations/linearRideMode';

describe('linearRideMode', () => {
  it('calculates linear boost between effective min and max before crash', () => {
    const minBoost = 0.1;
    const maxBoost = 0.5;
    const crashPct = 0.8;

    expect(
      calculateLinearBoostPctAtElapsed(0, crashPct, minBoost, maxBoost)
    ).toBeCloseTo(minBoost, 6);
    expect(
      calculateLinearBoostPctAtElapsed(0.4, crashPct, minBoost, maxBoost)
    ).toBeCloseTo(0.3, 6);
    expect(
      calculateLinearBoostPctAtElapsed(0.8, crashPct, minBoost, maxBoost)
    ).toBeCloseTo(maxBoost, 6);
  });

  it('builds path that stays linear pre-crash and drops to zero after crash', () => {
    const points = buildLinearEffectiveRidePath(6, 0.6, 0.05, 0.35);

    expect(points).toHaveLength(6);
    expect(points[0].baseBoostValue).toBeCloseTo(0.05, 6);
    expect(points[2].baseBoostValue).toBeGreaterThan(points[1].baseBoostValue);
    expect(points[3].timePct).toBeCloseTo(0.6, 6);
    expect(points[3].baseBoostValue).toBe(0);
    expect(points[4].baseBoostValue).toBe(0);
    expect(points[5].baseBoostValue).toBe(0);
  });
});
