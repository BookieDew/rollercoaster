import { createHash } from 'crypto';
import { config } from '../../src/config';
import * as math from '../../src/computations';
import { getQuote } from '../../src/services/boostQuoteService';
import { lockBoost } from '../../src/services/boostLockService';
import { optIn, getRideCheckpoints } from '../../src/services/rewardOptInService';
import { simulateRide } from '../../src/services/simulationService';
import { userRewardRepository } from '../../src/db/repositories/userRewardRepository';
import { rewardProfileRepository } from '../../src/db/repositories/rewardProfileRepository';
import { rideDefinitionRepository } from '../../src/db/repositories/rideDefinitionRepository';
import { betBoostLockRepository } from '../../src/db/repositories/betBoostLockRepository';
import { auditLogRepository } from '../../src/db/repositories/auditLogRepository';
import { ReasonCode } from '../../src/types/reasonCodes';
import type { Selection } from '../../src/types/ticket';
import type { RewardProfileVersion, RideMode } from '../../src/types/rewardProfile';
import type { UserReward } from '../../src/types/userReward';
import type { BetBoostLock } from '../../src/types/betBoostLock';
import type { RideMathSnapshot } from '../../src/services/rideMathSnapshot';

const startMs = Date.parse('2026-09-18T10:00:00.000Z');
const input = { userId: 'user', rewardId: 'reward', betId: 'bet' };
const lowTicket: Selection[] = [1, 2, 3].map(id => ({ id: String(id), odds: 1.5 }));
const strongTicket = Array.from({ length: 12 }, (_, id) => ({ id: String(id), odds: 2 }));
const sgpTicket: Selection[] = [
  { id: 'composite', odds: 1.5, selection_type: 'SGP_COMPOSITE', sgp_group_id: 'g' },
  { id: 'leg', odds: 8, selection_type: 'SGP_LEG', sgp_group_id: 'g' },
  { id: 'b', odds: 1.5 }, { id: 'c', odds: 1.5 },
  { id: 'excluded', odds: 50, eligible: false },
  { id: 'reason', odds: 50, ineligible_reason: 'excluded' },
  { id: 'low', odds: 1.1 },
];
const productionTiming = { minDurationSeconds: 2, maxDurationSeconds: 15, minCrashSeconds: 2 };
const oldTiming = { ...config.ride };

// Only persistence and time are doubled. Generation, filtering, strength, floor/cap,
// live services, simulation and path construction all use production computations.
function setup(mode: RideMode, seed: string, overrides: Partial<RewardProfileVersion> = {}) {
  const timestamp = new Date(startMs).toISOString();
  const profile: RewardProfileVersion = {
    id: 'profile', name: 'test', description: null, minSelections: 3,
    minCombinedOdds: 3, minSelectionOdds: 1.2, minBoostPct: 0.05, maxBoostPct: 1,
    maxBoostMinSelections: null, maxBoostMinCombinedOdds: null,
    maxEligibilitySelectionWeight: 0.75, maxEligibilityOddsWeight: 0.25,
    effectiveMinFloorRate: 0.35, rideMode: mode, rideDurationSeconds: 10,
    isActive: true, createdAt: timestamp, updatedAt: timestamp, ...overrides,
  };
  const reward: UserReward = {
    id: 'reward', userId: 'user', profileVersionId: 'profile', status: 'GRANTED',
    startTime: timestamp, endTime: timestamp, seed, betId: null, ticketSnapshot: null,
    optedInAt: null, createdAt: timestamp, updatedAt: timestamp,
  };
  let points: Awaited<ReturnType<typeof rideDefinitionRepository.findByRewardId>> = [];
  let savedLock: BetBoostLock | null = null;
  jest.spyOn(rewardProfileRepository, 'findById').mockResolvedValue(profile);
  jest.spyOn(userRewardRepository, 'findById').mockResolvedValue(reward);
  jest.spyOn(userRewardRepository, 'updateRideStart').mockImplementation(async (_, startTime, endTime, betId, snapshot) => {
    Object.assign(reward, { startTime, endTime, betId, ticketSnapshot: JSON.parse(JSON.stringify(snapshot)) });
    return reward;
  });
  jest.spyOn(userRewardRepository, 'updateStatus').mockImplementation(async (_, status) => {
    reward.status = status;
    return reward;
  });
  jest.spyOn(rideDefinitionRepository, 'createMany').mockImplementation(async cps => {
    points = cps.map((cp, index) => ({ ...cp, id: String(index), createdAt: timestamp }));
    return points;
  });
  jest.spyOn(rideDefinitionRepository, 'findByRewardId').mockImplementation(async () => points);
  jest.spyOn(betBoostLockRepository, 'findByBetId').mockImplementation(async () => savedLock);
  jest.spyOn(betBoostLockRepository, 'create').mockImplementation(async payload => {
    savedLock = { ...payload, id: 'lock', lockedAt: timestamp, createdAt: timestamp };
    return savedLock;
  });
  jest.spyOn(auditLogRepository, 'append').mockResolvedValue({
    id: 'audit', entityType: 'user_reward', entityId: 'reward', action: 'test',
    payload: {}, timestamp, createdAt: timestamp,
  });
  return {
    profile, reward,
    get snapshot() { return reward.ticketSnapshot?.rideMath as RideMathSnapshot; },
    get savedLock() { return savedLock; },
    setLegacyPoints(cps: math.RideCheckpoint[]) { points = cps.map(cp => ({ ...cp, checkpointIndex: cp.index, id: String(cp.index), rewardId: reward.id, createdAt: timestamp })); },
    clearLock() { savedLock = null; reward.status = 'ENTERED'; },
  };
}

