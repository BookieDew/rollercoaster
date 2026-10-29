import {
  calculateSettlement,
  SettlementCalculationError,
  validateSettlementLegs,
} from '../../src/computations/settlementCalculator';
import type {
  SettlementCalculation,
  SettlementInput,
  SettlementLeg,
  SettlementLegResult,
  SettlementMinimums,
  SettlementOutcome,
} from '../../src/computations/settlementCalculator';
import { calculateCombinedOdds } from '../../src/computations/combinedOddsCalculator';
import type { Selection } from '../../src/types/ticket';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const MINIMUMS: SettlementMinimums = {
  minSelections: 3,
  minCombinedOdds: 3.0,
  minSelectionOdds: 1.2,
};

function sel(id: string, odds: number, extra: Partial<Selection> = {}): Selection {
  return { id, odds, ...extra };
}

function legsOf(results: Record<string, SettlementLegResult>): SettlementLeg[] {
  return Object.entries(results).map(([selection_id, result]) => ({ selection_id, result }));
}

function settle(overrides: Partial<SettlementInput> & Pick<SettlementInput, 'storedSelections'>): SettlementCalculation {
  return calculateSettlement({
    outcome: 'SETTLED',
    stakeMinor: 1000,
    lockedBoostPct: 0.2,
    bonusCapMinor: 50_000,
    minimums: MINIMUMS,
    ...overrides,
  });
}

function expectCalcError(fn: () => unknown, code: string): SettlementCalculationError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(SettlementCalculationError);
    expect((error as SettlementCalculationError).code).toBe(code);
    return error as SettlementCalculationError;
  }
  throw new Error(`expected SettlementCalculationError ${code}`);
}

const THREE_LEG_TICKET: Selection[] = [
  sel('a', 2.1),
  sel('b', 1.9),
  sel('c', 2.5),
];

// ---------------------------------------------------------------------------
// Worked examples
// ---------------------------------------------------------------------------

