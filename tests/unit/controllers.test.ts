import type { NextFunction, Request, Response } from 'express';
import {
  getQuote,
  lockBoost,
  getLock,
} from '../../src/controllers/boostController';
import {
  settleBet,
  getSettlement,
} from '../../src/controllers/settlementController';
import {
  grantReward,
  getReward,
  getRewardsByUser,
  optInToReward,
  getActiveReward,
  precheckEligibility,
} from '../../src/controllers/rewardController';
import { boostQuoteService } from '../../src/services/boostQuoteService';
import { boostLockService } from '../../src/services/boostLockService';
import { settlementService } from '../../src/services/settlementService';
import { rewardEntitlementService } from '../../src/services/rewardEntitlementService';
import { rewardOptInService } from '../../src/services/rewardOptInService';
import { ReasonCode } from '../../src/types/reasonCodes';

function mockResponse(): Response {
  const res = {} as Response;
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  res.send = jest.fn().mockReturnValue(res);
  return res;
}

function mockRequest(
  body: Record<string, unknown> = {},
  params: Record<string, string> = {},
  query: Record<string, string> = {}
): Request {
  return { body, params, query } as unknown as Request;
}

describe('controller branch coverage', () => {
  let res: Response;
  let next: jest.MockedFunction<NextFunction>;

  beforeEach(() => {
    res = mockResponse();
    next = jest.fn() as unknown as jest.MockedFunction<NextFunction>;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('boostController', () => {
    it('handles getQuote success/failure/validation', async () => {
      jest.spyOn(boostQuoteService, 'getQuote').mockResolvedValue({
        success: true,
        data: {
          eligible: true,
          reason_code: ReasonCode.ELIGIBLE,
          qualifying_selection_count: 1,
          total_selection_count: 1,
          combined_odds: 1.5,
          current_boost_pct: 0.1,
          effective_min_boost_pct: 0.05,
          effective_max_boost_pct: 0.2,
          theoretical_max_boost_pct: 0.2,
          ticket_strength: 0.5,
          boost_model: {
            selection_weight: 0.75,
            odds_weight: 0.25,
            max_eligibility_exponent: 1.2,
            effective_min_floor_rate: 0.35,
            selection_ratio: 0.5,
            odds_ratio: 0.5,
            eligibility_factor: 0.5,
          },
          ride_end_at_offset_seconds: 10,
          ride_crash_at_offset_seconds: 8,
        },
      });

      await getQuote(mockRequest({
        user_id: 'u1',
        reward_id: '00000000-0000-0000-0000-000000000001',
        bet_id: 'b1',
      }), res, next);
      expect(res.json).toHaveBeenCalledTimes(1);

      jest.spyOn(boostQuoteService, 'getQuote').mockResolvedValueOnce({
        success: false,
        error: { code: ReasonCode.INTERNAL_ERROR, message: 'failed' },
      });
      await getQuote(mockRequest({
        user_id: 'u1',
        reward_id: '00000000-0000-0000-0000-000000000001',
        bet_id: 'b1',
      }), res, next);
      expect(next).toHaveBeenCalled();

      await getQuote(mockRequest({ user_id: 'u1' }), res, next);
      expect(next).toHaveBeenCalled();
    });

    it('handles lockBoost success/failure', async () => {
      jest.spyOn(boostLockService, 'lockBoost').mockResolvedValue({
        success: true,
        data: {
          lock_id: 'lock-1',
          bet_id: 'bet-1',
          reward_id: 'reward-1',
          locked_boost_pct: 0.1,
          qualifying_selections: 3,
          qualifying_odds: 10,
          ticket_strength: 0.5,
          locked_at: new Date().toISOString(),
          effective_min_boost_pct: 0.05,
          effective_max_boost_pct: 0.2,
          theoretical_max_boost_pct: 0.25,
          boost_model: {
            selection_weight: 0.75,
            odds_weight: 0.25,
            max_eligibility_exponent: 1.2,
            effective_min_floor_rate: 0.35,
            selection_ratio: 0.5,
            odds_ratio: 0.5,
            eligibility_factor: 0.5,
          },
          ride_stop_at_offset_seconds: 2,
          ride_end_at_offset_seconds: 10,
          ride_crash_at_offset_seconds: 8,
          ride_path: [],
        },
      });

      await lockBoost(mockRequest({
        user_id: 'u1',
        reward_id: '00000000-0000-0000-0000-000000000001',
        bet_id: 'b1',
      }), res, next);
      expect(res.status).toHaveBeenCalledWith(201);

      jest.spyOn(boostLockService, 'lockBoost').mockResolvedValueOnce({
        success: false,
        error: {
          code: ReasonCode.REWARD_ALREADY_USED,
          message: 'used',
          details: { a: 1 } as unknown as never,
        },
      });
      await lockBoost(mockRequest({
        user_id: 'u1',
        reward_id: '00000000-0000-0000-0000-000000000001',
        bet_id: 'b1',
      }), res, next);
      expect(next).toHaveBeenCalled();
    });

    it('handles getLock success/not-found/failure', async () => {
      const lock = {
        id: 'lock-1',
        betId: 'bet-1',
        rewardId: 'reward-1',
        lockedBoostPct: 0.12,
        qualifyingSelections: 5,
        qualifyingOdds: 15,
        ticketStrength: 0.6,
        lockedAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
        snapshot: {
          effectiveMinBoostPct: 0.05,
          maxEligibleBoostPct: 0.3,
          maxPossibleBoostPct: 0.4,
          rideDurationSeconds: 10,
          elapsedPct: 0.5,
          crashPct: 0.8,
          ridePath: [],
          boostModel: {
            selectionWeight: 0.75,
            oddsWeight: 0.25,
            maxEligibilityExponent: 1.2,
            effectiveMinFloorRate: 0.35,
            selectionRatio: 0.5,
            oddsRatio: 0.5,
            eligibilityFactor: 0.5,
          },
        },
      } as unknown as Awaited<ReturnType<typeof boostLockService.getLockByBetId>> extends { data: infer T } ? T : never;

      jest.spyOn(boostLockService, 'getLockByBetId').mockResolvedValue({ success: true, data: lock });
      await getLock(mockRequest({}, { betId: 'bet-1' }), res, next);
      expect(res.json).toHaveBeenCalled();

      jest.spyOn(boostLockService, 'getLockByBetId').mockResolvedValueOnce({ success: true, data: null });
      await getLock(mockRequest({}, { betId: 'bet-missing' }), res, next);
      expect(res.status).toHaveBeenCalledWith(404);

      jest.spyOn(boostLockService, 'getLockByBetId').mockResolvedValueOnce({
        success: false,
        error: { code: ReasonCode.INTERNAL_ERROR, message: 'boom' },
      });
      await getLock(mockRequest({}, { betId: 'bet-err' }), res, next);
      expect(next).toHaveBeenCalled();
    });
  });

  describe('settlementController', () => {
    it('handles settleBet and getSettlement branches', async () => {
      jest.spyOn(settlementService, 'settleBet').mockResolvedValue({
        success: true,
        data: {
          settlement_id: 's1',
          bet_id: 'b1',
          outcome: 'WIN',
          winnings: 100,
          bonus_amount: 10,
          locked_boost_pct: 0.1,
          settled_at: new Date().toISOString(),
        },
      });

      await settleBet(mockRequest({
        bet_id: 'b1',
        outcome: 'WIN',
        winnings: 100,
      }), res, next);
      expect(res.status).toHaveBeenCalledWith(201);

      jest.spyOn(settlementService, 'settleBet').mockResolvedValueOnce({
        success: false,
        error: { code: ReasonCode.LOCK_NOT_FOUND, message: 'missing' },
      });
      await settleBet(mockRequest({
        bet_id: 'b1',
        outcome: 'WIN',
        winnings: 100,
      }), res, next);
      expect(next).toHaveBeenCalled();

      await settleBet(mockRequest({ bet_id: 'b1', winnings: 100 }), res, next);
      expect(next).toHaveBeenCalled();

      jest.spyOn(settlementService, 'getSettlementByBetId').mockResolvedValue({
        success: true,
        data: null,
      });
      await getSettlement(mockRequest({}, { betId: 'missing' }), res, next);
      expect(res.status).toHaveBeenCalledWith(404);

      jest.spyOn(settlementService, 'getSettlementByBetId').mockResolvedValueOnce({
        success: true,
        data: {
          settlement_id: 's2',
          bet_id: 'b2',
          outcome: 'LOSS',
          winnings: 0,
          bonus_amount: 0,
          locked_boost_pct: 0.2,
          settled_at: new Date().toISOString(),
        },
      });
      await getSettlement(mockRequest({}, { betId: 'b2' }), res, next);
      expect(res.json).toHaveBeenCalled();

      jest.spyOn(settlementService, 'getSettlementByBetId').mockResolvedValueOnce({
        success: false,
        error: { code: ReasonCode.INTERNAL_ERROR, message: 'err' },
      });
      await getSettlement(mockRequest({}, { betId: 'b3' }), res, next);
      expect(next).toHaveBeenCalled();
    });
  });

  describe('rewardController', () => {
    const rewardDto = {
      id: 'reward-1',
      userId: 'u1',
      profileVersionId: 'p1',
      status: 'GRANTED',
      startTime: new Date().toISOString(),
      endTime: new Date().toISOString(),
      seed: 'seed',
      optedInAt: null,
      betId: null,
      ticketSnapshot: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } as const;

    it('handles grant/get/list/opt-in/precheck branches', async () => {
      jest.spyOn(rewardEntitlementService, 'grantReward').mockResolvedValue({
        success: true,
        data: rewardDto,
      });
      await grantReward(mockRequest({
        user_id: 'u1',
        profile_version_id: '00000000-0000-0000-0000-000000000001',
      }), res, next);
      expect(res.status).toHaveBeenCalledWith(201);

      jest.spyOn(rewardEntitlementService, 'grantReward').mockResolvedValueOnce({
        success: false,
        error: { code: ReasonCode.PROFILE_NOT_FOUND, message: 'missing profile' },
      });
      await grantReward(mockRequest({
        user_id: 'u1',
        profile_version_id: '00000000-0000-0000-0000-000000000001',
      }), res, next);
      expect(next).toHaveBeenCalled();

      await grantReward(mockRequest({ user_id: 'u1' }), res, next);
      expect(next).toHaveBeenCalled();

      jest.spyOn(rewardEntitlementService, 'getRewardById').mockResolvedValue({
        success: true,
        data: rewardDto,
      });
      await getReward(mockRequest({}, { id: 'reward-1' }), res, next);
      expect(res.json).toHaveBeenCalled();

      jest.spyOn(rewardEntitlementService, 'getRewardById').mockResolvedValueOnce({
        success: false,
        error: { code: ReasonCode.REWARD_NOT_FOUND, message: 'missing' },
      });
      await getReward(mockRequest({}, { id: 'missing' }), res, next);
      expect(next).toHaveBeenCalled();

      jest.spyOn(rewardEntitlementService, 'getRewardsByUserId').mockResolvedValue({
        success: true,
        data: [rewardDto],
      });
      await getRewardsByUser(mockRequest({}, { userId: 'u1' }), res, next);
      expect(res.json).toHaveBeenCalled();

      jest.spyOn(rewardEntitlementService, 'getRewardsByUserId').mockResolvedValueOnce({
        success: false,
        error: { code: ReasonCode.INTERNAL_ERROR, message: 'boom' },
      });
      await getRewardsByUser(mockRequest({}, { userId: 'u1' }), res, next);
      expect(next).toHaveBeenCalled();

      jest.spyOn(rewardOptInService, 'optIn').mockResolvedValue({
        success: true,
        data: {
          reward: { ...rewardDto, status: 'ENTERED', endTime: new Date().toISOString() },
          rideStarted: true,
        },
      });
      await optInToReward(mockRequest({
        user_id: 'u1',
        bet_id: 'bet-1',
        ticket: { selections: [{ id: 's1', odds: 1.5 }] },
      }, { id: 'reward-1' }), res, next);
      expect(res.json).toHaveBeenCalled();

      jest.spyOn(rewardOptInService, 'optIn').mockResolvedValueOnce({
        success: false,
        error: { code: ReasonCode.NOT_OPTED_IN, message: 'fail' },
      });
      await optInToReward(mockRequest({
        user_id: 'u1',
        bet_id: 'bet-1',
        ticket: { selections: [{ id: 's1', odds: 1.5 }] },
      }, { id: 'reward-1' }), res, next);
      expect(next).toHaveBeenCalled();

      await optInToReward(mockRequest({ user_id: 'u1' }, { id: 'reward-1' }), res, next);
      expect(next).toHaveBeenCalled();

      jest.spyOn(rewardEntitlementService, 'getActiveRewardForUser').mockResolvedValue({
        success: true,
        data: null,
      });
      await getActiveReward(mockRequest({}, { userId: 'u1' }), res, next);
      expect(res.json).toHaveBeenCalledWith({ active_reward: null });

      jest.spyOn(rewardEntitlementService, 'getActiveRewardForUser').mockResolvedValueOnce({
        success: true,
        data: rewardDto,
      });
      await getActiveReward(mockRequest({}, { userId: 'u1' }), res, next);
      expect(res.json).toHaveBeenCalled();

      jest.spyOn(rewardEntitlementService, 'getActiveRewardForUser').mockResolvedValueOnce({
        success: false,
        error: { code: ReasonCode.INTERNAL_ERROR, message: 'fail' },
      });
      await getActiveReward(mockRequest({}, { userId: 'u1' }), res, next);
      expect(next).toHaveBeenCalled();

      jest.spyOn(rewardOptInService, 'precheckEligibility').mockResolvedValue({
        success: true,
        data: {
          eligible: true,
          reason_code: ReasonCode.ELIGIBLE,
          qualifying_selection_count: 1,
          total_selection_count: 1,
          combined_odds: 1.5,
          ticket_strength: 0.1,
        },
      });
      await precheckEligibility(mockRequest({
        user_id: 'u1',
        ticket: { selections: [{ id: 's1', odds: 1.5 }] },
      }, { id: 'reward-1' }), res, next);
      expect(res.json).toHaveBeenCalled();

      jest.spyOn(rewardOptInService, 'precheckEligibility').mockResolvedValueOnce({
        success: false,
        error: { code: ReasonCode.INTERNAL_ERROR, message: 'oops' },
      });
      await precheckEligibility(mockRequest({
        user_id: 'u1',
        ticket: { selections: [{ id: 's1', odds: 1.5 }] },
      }, { id: 'reward-1' }), res, next);
      expect(next).toHaveBeenCalled();

      await precheckEligibility(mockRequest({ user_id: 'u1' }, { id: 'reward-1' }), res, next);
      expect(next).toHaveBeenCalled();
    });
  });
});