function expectedFromRideModel(f: ReturnType<typeof setup>, selections: Selection[], elapsedPct: number) {
  const p = f.snapshot.profile;
  const qualifying = math.filterQualifyingSelections(selections, p.minSelectionOdds).qualifying;
  const odds = math.calculateCombinedOdds(qualifying);
  const strength = math.computeTicketStrength(qualifying.length, odds, { minSelections: p.minSelections });
  const wave = math.generateRide(f.reward.seed, {
    ...f.snapshot, minBoostPct: p.minBoostPct, maxBoostPct: p.maxBoostPct,
    durationSeconds: f.snapshot.rideDurationSeconds, rideMode: 'WAVES', ticketStrength: strength,
  });
  const originalCheckpointMax = Math.max(...wave.checkpoints.filter(cp => cp.timeOffsetPct <= f.snapshot.crashPct).map(cp => cp.baseBoostValue));
  const details = (rideValue: number, ended = false) => math.calculateFinalBoostDetails({
    rideValue, ticketStrength: strength, qualifyingSelections: qualifying.length,
    combinedOdds: odds, hasRideEnded: ended, config: p,
  });
  const rawMaximum = f.snapshot.version >= 2
    ? Math.max(originalCheckpointMax, math.interpolateRideValue(wave.checkpoints, f.snapshot.crashPct))
    : originalCheckpointMax;
  const maximum = details(rawMaximum).finalBoostPct;
  const wavePoints = f.snapshot.version === 3 ? f.snapshot.checkpoints! : wave.checkpoints;
  const evaluate = (timePct: number) => timePct >= f.snapshot.crashPct || timePct >= 1 ? 0 :
    p.rideMode === 'WAVES'
      ? details(math.interpolateRideValue(wavePoints, timePct)).finalBoostPct
      : math.calculateLinearBoostPctAtElapsed(timePct, f.snapshot.crashPct, details(0).minBoost, maximum);
  return { maximum, boost: evaluate(elapsedPct), evaluate, strength, odds, count: qualifying.length };
}

beforeEach(() => {
  Object.assign(config.ride, productionTiming);
  jest.useFakeTimers().setSystemTime(startMs);
});
afterEach(() => {
  jest.restoreAllMocks();
  jest.useRealTimers();
  Object.assign(config.ride, oldTiming);
});

