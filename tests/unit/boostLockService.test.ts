import { boostLockService } from '../../src/services/boostLockService';
import { userRewardRepository } from '../../src/db/repositories/userRewardRepository';
import { rewardProfileRepository } from '../../src/db/repositories/rewardProfileRepository';
import { rideDefinitionRepository } from '../../src/db/repositories/rideDefinitionRepository';
import { betBoostLockRepository } from '../../src/db/repositories/betBoostLockRepository';
import { auditLogRepository } from '../../src/db/repositories/auditLogRepository';
import * as computations from '../../src/computations';
import { ReasonCode } from '../../src/types/reasonCodes';
import type { BetBoostLock, LockSnapshot } from '../../src/types/betBoostLock';
import type { RewardProfileVersion } from '../../src/types/rewardProfile';
import type { UserReward } from '../../src/types/userReward';

function makeReward(overrides: Partial<UserReward> = {}): UserReward {
  const now = new Date();
  const start = new Date(now.getTime() - 3_000).toISOString();
  const end = new Date(now.getTime() + 7_000).toISOString();
  return {
    id: 'reward-1',
    userId: 'user-1',
    profileVersionId: 'profile-1',
    status: 'ENTERED',
    startTime: start,
    endTime: end,
    seed: 'seed-1',
    betId: 'bet-1',
    ticketSnapshot: { selections: [{ id: 's1', odds: 1.8 }, { id: 's2', odds: 1.9 }] },
    optedInAt: now.toISOString(),
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    ...overrides,
  };
}