describe('settlementCalculator worked examples', () => {
  it('pays bonus on the total return: EUR 10.00 at 2.10/1.90/2.50, boost 20%', () => {
    const result = settle({
      storedSelections: THREE_LEG_TICKET,
      legs: legsOf({ a: 'WON', b: 'WON', c: 'WON' }),
    });
    expect(result).toEqual({
      betResult: 'WON',
      totalReturnMinor: 9975n,
      bonusMinor: 1995,
      capApplied: false,
      minimumsMet: null,
      issueReplacement: false,
    });
  });

  it('push (Draw No Bet draw) prices the leg at 1.00 and does not re-check minimums', () => {
    // Without a cancel the minimums are not re-evaluated, even though the
    // pushed leg no longer contributes to the price.
    const result = settle({
      storedSelections: THREE_LEG_TICKET,
      legs: legsOf({ a: 'WON', b: 'WON', c: 'PUSH' }),
      minimums: { minSelections: 3, minCombinedOdds: 9.0, minSelectionOdds: 1.2 },
    });
    expect(result).toEqual({
      betResult: 'WON',
      totalReturnMinor: 3990n, // 1000 x 2.10 x 1.90 x 1.00
      bonusMinor: 798,
      capApplied: false,
      minimumsMet: null,
      issueReplacement: false,
    });
  });

  it('cancel that keeps the minimums pays the bonus on the reduced return', () => {
    const result = settle({
      storedSelections: [...THREE_LEG_TICKET, sel('d', 1.5)],
      legs: legsOf({ a: 'WON', b: 'WON', c: 'WON', d: 'CANCELLED' }),
    });
    expect(result).toEqual({
      betResult: 'WON',
      totalReturnMinor: 9975n,
      bonusMinor: 1995,
      capApplied: false,
      minimumsMet: true,
      issueReplacement: false,
    });
  });

  it('cancel that breaks the minimum selection count → WON_NO_BONUS', () => {
    const result = settle({
      storedSelections: THREE_LEG_TICKET,
      legs: legsOf({ a: 'WON', b: 'WON', c: 'CANCELLED' }),
      minimums: { minSelections: 3, minCombinedOdds: 1.01, minSelectionOdds: 1.01 },
    });
    expect(result).toEqual({
      betResult: 'WON_NO_BONUS',
      totalReturnMinor: 3990n,
      bonusMinor: 0,
      capApplied: false,
      minimumsMet: false,
      issueReplacement: false,
    });
  });

  it('cancel that breaks the minimum combined odds → WON_NO_BONUS', () => {
    const result = settle({
      storedSelections: THREE_LEG_TICKET,
      legs: legsOf({ a: 'WON', b: 'WON', c: 'CANCELLED' }),
      minimums: { minSelections: 2, minCombinedOdds: 5.0, minSelectionOdds: 1.2 },
    });
    expect(result.betResult).toBe('WON_NO_BONUS');
    expect(result.totalReturnMinor).toBe(3990n);
    expect(result.bonusMinor).toBe(0);
    expect(result.minimumsMet).toBe(false);
  });

  it('cancel re-check counts PUSH legs at their ORIGINAL odds', () => {
    // Non-cancelled: a 2.10 WON + c 2.50 PUSH. Original-odds product 5.25 >= 5.0.
    // (At 1.00 the push would leave 2.10 and fail.)
    const result = settle({
      storedSelections: THREE_LEG_TICKET,
      legs: legsOf({ a: 'WON', b: 'CANCELLED', c: 'PUSH' }),
      minimums: { minSelections: 2, minCombinedOdds: 5.0, minSelectionOdds: 1.2 },
    });
    expect(result).toEqual({
      betResult: 'WON',
      totalReturnMinor: 2100n,
      bonusMinor: 420,
      capApplied: false,
      minimumsMet: true,
      issueReplacement: false,
    });
  });

  it('re-check applies min selection odds to the remaining legs', () => {
    const result = settle({
      storedSelections: [sel('a', 2.0), sel('b', 1.15), sel('c', 2.0), sel('d', 3.0)],
      legs: legsOf({ a: 'WON', b: 'WON', c: 'WON', d: 'CANCELLED' }),
      minimums: { minSelections: 3, minCombinedOdds: 1.5, minSelectionOdds: 1.2 },
    });
    expect(result.betResult).toBe('WON_NO_BONUS');
    expect(result.totalReturnMinor).toBe(4600n); // 1000 x 2 x 1.15 x 2
    expect(result.minimumsMet).toBe(false);
  });

  describe('SGP composite', () => {
    const ticket: Selection[] = [
      sel('a', 2.0),
      sel('sgp', 3.5, { selection_type: 'SGP_COMPOSITE', sgp_group_id: 'g1' }),
      sel('sgp-l1', 1.5, { selection_type: 'SGP_LEG', sgp_group_id: 'g1' }),
      sel('sgp-l2', 2.0, { selection_type: 'SGP_LEG', sgp_group_id: 'g1' }),
      sel('b', 1.8),
    ];

    it('counts once at its own price; SGP_LEG entries are not bet legs', () => {
      const legs = legsOf({ a: 'WON', sgp: 'WON', b: 'CANCELLED' });
      expect(validateSettlementLegs(ticket, legs)).toEqual([]);
      const result = settle({
        storedSelections: ticket,
        legs,
        minimums: { minSelections: 2, minCombinedOdds: 7.0, minSelectionOdds: 1.2 },
      });
      expect(result).toEqual({
        betResult: 'WON',
        totalReturnMinor: 7000n, // 1000 x 2.0 x 3.5 (SGP_LEG prices are illustrative)
        bonusMinor: 1400,
        capApplied: false,
        minimumsMet: true,
        issueReplacement: false,
      });
    });

    it('does not let SGP_LEG components lift the qualifying count', () => {
      const result = settle({
        storedSelections: ticket,
        legs: legsOf({ a: 'WON', sgp: 'WON', b: 'CANCELLED' }),
        minimums: { minSelections: 3, minCombinedOdds: 1.01, minSelectionOdds: 1.01 },
      });
      expect(result.betResult).toBe('WON_NO_BONUS');
      expect(result.minimumsMet).toBe(false);
    });

    it('a duplicate composite of the same group is a bet leg but qualifies only once', () => {
      const dupTicket: Selection[] = [
        sel('a', 2.0),
        sel('sgp1', 3.0, { selection_type: 'SGP_COMPOSITE', sgp_group_id: 'g1' }),
        sel('sgp2', 3.0, { selection_type: 'SGP_COMPOSITE', sgp_group_id: 'g1' }),
        sel('b', 1.8),
      ];
      const result = settle({
        storedSelections: dupTicket,
        legs: legsOf({ a: 'WON', sgp1: 'WON', sgp2: 'WON', b: 'CANCELLED' }),
        minimums: { minSelections: 3, minCombinedOdds: 1.01, minSelectionOdds: 1.01 },
      });
      expect(result.betResult).toBe('WON_NO_BONUS');
      expect(result.totalReturnMinor).toBe(18000n); // still priced as a bet leg
    });
  });

  describe('excluded / ineligible selections', () => {
    const ticket: Selection[] = [
      sel('a', 2.0),
      sel('b', 2.0),
      sel('x', 3.0, { eligible: false }),
      sel('y', 1.5, { ineligible_reason: 'MARKET_EXCLUDED' }),
      sel('c', 2.0),
    ];

    it('is a bet leg that must be settled', () => {
      const problems = validateSettlementLegs(ticket, legsOf({ a: 'WON', b: 'WON', c: 'WON', y: 'WON' }));
      expect(problems).toEqual([
        expect.objectContaining({ code: 'MISSING_LEG', selection_id: 'x' }),
      ]);
    });

    it('is priced in the return but does not qualify on the re-check', () => {
      const result = settle({
        storedSelections: ticket,
        legs: legsOf({ a: 'WON', b: 'WON', x: 'WON', y: 'WON', c: 'CANCELLED' }),
        minimums: { minSelections: 3, minCombinedOdds: 1.01, minSelectionOdds: 1.01 },
      });
      expect(result).toEqual({
        betResult: 'WON_NO_BONUS',
        totalReturnMinor: 18000n, // 1000 x 2 x 2 x 3 x 1.5
        bonusMinor: 0,
        capApplied: false,
        minimumsMet: false,
        issueReplacement: false,
      });
    });

    it('is priced in the return and the bonus applies to the whole return when minimums hold', () => {
      const result = settle({
        storedSelections: ticket,
        legs: legsOf({ a: 'WON', b: 'WON', x: 'WON', y: 'PUSH', c: 'CANCELLED' }),
        minimums: { minSelections: 2, minCombinedOdds: 4.0, minSelectionOdds: 1.01 },
      });
      expect(result.betResult).toBe('WON');
      expect(result.totalReturnMinor).toBe(12000n);
      expect(result.bonusMinor).toBe(2400);
      expect(result.minimumsMet).toBe(true);
    });
  });

  it('all PUSH → PUSHED, return equals stake, no bonus', () => {
    const result = settle({
      storedSelections: THREE_LEG_TICKET,
      legs: legsOf({ a: 'PUSH', b: 'PUSH', c: 'PUSH' }),
    });
    expect(result).toEqual({
      betResult: 'PUSHED',
      totalReturnMinor: 1000n,
      bonusMinor: 0,
      capApplied: false,
      minimumsMet: null,
      issueReplacement: false,
    });
  });

  it('PUSH + CANCELLED with no WON → PUSHED (no re-check, no replacement)', () => {
    const result = settle({
      storedSelections: THREE_LEG_TICKET,
      legs: legsOf({ a: 'PUSH', b: 'CANCELLED', c: 'PUSH' }),
    });
    expect(result).toEqual({
      betResult: 'PUSHED',
      totalReturnMinor: 1000n,
      bonusMinor: 0,
      capApplied: false,
      minimumsMet: null,
      issueReplacement: false,
    });
  });

  it('all CANCELLED legs → CANCELLED with a replacement', () => {
    const result = settle({
      storedSelections: THREE_LEG_TICKET,
      legs: legsOf({ a: 'CANCELLED', b: 'CANCELLED', c: 'CANCELLED' }),
    });
    expect(result).toEqual({
      betResult: 'CANCELLED',
      totalReturnMinor: null,
      bonusMinor: 0,
      capApplied: false,
      minimumsMet: null,
      issueReplacement: true,
    });
  });

  it('outcome CANCELLED → CANCELLED with a replacement, no legs', () => {
    const result = settle({ storedSelections: THREE_LEG_TICKET, outcome: 'CANCELLED' });
    expect(result).toEqual({
      betResult: 'CANCELLED',
      totalReturnMinor: null,
      bonusMinor: 0,
      capApplied: false,
      minimumsMet: null,
      issueReplacement: true,
    });
  });

  it('outcome CASHOUT → CASHED_OUT, token spent, return not reported', () => {
    const result = settle({ storedSelections: THREE_LEG_TICKET, outcome: 'CASHOUT', legs: [] });
    expect(result).toEqual({
      betResult: 'CASHED_OUT',
      totalReturnMinor: null,
      bonusMinor: 0,
      capApplied: false,
      minimumsMet: null,
      issueReplacement: false,
    });
  });

  it('any LOST leg → LOST even alongside WON, PUSH and CANCELLED legs', () => {
    const result = settle({
      storedSelections: [...THREE_LEG_TICKET, sel('d', 1.5)],
      legs: legsOf({ a: 'WON', b: 'PUSH', c: 'CANCELLED', d: 'LOST' }),
    });
    expect(result).toEqual({
      betResult: 'LOST',
      totalReturnMinor: 0n,
      bonusMinor: 0,
      capApplied: false,
      minimumsMet: null,
      issueReplacement: false,
    });
  });

  it('LOST takes precedence over every other leg being CANCELLED', () => {
    const result = settle({
      storedSelections: THREE_LEG_TICKET,
      legs: legsOf({ a: 'CANCELLED', b: 'LOST', c: 'CANCELLED' }),
    });
    expect(result.betResult).toBe('LOST');
    expect(result.issueReplacement).toBe(false);
  });

  describe('bonus cap', () => {
    // Uncapped bonus is exactly 1995 (9975 x 0.2).
    const base = {
      storedSelections: THREE_LEG_TICKET,
      legs: legsOf({ a: 'WON', b: 'WON', c: 'WON' }),
    };

    it('uncapped bonus exactly equal to the cap is paid in full, cap not applied', () => {
      const result = settle({ ...base, bonusCapMinor: 1995 });
      expect(result.bonusMinor).toBe(1995);
      expect(result.capApplied).toBe(false);
    });

    it('uncapped bonus one minor unit over the cap is cut to the cap', () => {
      const result = settle({ ...base, bonusCapMinor: 1994 });
      expect(result.bonusMinor).toBe(1994);
      expect(result.capApplied).toBe(true);
      expect(result.totalReturnMinor).toBe(9975n);
    });

    it('a zero cap pays no bonus and reports the cap as applied', () => {
      const result = settle({ ...base, bonusCapMinor: 0 });
      expect(result.bonusMinor).toBe(0);
      expect(result.capApplied).toBe(true);
    });

    it('a zero boost with a zero cap is not reported as capped', () => {
      const result = settle({ ...base, bonusCapMinor: 0, lockedBoostPct: 0 });
      expect(result).toMatchObject({ betResult: 'WON', bonusMinor: 0, capApplied: false });
    });
  });

  describe('half-up rounding', () => {
    it('rounds a total return of exactly .5 up (3 x 1.5 = 4.5 → 5, not banker\'s 4)', () => {
      const result = settle({
        storedSelections: [sel('a', 1.5)],
        legs: legsOf({ a: 'WON' }),
        stakeMinor: 3,
        lockedBoostPct: 0,
        minimums: { minSelections: 1, minCombinedOdds: 1, minSelectionOdds: 1 },
      });
      expect(result.totalReturnMinor).toBe(5n);
    });

    it('rounds a bonus of exactly .5 up (1005 x 0.5 = 502.5 → 503)', () => {
      const result = settle({
        storedSelections: [sel('a', 1.005)],
        legs: legsOf({ a: 'WON' }),
        lockedBoostPct: 0.5,
        minimums: { minSelections: 1, minCombinedOdds: 1, minSelectionOdds: 1 },
      });
      expect(result.totalReturnMinor).toBe(1005n);
      expect(result.bonusMinor).toBe(503);
    });

    it('rounds just below .5 down (499999 x 0.000001 = 0.499999 → 0; 500000 → 1)', () => {
      const common = {
        storedSelections: [sel('a', 1)],
        legs: legsOf({ a: 'WON' }),
        lockedBoostPct: 0.000001,
        minimums: { minSelections: 1, minCombinedOdds: 1, minSelectionOdds: 1 },
      };
      expect(settle({ ...common, stakeMinor: 499_999 }).bonusMinor).toBe(0);
      expect(settle({ ...common, stakeMinor: 500_000 }).bonusMinor).toBe(1);
    });

    it('rounds the total return once, not per leg (1 x 1.5 x 1.5 = 2.25 → 2)', () => {
      const result = settle({
        storedSelections: [sel('a', 1.5), sel('b', 1.5)],
        legs: legsOf({ a: 'WON', b: 'WON' }),
        stakeMinor: 1,
        minimums: { minSelections: 1, minCombinedOdds: 1, minSelectionOdds: 1 },
      });
      expect(result.totalReturnMinor).toBe(2n);
    });

    it('computes the bonus from the ROUNDED total return', () => {
      // 1 x 2.5 = 2.5 → 3; bonus 3 x 0.5 = 1.5 → 2 (unrounded would be 1.25 → 1).
      const result = settle({
        storedSelections: [sel('a', 2.5)],
        legs: legsOf({ a: 'WON' }),
        stakeMinor: 1,
        lockedBoostPct: 0.5,
        minimums: { minSelections: 1, minCombinedOdds: 1, minSelectionOdds: 1 },
      });
      expect(result.totalReturnMinor).toBe(3n);
      expect(result.bonusMinor).toBe(2);
    });

    it('uses 6-dp odds exactly', () => {
      const result = settle({
        storedSelections: [sel('a', 1.333333), sel('b', 2.000001)],
        legs: legsOf({ a: 'WON', b: 'WON' }),
        stakeMinor: 1_000_000_000,
        lockedBoostPct: 0.123457,
        bonusCapMinor: Number.MAX_SAFE_INTEGER,
        minimums: { minSelections: 1, minCombinedOdds: 1, minSelectionOdds: 1 },
      });
      // 1e9 x 1.333333 x 2.000001 = 2666667333.333 → 2666667333
      expect(result.totalReturnMinor).toBe(2_666_667_333n);
      // 2666667333 x 0.123457 = 329218749.03... → 329218749
      expect(result.bonusMinor).toBe(329_218_749);
    });
  });

  describe('minimums re-check edge cases', () => {
    it('uses an exact combined-odds comparison (opt-in float product would say not met)', () => {
      // 1.01 x 1.63 = 1.6463 exactly, but the IEEE-754 product is 1.6462999999999999.
      const remaining = [sel('a', 1.01), sel('b', 1.63)];
      expect(calculateCombinedOdds(remaining)).toBeLessThan(1.6463);
      const result = settle({
        storedSelections: [...remaining, sel('c', 2.0)],
        legs: legsOf({ a: 'WON', b: 'WON', c: 'CANCELLED' }),
        minimums: { minSelections: 2, minCombinedOdds: 1.6463, minSelectionOdds: 1.01 },
      });
      expect(result.minimumsMet).toBe(true);
      expect(result.betResult).toBe('WON');
    });

    it('fails one micro-unit above the exact combined odds', () => {
      const result = settle({
        storedSelections: [sel('a', 1.01), sel('b', 1.63), sel('c', 2.0)],
        legs: legsOf({ a: 'WON', b: 'WON', c: 'CANCELLED' }),
        minimums: { minSelections: 2, minCombinedOdds: 1.6463001, minSelectionOdds: 1.01 },
      });
      expect(result.minimumsMet).toBe(false);
    });

    it('an empty qualifying set has combined odds 0, as at opt-in', () => {
      const ticket = [sel('x', 3.0, { eligible: false }), sel('a', 2.0)];
      const legs = legsOf({ x: 'WON', a: 'CANCELLED' });
      expect(settle({
        storedSelections: ticket,
        legs,
        minimums: { minSelections: 0, minCombinedOdds: 0, minSelectionOdds: 1 },
      }).minimumsMet).toBe(true);
      expect(settle({
        storedSelections: ticket,
        legs,
        minimums: { minSelections: 0, minCombinedOdds: 1, minSelectionOdds: 1 },
      }).minimumsMet).toBe(false);
    });
  });

  it('is independent of leg order', () => {
    const ticket = [...THREE_LEG_TICKET, sel('d', 1.5)];
    const forward = settle({ storedSelections: ticket, legs: legsOf({ a: 'WON', b: 'PUSH', c: 'WON', d: 'CANCELLED' }) });
    const reversed = settle({ storedSelections: ticket, legs: legsOf({ d: 'CANCELLED', c: 'WON', b: 'PUSH', a: 'WON' }) });
    expect(reversed).toEqual(forward);
  });

  it('does not mutate its inputs', () => {
    const ticket = Object.freeze([
      Object.freeze(sel('a', 2.0)),
      Object.freeze(sel('x', 3.0, { eligible: false })),
      Object.freeze(sel('b', 2.0)),
      Object.freeze(sel('c', 1.1)),
    ]) as unknown as Selection[];
    const legs = Object.freeze(legsOf({ a: 'WON', x: 'WON', b: 'WON', c: 'CANCELLED' }).map((l) => Object.freeze(l)));
    const snapshot = JSON.stringify({ ticket, legs });
    const result = settle({
      storedSelections: ticket,
      legs: legs as SettlementLeg[],
      minimums: Object.freeze({ minSelections: 2, minCombinedOdds: 3, minSelectionOdds: 1.2 }),
    });
    expect(result.betResult).toBe('WON');
    expect(JSON.stringify({ ticket, legs })).toBe(snapshot);
  });
});

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