const fixtures: Array<[string, Partial<RewardProfileVersion>, Selection[]]> = [
  ['no targets / weak floor', {}, lowTicket],
  ['selection target', { maxBoostMinSelections: 10 }, lowTicket],
  ['odds target', { maxBoostMinCombinedOdds: 50 }, lowTicket],
  ['both targets', { maxBoostMinSelections: 10, maxBoostMinCombinedOdds: 50 }, lowTicket],
  ['high targets', { maxBoostMinSelections: 100, maxBoostMinCombinedOdds: 10000 }, lowTicket],
  ['selection-only weight', { maxBoostMinSelections: 10, maxBoostMinCombinedOdds: 50, maxEligibilitySelectionWeight: 1, maxEligibilityOddsWeight: 0 }, lowTicket],
  ['odds-only weight', { maxBoostMinSelections: 10, maxBoostMinCombinedOdds: 50, maxEligibilitySelectionWeight: 0, maxEligibilityOddsWeight: 1 }, lowTicket],
  ['zero floor rate', { maxBoostMinSelections: 10, maxBoostMinCombinedOdds: 50, effectiveMinFloorRate: 0 }, lowTicket],
  ['full floor rate', { maxBoostMinSelections: 10, maxBoostMinCombinedOdds: 50, effectiveMinFloorRate: 1 }, lowTicket],
  ['saturated', { maxBoostMinSelections: 10, maxBoostMinCombinedOdds: 50 }, strongTicket],
  ['equal min/max', { minBoostPct: 0.1, maxBoostPct: 0.1 }, lowTicket],
  ['SGP and exclusions', { maxBoostMinSelections: 10, maxBoostMinCombinedOdds: 50 }, sgpTicket],
];

