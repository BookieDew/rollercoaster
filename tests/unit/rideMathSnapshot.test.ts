import { config } from '../../src/config';
import { buildRideMath, resolveRideMath, toRideMathProfile } from '../../src/services/rideMathSnapshot';
import { evaluateTicket } from '../../src/services/ticketEvaluation';
import type { RewardProfileVersion } from '../../src/types/rewardProfile';
import type { RideMathSnapshotV4 } from '../../src/types/ride';
import type { UserReward } from '../../src/types/userReward';
import { findSeed } from '../helpers/v4Rides';

/** Repair 2 of 1b-iii-a: the rebuild compares the reward row's end time to the frozen end as an instant. */
const SEED = findSeed('snapshot-end-time', (p) => p.outcome === 'CRASHED');
const START_MS = Date.parse('2026-10-30T10:00:00.000Z');

const PROFILE: RewardProfileVersion = {
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
  createdAt: '2026-10-30T09:00:00.000Z',
  updatedAt: '2026-10-30T09:00:00.000Z',
};
const SELECTIONS = [{ id: 's1', odds: 1.8 }, { id: 's2', odds: 1.9 }];

function frozenMath(): RideMathSnapshotV4 {
  const profile = toRideMathProfile(PROFILE);
  return buildRideMath(SEED, profile, evaluateTicket(SELECTIONS, profile), config.ride, START_MS).math;
}

/**
 * An entered reward whose row `end_time` is the given value. The repository casts the column `as string`,
 * so on Postgres (pg returns `timestamp` as a Date) a Date reaches the rebuild under the string type.
 */
function rewardWithEndTime(endTime: unknown, math = frozenMath()): UserReward {
  return {
    id: 'reward-1',
    userId: 'user-1',
    profileVersionId: 'profile-1',
    status: 'ENTERED',
    startTime: math.startTime,
    endTime: endTime as string,
    seed: SEED,
    betId: 'bet-1',
    ticketSnapshot: { rideMath: math, selections: SELECTIONS },
    optedInAt: math.startTime,
    createdAt: math.startTime,
    updatedAt: math.startTime,
  };
}

describe('resolveRideMath end-time check', () => {
  const math = frozenMath();
  const endMs = Date.parse(math.endTime);

  it('freezes a canonical ISO end time (the value SQLite returns)', () => {
    expect(new Date(endMs).toISOString()).toBe(math.endTime);
    expect(endMs).toBeGreaterThan(START_MS);
  });

  it('accepts the row end time as the same ISO string (string path unchanged)', () => {
    const resolved = resolveRideMath(rewardWithEndTime(math.endTime));
    expect(resolved).not.toBeNull();
    expect(resolved?.math).toEqual(math);
  });

  it('fails closed on an ISO string 1 ms off or unparsable', () => {
    expect(resolveRideMath(rewardWithEndTime(new Date(endMs + 1).toISOString()))).toBeNull();
    expect(resolveRideMath(rewardWithEndTime(new Date(endMs - 1).toISOString()))).toBeNull();
    expect(resolveRideMath(rewardWithEndTime('not-a-time'))).toBeNull();
    expect(resolveRideMath(rewardWithEndTime(''))).toBeNull();
  });

  it('accepts the row end time as a Date at the same instant (Postgres)', () => {
    const resolved = resolveRideMath(rewardWithEndTime(new Date(endMs)));
    expect(resolved).not.toBeNull();
    expect(resolved?.math).toEqual(math);
    expect(resolved?.ride.params.durationSeconds).toBe(math.rideDurationSeconds);
  });

  it('fails closed on a Date 1 ms off or an invalid Date', () => {
    expect(resolveRideMath(rewardWithEndTime(new Date(endMs + 1)))).toBeNull();
    expect(resolveRideMath(rewardWithEndTime(new Date(endMs - 1)))).toBeNull();
    expect(resolveRideMath(rewardWithEndTime(new Date(Number.NaN)))).toBeNull();
  });

  it('accepts epoch milliseconds of the same instant and fails closed on anything else', () => {
    expect(resolveRideMath(rewardWithEndTime(endMs))).not.toBeNull();
    expect(resolveRideMath(rewardWithEndTime(endMs + 1))).toBeNull();
    expect(resolveRideMath(rewardWithEndTime(endMs / 1000))).toBeNull();
    expect(resolveRideMath(rewardWithEndTime(Number.NaN))).toBeNull();
    for (const value of [null, undefined, {}, [], true, { getTime: () => endMs }]) {
      expect(resolveRideMath(rewardWithEndTime(value))).toBeNull();
    }
  });

  it('still requires the frozen end to be the canonical start + duration, whatever the row type', () => {
    const shifted = new Date(endMs + 1).toISOString();
    const damaged = { ...math, endTime: shifted };
    expect(resolveRideMath(rewardWithEndTime(new Date(endMs + 1), damaged))).toBeNull();
    expect(resolveRideMath(rewardWithEndTime(shifted, damaged))).toBeNull();
  });
});