describe('validateSettlementLegs', () => {
  const ticket: Selection[] = [
    sel('a', 2.0),
    sel('sgp', 3.0, { selection_type: 'SGP_COMPOSITE', sgp_group_id: 'g1' }),
    sel('l1', 1.5, { selection_type: 'SGP_LEG', sgp_group_id: 'g1' }),
    sel('x', 1.5, { eligible: false }),
  ];

  it('accepts every bet leg exactly once in any order', () => {
    expect(validateSettlementLegs(ticket, legsOf({ x: 'LOST', sgp: 'PUSH', a: 'WON' }))).toEqual([]);
  });

  it('reports missing legs', () => {
    expect(validateSettlementLegs(ticket, legsOf({ a: 'WON' }))).toEqual([
      { code: 'MISSING_LEG', selection_id: 'sgp', message: expect.any(String) },
      { code: 'MISSING_LEG', selection_id: 'x', message: expect.any(String) },
    ]);
  });

  it('reports unknown selection ids', () => {
    expect(validateSettlementLegs(ticket, legsOf({ a: 'WON', sgp: 'WON', x: 'WON', nope: 'WON' }))).toEqual([
      { code: 'UNKNOWN_SELECTION', selection_id: 'nope', message: expect.any(String) },
    ]);
  });

  it('reports a duplicate once, however often it repeats', () => {
    const legs: SettlementLeg[] = [
      { selection_id: 'a', result: 'WON' },
      { selection_id: 'a', result: 'LOST' },
      { selection_id: 'a', result: 'WON' },
      { selection_id: 'sgp', result: 'WON' },
      { selection_id: 'x', result: 'WON' },
    ];
    expect(validateSettlementLegs(ticket, legs)).toEqual([
      { code: 'DUPLICATE_LEG', selection_id: 'a', message: expect.any(String) },
    ]);
  });

  it('rejects (does not ignore) a supplied SGP_LEG', () => {
    expect(validateSettlementLegs(ticket, legsOf({ a: 'WON', sgp: 'WON', x: 'WON', l1: 'WON' }))).toEqual([
      { code: 'SGP_LEG_NOT_A_BET_LEG', selection_id: 'l1', message: expect.any(String) },
    ]);
  });

  it('rejects malformed legs', () => {
    const legs = [
      { selection_id: 'a', result: 'VOID' },
      { selection_id: 7, result: 'WON' },
      null,
      { selection_id: 'sgp', result: 'WON' },
      { selection_id: 'x', result: 'WON' },
    ] as unknown as SettlementLeg[];
    expect(validateSettlementLegs(ticket, legs)).toEqual([
      { code: 'INVALID_LEG', selection_id: 'a', message: expect.stringContaining('legs[0]') },
      { code: 'INVALID_LEG', selection_id: null, message: expect.stringContaining('legs[1]') },
      { code: 'INVALID_LEG', selection_id: null, message: expect.stringContaining('legs[2]') },
      { code: 'MISSING_LEG', selection_id: 'a', message: expect.any(String) },
    ]);
  });

  it('reports a ticket with no bet legs', () => {
    expect(validateSettlementLegs([sel('l1', 1.5, { selection_type: 'SGP_LEG', sgp_group_id: 'g' })], [])).toEqual([
      { code: 'NO_BET_LEGS', selection_id: null, message: expect.any(String) },
    ]);
  });

  it('reports stored bet legs that share an id as ambiguous', () => {
    expect(validateSettlementLegs([sel('a', 2), sel('a', 3)], legsOf({ a: 'WON' }))).toEqual([
      { code: 'AMBIGUOUS_STORED_SELECTION', selection_id: 'a', message: expect.any(String) },
    ]);
  });

  it('collects several problems at once and never throws', () => {
    const problems = validateSettlementLegs(ticket, [
      { selection_id: 'a', result: 'WON' },
      { selection_id: 'a', result: 'WON' },
      { selection_id: 'zzz', result: 'WON' },
    ]);
    expect(problems.map((p) => [p.code, p.selection_id])).toEqual([
      ['DUPLICATE_LEG', 'a'],
      ['UNKNOWN_SELECTION', 'zzz'],
      ['MISSING_LEG', 'sgp'],
      ['MISSING_LEG', 'x'],
    ]);
  });
});