describe.each<RideMode>(['WAVES', 'LINEAR'])('%s authoritative consistency', mode => {
  it.each(fixtures)('%s: quote / lock / simulation / path agree', async (_, overrides, selections) => {
    const f = setup(mode, 'audit-seed-42', overrides);
    expect((await optIn('reward', { userId: 'user', betId: 'bet', selections })).success).toBe(true);
    const durationMs = Math.round(f.snapshot.rideDurationSeconds * 1000);
    const elapsedMs = Math.floor(durationMs * f.snapshot.crashPct * 0.4);
    jest.setSystemTime(startMs + elapsedMs);
    const quote = (await getQuote(input)).data!;
    const expected = expectedFromRideModel(f, selections, elapsedMs / durationMs);
    expect(quote.eligible).toBe(true);
    expect(quote.maximum_model).toBe('WAVES_PRE_CRASH_SUPREMUM_V2');
    expect(quote.current_boost_pct).toBe(expected.boost);
    expect(quote.theoretical_max_boost_pct).toBe(expected.maximum);
    expect(quote.ticket_strength).toBe(expected.strength);
    expect(quote.qualifying_selection_count).toBe(expected.count);
    expect(quote.combined_odds).toBe(expected.odds);
    expect(quote.ride_elapsed_seconds).toBe(elapsedMs / 1000);
    expect(quote.ride_path).toBeUndefined();
    expect(quote.ride_end_at_offset_seconds).toBeNull();
    expect(quote.ride_crash_at_offset_seconds).toBeNull();
    const simulation = (await simulateRide({ profileId: 'profile', seed: f.reward.seed, ticket: { selections }, samplePoints: durationMs })).data!;
    expect(simulation.eligible).toBe(true);
    expect(simulation.reason_code).toBe(ReasonCode.ELIGIBLE);
    expect(simulation.serialization_decimals).toBe(4);
    expect(simulation.maximum_model).toBe('WAVES_PRE_CRASH_SUPREMUM_V2');
    expect(simulation.curve[elapsedMs].final_boost_pct).toBe(Math.round(expected.boost * 10000) / 10000);
    const locked = (await lockBoost(input)).data!;
    expect(locked.locked_boost_pct).toBe(quote.current_boost_pct);
    expect(locked.maximum_model).toBe('WAVES_PRE_CRASH_SUPREMUM_V2');
    expect(locked.theoretical_max_boost_pct).toBe(quote.theoretical_max_boost_pct);
    expect(locked.ride_stop_at_offset_seconds).toBe(quote.ride_elapsed_seconds);
    for (const point of locked.ride_path) expect(point.baseBoostValue).toBe(expected.evaluate(point.timePct));
    jest.setSystemTime(startMs + 60000);
    f.profile.maxBoostPct = 10;
    const repeated = await lockBoost(input);
    expect(repeated.data).toEqual(locked);
  });

  it('freezes all resolved math and timing inputs at opt-in despite later profile/config mutations', async () => {
    const f = setup(mode, 'audit-seed-42');
    await optIn('reward', { userId: 'user', betId: 'bet', selections: lowTicket });
    jest.setSystemTime(startMs + 1000);
    const before = (await getQuote(input)).data!;
    expect(f.snapshot.version).toBe(3);
    Object.assign(f.profile, {
      minSelections: 30, minCombinedOdds: 1000, minSelectionOdds: 9,
      minBoostPct: 0.3, maxBoostPct: 10, maxBoostMinSelections: 30,
      maxBoostMinCombinedOdds: 1000, maxEligibilitySelectionWeight: 0,
      maxEligibilityOddsWeight: 1, effectiveMinFloorRate: 1,
      rideMode: mode === 'WAVES' ? 'LINEAR' : 'WAVES',
    });
    config.ride.minCrashSeconds = 100;
    jest.mocked(rewardProfileRepository.findById).mockClear().mockResolvedValue(null);
    const after = (await getQuote(input)).data!;
    expect(after).toEqual(before);
    const locked = (await lockBoost(input)).data!;
    expect(locked.locked_boost_pct).toBe(before.current_boost_pct);
    expect(f.savedLock!.snapshot.rideMode).toBe(mode);
    expect(f.savedLock!.snapshot.minSelections).toBe(3);
    expect(rewardProfileRepository.findById).not.toHaveBeenCalled();
  });

  it('retains the legacy fallback without rewriting its snapshot', async () => {
    const f = setup(mode, 'audit-seed-42');
    await optIn('reward', { userId: 'user', betId: 'bet', selections: lowTicket });
    jest.setSystemTime(startMs + 1000);
    const frozenQuote = (await getQuote(input)).data!;
    delete f.reward.ticketSnapshot!.rideMath;
    const originalTicketSnapshot = JSON.stringify(f.reward.ticketSnapshot);
    const legacyQuote = (await getQuote(input)).data!;
    expect(legacyQuote).toEqual({ ...frozenQuote, maximum_model: 'LEGACY_CHECKPOINT_MAX_V1' });
    expect((await lockBoost(input)).data!.locked_boost_pct).toBe(frozenQuote.current_boost_pct);
    expect(JSON.stringify(f.reward.ticketSnapshot)).toBe(originalTicketSnapshot);
  });

  it.each([
    [[], ReasonCode.MIN_SELECTIONS_NOT_MET],
    [lowTicket.slice(0, 2), ReasonCode.MIN_SELECTIONS_NOT_MET],
    [lowTicket.map(s => ({ ...s, odds: 1.2 })), ReasonCode.MIN_COMBINED_ODDS_NOT_MET],
    [sgpTicket.filter(s => s.id !== 'c'), ReasonCode.MIN_SELECTIONS_NOT_MET],
  ] as Array<[Selection[], ReasonCode]>)('reports supplied ineligible tickets without fabricated payouts (%j)', async (selections, reason) => {
    const f = setup(mode, 'audit-seed-42');
    const simulation = (await simulateRide({ profileId: 'profile', seed: f.reward.seed, ticket: { selections }, samplePoints: 10 })).data!;
    expect(simulation.evaluation_mode).toBe('TICKET');
    expect(simulation.eligible).toBe(false);
    expect(simulation.reason_code).toBe(reason);
    expect(simulation.curve.every(point => point.final_boost_pct === null)).toBe(true);
    expect((await optIn('reward', { userId: 'user', betId: 'bet', selections })).error!.code).toBe(reason);
    // Characterize compatibility gates for a pre-snapshot, already-entered ride.
    f.reward.status = 'ENTERED';
    f.reward.betId = 'bet';
    f.reward.ticketSnapshot = { selections };
    f.reward.endTime = new Date(startMs + 10000).toISOString();
    const quote = (await getQuote(input)).data!;
    expect(quote.reason_code).toBe(reason);
    expect(quote.current_boost_pct).toBeNull();
    expect(quote.ride_elapsed_seconds ?? null).toBeNull();
    expect((await lockBoost(input)).error!.code).toBe(reason);
  });

  it.each(['audit-seed-42', '3c739b8c1ef7c7ed973182eec337c66b76483bbbf1ae778a8810d4339ec6600f'])('one instant at exact end/crash and one millisecond before: %s', async seed => {
    const f = setup(mode, seed);
    await optIn('reward', { userId: 'user', betId: 'bet', selections: lowTicket });
    const boundaryMs = Math.ceil(f.snapshot.rideDurationSeconds * f.snapshot.crashPct * 1000);
    for (const delta of [-1, 0, 1]) {
      f.clearLock();
      const evaluationMs = startMs + boundaryMs + delta;
      // A second independent read would jump far past the terminal boundary.
      const nowSpy = jest.spyOn(Date, 'now').mockReturnValueOnce(evaluationMs).mockReturnValue(evaluationMs + 60000);
      const quote = (await getQuote(input)).data!;
      expect(nowSpy).toHaveBeenCalledTimes(1);
      nowSpy.mockRestore();
      expect(quote.eligible).toBe(delta < 0);
      expect(quote.ride_elapsed_seconds).toBe((boundaryMs + delta) / 1000);
      const lockClock = jest.spyOn(Date, 'now').mockReturnValueOnce(evaluationMs).mockReturnValue(evaluationMs + 60000);
      const locked = await lockBoost(input);
      expect(lockClock).toHaveBeenCalledTimes(1);
      lockClock.mockRestore();
      expect(locked.success).toBe(delta < 0);
      if (delta < 0) expect(locked.data!.locked_boost_pct).toBe(quote.current_boost_pct);
      else {
        const reason = f.snapshot.crashPct < 1 ? ReasonCode.RIDE_CRASHED : ReasonCode.RIDE_ENDED;
        expect(quote.current_boost_pct).toBe(0);
        expect(quote.reason_code).toBe(reason);
        expect(locked.error!.code).toBe(reason);
        expect(locked.error!.details).toMatchObject({ ride_elapsed_seconds: (boundaryMs + delta) / 1000, current_boost_pct: 0 });
      }
    }
  });
});

