import {
  brandIdSchema,
  brandQuerySchema,
  createRewardProfileSchema,
  currencySchema,
  maxBonusMinorSchema,
  startRideSchema,
  updateRewardProfileSchema,
} from '../../src/validation/schemas';
import { MAX_STAKE_MINOR, parseBonusCapMap, parseMinorUnits } from '../../src/money/minorUnits';
import { startRewardExpiryJob } from '../../src/services/rewardExpiryService';
import { createApiError } from '../../src/middleware/errorHandler';
import { ReasonCode, isReasonCode } from '../../src/types/reasonCodes';
import { toDTO as rewardToDTO } from '../../src/types/userReward';
import { toDTO as profileToDTO } from '../../src/types/rewardProfile';

const validProfile = {
  brand_id: 'brand-a',
  name: 'P',
  min_selections: 3,
  min_combined_odds: 3,
  min_selection_odds: 1.2,
  min_boost_pct: 0.05,
  max_boost_pct: 0.5,
  ride_duration_seconds: 60,
  max_bonus_minor: { EUR: 50_000 },
  reward_validity_seconds: 86_400,
};

describe('brand, money and validity schemas', () => {
  it('accepts brand ids of 1-64 letters, digits, underscore and hyphen', () => {
    for (const ok of ['a', 'Brand_1-x', 'x'.repeat(64)]) {
      expect(brandIdSchema.safeParse(ok).success).toBe(true);
    }
    for (const bad of ['', 'x'.repeat(65), 'has space', 'dot.ted', 'slash/y', 'ünï', '<b>']) {
      expect(brandIdSchema.safeParse(bad).success).toBe(false);
    }
  });

  it('requires brand_id on the brand-scoped query string and rejects repeated values', () => {
    expect(brandQuerySchema.safeParse({ brand_id: 'a' }).success).toBe(true);
    expect(brandQuerySchema.safeParse({}).success).toBe(false);
    expect(brandQuerySchema.safeParse({ brand_id: ['a', 'b'] }).success).toBe(false);
  });

  it('accepts three-letter uppercase currencies only', () => {
    expect(currencySchema.safeParse('EUR').success).toBe(true);
    for (const bad of ['eur', 'EU', 'EURO', 'E1R', '', ' EUR']) {
      expect(currencySchema.safeParse(bad).success).toBe(false);
    }
  });

  it('requires a non-empty map of currency to positive safe integer for bonus caps', () => {
    expect(maxBonusMinorSchema.safeParse({ EUR: 1, USD: Number.MAX_SAFE_INTEGER }).success).toBe(true);
    for (const bad of [
      {}, { EUR: 0 }, { EUR: -5 }, { EUR: 1.5 }, { eur: 5 }, { EURO: 5 }, { EUR: '5' },
      { EUR: Number.MAX_SAFE_INTEGER + 2 }, { EUR: Infinity }, { EUR: NaN },
    ]) {
      expect(maxBonusMinorSchema.safeParse(bad).success).toBe(false);
    }
    const tooMany = Object.fromEntries(
      Array.from({ length: 51 }, (_, i) => [String.fromCharCode(65 + (i % 26)) + String.fromCharCode(65 + Math.floor(i / 26)) + 'X', 1])
    );
    expect(maxBonusMinorSchema.safeParse(tooMany).success).toBe(false);
  });

  describe('profile create', () => {
    it('requires brand_id, max_bonus_minor and reward_validity_seconds', () => {
      expect(createRewardProfileSchema.safeParse(validProfile).success).toBe(true);
      for (const key of ['brand_id', 'max_bonus_minor', 'reward_validity_seconds']) {
        const { [key]: _omitted, ...rest } = validProfile as Record<string, unknown>;
        expect(createRewardProfileSchema.safeParse(rest).success).toBe(false);
      }
    });

    it.each([
      [59, false], [60, true], [61, true], [31_536_000, true], [31_536_001, false],
      [0, false], [-1, false], [60.5, false], [Number.NaN, false],
    ])('reward_validity_seconds %p -> accepted=%p', (value, accepted) => {
      expect(createRewardProfileSchema.safeParse({ ...validProfile, reward_validity_seconds: value }).success)
        .toBe(accepted);
    });
  });

  describe('profile update', () => {
    it('allows updating caps and validity but never the brand', () => {
      expect(updateRewardProfileSchema.safeParse({ max_bonus_minor: { USD: 100 } }).success).toBe(true);
      expect(updateRewardProfileSchema.safeParse({ reward_validity_seconds: 60 }).success).toBe(true);
      expect(updateRewardProfileSchema.safeParse({ reward_validity_seconds: 59 }).success).toBe(false);
      expect(updateRewardProfileSchema.safeParse({ max_bonus_minor: {} }).success).toBe(false);
      const brand = updateRewardProfileSchema.safeParse({ brand_id: 'other' });
      expect(brand.success).toBe(false);
      expect(JSON.stringify(brand)).toContain('immutable');
    });
  });

  describe('opt-in body', () => {
    const base = { user_id: 'u', bet_id: 'b', ticket: { selections: [{ id: 's', odds: 2 }] } };

    it.each([
      [1, true], [1000, true], [MAX_STAKE_MINOR, true],
      [0, false], [-1, false], [1.5, false], [MAX_STAKE_MINOR + 1, false],
      [Number.NaN, false], [Infinity, false], ['1000', false],
    ])('stake_minor %p -> accepted=%p', (stake, accepted) => {
      expect(startRideSchema.safeParse({ ...base, stake_minor: stake, currency: 'EUR' }).success).toBe(accepted);
    });

    it('requires stake_minor and currency, and keeps the deprecated ticket.stake optional', () => {
      expect(startRideSchema.safeParse({ ...base, currency: 'EUR' }).success).toBe(false);
      expect(startRideSchema.safeParse({ ...base, stake_minor: 1000 }).success).toBe(false);
      expect(startRideSchema.safeParse({ ...base, stake_minor: 1000, currency: 'eur' }).success).toBe(false);
      const withLegacyStake = { ...base, ticket: { ...base.ticket, stake: 10.5 } };
      expect(startRideSchema.safeParse({ ...withLegacyStake, stake_minor: 1000, currency: 'EUR' }).success).toBe(true);
    });
  });
});

