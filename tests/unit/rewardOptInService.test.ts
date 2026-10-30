import { rewardOptInService } from '../../src/services/rewardOptInService';
import { userRewardRepository, BetAlreadyBoundError } from '../../src/db/repositories/userRewardRepository';
import { rewardProfileRepository } from '../../src/db/repositories/rewardProfileRepository';
import { auditLogRepository } from '../../src/db/repositories/auditLogRepository';
import { computeTicketStrength } from '../../src/computations';
import { combinedOddsExact, createV4Ride, seedCommitment } from '../../src/computations/v4';
import { config } from '../../src/config';
import type { RideMathSnapshotV4 } from '../../src/types/ride';
import { ReasonCode } from '../../src/types/reasonCodes';
import type { RewardProfileVersion } from '../../src/types/rewardProfile';
import type { Selection } from '../../src/types/ticket';
import type { UserReward } from '../../src/types/userReward';

const SEED = '5eed'.repeat(16);

function makeReward(overrides: Partial<UserReward> = {}): UserReward {
  const now = new Date().toISOString();
  return {
    id: 'reward-1',
    userId: 'user-1',
    profileVersionId: 'profile-1',
    status: 'GRANTED',
    startTime: now,
    endTime: now,
    seed: SEED,
    betId: null,
    ticketSnapshot: null,
    optedInAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function makeProfile(overrides: Partial<RewardProfileVersion> = {}): RewardProfileVersion {
  const now = new Date().toISOString();
  return {
    id: 'profile-1',
    name: 'Profile',
    description: null,
    minSelections: 5,
    minCombinedOdds: 10,
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

/** Eligible for makeProfile: 5 qualifying selections, combined odds 1.7 x 1.8 x 2.1 x 1.5 x 1.6 = 15.4224. */
function makeSelections(): Selection[] {
  return [
    { id: 's1', odds: 1.7 },
    { id: 's2', odds: 1.8 },
    { id: 's3', odds: 2.1 },
    { id: 's4', odds: 1.5 },
    { id: 's5', odds: 1.6 },
  ];
}

/** 3 qualifying selections (minimum 5). */
function tooFewSelections(): Selection[] {
  return makeSelections().slice(0, 3);
}

/** 5 qualifying selections but combined odds 1.31^5 = 3.86 (minimum 10). */
function lowOddsSelections(): Selection[] {
  return Array.from({ length: 5 }, (_, i) => ({ id: `low${i}`, odds: 1.31 }));
}

function setupOptInDefaults(): void {
  jest.spyOn(userRewardRepository, 'updateStatus').mockResolvedValue(makeReward({ status: 'ENTERED' }));
  jest.spyOn(userRewardRepository, 'updateRideStart').mockResolvedValue(
    makeReward({ status: 'ENTERED', betId: 'bet-1' })
  );
  jest.spyOn(auditLogRepository, 'append').mockResolvedValue({
    id: 'audit-1',
    entityType: 'user_reward',
    entityId: 'reward-1',
    action: 'OPT_IN',
    payload: {},
    timestamp: new Date().toISOString(),
    createdAt: new Date().toISOString(),
  });
}

describe('rewardOptInService', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('precheckEligibility', () => {
    it('returns REWARD_NOT_FOUND for missing reward or wrong user', async () => {
      jest.spyOn(userRewardRepository, 'findById').mockResolvedValue(null);

      const missing = await rewardOptInService.precheckEligibility(
        'missing',
        'user-1',
        makeSelections()
      );
      expect(missing.success).toBe(true);
      expect(missing.data?.reason_code).toBe(ReasonCode.REWARD_NOT_FOUND);

      jest.spyOn(userRewardRepository, 'findById').mockResolvedValueOnce(
        makeReward({ userId: 'different-user' })
      );
      const wrongUser = await rewardOptInService.precheckEligibility(
        'reward-1',
        'user-1',
        makeSelections()
      );
      expect(wrongUser.success).toBe(true);
      expect(wrongUser.data?.reason_code).toBe(ReasonCode.REWARD_NOT_FOUND);
    });

    it('returns status-based precheck reasons', async () => {
      jest.spyOn(userRewardRepository, 'findById')
        .mockResolvedValueOnce(makeReward({ status: 'USED' }))
        .mockResolvedValueOnce(makeReward({ status: 'EXPIRED' }))
        .mockResolvedValueOnce(makeReward({ status: 'ENTERED' }));

      const used = await rewardOptInService.precheckEligibility('reward-1', 'user-1', makeSelections());
      const expired = await rewardOptInService.precheckEligibility('reward-1', 'user-1', makeSelections());
      const entered = await rewardOptInService.precheckEligibility('reward-1', 'user-1', makeSelections());

      expect(used.data?.reason_code).toBe(ReasonCode.REWARD_ALREADY_USED);
      expect(expired.data?.reason_code).toBe(ReasonCode.REWARD_EXPIRED);
      expect(entered.data?.reason_code).toBe(ReasonCode.ALREADY_OPTED_IN);
    });

    it('returns PROFILE_NOT_FOUND when profile is missing', async () => {
      jest.spyOn(userRewardRepository, 'findById').mockResolvedValue(makeReward());
      jest.spyOn(rewardProfileRepository, 'findById').mockResolvedValue(null);

      const result = await rewardOptInService.precheckEligibility('reward-1', 'user-1', makeSelections());

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(ReasonCode.PROFILE_NOT_FOUND);
    });

    it('returns threshold failures and eligible response (exact combined odds)', async () => {
      jest.spyOn(userRewardRepository, 'findById').mockResolvedValue(makeReward());
      jest.spyOn(rewardProfileRepository, 'findById').mockResolvedValue(makeProfile());

      const minSelections = await rewardOptInService.precheckEligibility('reward-1', 'user-1', tooFewSelections());
      expect(minSelections.success).toBe(true);
      expect(minSelections.data?.reason_code).toBe(ReasonCode.MIN_SELECTIONS_NOT_MET);
      expect(minSelections.data?.qualifying_selection_count).toBe(3);
      expect(minSelections.data?.ticket_strength).toBe(0);

      const minOdds = await rewardOptInService.precheckEligibility('reward-1', 'user-1', lowOddsSelections());
      expect(minOdds.success).toBe(true);
      expect(minOdds.data?.reason_code).toBe(ReasonCode.MIN_COMBINED_ODDS_NOT_MET);
      expect(minOdds.data?.combined_odds).toBe(3.8579489651);

      const eligible = await rewardOptInService.precheckEligibility('reward-1', 'user-1', makeSelections());
      expect(eligible.success).toBe(true);
      expect(eligible.data?.reason_code).toBe(ReasonCode.ELIGIBLE);
      expect(eligible.data?.eligible).toBe(true);
      expect(eligible.data?.combined_odds).toBe(15.4224);
      expect(eligible.data?.ticket_strength).toBe(
        computeTicketStrength(5, combinedOddsExact([1.7, 1.8, 2.1, 1.5, 1.6]), { minSelections: 5 })
      );
      expect(eligible.data?.ticket_strength).toBeGreaterThan(0);
    });

    it('meets a combined-odds minimum exactly where the float product falls short', async () => {
      // 1.1 x 1.15 x 1.15 = 1.45475 exactly; the float product is 1.4547499999999998.
      jest.spyOn(userRewardRepository, 'findById').mockResolvedValue(makeReward());
      jest.spyOn(rewardProfileRepository, 'findById').mockResolvedValue(
        makeProfile({ minSelections: 3, minCombinedOdds: 1.45475, minSelectionOdds: 1.01 })
      );
      const selections = [{ id: 'a', odds: 1.1 }, { id: 'b', odds: 1.15 }, { id: 'c', odds: 1.15 }];
      expect(1.1 * 1.15 * 1.15).toBeLessThan(1.45475);
      const result = await rewardOptInService.precheckEligibility('reward-1', 'user-1', selections);
      expect(result.data?.reason_code).toBe(ReasonCode.ELIGIBLE);
    });

    it('reports combined odds beyond the double range as an exact decimal string', async () => {
      jest.spyOn(userRewardRepository, 'findById').mockResolvedValue(makeReward());
      jest.spyOn(rewardProfileRepository, 'findById').mockResolvedValue(makeProfile());
      const huge = Array.from({ length: 100 }, (_, i) => ({ id: `h${i}`, odds: 10000 }));
      const result = await rewardOptInService.precheckEligibility('reward-1', 'user-1', huge);
      expect(result.data?.reason_code).toBe(ReasonCode.ELIGIBLE);
      expect(result.data?.combined_odds).toBe('1' + '0'.repeat(400));
      expect(result.data?.ticket_strength).toBe(1);
    });
  });

  describe('optIn', () => {
    const input = {
      userId: 'user-1',
      betId: 'bet-1',
      selections: makeSelections(),
    };

    it('returns early failures for missing reward, wrong user, or reward state', async () => {
      jest.spyOn(userRewardRepository, 'findById')
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(makeReward({ userId: 'different-user' }))
        .mockResolvedValueOnce(makeReward({ status: 'ENTERED' }))
        .mockResolvedValueOnce(makeReward({ status: 'USED' }))
        .mockResolvedValueOnce(makeReward({ status: 'EXPIRED' }));

      const missing = await rewardOptInService.optIn('reward-1', input);
      const wrongUser = await rewardOptInService.optIn('reward-1', input);
      const entered = await rewardOptInService.optIn('reward-1', input);
      const used = await rewardOptInService.optIn('reward-1', input);
      const expired = await rewardOptInService.optIn('reward-1', input);

      expect(missing.error?.code).toBe(ReasonCode.REWARD_NOT_FOUND);
      expect(wrongUser.error?.code).toBe(ReasonCode.REWARD_NOT_FOUND);
      expect(entered.error?.code).toBe(ReasonCode.ALREADY_OPTED_IN);
      expect(used.error?.code).toBe(ReasonCode.REWARD_ALREADY_USED);
      expect(expired.error?.code).toBe(ReasonCode.REWARD_EXPIRED);
    });

    it('returns profile and eligibility failures', async () => {
      jest.spyOn(userRewardRepository, 'findById').mockResolvedValue(makeReward());
      jest.spyOn(rewardProfileRepository, 'findById')
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(makeProfile())
        .mockResolvedValueOnce(makeProfile());
      setupOptInDefaults();

      const missingProfile = await rewardOptInService.optIn('reward-1', input);
      expect(missingProfile.error?.code).toBe(ReasonCode.PROFILE_NOT_FOUND);

      const minSelections = await rewardOptInService.optIn('reward-1', { ...input, selections: tooFewSelections() });
      expect(minSelections.error?.code).toBe(ReasonCode.MIN_SELECTIONS_NOT_MET);

      const minCombined = await rewardOptInService.optIn('reward-1', { ...input, selections: lowOddsSelections() });
      expect(minCombined.error?.code).toBe(ReasonCode.MIN_COMBINED_ODDS_NOT_MET);
      expect(minCombined.error?.message).toContain('got 3.86');

      expect(userRewardRepository.updateStatus).not.toHaveBeenCalled();
      expect(auditLogRepository.append).not.toHaveBeenCalled();
    });

    it('maps a lost GRANTED claim, a bound bet and a missing row to service errors', async () => {
      jest.spyOn(userRewardRepository, 'findById').mockResolvedValue(makeReward());
      jest.spyOn(rewardProfileRepository, 'findById').mockResolvedValue(makeProfile());
      setupOptInDefaults();

      // Concurrent opt-in already moved the reward out of GRANTED.
      jest.spyOn(userRewardRepository, 'updateStatus').mockResolvedValueOnce(null);
      const lostClaim = await rewardOptInService.optIn('reward-1', input);
      expect(lostClaim.error?.code).toBe(ReasonCode.ALREADY_OPTED_IN);

      // Bet already attached to another reward.
      jest.spyOn(userRewardRepository, 'updateRideStart').mockRejectedValueOnce(new BetAlreadyBoundError('bet-1'));
      const bound = await rewardOptInService.optIn('reward-1', input);
      expect(bound.error?.code).toBe(ReasonCode.BET_ALREADY_BOUND);

      jest.spyOn(userRewardRepository, 'updateRideStart').mockResolvedValueOnce(null);
      const missingRow = await rewardOptInService.optIn('reward-1', input);
      expect(missingRow.error?.code).toBe(ReasonCode.INTERNAL_ERROR);
      expect(missingRow.error?.message).toMatch(/start ride/i);

      // None of the failed attempts wrote an audit row.
      expect(auditLogRepository.append).not.toHaveBeenCalled();
    });

    it('rethrows unexpected persistence errors', async () => {
      jest.spyOn(userRewardRepository, 'findById').mockResolvedValue(makeReward());
      jest.spyOn(rewardProfileRepository, 'findById').mockResolvedValue(makeProfile());
      setupOptInDefaults();
      jest.spyOn(auditLogRepository, 'append').mockRejectedValueOnce(new Error('disk full'));

      await expect(rewardOptInService.optIn('reward-1', input)).rejects.toThrow('disk full');
    });

    it.each(['WAVES', 'LINEAR'] as const)('%s: starts a V4 ride and freezes every payout input', async (rideMode) => {
      jest.spyOn(userRewardRepository, 'findById').mockResolvedValue(makeReward());
      jest.spyOn(rewardProfileRepository, 'findById').mockResolvedValue(makeProfile({ rideMode }));
      setupOptInDefaults();

      const result = await rewardOptInService.optIn('reward-1', input);

      expect(result.success).toBe(true);
      expect(result.data?.rideStarted).toBe(true);
      expect(result.data?.reward.status).toBe('ENTERED');
      expect(auditLogRepository.append).toHaveBeenCalledTimes(1);

      // Conditional claim and every write share one transaction scope.
      const statusCall = jest.mocked(userRewardRepository.updateStatus).mock.calls[0];
      expect(statusCall[0]).toBe('reward-1');
      expect(statusCall[1]).toBe('ENTERED');
      expect(statusCall[3]).toMatchObject({ fromStatus: 'GRANTED' });
      const tx = statusCall[3]?.tx;
      expect(tx).toBeDefined();
      const [, startTime, endTime, betId, ticketSnapshot, startTx] = jest.mocked(userRewardRepository.updateRideStart).mock.calls[0];
      expect(startTx).toBe(tx);
      expect(betId).toBe('bet-1');
      expect(jest.mocked(auditLogRepository.append).mock.calls[0][1]).toBe(tx);

      // The snapshot rebuilds exactly this ride from the seed.
      const math = (ticketSnapshot as { rideMath: RideMathSnapshotV4 }).rideMath;
      const ticketStrength = computeTicketStrength(5, combinedOddsExact([1.7, 1.8, 2.1, 1.5, 1.6]), { minSelections: 5 });
      const ride = createV4Ride(SEED, {
        mode: rideMode,
        minBoostPct: 0.05,
        maxBoostPct: 1,
        effectiveMin: math.effectiveMinBoostPct,
        effectiveMax: math.effectiveMaxBoostPct,
        ticketStrength,
        ...config.ride,
        linearPace: rideMode === 'LINEAR' ? 'MEDIUM' : undefined,
      });
      expect(math).toMatchObject({
        version: 4,
        mathVersion: 'V4',
        startTime,
        endTime,
        qualifyingSelectionCount: 5,
        combinedOddsExact: '15.4224',
        ticketStrength,
        rideDurationSeconds: ride.params.durationSeconds,
        outcome: ride.params.outcome,
        crashAtSeconds: ride.params.crashAtSeconds,
        crashBucket: ride.params.crashBucket,
        crashPhase: ride.params.crashPhase,
        linearPace: rideMode === 'LINEAR' ? 'MEDIUM' : null,
        rideMaximumPct: ride.params.rideMaximum,
        preCrashMaximumPct: ride.maximumBefore(ride.params.crashAtSeconds ?? ride.params.durationSeconds),
        seedCommitment: seedCommitment(SEED),
        minDurationSeconds: config.ride.minDurationSeconds,
        maxDurationSeconds: config.ride.maxDurationSeconds,
        minCrashSeconds: config.ride.minCrashSeconds,
      });
      expect(math.profile).toMatchObject({ id: 'profile-1', rideMode, minBoostPct: 0.05, maxBoostPct: 1 });
      expect(Date.parse(endTime) - Date.parse(startTime)).toBe(Math.floor(ride.params.durationSeconds * 1000));
      expect(math.seedCommitment).toMatch(/^[0-9a-f]{64}$/);

      // Neither the snapshot nor the audit row carries the seed.
      const payload = jest.mocked(auditLogRepository.append).mock.calls[0][0].payload;
      expect(payload).toMatchObject({ mathSnapshotVersion: 4, seedCommitment: seedCommitment(SEED), combinedOdds: '15.4224' });
      for (const stored of [ticketSnapshot, payload]) {
        expect(JSON.stringify(stored)).not.toContain(SEED);
        expect(JSON.stringify(stored)).not.toMatch(/"seed"/);
      }
    });
  });
});