describe('calculateSettlement input guards', () => {
  const okLegs = legsOf({ a: 'WON', b: 'WON', c: 'WON' });

  it('throws INVALID_LEGS with the problem list for bad legs', () => {
    const error = expectCalcError(() => settle({
      storedSelections: THREE_LEG_TICKET,
      legs: legsOf({ a: 'WON', b: 'WON' }),
    }), 'INVALID_LEGS');
    expect(error.problems).toEqual([expect.objectContaining({ code: 'MISSING_LEG', selection_id: 'c' })]);
  });

  it('requires legs for SETTLED', () => {
    expectCalcError(() => settle({ storedSelections: THREE_LEG_TICKET }), 'INVALID_LEGS');
  });

  it.each(['CASHOUT', 'CANCELLED'] as SettlementOutcome[])('forbids legs for %s', (outcome) => {
    expectCalcError(() => settle({ storedSelections: THREE_LEG_TICKET, outcome, legs: okLegs }), 'INVALID_INPUT');
  });

  const invalidInputs: Array<[string, Partial<SettlementInput>]> = [
    ['unknown outcome', { outcome: 'VOID' as SettlementOutcome }],
    ['non-array storedSelections', { storedSelections: null as unknown as Selection[] }],
    ['non-array legs', { legs: {} as unknown as SettlementLeg[] }],
    ['zero stake', { stakeMinor: 0 }],
    ['fractional stake', { stakeMinor: 10.5 }],
    ['unsafe stake', { stakeMinor: Number.MAX_SAFE_INTEGER + 1 }],
    ['string stake', { stakeMinor: '1000' as unknown as number }],
    ['negative cap', { bonusCapMinor: -1 }],
    ['fractional cap', { bonusCapMinor: 0.5 }],
    ['boost with 7 dp', { lockedBoostPct: 0.1234567 }],
    ['negative boost', { lockedBoostPct: -0.1 }],
    ['NaN boost', { lockedBoostPct: Number.NaN }],
    ['infinite boost', { lockedBoostPct: Number.POSITIVE_INFINITY }],
    ['tiny boost in exponent form', { lockedBoostPct: 1e-7 }],
    ['missing minimums', { minimums: null as unknown as SettlementMinimums }],
    ['NaN minSelections', { minimums: { ...MINIMUMS, minSelections: Number.NaN } }],
    ['string minSelectionOdds', { minimums: { ...MINIMUMS, minSelectionOdds: '1.2' as unknown as number } }],
    ['negative minCombinedOdds', { minimums: { ...MINIMUMS, minCombinedOdds: -1 } }],
    ['infinite minCombinedOdds', { minimums: { ...MINIMUMS, minCombinedOdds: Number.POSITIVE_INFINITY } }],
  ];

  it.each(invalidInputs)('rejects %s', (_label, overrides) => {
    expectCalcError(() => settle({ storedSelections: THREE_LEG_TICKET, legs: okLegs, ...overrides }), 'INVALID_INPUT');
  });

  it('rejects a non-object input', () => {
    expectCalcError(() => calculateSettlement(null as unknown as SettlementInput), 'INVALID_INPUT');
  });

  it.each([
    ['7 dp', 1.0000001],
    ['zero', 0],
    ['negative', -2],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['string', '2.1' as unknown as number],
  ])('rejects stored odds that are %s', (_label, odds) => {
    expectCalcError(() => settle({
      storedSelections: [sel('a', 2.1), sel('b', odds)],
      legs: legsOf({ a: 'WON', b: 'WON' }),
    }), 'INVALID_INPUT');
  });

  it('validates odds even for legs that do not price (e.g. CANCELLED)', () => {
    expectCalcError(() => settle({
      storedSelections: [sel('a', 2.1), sel('b', 1.0000001)],
      legs: legsOf({ a: 'WON', b: 'CANCELLED' }),
    }), 'INVALID_INPUT');
  });

  it('accepts a minCombinedOdds with more than 6 dp and compares it exactly', () => {
    const result = settle({
      storedSelections: [sel('a', 2), sel('b', 2), sel('c', 2)],
      legs: legsOf({ a: 'WON', b: 'WON', c: 'CANCELLED' }),
      minimums: { minSelections: 2, minCombinedOdds: 4.0000000001, minSelectionOdds: 1 },
    });
    expect(result.minimumsMet).toBe(false);
  });

  it('parses large values printed in exponent form', () => {
    // String(1e21) === '1e+21'; parsed exactly, then the bonus is capped.
    const result = settle({
      storedSelections: [sel('a', 1)],
      legs: legsOf({ a: 'WON' }),
      lockedBoostPct: 1e21,
      bonusCapMinor: 12_345,
      minimums: { minSelections: 1, minCombinedOdds: 1, minSelectionOdds: 1 },
    });
    expect(result).toMatchObject({ totalReturnMinor: 1000n, bonusMinor: 12_345, capApplied: true });
  });
});