describe('minor unit helpers', () => {
  it('reads bigint columns from SQLite (number) and PostgreSQL (string, bigint)', () => {
    expect(parseMinorUnits(null)).toBeNull();
    expect(parseMinorUnits(undefined)).toBeNull();
    expect(parseMinorUnits(1000)).toBe(1000);
    expect(parseMinorUnits('1000')).toBe(1000);
    expect(parseMinorUnits(BigInt(1000))).toBe(1000);
  });

  it('refuses amounts that are not safe integers instead of rounding them', () => {
    for (const bad of [1.5, '1.5', 'abc', Number.MAX_SAFE_INTEGER + 2, '9007199254740993', {}]) {
      expect(() => parseMinorUnits(bad)).toThrow('safe integer');
    }
  });

  it('parses stored cap maps in every shape the database can return', () => {
    expect(parseBonusCapMap('{"EUR":50000,"USD":"700"}')).toEqual({ EUR: 50000, USD: 700 });
    expect(parseBonusCapMap({ EUR: 5 })).toEqual({ EUR: 5 });
    for (const empty of [null, undefined, '', '{}', '[]', 'null', 5]) {
      expect(parseBonusCapMap(empty as never)).toEqual({});
    }
  });
});

describe('CURRENCY_NOT_SUPPORTED', () => {
  it('is a whitelisted reason code mapped to 422', () => {
    expect(isReasonCode('CURRENCY_NOT_SUPPORTED')).toBe(true);
    expect(createApiError('nope', ReasonCode.CURRENCY_NOT_SUPPORTED).statusCode).toBe(422);
  });
});

describe('DTO fallbacks for entities that predate Phase 1a', () => {
  const now = new Date().toISOString();

  it('reports brand default, no expiry and no money on a bare reward', () => {
    const dto = rewardToDTO({
      id: 'r', userId: 'u', profileVersionId: 'p', status: 'GRANTED', startTime: now, endTime: now,
      seed: 's', betId: null, ticketSnapshot: null, optedInAt: null, createdAt: now, updatedAt: now,
    });
    expect(dto).toMatchObject({
      brand_id: 'default', valid_until: null, stake_minor: null, currency: null,
      bonus_cap_minor: null, replaces_reward_id: null,
    });
  });

  it('reports brand default, empty caps and no validity on a bare profile', () => {
    const dto = profileToDTO({
      id: 'p', name: 'n', description: null, minSelections: 1, minCombinedOdds: 1, minSelectionOdds: 1,
      minBoostPct: 0, maxBoostPct: 1, maxBoostMinSelections: null, maxBoostMinCombinedOdds: null,
      maxEligibilitySelectionWeight: 0.75, maxEligibilityOddsWeight: 0.25, effectiveMinFloorRate: 0.35,
      rideMode: 'WAVES', rideDurationSeconds: 1, isActive: true, createdAt: now, updatedAt: now,
    });
    expect(dto).toMatchObject({ brand_id: 'default', max_bonus_minor: {}, reward_validity_seconds: null });
  });
});

describe('startRewardExpiryJob', () => {
  const result = { granted_expired: 1, entered_expired: 0, total_expired: 1, evaluated_at: 'now' };

  beforeEach(() => {
    jest.useFakeTimers();
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('starts nothing when the interval is 0', () => {
    const run = jest.fn();
    expect(startRewardExpiryJob(0, run)).toBeNull();
    jest.advanceTimersByTime(10_000);
    expect(run).not.toHaveBeenCalled();
  });

  it('runs on every interval and stops when asked', async () => {
    const run = jest.fn().mockResolvedValue(result);
    const job = startRewardExpiryJob(5, run)!;

    await jest.advanceTimersByTimeAsync(4_999);
    expect(run).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1);
    expect(run).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(5_000);
    expect(run).toHaveBeenCalledTimes(2);

    job.stop();
    await jest.advanceTimersByTimeAsync(20_000);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('never overlaps runs and survives a failing run', async () => {
    let release: (value: typeof result) => void = () => {};
    const run = jest.fn()
      .mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }))
      .mockRejectedValueOnce(new Error('db down'))
      .mockResolvedValue({ ...result, total_expired: 0 });
    const job = startRewardExpiryJob(1, run)!;

    await jest.advanceTimersByTimeAsync(3_000);
    expect(run).toHaveBeenCalledTimes(1); // still running: ticks are skipped

    release(result);
    await jest.advanceTimersByTimeAsync(1_000);
    expect(run).toHaveBeenCalledTimes(2); // this run fails, only logged
    expect(console.error).toHaveBeenCalledWith('[ERROR] Reward expiry job failed:', expect.any(Error));

    await jest.advanceTimersByTimeAsync(1_000);
    expect(run).toHaveBeenCalledTimes(3);
    job.stop();
  });
});