it('preserves v1 live payout/reference formulas across 200 independent seeds in both modes', async () => {
  let comparisons = 0;
  for (const mode of ['WAVES', 'LINEAR'] as const) {
    for (let i = 0; i < 200; i++) {
      jest.restoreAllMocks();
      jest.setSystemTime(startMs);
      const seed = createHash('sha256').update(`unchanged-payout-${i}`).digest('hex');
      const f = setup(mode, seed, i % 2 ? { maxBoostMinSelections: 10, maxBoostMinCombinedOdds: 50 } : {});
      const selections = i % 3 ? lowTicket : strongTicket;
      await optIn('reward', { userId: 'user', betId: 'bet', selections });
      f.snapshot.version = 1;
      delete f.snapshot.maximumModel;
      const q = math.filterQualifyingSelections(selections, f.profile.minSelectionOdds).qualifying;
      const odds = math.calculateCombinedOdds(q);
      f.setLegacyPoints(math.generateRide(seed, { ...f.snapshot, ...f.profile, durationSeconds: f.snapshot.rideDurationSeconds, ticketStrength: math.computeTicketStrength(q.length, odds, { minSelections: f.profile.minSelections }) }).checkpoints);
      for (const fraction of [0, 0.25, 0.75, 0.999]) {
        const elapsedMs = Math.floor(f.snapshot.rideDurationSeconds * f.snapshot.crashPct * 1000 * fraction);
        jest.setSystemTime(startMs + elapsedMs);
        const quote = (await getQuote(input)).data!;
        const expected = expectedFromRideModel(f, selections, elapsedMs / (f.snapshot.rideDurationSeconds * 1000));
        expect(quote.current_boost_pct).toBe(expected.boost);
        expect(quote.theoretical_max_boost_pct).toBe(expected.maximum);
        comparisons++;
      }
    }
  }
  expect(comparisons).toBe(1600);
});

it('distinguishes no-ticket exploration and validates resolved mixed overrides', async () => {
  setup('LINEAR', 'audit-seed-42');
  const exploration = (await simulateRide({ profileId: 'profile', seed: 'audit-seed-42', samplePoints: 10 })).data!;
  expect(exploration.evaluation_mode).toBe('EXPLORATORY');
  expect(exploration.eligible).toBeNull();
  expect(exploration.reason_code).toBeNull();
  expect(exploration.curve.every(point => point.final_boost_pct !== null)).toBe(true);
  for (const override of [{ minBoostPct: 2 }, { maxBoostPct: 0.01 }, { minBoostPct: 0.8, maxBoostPct: 0.2 }]) {
    const result = await simulateRide({ profileId: 'profile', seed: 'audit-seed-42', ...override });
    expect(result.error!.code).toBe(ReasonCode.INVALID_CONFIGURATION);
  }
});

