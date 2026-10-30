import {
  combinedOddsExact,
  compareExact,
  meetsTarget,
  parseOdds,
  ratioToTarget,
  toDecimalString,
  toFiniteNumber,
} from '../../../src/computations/v4';

describe('V4 exact combined odds (contract §4)', () => {
  it('multiplies decimal odds exactly, from numbers or strings', () => {
    expect(toDecimalString(combinedOddsExact([1.95, 2.1]))).toBe('4.095');
    expect(toDecimalString(combinedOddsExact(['1.95', '2.10']))).toBe('4.095');
    expect(toDecimalString(combinedOddsExact([4, 4, 4, 4, 4, 4, 4, 4, 4, 4]))).toBe('1048576');
    expect(toDecimalString(combinedOddsExact(['1.000001', '1.000001']))).toBe('1.000002000001');
    expect(toDecimalString(combinedOddsExact(['0.5']))).toBe('0.5');
    expect(toDecimalString(combinedOddsExact(['10000.000001']))).toBe('10000.000001');
    expect(combinedOddsExact([])).toEqual({ units: 0n, scale: 0 });
    expect(toDecimalString(combinedOddsExact([]))).toBe('0');
  });

  it('compares with targets exactly where a float product would miss', () => {
    // 1.1 * 1.15 * 1.15 is 1.45475 exactly, but 1.4547499999999998 in floating point.
    expect(1.1 * 1.15 * 1.15 < 1.45475).toBe(true);
    expect(meetsTarget([1.1, 1.15, 1.15], 1.45475)).toBe(true);
    expect(meetsTarget([1.1, 1.15, 1.15], '1.454751')).toBe(false);
    expect(ratioToTarget([1.1, 1.15, 1.15], 1.45475)).toBe(1);
    expect(meetsTarget([2, 1.5], 3)).toBe(true);
    expect(meetsTarget([], 3)).toBe(false);
  });

  it('keeps 100 legs at 10,000 exact, finite in ratio and renderable as a string', () => {
    const legs = Array.from({ length: 100 }, () => 10000);
    const product = combinedOddsExact(legs);
    expect(toDecimalString(product)).toBe('1' + '0'.repeat(400));
    expect(toFiniteNumber(product)).toBeNull();
    expect(meetsTarget(legs, 20)).toBe(true);
    expect(ratioToTarget(legs, 20)).toBe(1);
    expect(ratioToTarget(legs, '9999999999999999999999.999999')).toBe(1);
    const fractional = Array.from({ length: 100 }, () => '9999.999999');
    expect(meetsTarget(fractional, '1' + '0'.repeat(30))).toBe(true);
    expect(toDecimalString(combinedOddsExact(fractional)).length).toBeGreaterThan(400);
  });

  it('returns a finite ratio below 1 when the target is not met', () => {
    expect(ratioToTarget([2], 4)).toBe(0.5);
    expect(ratioToTarget([3.5], 20)).toBe(0.175);
    expect(ratioToTarget([10], 30)).toBe(1 / 3);
    expect(ratioToTarget([], 20)).toBe(0);
    const almost = ratioToTarget(['1.999999'], '2');
    expect(almost).toBeLessThan(1);
    expect(almost).toBeCloseTo(0.9999995, 12);
    const justBelow = ratioToTarget(Array.from({ length: 100 }, () => '1.000001'), '1' + '0'.repeat(20));
    expect(justBelow).toBeCloseTo(1.000100004950162e-20, 33); // 1.000001^100 / 1e20
    expect(ratioToTarget(['1.5'], '1' + '0'.repeat(400))).toBe(0);
    // 1 - 1e-18 is not representable; the ratio still stays strictly below 1.
    const tiny = ratioToTarget(['999999999999999999.999999'], '1000000000000000000');
    expect(tiny).toBeLessThan(1);
    expect(tiny).toBe(1 - Number.EPSILON / 2);
  });

  it('compares exact decimals of different scales', () => {
    const a = combinedOddsExact([1.5, 2]);
    const b = combinedOddsExact([3]);
    expect(compareExact(a, b)).toBe(0);
    expect(compareExact(combinedOddsExact([3.000001]), b)).toBe(1);
    expect(compareExact(b, combinedOddsExact([3.000001]))).toBe(-1);
    expect(toFiniteNumber(a)).toBe(3);
  });

  it('rejects malformed odds', () => {
    expect(parseOdds('1.25')).toBe(1250000n);
    expect(parseOdds(1.123456)).toBe(1123456n);
    for (const bad of ['1.1234567', 'abc', '-1', '1e5', ' 2', '2.', '.5', '0', '0.000000']) {
      expect(() => parseOdds(bad)).toThrow();
    }
    for (const bad of [1.1234567, 0, -2, NaN, Infinity, 1e10]) {
      expect(() => parseOdds(bad)).toThrow();
    }
    expect(() => meetsTarget([2], 0)).toThrow();
    expect(() => ratioToTarget([2], '0')).toThrow();
  });
});
