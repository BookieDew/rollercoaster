import {
  settlementService,
  normalizeSettlementPayload,
  type SettleInput,
} from '../../src/services/settlementService';
import { settlementRepository } from '../../src/db/repositories/settlementRepository';
import { betBoostLockRepository } from '../../src/db/repositories/betBoostLockRepository';
import { userRewardRepository } from '../../src/db/repositories/userRewardRepository';
import { auditLogRepository } from '../../src/db/repositories/auditLogRepository';
import * as calculator from '../../src/computations/settlementCalculator';
import { ReasonCode } from '../../src/types/reasonCodes';
import type { BetSettlement } from '../../src/types/settlement';
import type { BetBoostLock } from '../../src/types/betBoostLock';
import type { UserReward } from '../../src/types/userReward';

const SELECTIONS = [
  { id: 'a', odds: 2.1 },
  { id: 'b', odds: 1.9 },
  { id: 'c', odds: 2.5 },
];

function makeLock(overrides: Partial<BetBoostLock> = {}): BetBoostLock {
  return {
    id: 'lock-1',
    brandId: 'brand-a',
    betId: 'bet-1',
    rewardId: 'reward-1',
    lockedBoostPct: 0.2,
    qualifyingSelections: 3,
    qualifyingOdds: 9.975,
    ticketStrength: 0.5,
    snapshot: { minSelections: 2, minCombinedOdds: 5, minSelectionOdds: 1.2 } as BetBoostLock['snapshot'],
    lockedAt: '2026-10-29T00:00:00.000Z',
    createdAt: '2026-10-29T00:00:00.000Z',
    ...overrides,
  };
}

function makeReward(overrides: Partial<UserReward> = {}): UserReward {
  return {
    id: 'reward-1',
    brandId: 'brand-a',
    userId: 'user-1',
    profileVersionId: 'profile-1',
    status: 'USED',
    startTime: '2026-10-29T00:00:00.000Z',
    endTime: '2026-10-29T00:00:10.000Z',
    seed: 'seed',
    betId: 'bet-1',
    ticketSnapshot: { selections: SELECTIONS },
    optedInAt: '2026-10-29T00:00:00.000Z',
    validUntil: null,
    stakeMinor: 1000,
    currency: 'EUR',
    bonusCapMinor: 50_000,
    replacesRewardId: null,
    createdAt: '2026-10-29T00:00:00.000Z',
    updatedAt: '2026-10-29T00:00:00.000Z',
    ...overrides,
  };
}

function makeSettlement(overrides: Partial<BetSettlement> = {}): BetSettlement {
  return {
    id: 'settlement-1',
    brandId: 'brand-a',
    betId: 'bet-1',
    lockId: 'lock-1',
    revision: 1,
    isCurrent: true,
    outcome: 'CANCELLED',
    betResult: 'CANCELLED',
    legs: null,
    currency: 'EUR',
    stakeMinor: 1000,
    totalReturnMinor: null,
    lockedBoostPct: 0.2,
    bonusMinor: 0,
    bonusCapMinor: 50_000,
    capApplied: false,
    minimumsMet: null,
    replacementRewardId: 'replacement-1',
    reason: null,
    settledAt: '2026-10-29T00:00:00.000Z',
    createdAt: '2026-10-29T00:00:00.000Z',
    ...overrides,
  };
}

const ALL_WON: SettleInput = {
  brandId: 'brand-a',
  betId: 'bet-1',
  outcome: 'SETTLED',
  legs: [
    { selection_id: 'c', result: 'WON' },
    { selection_id: 'a', result: 'WON' },
    { selection_id: 'b', result: 'WON' },
  ],
};

const UNIQUE_ERROR = { code: 'SQLITE_CONSTRAINT', message: 'UNIQUE constraint failed: bet_settlements.lock_id, bet_settlements.revision' };