describe('large total returns (no size limit, exact BigInt)', () => {
  const minimums = { minSelections: 1, minCombinedOdds: 1, minSelectionOdds: 1 };

  it('returns the exact total when it exceeds MAX_SAFE_INTEGER', () => {
    const result = settle({
      storedSelections: [sel('a', 1.000001)],
      legs: legsOf({ a: 'WON' }),
      stakeMinor: Number.MAX_SAFE_INTEGER,
      minimums,
    });
    // 9007199254740991 x 1.000001 = 9007208261940245.740991 → 9007208261940246
    expect(result).toEqual({
      betResult: 'WON',
      totalReturnMinor: 9_007_208_261_940_246n,
      bonusMinor: 50_000,
      capApplied: true,
      minimumsMet: null,
      issueReplacement: false,
    });
  });

  it('returns exactly MAX_SAFE_INTEGER + 1', () => {
    // 2^52 x 2.0 = 2^53 = MAX_SAFE_INTEGER + 1
    const result = settle({
      storedSelections: [sel('a', 2.0)],
      legs: legsOf({ a: 'WON' }),
      stakeMinor: 2 ** 52,
      minimums,
    });
    expect(result.totalReturnMinor).toBe(2n ** 53n);
    expect(result).toMatchObject({ betResult: 'WON', bonusMinor: 50_000, capApplied: true });
  });

  it('handles huge odds printed in exponent form exactly', () => {
    const result = settle({
      storedSelections: [sel('a', 1e21)],
      legs: legsOf({ a: 'WON' }),
      stakeMinor: 1,
      minimums,
    });
    expect(result).toMatchObject({ betResult: 'WON', totalReturnMinor: 10n ** 21n, bonusMinor: 50_000, capApplied: true });
  });

  it('allows a total return of exactly MAX_SAFE_INTEGER', () => {
    const result = settle({
      storedSelections: [sel('a', 2.0), sel('b', 1.5)],
      legs: legsOf({ a: 'PUSH', b: 'PUSH' }),
      stakeMinor: Number.MAX_SAFE_INTEGER,
      minimums,
    });
    expect(result).toMatchObject({ betResult: 'PUSHED', totalReturnMinor: BigInt(Number.MAX_SAFE_INTEGER) });
  });

  it('settles 100 legs at odds 10,000 on a 1e12 stake: exact 10^412 return, bonus capped', () => {
    const storedSelections = Array.from({ length: 100 }, (_, i) => sel(`l${i}`, 10_000));
    const allWon = Object.fromEntries(storedSelections.map((s) => [s.id, 'WON'])) as Record<string, SettlementLegResult>;
    const result = settle({
      storedSelections,
      legs: legsOf(allWon),
      stakeMinor: 1_000_000_000_000,
      lockedBoostPct: 1,
      bonusCapMinor: 12_345,
      minimums,
    });
    expect(result).toEqual({
      betResult: 'WON',
      totalReturnMinor: 10n ** 412n,
      bonusMinor: 12_345,
      capApplied: true,
      minimumsMet: null,
      issueReplacement: false,
    });

    // The cap can be the largest safe integer: the bonus still never exceeds it.
    const maxCap = settle({
      storedSelections,
      legs: legsOf(allWon),
      stakeMinor: 1_000_000_000_000,
      bonusCapMinor: Number.MAX_SAFE_INTEGER,
      minimums,
    });
    expect(maxCap).toMatchObject({ bonusMinor: Number.MAX_SAFE_INTEGER, capApplied: true });

    // One leg cancelled: 99 legs at 10,000 still meet the minimums; return 10^408.
    const oneCancelled = settle({
      storedSelections,
      legs: legsOf({ ...allWon, l0: 'CANCELLED' }),
      stakeMinor: 1_000_000_000_000,
      bonusCapMinor: 12_345,
      minimums,
    });
    expect(oneCancelled).toMatchObject({
      betResult: 'WON', totalReturnMinor: 10n ** 408n, bonusMinor: 12_345, capApplied: true, minimumsMet: true,
    });

    // Minimums failing on a huge return pays no bonus but keeps the exact return.
    const noBonus = settle({
      storedSelections,
      legs: legsOf({ ...allWon, l0: 'CANCELLED' }),
      stakeMinor: 1_000_000_000_000,
      minimums: { minSelections: 100, minCombinedOdds: 1, minSelectionOdds: 1 },
    });
    expect(noBonus).toMatchObject({
      betResult: 'WON_NO_BONUS', totalReturnMinor: 10n ** 408n, bonusMinor: 0, capApplied: false, minimumsMet: false,
    });
  });

  it('settles LOST, CANCELLED and CASHOUT whatever the stake and odds', () => {
    const big = { storedSelections: [sel('a', 10_000), sel('b', 10_000)], stakeMinor: Number.MAX_SAFE_INTEGER, minimums };
    expect(settle({ ...big, legs: legsOf({ a: 'WON', b: 'LOST' }) }).betResult).toBe('LOST');
    expect(settle({ ...big, legs: legsOf({ a: 'CANCELLED', b: 'CANCELLED' }) }).betResult).toBe('CANCELLED');
    expect(settle({ ...big, outcome: 'CASHOUT' }).betResult).toBe('CASHED_OUT');
  });
});