function makeProfile(overrides: Partial<RewardProfileVersion> = {}): RewardProfileVersion {
  const now = new Date().toISOString();
  return {
    id: 'profile-1',
    name: 'Profile',
    description: null,
    minSelections: 2,
    minCombinedOdds: 3,
    minSelectionOdds: 1.3,
    minBoostPct: 0.05,
    maxBoostPct: 1,
    maxBoostMinSelections: 10,
    maxBoostMinCombinedOdds: 50,
    maxEligibilitySelectionWeight: 0.75,
    maxEligibilityOddsWeight: 0.25,
    effectiveMinFloorRate: 0.35,
    rideMode: 'WAVES',
    rideDurationSeconds: 10,
    isActive: true,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function makeSnapshot(): LockSnapshot {
  return {
    selections: [{ id: 's1', odds: 1.8 }],
    disqualifiedSelections: [],
    profileId: 'profile-1',
    rideMode: 'WAVES',
    minSelections: 2,
    minCombinedOdds: 3,
    minSelectionOdds: 1.3,
    minBoostPct: 0.05,
    maxBoostPct: 1,
    maxBoostMinSelections: 10,
    maxBoostMinCombinedOdds: 50,
    maxEligibilitySelectionWeight: 0.75,
    maxEligibilityOddsWeight: 0.25,
    effectiveMinFloorRate: 0.35,
    rideDurationSeconds: 10,
    checkpointCount: 10,
    volatility: 0.4,
    seed: 'seed-1',
    crashPct: 0.8,
    totalSelectionCount: 2,
    qualifyingSelectionCount: 2,
    combinedOdds: 3.4,
    ticketStrength: 0.4,
    rideValue: 0.2,
    maxRideValue: 0.6,
    elapsedPct: 0.3,
    effectiveMinBoostPct: 0.1,
    maxEligibleBoostPct: 0.6,
    maxPossibleBoostPct: 0.7,
    boostModel: {
      selectionWeight: 0.75,
      oddsWeight: 0.25,
      maxEligibilityExponent: 1.2,
      effectiveMinFloorRate: 0.35,
      selectionRatio: 0.5,
      oddsRatio: 0.5,
      eligibilityFactor: 0.5,
    },
    ridePath: [{ timePct: 0, baseBoostValue: 0.1 }, { timePct: 1, baseBoostValue: 0 }],
  };
}

function makeLock(overrides: Partial<BetBoostLock> = {}): BetBoostLock {
  const now = new Date().toISOString();
  return {
    id: 'lock-1',
    betId: 'bet-1',
    rewardId: 'reward-1',
    lockedBoostPct: 0.2,
    qualifyingSelections: 2,
    qualifyingOdds: 3.4,
    ticketStrength: 0.4,
    snapshot: makeSnapshot(),
    lockedAt: now,
    createdAt: now,
    ...overrides,
  };
}

function setupCoreMocks(): void {
  jest.spyOn(computations, 'filterQualifyingSelections').mockReturnValue({
    qualifying: [{ id: 's1', odds: 1.8 }, { id: 's2', odds: 1.9 }],
    disqualified: [],
  });
  jest.spyOn(computations, 'calculateCombinedOdds').mockReturnValue(3.42);
  jest.spyOn(computations, 'meetsMinSelectionCount').mockReturnValue(true);
  jest.spyOn(computations, 'meetsCombinedOddsThreshold').mockReturnValue(true);
  jest.spyOn(computations, 'computeTicketStrength').mockReturnValue(0.41);
  jest.spyOn(computations, 'computeBoostModelDetails').mockReturnValue({
    selectionWeight: 0.75,
    oddsWeight: 0.25,
    maxEligibilityExponent: 1.2,
    effectiveMinFloorRate: 0.35,
    selectionRatio: 0.5,
    oddsRatio: 0.5,
    eligibilityFactor: 0.5,
    effectiveMinBoost: 0.1,
    effectiveMaxBoost: 0.62,
  });
  jest.spyOn(computations, 'calculateElapsedPct').mockReturnValue(0.3);
  jest.spyOn(computations, 'deriveRideParams').mockReturnValue({
    checkpointCount: 10,
    volatility: 0.4,
    crashPct: 0.8,
  });
  jest.spyOn(computations, 'hasRideEnded').mockReturnValue(false);
  jest.spyOn(computations, 'calculateFinalBoostDetails')
    .mockReturnValueOnce({
      finalBoostPct: 0.2,
      minBoost: 0.1,
      effectiveMaxBoost: 0.62,
      rawBoost: 0.2,
      isClampedToMax: false,
      isClampedToMin: false,
      boostModel: {
        selectionWeight: 0.75,
        oddsWeight: 0.25,
        maxEligibilityExponent: 1.2,
        effectiveMinFloorRate: 0.35,
        selectionRatio: 0.5,
        oddsRatio: 0.5,
        eligibilityFactor: 0.5,
        effectiveMinBoost: 0.1,
        effectiveMaxBoost: 0.62,
      },
    })
    .mockReturnValueOnce({
      finalBoostPct: 0.4,
      minBoost: 0.1,
      effectiveMaxBoost: 0.62,
      rawBoost: 0.4,
      isClampedToMax: false,
      isClampedToMin: false,
      boostModel: {
        selectionWeight: 0.75,
        oddsWeight: 0.25,
        maxEligibilityExponent: 1.2,
        effectiveMinFloorRate: 0.35,
        selectionRatio: 0.5,
        oddsRatio: 0.5,
        eligibilityFactor: 0.5,
        effectiveMinBoost: 0.1,
        effectiveMaxBoost: 0.62,
      },
    });
  jest.spyOn(computations, 'interpolateRideValue').mockReturnValue(0.25);
  jest.spyOn(computations, 'buildEffectiveRidePath').mockReturnValue([
    { timePct: 0, baseBoostValue: 0.1 },
    { timePct: 1, baseBoostValue: 0 },
  ]);
  jest.spyOn(computations, 'buildLinearEffectiveRidePath').mockReturnValue([
    { timePct: 0, baseBoostValue: 0.1 },
    { timePct: 1, baseBoostValue: 0 },
  ]);
  jest.spyOn(computations, 'calculateLinearBoostPctAtElapsed').mockReturnValue(0.33);
  jest.spyOn(betBoostLockRepository, 'create').mockResolvedValue(makeLock());
  jest.spyOn(rideDefinitionRepository, 'findByRewardId').mockResolvedValue([
    { id: 'cp-1', rewardId: 'reward-1', checkpointIndex: 0, timeOffsetPct: 0, baseBoostValue: 0.1, createdAt: new Date().toISOString() },
    { id: 'cp-2', rewardId: 'reward-1', checkpointIndex: 1, timeOffsetPct: 0.6, baseBoostValue: 0.4, createdAt: new Date().toISOString() },
    { id: 'cp-3', rewardId: 'reward-1', checkpointIndex: 2, timeOffsetPct: 1, baseBoostValue: 0, createdAt: new Date().toISOString() },
  ]);
  jest.spyOn(userRewardRepository, 'updateStatus').mockResolvedValue(makeReward({ status: 'USED' }));
  jest.spyOn(auditLogRepository, 'append').mockResolvedValue({
    id: 'audit-1',
    entityType: 'bet_boost_lock',
    entityId: 'lock-1',
    action: 'LOCK',
    payload: {},
    timestamp: new Date().toISOString(),
    createdAt: new Date().toISOString(),
  });
}

describe('boostLockService', () => {
  const input = { userId: 'user-1', rewardId: 'reward-1', betId: 'bet-1' };

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('returns existing lock for idempotent lock requests from the owning user and reward', async () => {
    jest.spyOn(betBoostLockRepository, 'findByBetId').mockResolvedValue(makeLock());
    jest.spyOn(userRewardRepository, 'findById').mockResolvedValue(makeReward({ status: 'USED' }));

    const result = await boostLockService.lockBoost(input);
    expect(result.success).toBe(true);
    expect(result.data?.lock_id).toBe('lock-1');
  });

  it('rejects an existing lock for another reward, another user or a missing reward with BET_ALREADY_LOCKED', async () => {
    jest.spyOn(betBoostLockRepository, 'findByBetId').mockResolvedValue(makeLock());
    const findReward = jest.spyOn(userRewardRepository, 'findById')
      .mockResolvedValueOnce(makeReward({ userId: 'someone-else', status: 'USED' }))
      .mockResolvedValueOnce(null);
    const create = jest.spyOn(betBoostLockRepository, 'create');

    const otherReward = await boostLockService.lockBoost({ ...input, rewardId: 'reward-2' });
    const otherUser = await boostLockService.lockBoost(input);
    const missingReward = await boostLockService.lockBoost(input);

    for (const result of [otherReward, otherUser, missingReward]) {
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(ReasonCode.BET_ALREADY_LOCKED);
      expect(result.data).toBeUndefined();
    }
    // A different reward never needs an ownership read.
    expect(findReward).toHaveBeenCalledTimes(2);
    expect(create).not.toHaveBeenCalled();
  });

  it('returns early failures for reward lookup, ownership, and status', async () => {
    jest.spyOn(betBoostLockRepository, 'findByBetId').mockResolvedValue(null);
    jest.spyOn(userRewardRepository, 'findById')
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(makeReward({ userId: 'different-user' }))
      .mockResolvedValueOnce(makeReward({ status: 'EXPIRED' }))
      .mockResolvedValueOnce(makeReward({ status: 'USED' }))
      .mockResolvedValueOnce(makeReward({ status: 'GRANTED' }));

    const missing = await boostLockService.lockBoost(input);
    const wrongUser = await boostLockService.lockBoost(input);
    const expired = await boostLockService.lockBoost(input);
    const used = await boostLockService.lockBoost(input);
    const notEntered = await boostLockService.lockBoost(input);

    expect(missing.error?.code).toBe(ReasonCode.REWARD_NOT_FOUND);
    expect(wrongUser.error?.code).toBe(ReasonCode.REWARD_NOT_FOUND);
    expect(expired.error?.code).toBe(ReasonCode.REWARD_EXPIRED);
    expect(used.error?.code).toBe(ReasonCode.REWARD_ALREADY_USED);
    expect(notEntered.error?.code).toBe(ReasonCode.NOT_OPTED_IN);
  });

  it('re-reads the lock when the reward is already USED and applies the replay rule', async () => {
    jest.spyOn(userRewardRepository, 'findById').mockResolvedValue(makeReward({ status: 'USED' }));
    const findLock = jest.spyOn(betBoostLockRepository, 'findByBetId')
      // Lock committed by a concurrent request after the idempotency check.
      .mockResolvedValueOnce(null).mockResolvedValueOnce(makeLock())
      // The bet is locked under a different reward.
      .mockResolvedValueOnce(null).mockResolvedValueOnce(makeLock({ rewardId: 'reward-other' }))
      // No lock exists for this bet at all.
      .mockResolvedValueOnce(null).mockResolvedValueOnce(null);
    const create = jest.spyOn(betBoostLockRepository, 'create');

    const replayed = await boostLockService.lockBoost(input);
    expect(replayed.success).toBe(true);
    expect(replayed.data?.lock_id).toBe('lock-1');

    const otherReward = await boostLockService.lockBoost(input);
    expect(otherReward.error?.code).toBe(ReasonCode.BET_ALREADY_LOCKED);

    const noLock = await boostLockService.lockBoost(input);
    expect(noLock.error?.code).toBe(ReasonCode.REWARD_ALREADY_USED);

    expect(findLock).toHaveBeenCalledTimes(6);
    // The already-loaded reward is reused for the ownership check.
    expect(userRewardRepository.findById).toHaveBeenCalledTimes(3);
    expect(create).not.toHaveBeenCalled();
  });

  it('returns failures for missing ride state and profile/eligibility thresholds', async () => {
    jest.spyOn(betBoostLockRepository, 'findByBetId').mockResolvedValue(null);
    jest.spyOn(userRewardRepository, 'findById')
      .mockResolvedValueOnce(makeReward({ betId: null }))
      .mockResolvedValueOnce(makeReward())
      .mockResolvedValueOnce(makeReward())
      .mockResolvedValueOnce(makeReward());
    jest.spyOn(rewardProfileRepository, 'findById')
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(makeProfile())
      .mockResolvedValueOnce(makeProfile());
    setupCoreMocks();

    const missingRide = await boostLockService.lockBoost(input);
    expect(missingRide.error?.code).toBe(ReasonCode.NOT_OPTED_IN);

    const missingProfile = await boostLockService.lockBoost(input);
    expect(missingProfile.error?.code).toBe(ReasonCode.PROFILE_NOT_FOUND);

    (computations.meetsMinSelectionCount as jest.Mock).mockReturnValueOnce(false);
    const minSelections = await boostLockService.lockBoost(input);
    expect(minSelections.error?.code).toBe(ReasonCode.MIN_SELECTIONS_NOT_MET);

    (computations.meetsCombinedOddsThreshold as jest.Mock).mockReturnValueOnce(false);
    const minCombined = await boostLockService.lockBoost(input);
    expect(minCombined.error?.code).toBe(ReasonCode.MIN_COMBINED_ODDS_NOT_MET);
  });

  it('returns RIDE_CRASHED and RIDE_ENDED states with ride details', async () => {
    jest.spyOn(betBoostLockRepository, 'findByBetId').mockResolvedValue(null);
    jest.spyOn(userRewardRepository, 'findById').mockResolvedValue(makeReward());
    jest.spyOn(rewardProfileRepository, 'findById').mockResolvedValue(makeProfile());
    setupCoreMocks();

    (computations.calculateElapsedPct as jest.Mock).mockReturnValueOnce(0.9);
    const crashed = await boostLockService.lockBoost(input);
    expect(crashed.error?.code).toBe(ReasonCode.RIDE_CRASHED);
    expect((crashed.error?.details as { current_boost_pct?: number })?.current_boost_pct).toBe(0);

    (computations.deriveRideParams as jest.Mock).mockReturnValueOnce({
      checkpointCount: 10,
      volatility: 0.4,
      crashPct: 1,
    });
    (computations.calculateElapsedPct as jest.Mock).mockReturnValueOnce(1.05);
    (computations.hasRideEnded as jest.Mock).mockReturnValueOnce(true);
    const ended = await boostLockService.lockBoost(input);
    expect(ended.error?.code).toBe(ReasonCode.RIDE_ENDED);
  });

  it('creates lock successfully in WAVES and LINEAR modes', async () => {
    jest.spyOn(betBoostLockRepository, 'findByBetId').mockResolvedValue(null);
    jest.spyOn(userRewardRepository, 'findById').mockResolvedValue(makeReward());
    const profileSpy = jest.spyOn(rewardProfileRepository, 'findById')
      .mockResolvedValueOnce(makeProfile({ rideMode: 'WAVES' }))
      .mockResolvedValueOnce(makeProfile({ rideMode: 'LINEAR' }));
    setupCoreMocks();
    jest.spyOn(betBoostLockRepository, 'create').mockImplementation(async (payload) => makeLock({
      lockedBoostPct: payload.lockedBoostPct,
      qualifyingSelections: payload.qualifyingSelections,
      qualifyingOdds: payload.qualifyingOdds,
      ticketStrength: payload.ticketStrength,
      snapshot: payload.snapshot,
    }));

    const waveResult = await boostLockService.lockBoost(input);
    expect(waveResult.success).toBe(true);
    expect(waveResult.data?.lock_id).toBe('lock-1');

    const linearResult = await boostLockService.lockBoost(input);
    expect(linearResult.success).toBe(true);
    expect(linearResult.data?.locked_boost_pct).toBe(0.33);
    expect(profileSpy).toHaveBeenCalledTimes(2);
  });

  it('passes one transaction scope to insert, conditional USED transition and audit', async () => {
    jest.spyOn(betBoostLockRepository, 'findByBetId').mockResolvedValue(null);
    jest.spyOn(userRewardRepository, 'findById').mockResolvedValue(makeReward());
    jest.spyOn(rewardProfileRepository, 'findById').mockResolvedValue(makeProfile());
    setupCoreMocks();

    const result = await boostLockService.lockBoost(input);
    expect(result.success).toBe(true);

    const createTx = jest.mocked(betBoostLockRepository.create).mock.calls[0][1];
    expect(createTx).toBeDefined();
    expect(userRewardRepository.updateStatus).toHaveBeenCalledWith('reward-1', 'USED', undefined, {
      tx: createTx,
      fromStatus: 'ENTERED',
    });
    expect(jest.mocked(auditLogRepository.append).mock.calls[0][1]).toBe(createTx);
  });

  it('applies the replay rule after unique-key races without touching reward status', async () => {
    jest.spyOn(userRewardRepository, 'findById').mockResolvedValue(makeReward());
    jest.spyOn(rewardProfileRepository, 'findById').mockResolvedValue(makeProfile());
    setupCoreMocks();
    jest.spyOn(betBoostLockRepository, 'findByBetId')
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(makeLock())
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(makeLock({ rewardId: 'reward-other' }))
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null);
    jest.spyOn(betBoostLockRepository, 'create')
      .mockRejectedValueOnce({
        code: 'SQLITE_CONSTRAINT',
        message: 'UNIQUE constraint failed: bet_boost_locks.bet_id',
      })
      .mockRejectedValueOnce({
        code: '23505',
        detail: 'duplicate key value violates unique constraint bet_id',
      })
      .mockRejectedValueOnce({
        code: 'SQLITE_CONSTRAINT',
        message: 'UNIQUE constraint failed: bet_boost_locks.reward_id',
      });

    const sameReward = await boostLockService.lockBoost(input);
    expect(sameReward.success).toBe(true);
    expect(sameReward.data?.lock_id).toBe('lock-1');

    const otherReward = await boostLockService.lockBoost(input);
    expect(otherReward.error?.code).toBe(ReasonCode.BET_ALREADY_LOCKED);

    const rewardCollision = await boostLockService.lockBoost(input);
    expect(rewardCollision.error?.code).toBe(ReasonCode.REWARD_ALREADY_USED);

    // Status is only ever changed inside the lock transaction, never in the fallback.
    expect(userRewardRepository.updateStatus).not.toHaveBeenCalled();
  });

  it('treats a lost ENTERED -> USED transition as a conflict and re-reads state', async () => {
    jest.spyOn(rewardProfileRepository, 'findById').mockResolvedValue(makeProfile());
    setupCoreMocks();
    jest.spyOn(betBoostLockRepository, 'findByBetId').mockResolvedValue(null);
    jest.spyOn(userRewardRepository, 'findById')
      .mockResolvedValueOnce(makeReward())
      .mockResolvedValueOnce(makeReward({ status: 'EXPIRED' }));
    jest.spyOn(userRewardRepository, 'updateStatus').mockResolvedValueOnce(null);

    const result = await boostLockService.lockBoost(input);
    expect(result.error?.code).toBe(ReasonCode.REWARD_EXPIRED);
    expect(auditLogRepository.append).not.toHaveBeenCalled();
  });

  it('rethrows unexpected persistence errors', async () => {
    jest.spyOn(betBoostLockRepository, 'findByBetId').mockResolvedValue(null);
    jest.spyOn(userRewardRepository, 'findById').mockResolvedValue(makeReward());
    jest.spyOn(rewardProfileRepository, 'findById').mockResolvedValue(makeProfile());
    setupCoreMocks();
    jest.spyOn(betBoostLockRepository, 'create').mockRejectedValueOnce(new Error('disk full'));

    await expect(boostLockService.lockBoost(input)).rejects.toThrow('disk full');
  });

  it('returns lock record by bet id', async () => {
    jest.spyOn(betBoostLockRepository, 'findByBetId').mockResolvedValue(makeLock());

    const result = await boostLockService.getLockByBetId('bet-1');
    expect(result.success).toBe(true);
    expect(result.data?.id).toBe('lock-1');
  });
});
