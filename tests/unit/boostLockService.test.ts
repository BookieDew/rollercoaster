import { boostLockService } from '../../src/services/boostLockService';
import { userRewardRepository } from '../../src/db/repositories/userRewardRepository';
import { betBoostLockRepository } from '../../src/db/repositories/betBoostLockRepository';
import { auditLogRepository } from '../../src/db/repositories/auditLogRepository';
import { config } from '../../src/config';
import { seedCommitment } from '../../src/computations/v4';
import { buildRideMath, toRideMathProfile } from '../../src/services/rideMathSnapshot';
import { evaluateTicket } from '../../src/services/ticketEvaluation';
import { ReasonCode } from '../../src/types/reasonCodes';
import type { BetBoostLock, LegacyLockSnapshot, LockSnapshotV4 } from '../../src/types/betBoostLock';
import type { RewardProfileVersion } from '../../src/types/rewardProfile';
import type { RideMathSnapshotV4 } from '../../src/types/ride';
import type { Selection } from '../../src/types/ticket';
import type { UserReward } from '../../src/types/userReward';
import { findSeed, liveMomentMs } from '../helpers/v4Rides';

const CRASH_SEED = findSeed('lock-crash', (p) => p.outcome === 'CRASHED');
const END_SEED = findSeed('lock-end', (p) => p.outcome === 'ENDED');
const START_MS = Date.parse('2026-10-30T10:00:00.000Z');
const SELECTIONS: Selection[] = [{ id: 's1', odds: 1.8 }, { id: 's2', odds: 1.9 }];

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

/** The V4 opt-in snapshot of a ticket, as the opt-in service freezes it. */
function rideMathFor(
  seed = CRASH_SEED,
  profile = makeProfile(),
  selections = SELECTIONS
): RideMathSnapshotV4 {
  const frozen = toRideMathProfile(profile);
  return buildRideMath(seed, frozen, evaluateTicket(selections, frozen), config.ride, START_MS).math;
}