// ---------------------------------------------------------------------------
// Property test against an independent exact-rational reference
// ---------------------------------------------------------------------------

/** mulberry32: small seeded PRNG. */
function makeRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Rational { n: bigint; d: bigint }

function gcd(a: bigint, b: bigint): bigint {
  let x = a < 0n ? -a : a;
  let y = b < 0n ? -b : b;
  while (y !== 0n) {
    [x, y] = [y, x % y];
  }
  return x;
}

function rat(n: bigint, d: bigint = 1n): Rational {
  const g = gcd(n, d) || 1n;
  return { n: n / g, d: d / g };
}

function mul(a: Rational, b: Rational): Rational {
  return rat(a.n * b.n, a.d * b.d);
}

function gte(a: Rational, b: Rational): boolean {
  return a.n * b.d >= b.n * a.d;
}

/** Reference half-up rounding: floor(x + 1/2) for x >= 0. */
function refRound(x: Rational): bigint {
  const twice = rat(2n * x.n + x.d, 2n * x.d);
  return twice.n / twice.d; // BigInt division floors for non-negative values
}

/** Reference decimal-string parser ("123.4500" style, no exponent). */
function ratFromDecimalString(text: string): Rational {
  const [whole, fraction = ''] = text.split('.');
  return rat(BigInt(whole + fraction), 10n ** BigInt(fraction.length));
}

