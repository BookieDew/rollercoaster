import { settlementService, roundToStoredWinnings } from '../../src/services/settlementService';
import { settlementRepository } from '../../src/db/repositories/settlementRepository';
import { betBoostLockRepository } from '../../src/db/repositories/betBoostLockRepository';
import { auditLogRepository } from '../../src/db/repositories/auditLogRepository';
import { ReasonCode } from '../../src/types/reasonCodes';
import type { SettlementRecord } from '../../src/types/settlement';
import type { BetBoostLock } from '../../src/types/betBoostLock';

function makeSettlement(overrides: Partial<SettlementRecord> = {}): SettlementRecord {
  return {
    id: 'settlement-1',
    betId: 'bet-1',
    outcome: 'WIN',
    winnings: 100,
    bonusAmount: 20,
    settledAt: '2026-10-29T00:00:00.000Z',
    createdAt: '2026-10-29T00:00:00.000Z',
    ...overrides,
  };
}

const lock = { id: 'lock-1', betId: 'bet-1', rewardId: 'reward-1', lockedBoostPct: 0.2 } as BetBoostLock;

describe('settlementService', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('roundToStoredWinnings', () => {
    it.each([
      [100, 100],
      [100.00004, 100],
      [100.00005, 100.0001],
      [1.00005, 1.0001],
      [0.12344999, 0.1234],
      [1_000_000_000, 1_000_000_000],
      [1e-7, 0],
      [0, 0],
    ])('%d -> %d', (input, expected) => {
      expect(roundToStoredWinnings(input)).toBe(expected);
    });
  });

  it('replays an identical settlement and rejects a conflicting one', async () => {
    jest.spyOn(settlementRepository, 'findByBetId').mockResolvedValue(makeSettlement());
    jest.spyOn(betBoostLockRepository, 'findByBetId').mockResolvedValue(lock);
    const create = jest.spyOn(settlementRepository, 'create');

    const identical = await settlementService.settleBet({ betId: 'bet-1', outcome: 'WIN', winnings: 100.00001 });
    expect(identical.success).toBe(true);
    expect(identical.data).toMatchObject({ settlement_id: 'settlement-1', bonus_amount: 20, locked_boost_pct: 0.2 });

    const otherOutcome = await settlementService.settleBet({ betId: 'bet-1', outcome: 'LOSS', winnings: 100 });
    const otherAmount = await settlementService.settleBet({ betId: 'bet-1', outcome: 'WIN', winnings: 99.99 });
    expect(otherOutcome.error?.code).toBe(ReasonCode.BET_ALREADY_SETTLED);
    expect(otherAmount.error?.code).toBe(ReasonCode.BET_ALREADY_SETTLED);
    expect(create).not.toHaveBeenCalled();
  });

  it('re-reads after a concurrent unique violation and applies the same replay rule', async () => {
    jest.spyOn(settlementRepository, 'findByBetId')
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(makeSettlement())
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(makeSettlement({ outcome: 'LOSS', winnings: 0, bonusAmount: 0 }));
    jest.spyOn(betBoostLockRepository, 'findByBetId').mockResolvedValue(lock);
    jest.spyOn(settlementRepository, 'create').mockRejectedValue({
      code: 'SQLITE_CONSTRAINT',
      message: 'UNIQUE constraint failed: settlement_records.bet_id',
    });
    const audit = jest.spyOn(auditLogRepository, 'append');

    const sameAsWinner = await settlementService.settleBet({ betId: 'bet-1', outcome: 'WIN', winnings: 100 });
    expect(sameAsWinner.success).toBe(true);
    expect(sameAsWinner.data?.settlement_id).toBe('settlement-1');

    const conflictingWithWinner = await settlementService.settleBet({ betId: 'bet-1', outcome: 'WIN', winnings: 100 });
    expect(conflictingWithWinner.error?.code).toBe(ReasonCode.BET_ALREADY_SETTLED);
    expect(audit).not.toHaveBeenCalled();
  });

  it('rethrows non-unique errors and unique errors with nothing to re-read', async () => {
    jest.spyOn(settlementRepository, 'findByBetId').mockResolvedValue(null);
    jest.spyOn(betBoostLockRepository, 'findByBetId').mockResolvedValue(lock);
    jest.spyOn(settlementRepository, 'create')
      .mockRejectedValueOnce(new Error('disk full'))
      .mockRejectedValueOnce({ code: '23505', message: 'duplicate key' });

    await expect(settlementService.settleBet({ betId: 'bet-1', outcome: 'WIN', winnings: 1 }))
      .rejects.toThrow('disk full');
    await expect(settlementService.settleBet({ betId: 'bet-1', outcome: 'WIN', winnings: 1 }))
      .rejects.toMatchObject({ code: '23505' });
  });

  it('writes the record and audit row in one scope and computes the bonus from the lock', async () => {
    jest.spyOn(settlementRepository, 'findByBetId').mockResolvedValue(null);
    jest.spyOn(betBoostLockRepository, 'findByBetId').mockResolvedValue(lock);
    const create = jest.spyOn(settlementRepository, 'create').mockImplementation(async (input) => makeSettlement({
      outcome: input.outcome,
      winnings: input.winnings,
      bonusAmount: input.bonusAmount,
    }));
    const audit = jest.spyOn(auditLogRepository, 'append').mockResolvedValue({} as never);

    const result = await settlementService.settleBet({ betId: 'bet-1', outcome: 'WIN', winnings: 50 });
    expect(result.data).toMatchObject({ outcome: 'WIN', winnings: 50, bonus_amount: 10, locked_boost_pct: 0.2 });
    expect(create.mock.calls[0][1]).toBeDefined();
    expect(audit.mock.calls[0][1]).toBe(create.mock.calls[0][1]);
  });
});