function makeReward(overrides: Partial<UserReward> = {}, math = rideMathFor()): UserReward {
  const now = new Date().toISOString();
  return {
    id: 'reward-1',
    userId: 'user-1',
    profileVersionId: 'profile-1',
    status: 'ENTERED',
    startTime: math.startTime,
    endTime: math.endTime,
    seed: CRASH_SEED,
    betId: 'bet-1',
    ticketSnapshot: { rideMath: math, selections: SELECTIONS },
    optedInAt: now,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

/** Pins the service clock to a moment of the frozen ride. */
function clockAt(ms: number): void {
  jest.spyOn(Date, 'now').mockReturnValue(ms);
}

/** A lock stored under the retired V3 math: read back as stored. */
function makeSnapshot(): LegacyLockSnapshot {
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
    brandId: 'default',
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
  clockAt(liveMomentMs(rideMathFor()));
  jest.spyOn(betBoostLockRepository, 'create').mockResolvedValue(makeLock());
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

  it('rejects an existing lock for another reward or another user with BET_ALREADY_LOCKED', async () => {
    const findLock = jest.spyOn(betBoostLockRepository, 'findByBetId').mockResolvedValue(makeLock());
    jest.spyOn(userRewardRepository, 'findById')
      .mockResolvedValueOnce(makeReward({ id: 'reward-2', status: 'USED' }))
      .mockResolvedValueOnce(makeReward({ userId: 'someone-else', status: 'USED' }));
    const create = jest.spyOn(betBoostLockRepository, 'create');

    const otherReward = await boostLockService.lockBoost({ ...input, rewardId: 'reward-2' });
    const otherUser = await boostLockService.lockBoost(input);

    for (const result of [otherReward, otherUser]) {
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(ReasonCode.BET_ALREADY_LOCKED);
      expect(result.data).toBeUndefined();
    }
    // The lock lookup is scoped to the reward's brand.
    expect(findLock).toHaveBeenCalledWith('bet-1', 'default');
    expect(create).not.toHaveBeenCalled();
  });

  it('reports a missing reward as REWARD_NOT_FOUND without reading any lock (the brand comes from the reward)', async () => {
    const findLock = jest.spyOn(betBoostLockRepository, 'findByBetId').mockResolvedValue(makeLock());
    jest.spyOn(userRewardRepository, 'findById').mockResolvedValueOnce(null);

    const result = await boostLockService.lockBoost(input);
    expect(result.error?.code).toBe(ReasonCode.REWARD_NOT_FOUND);
    expect(findLock).not.toHaveBeenCalled();
  });

  it('scopes the lock lookup to the reward brand', async () => {
    const findLock = jest.spyOn(betBoostLockRepository, 'findByBetId').mockResolvedValue(makeLock({ brandId: 'brand-b' }));
    jest.spyOn(userRewardRepository, 'findById').mockResolvedValue(makeReward({ brandId: 'brand-b', status: 'USED' }));

    const result = await boostLockService.lockBoost(input);
    expect(result.success).toBe(true);
    expect(findLock).toHaveBeenCalledWith('bet-1', 'brand-b');
  });

  it('returns early failures for reward lookup, ownership, and status', async () => {
    jest.spyOn(betBoostLockRepository, 'findByBetId').mockResolvedValue(null);
    jest.spyOn(userRewardRepository, 'findById')
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(makeReward({ userId: 'different-user' }))
      // Expired without ever entering a ride, and expired after a ride on another bet.
      .mockResolvedValueOnce(makeReward({ status: 'EXPIRED', betId: null, ticketSnapshot: null }))
      .mockResolvedValueOnce(makeReward({ status: 'EXPIRED', betId: 'other-bet' }))
      .mockResolvedValueOnce(makeReward({ status: 'USED' }))
      .mockResolvedValueOnce(makeReward({ status: 'GRANTED' }));

    const missing = await boostLockService.lockBoost(input);
    const wrongUser = await boostLockService.lockBoost(input);
    const expired = await boostLockService.lockBoost(input);
    const expiredOtherBet = await boostLockService.lockBoost(input);
    const used = await boostLockService.lockBoost(input);
    const notEntered = await boostLockService.lockBoost(input);

    expect(missing.error?.code).toBe(ReasonCode.REWARD_NOT_FOUND);
    expect(wrongUser.error?.code).toBe(ReasonCode.REWARD_NOT_FOUND);
    expect(expired.error?.code).toBe(ReasonCode.REWARD_EXPIRED);
    expect(expiredOtherBet.error?.code).toBe(ReasonCode.REWARD_EXPIRED);
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

  it('returns failures for missing ride state, unusable ride math and eligibility thresholds', async () => {
    jest.spyOn(betBoostLockRepository, 'findByBetId').mockResolvedValue(null);
    const strict = makeProfile({ minSelections: 3 });
    const highOdds = makeProfile({ minCombinedOdds: 4 });
    jest.spyOn(userRewardRepository, 'findById')
      .mockResolvedValueOnce(makeReward({ betId: null }))
      .mockResolvedValueOnce(makeReward({ ticketSnapshot: { selections: SELECTIONS } }))
      .mockResolvedValueOnce(makeReward({ ticketSnapshot: { selections: SELECTIONS, rideMath: { version: 3 } } }))
      .mockResolvedValueOnce(makeReward({}, rideMathFor(CRASH_SEED, strict)))
      .mockResolvedValueOnce(makeReward({}, rideMathFor(CRASH_SEED, highOdds)));
    setupCoreMocks();

    const missingRide = await boostLockService.lockBoost(input);
    expect(missingRide.error?.code).toBe(ReasonCode.NOT_OPTED_IN);

    // Without a V4 snapshot the ride is never rebuilt from the mutable profile.
    const noMath = await boostLockService.lockBoost(input);
    expect(noMath.error?.code).toBe(ReasonCode.INVALID_CONFIGURATION);
    expect(noMath.error?.message).toBe('Invalid saved ride math');

    // A retired V1-V3 ride is never recomputed.
    const retired = await boostLockService.lockBoost(input);
    expect(retired.error?.code).toBe(ReasonCode.INVALID_CONFIGURATION);
    expect(retired.error?.message).toMatch(/retired math version/);

    const minSelections = await boostLockService.lockBoost(input);
    expect(minSelections.error?.code).toBe(ReasonCode.MIN_SELECTIONS_NOT_MET);

    const minCombined = await boostLockService.lockBoost(input);
    expect(minCombined.error?.code).toBe(ReasonCode.MIN_COMBINED_ODDS_NOT_MET);
    expect(minCombined.error?.message).toBe('Minimum combined odds of 4 required, got 3.42');
    expect(betBoostLockRepository.create).not.toHaveBeenCalled();
  });

  it('fails closed when the snapshot does not match the seed or the rebuilt ride', async () => {
    jest.spyOn(betBoostLockRepository, 'findByBetId').mockResolvedValue(null);
    const math = rideMathFor();
    jest.spyOn(userRewardRepository, 'findById')
      .mockResolvedValueOnce(makeReward({ seed: END_SEED }))
      .mockResolvedValueOnce(makeReward({}, { ...math, crashAtSeconds: (math.crashAtSeconds as number) + 0.5 }))
      .mockResolvedValueOnce(makeReward({}, { ...math, rideMaximumPct: math.rideMaximumPct + 0.01 }))
      .mockResolvedValueOnce(makeReward({ seed: 'not-a-seed' }))
      .mockResolvedValueOnce(makeReward({ status: 'EXPIRED', seed: END_SEED }));
    setupCoreMocks();

    for (let i = 0; i < 4; i += 1) {
      const result = await boostLockService.lockBoost(input);
      expect(result.error?.code).toBe(ReasonCode.INVALID_CONFIGURATION);
    }
    // An expired reward with unusable ride math is simply expired.
    expect((await boostLockService.lockBoost(input)).error?.code).toBe(ReasonCode.REWARD_EXPIRED);
    expect(betBoostLockRepository.create).not.toHaveBeenCalled();
  });

  it('returns RIDE_CRASHED and RIDE_ENDED states with ride details', async () => {
    jest.spyOn(betBoostLockRepository, 'findByBetId').mockResolvedValue(null);
    const crashMath = rideMathFor(CRASH_SEED);
    const endMath = rideMathFor(END_SEED);
    jest.spyOn(userRewardRepository, 'findById')
      .mockResolvedValueOnce(makeReward({}, crashMath))
      .mockResolvedValueOnce(makeReward({ seed: END_SEED }, endMath))
      .mockResolvedValueOnce(makeReward({ status: 'EXPIRED' }, crashMath));
    setupCoreMocks();

    clockAt(START_MS + Math.ceil((crashMath.crashAtSeconds as number) * 1000));
    const crashed = await boostLockService.lockBoost(input);
    expect(crashed.error?.code).toBe(ReasonCode.RIDE_CRASHED);
    const details = crashed.error?.details as Record<string, unknown>;
    expect(details.current_boost_pct).toBe(0);
    expect(details.ride_crash_at_offset_seconds).toBe(Math.round((crashMath.crashAtSeconds as number) * 1000) / 1000);
    expect(details.theoretical_max_boost_pct).toBe(crashMath.preCrashMaximumPct);
    expect(details.maximum_model).toBe('PRE_CRASH_SUPREMUM_V4');
    expect(details.ride_path).toHaveLength(60);

    clockAt(Date.parse(endMath.endTime));
    const ended = await boostLockService.lockBoost(input);
    expect(ended.error?.code).toBe(ReasonCode.RIDE_ENDED);
    expect((ended.error?.details as Record<string, unknown>).ride_crash_at_offset_seconds)
      .toBe(Math.round(endMath.rideDurationSeconds * 1000) / 1000);

    // Expiry never hides the outcome of an entered ride.
    clockAt(START_MS + Math.ceil((crashMath.crashAtSeconds as number) * 1000));
    expect((await boostLockService.lockBoost(input)).error?.code).toBe(ReasonCode.RIDE_CRASHED);
    expect(betBoostLockRepository.create).not.toHaveBeenCalled();
  });

  it('keeps an expired reward whose ride is still live unlockable', async () => {
    jest.spyOn(betBoostLockRepository, 'findByBetId').mockResolvedValue(null);
    jest.spyOn(userRewardRepository, 'findById').mockResolvedValue(makeReward({ status: 'EXPIRED' }));
    setupCoreMocks();
    expect((await boostLockService.lockBoost(input)).error?.code).toBe(ReasonCode.REWARD_EXPIRED);
    expect(betBoostLockRepository.create).not.toHaveBeenCalled();
  });

  it.each(['WAVES', 'LINEAR'] as const)('%s: creates the lock from the frozen V4 ride and freezes every payout input', async (rideMode) => {
    const math = rideMathFor(CRASH_SEED, makeProfile({ rideMode }));
    jest.spyOn(betBoostLockRepository, 'findByBetId').mockResolvedValue(null);
    jest.spyOn(userRewardRepository, 'findById').mockResolvedValue(makeReward({}, math));
    setupCoreMocks();
    const lockAtMs = liveMomentMs(math);
    clockAt(lockAtMs);
    jest.spyOn(betBoostLockRepository, 'create').mockImplementation(async (payload) => makeLock({
      lockedBoostPct: payload.lockedBoostPct,
      qualifyingSelections: payload.qualifyingSelections,
      qualifyingOdds: payload.qualifyingOdds,
      ticketStrength: payload.ticketStrength,
      snapshot: payload.snapshot,
    }));

    const result = await boostLockService.lockBoost(input);
    expect(result.success).toBe(true);
    expect(result.data?.lock_id).toBe('lock-1');

    const created = jest.mocked(betBoostLockRepository.create).mock.calls[0][0];
    const snapshot = created.snapshot as LockSnapshotV4;
    const elapsed = (lockAtMs - START_MS) / 1000;
    expect(created.lockedBoostPct).toBeGreaterThan(0);
    expect(created.qualifyingOdds).toBe(3.42);
    expect(created.ticketStrength).toBe(math.ticketStrength);
    expect(snapshot).toMatchObject({
      mathSnapshotVersion: 4,
      rideMath: math,
      seedCommitment: seedCommitment(CRASH_SEED),
      lockElapsedSeconds: elapsed,
      boostAtLock: created.lockedBoostPct,
      combinedOdds: 3.42,
      combinedOddsExact: '3.42',
      rideDurationSeconds: math.rideDurationSeconds,
      crashPct: (math.crashAtSeconds as number) / math.rideDurationSeconds,
      elapsedPct: elapsed / math.rideDurationSeconds,
      effectiveMinBoostPct: math.effectiveMinBoostPct,
      maxEligibleBoostPct: math.effectiveMaxBoostPct,
      maxPossibleBoostPct: math.preCrashMaximumPct,
      maximumModel: 'PRE_CRASH_SUPREMUM_V4',
      rideMode,
    });
    expect(snapshot.ridePath).toHaveLength(60);
    expect(JSON.stringify(snapshot)).not.toContain(CRASH_SEED);
    expect(JSON.stringify(snapshot)).not.toMatch(/"seed"/);
    const audit = jest.mocked(auditLogRepository.append).mock.calls[0][0].payload;
    expect(audit).toMatchObject({ seedCommitment: seedCommitment(CRASH_SEED), mathSnapshotVersion: 4, combinedOdds: '3.42' });
    expect(JSON.stringify(audit)).not.toContain(CRASH_SEED);

    expect(result.data).toMatchObject({
      locked_boost_pct: created.lockedBoostPct,
      qualifying_odds: 3.42,
      theoretical_max_boost_pct: math.preCrashMaximumPct,
      maximum_model: 'PRE_CRASH_SUPREMUM_V4',
      ride_stop_at_offset_seconds: Math.round(elapsed * 1000) / 1000,
      ride_crash_at_offset_seconds: Math.round((math.crashAtSeconds as number) * 1000) / 1000,
      ride_end_at_offset_seconds: Math.round(math.rideDurationSeconds * 1000) / 1000,
    });
  });

  it('locks a ticket whose combined odds are beyond the double range and reports them exactly', async () => {
    const huge = Array.from({ length: 100 }, (_, i) => ({ id: `h${i}`, odds: 10000 }));
    const frozen = toRideMathProfile(makeProfile());
    const math = buildRideMath(CRASH_SEED, frozen, evaluateTicket(huge, frozen), config.ride, START_MS).math;
    jest.spyOn(betBoostLockRepository, 'findByBetId').mockResolvedValue(null);
    jest.spyOn(userRewardRepository, 'findById').mockResolvedValue(
      makeReward({ ticketSnapshot: { rideMath: math, selections: huge } }, math)
    );
    setupCoreMocks();
    clockAt(liveMomentMs(math));
    jest.spyOn(betBoostLockRepository, 'create').mockImplementation(async (payload) => makeLock({
      qualifyingOdds: payload.qualifyingOdds,
      snapshot: payload.snapshot,
    }));

    const result = await boostLockService.lockBoost(input);
    expect(result.success).toBe(true);
    expect(result.data?.qualifying_odds).toBe('1' + '0'.repeat(400));
    const created = jest.mocked(betBoostLockRepository.create).mock.calls[0][0];
    expect(Number.isFinite(created.qualifyingOdds)).toBe(true);
    expect(created.ticketStrength).toBe(1);
    expect((created.snapshot as LockSnapshotV4).combinedOddsExact).toBe('1' + '0'.repeat(400));
    expect(created.snapshot.boostModel.oddsRatio).toBe(1);
  });

  it('replays a stored V3 lock as stored', async () => {
    jest.spyOn(betBoostLockRepository, 'findByBetId').mockResolvedValue(makeLock());
    jest.spyOn(userRewardRepository, 'findById').mockResolvedValue(makeReward({ status: 'USED' }));
    const result = await boostLockService.lockBoost(input);
    expect(result.data).toMatchObject({
      qualifying_odds: 3.4,
      theoretical_max_boost_pct: 0.7,
      ride_stop_at_offset_seconds: 3,
      ride_crash_at_offset_seconds: 8,
      ride_end_at_offset_seconds: 10,
    });
  });

  it('passes one transaction scope to insert, conditional USED transition and audit', async () => {
    jest.spyOn(betBoostLockRepository, 'findByBetId').mockResolvedValue(null);
    jest.spyOn(userRewardRepository, 'findById').mockResolvedValue(makeReward());
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
    const findReward = jest.spyOn(userRewardRepository, 'findById').mockResolvedValue(makeReward());
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

    // reward_id collision: the winning lock consumed the reward, so it reads as USED.
    findReward.mockResolvedValueOnce(makeReward()).mockResolvedValueOnce(makeReward({ status: 'USED' }));
    const rewardCollision = await boostLockService.lockBoost(input);
    expect(rewardCollision.error?.code).toBe(ReasonCode.REWARD_ALREADY_USED);

    // The insert rolled back and the reward is still ENTERED, yet no lock is visible
    // for (brand_id, bet_id): defensive conflict answer, never a 500.
    jest.spyOn(betBoostLockRepository, 'findByBetId').mockResolvedValue(null);
    jest.spyOn(betBoostLockRepository, 'create').mockRejectedValueOnce({
      code: 'SQLITE_CONSTRAINT',
      message: 'UNIQUE constraint failed: bet_boost_locks.brand_id, bet_boost_locks.bet_id',
    });
    const crossBrand = await boostLockService.lockBoost(input);
    expect(crossBrand.error?.code).toBe(ReasonCode.BET_ALREADY_LOCKED);

    // Status is only ever changed inside the lock transaction, never in the fallback.
    expect(userRewardRepository.updateStatus).not.toHaveBeenCalled();
  });

  it('treats a lost ENTERED -> USED transition as a conflict and re-reads state', async () => {
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
    setupCoreMocks();
    jest.spyOn(betBoostLockRepository, 'create').mockRejectedValueOnce(new Error('disk full'));

    await expect(boostLockService.lockBoost(input)).rejects.toThrow('disk full');
  });

  it('returns lock record by bet id', async () => {
    jest.spyOn(betBoostLockRepository, 'findByBetId').mockResolvedValue(makeLock());

    const result = await boostLockService.getLockByBetId('default', 'bet-1');
    expect(result.success).toBe(true);
    expect(result.data?.id).toBe('lock-1');
  });
});