function microsToString(micros: bigint): string {
  const whole = micros / 1_000_000n;
  const fraction = (micros % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : `${whole}`;
}

interface RefLeg {
  id: string;
  oddsMicros: bigint;
  type: 'STANDARD' | 'SGP_COMPOSITE' | 'SGP_LEG';
  group?: string;
  eligible?: boolean;
  ineligibleReason?: string;
}

interface RefCase {
  outcome: SettlementOutcome;
  stored: RefLeg[];
  results: Map<string, SettlementLegResult>;
  stake: bigint;
  boostMicros: bigint;
  cap: bigint;
  minSelections: number;
  minSelectionOdds: string;
  minCombinedOdds: string;
}

type RefResult = SettlementCalculation;

const MAX_SAFE_BIG = BigInt(Number.MAX_SAFE_INTEGER);

/**
 * Independent reference: exact rational arithmetic, written from the
 * contract text, sharing no code with the module.
 */
function referenceSettle(c: RefCase): RefResult {
  const none = { bonusMinor: 0, capApplied: false, minimumsMet: null } as const;
  if (c.outcome === 'CASHOUT') {
    return { betResult: 'CASHED_OUT', totalReturnMinor: null, ...none, issueReplacement: false };
  }
  if (c.outcome === 'CANCELLED') {
    return { betResult: 'CANCELLED', totalReturnMinor: null, ...none, issueReplacement: true };
  }
  const bets = c.stored.filter((leg) => leg.type !== 'SGP_LEG');
  const resultOf = (leg: RefLeg) => c.results.get(leg.id) as SettlementLegResult;
  if (bets.some((leg) => resultOf(leg) === 'LOST')) {
    return { betResult: 'LOST', totalReturnMinor: 0n, ...none, issueReplacement: false };
  }
  if (bets.every((leg) => resultOf(leg) === 'CANCELLED')) {
    return { betResult: 'CANCELLED', totalReturnMinor: null, ...none, issueReplacement: true };
  }
  let price = rat(1n);
  for (const leg of bets) {
    const legPrice = resultOf(leg) === 'WON' ? rat(leg.oddsMicros, 1_000_000n) : rat(1n);
    price = mul(price, legPrice);
  }
  const totalReturn = refRound(mul(rat(c.stake), price));
  if (!bets.some((leg) => resultOf(leg) === 'WON')) {
    return { betResult: 'PUSHED', totalReturnMinor: totalReturn, ...none, issueReplacement: false };
  }
  let minimumsMet: boolean | null = null;
  if (bets.some((leg) => resultOf(leg) === 'CANCELLED')) {
    const minSelectionOdds = ratFromDecimalString(c.minSelectionOdds);
    const groups = new Set<string>();
    const qualifying: RefLeg[] = [];
    for (const leg of bets) {
      if (resultOf(leg) === 'CANCELLED') continue;
      if (leg.eligible === false || leg.ineligibleReason) continue;
      if (leg.type === 'SGP_COMPOSITE' && leg.group !== undefined) {
        if (groups.has(leg.group)) continue;
        groups.add(leg.group);
      }
      if (gte(rat(leg.oddsMicros, 1_000_000n), minSelectionOdds)) {
        qualifying.push(leg);
      }
    }
    const combined = qualifying.length === 0
      ? rat(0n)
      : qualifying.reduce((acc, leg) => mul(acc, rat(leg.oddsMicros, 1_000_000n)), rat(1n));
    minimumsMet = qualifying.length >= c.minSelections
      && gte(combined, ratFromDecimalString(c.minCombinedOdds));
    if (!minimumsMet) {
      return {
        betResult: 'WON_NO_BONUS',
        totalReturnMinor: totalReturn,
        bonusMinor: 0,
        capApplied: false,
        minimumsMet: false,
        issueReplacement: false,
      };
    }
  }
  const uncapped = refRound(mul(rat(totalReturn), rat(c.boostMicros, 1_000_000n)));
  const capApplied = uncapped > c.cap;
  return {
    betResult: 'WON',
    totalReturnMinor: totalReturn,
    bonusMinor: Number(capApplied ? c.cap : uncapped),
    capApplied,
    minimumsMet,
    issueReplacement: false,
  };
}

function toModuleInput(c: RefCase, legOrder: SettlementLeg[]): SettlementInput {
  return {
    outcome: c.outcome,
    legs: c.outcome === 'SETTLED' ? legOrder : undefined,
    storedSelections: c.stored.map((leg) => {
      const selection: Selection = { id: leg.id, odds: Number(microsToString(leg.oddsMicros)) };
      // STANDARD is sometimes explicit and sometimes implied (undefined), as in stored tickets.
      if (leg.type !== 'STANDARD' || leg.id.endsWith('0')) selection.selection_type = leg.type;
      if (leg.group !== undefined) selection.sgp_group_id = leg.group;
      if (leg.eligible !== undefined) selection.eligible = leg.eligible;
      if (leg.ineligibleReason !== undefined) selection.ineligible_reason = leg.ineligibleReason;
      return selection;
    }),
    stakeMinor: Number(c.stake),
    lockedBoostPct: Number(microsToString(c.boostMicros)),
    bonusCapMinor: Number(c.cap),
    minimums: {
      minSelections: c.minSelections,
      minSelectionOdds: Number(c.minSelectionOdds),
      minCombinedOdds: Number(c.minCombinedOdds),
    },
  };
}

function runModule(input: SettlementInput): RefResult {
  return calculateSettlement(input);
}

/** JSON for failure messages and comparison; BigInt totals become strings. */
function stringify(value: unknown): string {
  return JSON.stringify(value, (_key, v) => (typeof v === 'bigint' ? `${v}n` : v));
}

function generateCase(rng: () => number): { refCase: RefCase; legOrder: SettlementLeg[] } {
  const int = (lo: number, hi: number) => lo + Math.floor(rng() * (hi - lo + 1));
  const pick = <T>(items: readonly T[]): T => items[Math.floor(rng() * items.length)];
  const bigUpTo = (max: bigint): bigint => {
    // 53 random bits, reduced into [0, max].
    const hi = BigInt(Math.floor(rng() * 2 ** 21));
    const lo = BigInt(Math.floor(rng() * 2 ** 32));
    return ((hi << 32n) | lo) % (max + 1n);
  };

  const oddsMicros = (): bigint => {
    const kind = rng();
    if (kind < 0.55) return BigInt(int(101, 500)) * 10_000n; // 2 dp, 1.01..5.00
    if (kind < 0.75) return BigInt(int(1_000_001, 3_000_000)); // 6 dp
    if (kind < 0.85) return BigInt(pick([1_500_000, 2_500_000, 1_250_000, 3_500_000, 1_005_000]));
    if (kind < 0.95) return BigInt(int(50, 500)) * 100_000n; // 1 dp, 5.0..50.0
    return BigInt(int(1, 10_000)) * 1_000_000n; // whole numbers up to 10,000
  };

  const stored: RefLeg[] = [];
  const betCount = int(1, 8);
  let counter = 0;
  for (let i = 0; i < betCount; i += 1) {
    const composite = rng() < 0.3;
    const leg: RefLeg = {
      id: `s${counter++}`,
      oddsMicros: oddsMicros(),
      type: composite ? 'SGP_COMPOSITE' : 'STANDARD',
    };
    if (composite) leg.group = pick(['g1', 'g2', 'g3']);
    const flag = rng();
    if (flag < 0.1) leg.eligible = false;
    else if (flag < 0.15) leg.ineligibleReason = 'EXCLUDED_MARKET';
    else if (flag < 0.2) leg.eligible = true;
    stored.push(leg);
    if (composite) {
      const components = int(0, 2);
      for (let k = 0; k < components; k += 1) {
        stored.push({ id: `s${counter++}`, oddsMicros: oddsMicros(), type: 'SGP_LEG', group: leg.group });
      }
    }
  }

  const outcomeRoll = rng();
  const outcome: SettlementOutcome = outcomeRoll < 0.9 ? 'SETTLED' : outcomeRoll < 0.95 ? 'CASHOUT' : 'CANCELLED';
  const allowLost = rng() < 0.2;
  const resultMode = rng();
  const results = new Map<string, SettlementLegResult>();
  for (const leg of stored) {
    if (leg.type === 'SGP_LEG') continue;
    let result: SettlementLegResult;
    if (resultMode < 0.05) result = 'CANCELLED';
    else if (resultMode < 0.1) result = pick(['PUSH', 'CANCELLED'] as const);
    else {
      const r = rng();
      result = r < 0.6 ? 'WON' : r < 0.72 ? 'PUSH' : r < 0.9 ? 'CANCELLED' : allowLost ? 'LOST' : 'WON';
    }
    results.set(leg.id, result);
  }

  const stakeRoll = rng();
  const stake = stakeRoll < 0.5 ? BigInt(int(1, 100_000))
    : stakeRoll < 0.65 ? BigInt(int(1, 999))
      : stakeRoll < 0.9 ? 1n + bigUpTo(1_000_000_000_000n - 1n)
        : 1n + bigUpTo(MAX_SAFE_BIG - 1n);

  const boostRoll = rng();
  const boostMicros = boostRoll < 0.55 ? BigInt(int(0, 1_000_000))
    : boostRoll < 0.8 ? BigInt(pick([500_000, 250_000, 125_000, 62_500, 31_250, 15_625, 5, 1]))
      : boostRoll < 0.85 ? 0n
        : BigInt(int(1_000_001, 3_000_000));

  const minSelections = int(0, 5);
  const minSelectionOdds = microsToString(rng() < 0.7 ? BigInt(int(100, 160)) * 10_000n : BigInt(int(1_000_000, 1_600_000)));

  // Combined-odds minimum: random, or exactly the product of two bet legs to hit the boundary.
  let minCombinedOdds: string;
  const bets = stored.filter((leg) => leg.type !== 'SGP_LEG');
  const combRoll = rng();
  if (combRoll < 0.25 && bets.length >= 2) {
    const product = pick(bets).oddsMicros * pick(bets).oddsMicros; // 12 dp
    const whole = product / 10n ** 12n;
    const fraction = (product % 10n ** 12n).toString().padStart(12, '0').replace(/0+$/, '');
    minCombinedOdds = fraction ? `${whole}.${fraction}` : `${whole}`;
    if (minCombinedOdds.replace('.', '').replace(/^0+/, '').length > 15) {
      minCombinedOdds = microsToString(BigInt(int(1_000_000, 20_000_000)));
    }
  } else if (combRoll < 0.35) {
    minCombinedOdds = '0';
  } else {
    minCombinedOdds = microsToString(rng() < 0.6 ? BigInt(int(100, 2000)) * 10_000n : BigInt(int(1_000_000, 20_000_000)));
  }

  const refCase: RefCase = {
    outcome,
    stored,
    results,
    stake,
    boostMicros,
    cap: 0n,
    minSelections,
    minSelectionOdds,
    minCombinedOdds,
  };

  // Cap: small, large, or within one unit of the uncapped bonus.
  const capRoll = rng();
  if (capRoll < 0.25) {
    refCase.cap = BigInt(int(0, 500));
  } else if (capRoll < 0.6) {
    refCase.cap = bigUpTo(MAX_SAFE_BIG);
  } else {
    refCase.cap = MAX_SAFE_BIG;
    const probe = referenceSettle(refCase);
    if (probe.betResult === 'WON') {
      const target = BigInt(probe.bonusMinor) + BigInt(int(-1, 1));
      refCase.cap = target < 0n ? 0n : target > MAX_SAFE_BIG ? MAX_SAFE_BIG : target;
    } else {
      refCase.cap = BigInt(int(0, 100_000));
    }
  }

  const legOrder: SettlementLeg[] = [...results.entries()].map(([selection_id, result]) => ({ selection_id, result }));
  for (let i = legOrder.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [legOrder[i], legOrder[j]] = [legOrder[j], legOrder[i]];
  }
  return { refCase, legOrder };
}

describe('settlementCalculator property test (exact-rational reference)', () => {
  it('agrees with the reference on every field for 12,000 seeded random tickets', () => {
    const rng = makeRng(0x5e771e);
    const tally: Record<string, number> = {};
    const bump = (key: string) => { tally[key] = (tally[key] ?? 0) + 1; };
    const CASES = 12_000;

    for (let i = 0; i < CASES; i += 1) {
      const { refCase, legOrder } = generateCase(rng);
      const input = toModuleInput(refCase, legOrder);
      const expected = referenceSettle(refCase);
      const actual = runModule(input);
      if (stringify(actual) !== stringify(expected)) {
        throw new Error(`case ${i} differs\ninput=${stringify(input)}\nexpected=${stringify(expected)}\nactual=${stringify(actual)}`);
      }
      expect(actual).toEqual(expected);

      // Totals above 2^53 - 1 (formerly AMOUNT_OVERFLOW) are now exact results.
      if (actual.totalReturnMinor !== null && actual.totalReturnMinor > MAX_SAFE_BIG) bump('BIG_RETURN');
      bump(actual.betResult);
      if (actual.capApplied) bump('capApplied');
      if (actual.minimumsMet === true) bump('minimumsMet:true');
      if (actual.minimumsMet === false) bump('minimumsMet:false');
      if (actual.betResult === 'WON') {
        // Count exact .5 ties in the bonus rounding: totalReturn x boostMicros ≡ 500000 (mod 1e6).
        const tie = ((actual.totalReturnMinor as bigint) * refCase.boostMicros) % 1_000_000n === 500_000n;
        if (tie) bump('bonusTie');
        if (BigInt(actual.bonusMinor) === refCase.cap && !actual.capApplied) bump('capBoundaryExact');
      }
    }

    // The generator must actually exercise every branch, or agreement proves little.
    for (const key of [
      'WON', 'WON_NO_BONUS', 'LOST', 'PUSHED', 'CANCELLED', 'CASHED_OUT', 'BIG_RETURN',
      'capApplied', 'capBoundaryExact', 'minimumsMet:true', 'minimumsMet:false', 'bonusTie',
    ]) {
      expect([key, (tally[key] ?? 0) >= 20]).toEqual([key, true]);
    }
  });
});
