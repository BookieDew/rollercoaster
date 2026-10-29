import { boostQuoteService, toPublicQuote } from '../../src/services/boostQuoteService';
import { userRewardRepository } from '../../src/db/repositories/userRewardRepository';
import { toDTO, publicEndTime } from '../../src/types/userReward';
import { ReasonCode } from '../../src/types/reasonCodes';
import type { QuoteResponse } from '../../src/types/ticket';
import type { UserReward, UserRewardStatus } from '../../src/types/userReward';

function makeQuote(overrides: Partial<QuoteResponse> = {}): QuoteResponse {
  return {
    eligible: true,
    reason_code: ReasonCode.ELIGIBLE,
    qualifying_selection_count: 3,
    total_selection_count: 3,
    combined_odds: 9,
    current_boost_pct: 0.12,
    effective_min_boost_pct: 0.05,
    effective_max_boost_pct: 0.4,
    theoretical_max_boost_pct: 0.3,
    ticket_strength: 0.5,
    ride_elapsed_seconds: 1.234,
    ride_end_at_offset_seconds: null,
    ride_crash_at_offset_seconds: null,
    ...overrides,
  };
}

function makeReward(status: UserRewardStatus): UserReward {
  return {
    id: 'reward-1',
    userId: 'user-1',
    profileVersionId: 'profile-1',
    status,
    startTime: '2026-10-29T10:00:00.000Z',
    endTime: '2026-10-29T10:00:07.250Z',
    seed: 'f'.repeat(64),
    betId: status === 'GRANTED' ? null : 'bet-1',
    ticketSnapshot: null,
    optedInAt: null,
    createdAt: '2026-10-29T10:00:00.000Z',
    updatedAt: '2026-10-29T10:00:00.000Z',
  };
}

describe('public quote view', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('withholds the reference maximum only while the ride is live', () => {
    const live = makeQuote();
    expect(toPublicQuote(live)).toEqual({ ...live, theoretical_max_boost_pct: null });
    expect(live.theoretical_max_boost_pct).toBe(0.3);

    const crashed = makeQuote({
      eligible: false,
      reason_code: ReasonCode.RIDE_CRASHED,
      current_boost_pct: 0,
      ride_end_at_offset_seconds: 7.25,
      ride_crash_at_offset_seconds: 4.1,
    });
    expect(toPublicQuote(crashed)).toBe(crashed);
  });

  it('getPublicQuote applies the redaction to service results and passes failures through', async () => {
    jest.spyOn(userRewardRepository, 'findById').mockResolvedValue(null);
    const notFound = await boostQuoteService.getPublicQuote({ userId: 'u', rewardId: 'r', betId: 'b' });
    expect(notFound.data?.reason_code).toBe(ReasonCode.REWARD_NOT_FOUND);
    expect(notFound.data?.theoretical_max_boost_pct).toBeNull();

    jest.spyOn(userRewardRepository, 'findById').mockResolvedValue({
      ...makeReward('ENTERED'),
      ticketSnapshot: { rideMath: { version: 99 } },
    });
    const malformed = await boostQuoteService.getPublicQuote({ userId: 'user-1', rewardId: 'reward-1', betId: 'bet-1' });
    expect(malformed.success).toBe(false);
    expect(malformed.error?.code).toBe(ReasonCode.INVALID_CONFIGURATION);
  });
});

describe('public reward view', () => {
  it.each<[UserRewardStatus, string | null]>([
    ['GRANTED', null],
    ['ENTERED', null],
    ['USED', '2026-10-29T10:00:07.250Z'],
    ['EXPIRED', '2026-10-29T10:00:07.250Z'],
  ])('%s -> end_time %s', (status, expected) => {
    const reward = makeReward(status);
    expect(publicEndTime(reward)).toBe(expected);
    const dto = toDTO(reward);
    expect(dto.end_time).toBe(expected);
    expect(dto).not.toHaveProperty('seed');
    expect(JSON.stringify(dto)).not.toContain(reward.seed);
  });
});