it('characterizes the unchanged minimum-duration rounding edge without changing crash distribution', () => {
  const seed = '59c66bfe8eddcf4b209992a990d5b7d40fa294cd4833b65c559095ce1ea02498';
  expect(math.deriveRideParams(seed, 2, 2).crashPct).toBe(0.9999);
  expect(math.deriveRideParams(seed, 2, 2).crashPct * 2).toBe(1.9998);
});

const understatedMaximumSeed = '4ceeaa00c35be4bfdafdf51a7755354e307ecd5b88e9dc98a6a24d368e760020';
describe.each<RideMode>(['WAVES', 'LINEAR'])('%s versioned maximum correction', mode => {
  it('uses the true existing WAVES limit for new rides without changing WAVES payouts', async () => {
    const f = setup(mode, understatedMaximumSeed);
    await optIn('reward', { userId: 'user', betId: 'bet', selections: strongTicket });
    expect(f.snapshot.version).toBe(3);
    expect(f.snapshot.maximumModel).toBe('WAVES_PRE_CRASH_SUPREMUM_V2');
    expect(f.snapshot.rideDurationSeconds).toBe(9.563);
    expect(f.snapshot.crashPct).toBe(0.2134);
    jest.setSystemTime(startMs + 2040);
    const quote = (await getQuote(input)).data!;
    expect(quote.theoretical_max_boost_pct).toBe(0.131805);
    expect(quote.current_boost_pct).toBeLessThan(quote.theoretical_max_boost_pct!);
    if (mode === 'WAVES') expect(quote.current_boost_pct).toBe(0.131776);
    else expect(quote.current_boost_pct).toBe(math.calculateLinearBoostPctAtElapsed(2.04 / 9.563, 0.2134, 0.05, 0.131805));
    const simulation = (await simulateRide({ profileId: 'profile', seed: understatedMaximumSeed, ticket: { selections: strongTicket }, samplePoints: 9563 })).data!;
    expect(simulation.curve[2040].final_boost_pct).toBe(Math.round(quote.current_boost_pct! * 10000) / 10000);
    const locked = (await lockBoost(input)).data!;
    expect(locked.locked_boost_pct).toBe(quote.current_boost_pct);
    expect(locked.theoretical_max_boost_pct).toBe(0.131805);
    expect(locked.maximum_model).toBe('WAVES_PRE_CRASH_SUPREMUM_V2');
    for (const point of locked.ride_path) {
      expect(point.baseBoostValue).toBe(expectedFromRideModel(f, strongTicket, point.timePct).boost);
      expect(point.baseBoostValue).toBeLessThanOrEqual(0.131805);
    }
    f.clearLock();
    jest.setSystemTime(startMs + 2041);
    const terminal = (await getQuote(input)).data!;
    expect(terminal.current_boost_pct).toBe(0);
    expect(terminal.reason_code).toBe(ReasonCode.RIDE_CRASHED);
    expect(terminal.maximum_model).toBe('WAVES_PRE_CRASH_SUPREMUM_V2');
    const terminalLock = await lockBoost(input);
    expect(terminalLock.error!.details).toMatchObject({ maximum_model: 'WAVES_PRE_CRASH_SUPREMUM_V2' });
  });

  it.each(['snapshot-v1', 'unversioned'] as const)('preserves %s reference and saved repeated locks on the known affected seed', async version => {
    const f = setup(mode, understatedMaximumSeed);
    await optIn('reward', { userId: 'user', betId: 'bet', selections: strongTicket });
    if (version === 'snapshot-v1') {
      f.snapshot.version = 1;
      delete f.snapshot.maximumModel;
    } else delete f.reward.ticketSnapshot!.rideMath;
    jest.setSystemTime(startMs + 2040);
    const quote = (await getQuote(input)).data!;
    expect(quote.theoretical_max_boost_pct).toBe(0.09522);
    expect(quote.maximum_model).toBe('LEGACY_CHECKPOINT_MAX_V1');
    expect(quote.current_boost_pct).toBe(mode === 'WAVES' ? 0.131776 : math.calculateLinearBoostPctAtElapsed(2.04 / 9.563, 0.2134, 0.05, 0.09522));
    const locked = (await lockBoost(input)).data!;
    expect(locked.locked_boost_pct).toBe(quote.current_boost_pct);
    expect(locked.theoretical_max_boost_pct).toBe(0.09522);
    const snapshotBefore = JSON.stringify(f.savedLock!.snapshot);
    jest.setSystemTime(startMs + 60000);
    f.profile.maxBoostPct = 50;
    expect((await lockBoost(input)).data).toEqual(locked);
    expect(JSON.stringify(f.savedLock!.snapshot)).toBe(snapshotBefore);
  });
});

