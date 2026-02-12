import { rewardOptInService } from '../../src/services/rewardOptInService';
import { userRewardRepository } from '../../src/db/repositories/userRewardRepository';
import { rewardProfileRepository } from '../../src/db/repositories/rewardProfileRepository';
import { rideDefinitionRepository } from '../../src/db/repositories/rideDefinitionRepository';
import { auditLogRepository } from '../../src/db/repositories/auditLogRepository';
import * as computations from '../../src/computations';
import * as rideGenerator from '../../src/computations/deterministicRideGenerator';
import { ReasonCode } from '../../src/types/reasonCodes';
import type { RewardProfileVersion } from '../../src/types/rewardProfile';
import type { Selection } from '../../src/types/ticket';
import type { UserReward } from '../../src/types/userReward';

function makeReward(overrides: Partial<UserReward> = {}): UserReward {
  const now = new Date().toISOString();
  return {
    id: 'reward-1',
    userId: 'user-1',
    profileVersionId: 'profile-1',
    status: 'GRANTED',
    startTime: now,
    endTime: now,
    seed: 'seed-1',
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

function makeSelections(): Selection[] {
  return [
    { id: 's1', odds: 1.7 },
    { id: 's2', odds: 1.8 },
    { id: 's3', odds: 2.1 },
  ];
}

function setupPrecheckDefaults(): void {
  jest.spyOn(computations, 'filterQualifyingSelections').mockReturnValue({
    qualifying: makeSelections(),
    disqualified: [],
  });
  jest.spyOn(computations, 'calculateCombinedOdds').mockReturnValue(12.5);
  jest.spyOn(computations, 'computeTicketStrength').mockReturnValue(0.44);
  jest.spyOn(computations, 'meetsMinSelectionCount').mockReturnValue(true);
  jest.spyOn(computations, 'meetsCombinedOddsThreshold').mockReturnValue(true);
}

function setupOptInDefaults(): void {
  setupPrecheckDefaults();
  jest.spyOn(rideGenerator, 'deriveRideDurationSeconds').mockReturnValue(8);
  jest.spyOn(rideGenerator, 'deriveRideParams').mockReturnValue({
    checkpointCount: 10,
    volatility: 0.4,
    crashPct: 0.7,
  });
  jest.spyOn(rideGenerator, 'generateRide').mockReturnValue({
    seed: 'seed-1',
    checkpoints: [
      { index: 0, timeOffsetPct: 0, baseBoostValue: 0.11 },
      { index: 1, timeOffsetPct: 1, baseBoostValue: 0 },
    ],
  });
  jest.spyOn(rideDefinitionRepository, 'createMany').mockResolvedValue([]);
  jest.spyOn(userRewardRepository, 'updateRideStart').mockResolvedValue(makeReward());
  jest.spyOn(userRewardRepository, 'updateStatus').mockResolvedValue(makeReward({ status: 'ENTERED' }));
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

    it('returns threshold failures and eligible response', async () => {
      jest.spyOn(userRewardRepository, 'findById').mockResolvedValue(makeReward());
      jest.spyOn(rewardProfileRepository, 'findById').mockResolvedValue(makeProfile());
      setupPrecheckDefaults();

      (computations.meetsMinSelectionCount as jest.Mock).mockReturnValueOnce(false);
      const minSelections = await rewardOptInService.precheckEligibility(
        'reward-1',
        'user-1',
        makeSelections()
      );
      expect(minSelections.success).toBe(true);
      expect(minSelections.data?.reason_code).toBe(ReasonCode.MIN_SELECTIONS_NOT_MET);
      expect(minSelections.data?.ticket_strength).toBe(0.44);

      (computations.meetsCombinedOddsThreshold as jest.Mock).mockReturnValueOnce(false);
      const minOdds = await rewardOptInService.precheckEligibility(
        'reward-1',
        'user-1',
        makeSelections()
      );
      expect(minOdds.success).toBe(true);
      expect(minOdds.data?.reason_code).toBe(ReasonCode.MIN_COMBINED_ODDS_NOT_MET);

      const eligible = await rewardOptInService.precheckEligibility(
        'reward-1',
        'user-1',
        makeSelections()
      );
      expect(eligible.success).toBe(true);
      expect(eligible.data?.reason_code).toBe(ReasonCode.ELIGIBLE);
      expect(eligible.data?.eligible).toBe(true);
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

      (computations.meetsMinSelectionCount as jest.Mock).mockReturnValueOnce(false);
      const minSelections = await rewardOptInService.optIn('reward-1', input);
      expect(minSelections.error?.code).toBe(ReasonCode.MIN_SELECTIONS_NOT_MET);

      (computations.meetsCombinedOddsThreshold as jest.Mock).mockReturnValueOnce(false);
      const minCombined = await rewardOptInService.optIn('reward-1', input);
      expect(minCombined.error?.code).toBe(ReasonCode.MIN_COMBINED_ODDS_NOT_MET);
    });

    it('returns internal errors when persistence updates fail', async () => {
      jest.spyOn(userRewardRepository, 'findById').mockResolvedValue(makeReward());
      jest.spyOn(rewardProfileRepository, 'findById').mockResolvedValue(makeProfile());
      setupOptInDefaults();

      jest.spyOn(userRewardRepository, 'updateRideStart').mockResolvedValueOnce(null);
      const missingRideStart = await rewardOptInService.optIn('reward-1', input);
      expect(missingRideStart.error?.code).toBe(ReasonCode.INTERNAL_ERROR);
      expect(missingRideStart.error?.message).toMatch(/update reward status/i);

      jest.spyOn(userRewardRepository, 'updateRideStart').mockResolvedValueOnce(makeReward());
      jest.spyOn(userRewardRepository, 'updateStatus').mockResolvedValueOnce(null);
      const missingEntered = await rewardOptInService.optIn('reward-1', input);
      expect(missingEntered.error?.code).toBe(ReasonCode.INTERNAL_ERROR);
      expect(missingEntered.error?.message).toMatch(/start ride/i);
    });

    it('starts ride and returns success payload', async () => {
      jest.spyOn(userRewardRepository, 'findById').mockResolvedValue(makeReward());
      jest.spyOn(rewardProfileRepository, 'findById').mockResolvedValue(makeProfile());
      setupOptInDefaults();

      const result = await rewardOptInService.optIn('reward-1', input);

      expect(result.success).toBe(true);
      expect(result.data?.rideStarted).toBe(true);
      expect(result.data?.reward.status).toBe('ENTERED');
      expect(rideDefinitionRepository.createMany).toHaveBeenCalledTimes(1);
      expect(auditLogRepository.append).toHaveBeenCalledTimes(1);
    });
  });

  it('gets ride checkpoints by reward id', async () => {
    const checkpoints = [{ id: 'cp-1', rewardId: 'reward-1', checkpointIndex: 0, timeOffsetPct: 0, baseBoostValue: 0.1, createdAt: new Date().toISOString() }];
    jest.spyOn(rideDefinitionRepository, 'findByRewardId').mockResolvedValue(checkpoints);

    const result = await rewardOptInService.getRideCheckpoints('reward-1');
    expect(result).toEqual(checkpoints);
  });
});