describe('settlementService', () => {
  beforeEach(() => {
    jest.spyOn(betBoostLockRepository, 'findByBetId').mockResolvedValue(makeLock());
    jest.spyOn(userRewardRepository, 'findById').mockResolvedValue(makeReward());
    jest.spyOn(auditLogRepository, 'append').mockResolvedValue({} as never);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('normalizeSettlementPayload', () => {
    it('sorts legs by selection_id, drops extra keys and nulls legs outside SETTLED', () => {
      const legs = [
        { selection_id: 'b', result: 'WON' as const, extra: 1 },
        { selection_id: 'a', result: 'PUSH' as const },
        { selection_id: 'a', result: 'LOST' as const },
      ];
      expect(normalizeSettlementPayload('SETTLED', legs)).toEqual({
        outcome: 'SETTLED',
        legs: [
          { selection_id: 'a', result: 'LOST' },
          { selection_id: 'a', result: 'PUSH' },
          { selection_id: 'b', result: 'WON' },
        ],
      });
      expect(normalizeSettlementPayload('SETTLED', undefined)).toEqual({ outcome: 'SETTLED', legs: null });
      expect(normalizeSettlementPayload('CASHOUT', legs)).toEqual({ outcome: 'CASHOUT', legs: null });
    });
  });

  describe('missing snapshot data never computes a bonus', () => {
    it.each([
      ['no reward', null, makeLock()],
      ['no stake', makeReward({ stakeMinor: null }), makeLock()],
      ['no currency', makeReward({ currency: undefined }), makeLock()],
      ['no cap', makeReward({ bonusCapMinor: null }), makeLock()],
      ['no stored ticket', makeReward({ ticketSnapshot: null }), makeLock()],
      ['no minimums', makeReward(), makeLock({ snapshot: {} as BetBoostLock['snapshot'] })],
      ['a lock without a snapshot', makeReward(), makeLock({ snapshot: undefined as unknown as BetBoostLock['snapshot'] })],
    ])('%s -> 422 SETTLEMENT_UNAVAILABLE', async (_label, reward, lock) => {
      jest.spyOn(userRewardRepository, 'findById').mockResolvedValue(reward);
      jest.spyOn(betBoostLockRepository, 'findByBetId').mockResolvedValue(lock);
      const calculate = jest.spyOn(calculator, 'calculateSettlement');
      const create = jest.spyOn(settlementRepository, 'create');

      const result = await settlementService.settleBet(ALL_WON);
      expect(result.error?.code).toBe(ReasonCode.SETTLEMENT_UNAVAILABLE);
      expect(calculate).not.toHaveBeenCalled();
      expect(create).not.toHaveBeenCalled();
    });
  });

  describe('calculator errors', () => {
    it('maps INVALID_INPUT to SETTLEMENT_UNAVAILABLE without details and rethrows unexpected errors', async () => {
      jest.spyOn(betBoostLockRepository, 'findByBetId').mockResolvedValue(makeLock({ lockedBoostPct: 0.1234567 }));
      const invalid = await settlementService.settleBet(ALL_WON);
      expect(invalid.error?.code).toBe(ReasonCode.SETTLEMENT_UNAVAILABLE);
      expect(invalid.error?.details).toBeUndefined();
      expect(invalid.error?.message).not.toMatch(/0\.1234567|decimal/);

      jest.spyOn(calculator, 'calculateSettlement').mockImplementation(() => {
        throw new Error('boom');
      });
      await expect(settlementService.settleBet(ALL_WON)).rejects.toThrow('boom');
    });
  });

  describe('settleBet races', () => {
    it('rethrows non-unique errors and a unique error with no winner to re-read', async () => {
      jest.spyOn(settlementRepository, 'findCurrentByLockId').mockResolvedValue(null);
      jest.spyOn(settlementRepository, 'create')
        .mockRejectedValueOnce(new Error('disk full'))
        .mockRejectedValueOnce(UNIQUE_ERROR);

      await expect(settlementService.settleBet(ALL_WON)).rejects.toThrow('disk full');
      await expect(settlementService.settleBet(ALL_WON)).rejects.toMatchObject({ code: 'SQLITE_CONSTRAINT' });
    });

    it('writes the revision and its audit row in one scope', async () => {
      jest.spyOn(settlementRepository, 'findCurrentByLockId').mockResolvedValue(null);
      const create = jest.spyOn(settlementRepository, 'create')
        .mockImplementation(async (input) => makeSettlement({ ...input, isCurrent: true, createdAt: input.settledAt }));
      const audit = jest.spyOn(auditLogRepository, 'append');

      const result = await settlementService.settleBet(ALL_WON);
      expect(result.data).toMatchObject({
        revision: 1, bet_result: 'WON', total_return_minor: '9975', bonus_minor: 1995,
        legs: [
          { selection_id: 'a', result: 'WON' },
          { selection_id: 'b', result: 'WON' },
          { selection_id: 'c', result: 'WON' },
        ],
        previous_bonus_minor: null,
        bonus_delta_minor: null,
      });
      expect(create.mock.calls[0][1]).toBeDefined();
      expect(audit.mock.calls[0][1]).toBe(create.mock.calls[0][1]);
    });
  });

  describe('resettleBet', () => {
    const CASHOUT = { brandId: 'brand-a', betId: 'bet-1', outcome: 'CASHOUT' as const, reason: 'fix' };

    it('treats a unique violation as a race and answers 409 when the winner differs', async () => {
      jest.spyOn(settlementRepository, 'findCurrentByLockId')
        .mockResolvedValueOnce(makeSettlement())
        .mockResolvedValueOnce(makeSettlement({ id: 'settlement-2', revision: 2, outcome: 'SETTLED', betResult: 'LOST', legs: [] }));
      jest.spyOn(settlementRepository, 'markSuperseded').mockResolvedValue(true);
      jest.spyOn(userRewardRepository, 'findById')
        .mockResolvedValueOnce(makeReward())
        .mockResolvedValueOnce(makeReward({ id: 'replacement-1', status: 'GRANTED', betId: null }));
      jest.spyOn(userRewardRepository, 'updateStatus').mockResolvedValue(makeReward({ status: 'EXPIRED' }));
      jest.spyOn(settlementRepository, 'create').mockRejectedValue(UNIQUE_ERROR);

      const result = await settlementService.resettleBet(CASHOUT);
      expect(result.error?.code).toBe(ReasonCode.BET_ALREADY_SETTLED);
    });

    it('answers 409 when a race leaves no current revision to compare', async () => {
      jest.spyOn(settlementRepository, 'findCurrentByLockId')
        .mockResolvedValueOnce(makeSettlement({ betResult: 'CASHED_OUT', outcome: 'CASHOUT', replacementRewardId: null }))
        .mockResolvedValueOnce(null);
      jest.spyOn(settlementRepository, 'markSuperseded').mockResolvedValue(false);

      const result = await settlementService.resettleBet({ ...CASHOUT, outcome: 'CANCELLED' });
      expect(result.error?.code).toBe(ReasonCode.BET_ALREADY_SETTLED);
    });

    it('rethrows unexpected transaction errors', async () => {
      jest.spyOn(settlementRepository, 'findCurrentByLockId').mockResolvedValue(makeSettlement());
      jest.spyOn(settlementRepository, 'markSuperseded').mockRejectedValue(new Error('disk full'));
      await expect(settlementService.resettleBet(CASHOUT)).rejects.toThrow('disk full');
    });

    it.each([
      ['the replacement no longer exists', null, null],
      ['the replacement expired unused', makeReward({ id: 'replacement-1', status: 'EXPIRED', betId: null }), null],
    ])('needs no revocation when %s', async (_label, replacement, revoked) => {
      jest.spyOn(settlementRepository, 'findCurrentByLockId').mockResolvedValue(makeSettlement());
      jest.spyOn(settlementRepository, 'markSuperseded').mockResolvedValue(true);
      jest.spyOn(userRewardRepository, 'findById')
        .mockResolvedValueOnce(makeReward())
        .mockResolvedValueOnce(replacement);
      const updateStatus = jest.spyOn(userRewardRepository, 'updateStatus');
      jest.spyOn(settlementRepository, 'create')
        .mockImplementation(async (input) => makeSettlement({ ...input, isCurrent: true, createdAt: input.settledAt }));
      const audit = jest.spyOn(auditLogRepository, 'append');

      const result = await settlementService.resettleBet(CASHOUT);
      expect(result.data).toMatchObject({ revision: 2, bet_result: 'CASHED_OUT', replacement_reward_id: null });
      expect(updateStatus).not.toHaveBeenCalled();
      expect(audit).toHaveBeenCalledTimes(1);
      expect(audit.mock.calls[0][0].payload).toMatchObject({ revokedRewardId: revoked });
    });

    it.each([
      ['expired', makeReward({ id: 'replacement-1', status: 'EXPIRED', betId: null })],
      ['gone', null],
    ])('treats a replacement that was %s concurrently (unused) as revoked', async (_label, reread) => {
      jest.spyOn(settlementRepository, 'findCurrentByLockId').mockResolvedValue(makeSettlement());
      jest.spyOn(settlementRepository, 'markSuperseded').mockResolvedValue(true);
      jest.spyOn(userRewardRepository, 'findById')
        .mockResolvedValueOnce(makeReward())
        .mockResolvedValueOnce(makeReward({ id: 'replacement-1', status: 'GRANTED', betId: null }))
        .mockResolvedValueOnce(reread);
      jest.spyOn(userRewardRepository, 'updateStatus').mockResolvedValue(null);
      jest.spyOn(settlementRepository, 'create')
        .mockImplementation(async (input) => makeSettlement({ ...input, isCurrent: true, createdAt: input.settledAt }));
      const audit = jest.spyOn(auditLogRepository, 'append');

      const result = await settlementService.resettleBet(CASHOUT);
      expect(result.data).toMatchObject({ revision: 2, bet_result: 'CASHED_OUT', replacement_reward_id: null });
      expect(audit).toHaveBeenCalledTimes(1);
      expect(audit.mock.calls[0][0].payload).toMatchObject({ revokedRewardId: null });
    });

    it('fails safe (409, nothing written) when the re-read after a 0-row revoke still shows GRANTED', async () => {
      jest.spyOn(settlementRepository, 'findCurrentByLockId').mockResolvedValue(makeSettlement());
      jest.spyOn(settlementRepository, 'markSuperseded').mockResolvedValue(true);
      jest.spyOn(userRewardRepository, 'findById')
        .mockResolvedValueOnce(makeReward())
        .mockResolvedValueOnce(makeReward({ id: 'replacement-1', status: 'GRANTED', betId: null }))
        .mockResolvedValueOnce(makeReward({ id: 'replacement-1', status: 'GRANTED', betId: null }));
      jest.spyOn(userRewardRepository, 'updateStatus').mockResolvedValue(null);
      const create = jest.spyOn(settlementRepository, 'create');
      const audit = jest.spyOn(auditLogRepository, 'append');

      const result = await settlementService.resettleBet(CASHOUT);
      expect(result.error).toMatchObject({
        code: ReasonCode.REPLACEMENT_ALREADY_USED,
        details: { replacement_reward_id: 'replacement-1' },
      });
      expect(create).not.toHaveBeenCalled();
      expect(audit).not.toHaveBeenCalled();
    });

    it('treats a replacement opted into between the read and the revoke as used', async () => {
      jest.spyOn(settlementRepository, 'findCurrentByLockId').mockResolvedValue(makeSettlement());
      jest.spyOn(settlementRepository, 'markSuperseded').mockResolvedValue(true);
      jest.spyOn(userRewardRepository, 'findById')
        .mockResolvedValueOnce(makeReward())
        .mockResolvedValueOnce(makeReward({ id: 'replacement-1', status: 'GRANTED', betId: null }))
        .mockResolvedValueOnce(makeReward({ id: 'replacement-1', status: 'ENTERED', betId: 'bet-2' }));
      jest.spyOn(userRewardRepository, 'updateStatus').mockResolvedValue(null);
      const create = jest.spyOn(settlementRepository, 'create');

      const result = await settlementService.resettleBet(CASHOUT);
      expect(result.error).toMatchObject({
        code: ReasonCode.REPLACEMENT_ALREADY_USED,
        details: { replacement_reward_id: 'replacement-1' },
      });
      expect(create).not.toHaveBeenCalled();
    });

    it('reports a null previous bonus when the previous revision cannot be read', async () => {
      jest.spyOn(settlementRepository, 'findCurrentByLockId').mockResolvedValue(
        makeSettlement({ revision: 3, outcome: 'CASHOUT', betResult: 'CASHED_OUT', replacementRewardId: null })
      );
      jest.spyOn(settlementRepository, 'findRevision').mockResolvedValue(null);
      const replay = await settlementService.resettleBet(CASHOUT);
      expect(replay.data).toMatchObject({ revision: 3, previous_bonus_minor: null, bonus_delta_minor: null });
    });
  });
});