it('bounds new ride payouts over varied seeds and keeps each original WAVES maximum while new WAVES values follow saved checkpoints', async () => {
  for (let i = 0; i < 200; i++) {
    const seed = i === 0 ? understatedMaximumSeed : createHash('sha256').update(`new-maximum-${i}`).digest('hex');
    const maxima: number[] = [];
    for (const mode of ['WAVES', 'LINEAR'] as const) {
      jest.restoreAllMocks();
      jest.setSystemTime(startMs);
      const selections = i % 3 ? lowTicket : strongTicket;
      const f = setup(mode, seed, i % 2 ? { maxBoostMinSelections: 10, maxBoostMinCombinedOdds: 50 } : {});
      await optIn('reward', { userId: 'user', betId: 'bet', selections });
      for (const fraction of [0, 0.25, 0.75, 0.999]) {
        const elapsedMs = Math.floor(f.snapshot.rideDurationSeconds * f.snapshot.crashPct * 1000 * fraction);
        jest.setSystemTime(startMs + elapsedMs);
        const quote = (await getQuote(input)).data!;
        const expected = expectedFromRideModel(f, selections, elapsedMs / (f.snapshot.rideDurationSeconds * 1000));
        expect(quote.current_boost_pct).toBe(expected.boost);
        expect(quote.theoretical_max_boost_pct).toBe(expected.maximum);
        expect(quote.current_boost_pct!).toBeLessThanOrEqual(quote.theoretical_max_boost_pct!);
        expect(quote.current_boost_pct!).toBeGreaterThanOrEqual(quote.effective_min_boost_pct!);
        expect(quote.theoretical_max_boost_pct!).toBeLessThanOrEqual(quote.effective_max_boost_pct!);
        if (fraction === 0) maxima.push(quote.theoretical_max_boost_pct!);
      }
    }
    expect(maxima[0]).toBe(maxima[1]);
  }
});

it('uses V3 JSON checkpoints after table rounding/corruption and freezes diagnostic identity on lock', async () => {
  const seed = '140f62b073c80d434c04b764bc80c46ba9aca5e610611a75238964490f4a53bb';
  const f = setup('WAVES', seed);
  await optIn('reward', { userId: 'user', betId: 'bet', selections: strongTicket });
  expect(f.snapshot.phaseDiagnostics?.status).toBe('REPAIRED');
  const saved = JSON.parse(JSON.stringify(f.snapshot));
  const elapsedMs = Math.floor(f.snapshot.rideDurationSeconds * f.snapshot.crashPct * 1000 - 200);
  jest.setSystemTime(startMs + elapsedMs);
  const quote = (await getQuote(input)).data!;
  f.setLegacyPoints([{ index: 0, timeOffsetPct: 0, baseBoostValue: 900 }, { index: 1, timeOffsetPct: 1, baseBoostValue: 0 }]);
  jest.mocked(rideDefinitionRepository.findByRewardId).mockClear();
  expect((await getQuote(input)).data).toEqual(quote);
  expect(rideDefinitionRepository.findByRewardId).not.toHaveBeenCalled();
  expect(await getRideCheckpoints('reward')).toEqual(f.snapshot.checkpoints!.map(cp => ({ ...cp, checkpointIndex: cp.index })));
  const sim = (await simulateRide({ profileId: 'profile', seed, ticket: { selections: strongTicket }, samplePoints: Math.round(f.snapshot.rideDurationSeconds * 1000) })).data!;
  expect(sim.math_snapshot_version).toBe(3);
  expect(sim.phase_diagnostics).toEqual(f.snapshot.phaseDiagnostics);
  expect(sim.curve[elapsedMs].final_boost_pct).toBe(Math.round(quote.current_boost_pct! * 10000) / 10000);
  const replay = sim.checkpoints.map(cp => ({ index: cp.index, timeOffsetPct: cp.time_offset_pct, baseBoostValue: cp.base_boost_value, ...(cp.incoming_segment_end ? { incomingSegmentEnd: { timeOffsetPct: cp.incoming_segment_end.time_offset_pct, baseBoostValue: cp.incoming_segment_end.base_boost_value } } : {}) }));
  expect(math.interpolateRideValue(replay, elapsedMs / (f.snapshot.rideDurationSeconds * 1000))).toBe(math.interpolateRideValue(f.snapshot.checkpoints!, elapsedMs / (f.snapshot.rideDurationSeconds * 1000)));
  const locked = (await lockBoost(input)).data!;
  expect(locked.locked_boost_pct).toBe(quote.current_boost_pct);
  expect(f.savedLock!.snapshot.phaseDiagnostics).toEqual(f.snapshot.phaseDiagnostics);
  expect(f.savedLock!.snapshot.mathSnapshotVersion).toBe(3);
  expect(f.snapshot).toEqual(saved);
  expect(quote).not.toHaveProperty('phase_diagnostics');
  expect(quote).not.toHaveProperty('phase');
});

it.each(['missing', 'nan', 'out-of-order', 'null-point', 'unknown-version', 'bad-segment-end'] as const)('fails closed for %s V3 checkpoints instead of using the table', async defect => {
  const f = setup('WAVES', 'audit-seed-42');
  await optIn('reward', { userId: 'user', betId: 'bet', selections: lowTicket });
  if (defect === 'missing') delete f.snapshot.checkpoints;
  if (defect === 'bad-segment-end') f.snapshot.checkpoints![1].incomingSegmentEnd = { timeOffsetPct: NaN, baseBoostValue: 1 };
  if (defect === 'null-point') (f.snapshot.checkpoints as unknown[])![0] = null;
  if (defect === 'unknown-version') (f.snapshot as { version: number }).version = 4;
  if (defect === 'nan') f.snapshot.checkpoints![1].baseBoostValue = Number.NaN;
  if (defect === 'out-of-order') f.snapshot.checkpoints![1].timeOffsetPct = -1;
  jest.mocked(rideDefinitionRepository.findByRewardId).mockClear();
  expect((await getQuote(input)).error?.code).toBe(ReasonCode.INVALID_CONFIGURATION);
  expect((await lockBoost(input)).error?.code).toBe(ReasonCode.INVALID_CONFIGURATION);
  await expect(getRideCheckpoints('reward')).rejects.toThrow('Invalid saved ride math snapshot');
  expect(rideDefinitionRepository.findByRewardId).not.toHaveBeenCalled();
});

it.each<RideMode>(['WAVES', 'LINEAR'])('preserves saved V2 %s services on a phase-correctable ride', async mode => {
  const seed = '140f62b073c80d434c04b764bc80c46ba9aca5e610611a75238964490f4a53bb';
  const f = setup(mode, seed);
  await optIn('reward', { userId: 'user', betId: 'bet', selections: strongTicket });
  const original = math.generateRide(seed, { ...f.snapshot, ...f.profile, durationSeconds: f.snapshot.rideDurationSeconds, ticketStrength: 1 });
  f.setLegacyPoints(original.checkpoints);
  f.snapshot.version = 2;
  delete f.snapshot.phaseModel; delete f.snapshot.phaseDiagnostics; delete f.snapshot.checkpoints;
  const frozen = JSON.stringify(f.snapshot);
  for (const fraction of [.1, .5, .9, .999]) {
    f.clearLock();
    const elapsedMs = Math.floor(f.snapshot.rideDurationSeconds * f.snapshot.crashPct * 1000 * fraction);
    jest.setSystemTime(startMs + elapsedMs);
    const expected = expectedFromRideModel(f, strongTicket, elapsedMs / (f.snapshot.rideDurationSeconds * 1000));
    const quote = (await getQuote(input)).data!;
    expect(quote.current_boost_pct).toBe(expected.boost);
    expect(quote.theoretical_max_boost_pct).toBe(expected.maximum);
    expect((await lockBoost(input)).data!.locked_boost_pct).toBe(expected.boost);
  }
  expect(JSON.stringify(f.snapshot)).toBe(frozen);
});
