import request from 'supertest';
import { app } from '../../src/index';
import db from '../../src/db/connection';
import { ReasonCode } from '../../src/types/reasonCodes';
import { config } from '../../src/config';
import { createV4Ride } from '../../src/computations/v4';
import { expireRewards } from '../../src/services/rewardExpiryService';
import { boostQuoteService } from '../../src/services/boostQuoteService';
import { boostLockService } from '../../src/services/boostLockService';
import { userRewardRepository } from '../../src/db/repositories/userRewardRepository';
import type { RideMathSnapshotV4 } from '../../src/types/ride';
import type { UserReward } from '../../src/types/userReward';
import { findSeed, liveMomentMs } from '../helpers/v4Rides';

/** Slice 1b-iii-a: every live path runs on the frozen V4 ride (math version 4). */
const API_KEY = 'test-api-key';
const SELECTIONS = [
  { id: 's1', odds: 2.0 },
  { id: 's2', odds: 2.5 },
  { id: 's3', odds: 1.8 },
];
const CRASH_SEED = findSeed('wiring-crash', (p) => p.outcome === 'CRASHED' && (p.crashAtSeconds as number) > 1);
const END_SEED = findSeed('wiring-end', (p) => p.outcome === 'ENDED' && p.durationSeconds > 1);

type RideMode = 'WAVES' | 'LINEAR';

async function createProfile(rideMode: RideMode = 'WAVES'): Promise<string> {
  const res = await request(app).post('/api/profiles').set('X-API-Key', API_KEY).send({
    name: `Wiring ${rideMode}`,
    min_selections: 3,
    min_combined_odds: 3.0,
    min_selection_odds: 1.2,
    min_boost_pct: 0.05,
    max_boost_pct: 0.5,
    max_boost_min_selections: 6,
    max_boost_min_combined_odds: 20,
    ride_mode: rideMode,
    ride_duration_seconds: 15,
    brand_id: 'brand-a',
    max_bonus_minor: { EUR: 50_000 },
    reward_validity_seconds: 86_400,
  });
  expect(res.status).toBe(201);
  return res.body.id;
}

async function enter(userId: string, betId: string, rideMode: RideMode = 'WAVES', selections = SELECTIONS, seed = CRASH_SEED) {
  const profileId = await createProfile(rideMode);
  const grant = await request(app).post('/api/rewards').set('X-API-Key', API_KEY)
    .send({ user_id: userId, profile_version_id: profileId });
  expect(grant.status).toBe(201);
  const rewardId = grant.body.id as string;
  await db('user_rewards').where({ id: rewardId }).update({ seed });
  const optIn = await request(app).post(`/api/rewards/${rewardId}/opt-in`).set('X-API-Key', API_KEY).send({
    stake_minor: 1000, currency: 'EUR', user_id: userId, bet_id: betId, ticket: { selections },
  });
  expect(optIn.status).toBe(200);
  const row = await db('user_rewards').where({ id: rewardId }).first();
  return { rewardId, profileId, math: JSON.parse(row.ticket_snapshot).rideMath as RideMathSnapshotV4 };
}

/** First epoch ms at which the service clock (elapsed = (ms - start) / 1000) is at or past `seconds`. */
function firstMsAtOrAfter(math: RideMathSnapshotV4, seconds: number): number {
  const startMs = Date.parse(math.startTime);
  let ms = Math.ceil(startMs + seconds * 1000);
  while ((ms - startMs) / 1000 < seconds) ms += 1;
  while ((ms - 1 - startMs) / 1000 >= seconds) ms -= 1;
  return ms;
}

function quote(rewardId: string, userId: string, betId: string) {
  return request(app).post('/api/boost/quote').set('X-API-Key', API_KEY)
    .send({ user_id: userId, reward_id: rewardId, bet_id: betId });
}

function lock(rewardId: string, userId: string, betId: string) {
  return request(app).post('/api/boost/lock').set('X-API-Key', API_KEY)
    .send({ user_id: userId, reward_id: rewardId, bet_id: betId });
}

async function updateSnapshot(rewardId: string, change: (snapshot: Record<string, unknown>) => void): Promise<void> {
  const row = await db('user_rewards').where({ id: rewardId }).first();
  const snapshot = JSON.parse(row.ticket_snapshot);
  change(snapshot);
  await db('user_rewards').where({ id: rewardId }).update({ ticket_snapshot: JSON.stringify(snapshot) });
}

describe('V4 wiring (math version 4 on every live path)', () => {
  beforeAll(async () => {
    await db.migrate.latest();
  });

  afterAll(async () => {
    await db.destroy();
  });

  beforeEach(async () => {
    await db('bet_settlements').del();
    await db('bet_boost_locks').del();
    await db('ride_definitions').del();
    await db('user_rewards').del();
    await db('audit_logs').del();
    await db('reward_profile_versions').del();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it.each<RideMode>(['WAVES', 'LINEAR'])('%s: quote, lock and terminal values are the V4 ride of the stored seed', async (mode) => {
    const { rewardId, math } = await enter(`v4-${mode}`, `v4-bet-${mode}`, mode);
    expect(math.linearPace).toBe(mode === 'LINEAR' ? 'MEDIUM' : null);
    const ride = createV4Ride(CRASH_SEED, {
      mode,
      minBoostPct: 0.05,
      maxBoostPct: 0.5,
      effectiveMin: math.effectiveMinBoostPct,
      effectiveMax: math.effectiveMaxBoostPct,
      ticketStrength: math.ticketStrength,
      ...config.ride,
      linearPace: mode === 'LINEAR' ? 'MEDIUM' : undefined,
    });
    const startMs = Date.parse(math.startTime);

    for (const fraction of [0.1, 0.4, 0.8]) {
      const at = startMs + Math.floor((math.crashAtSeconds as number) * 1000 * fraction);
      jest.spyOn(Date, 'now').mockReturnValue(at);
      const live = await quote(rewardId, `v4-${mode}`, `v4-bet-${mode}`);
      expect(live.body.eligible).toBe(true);
      expect(live.body.current_boost_pct).toBe(ride.boostAt((at - startMs) / 1000));
      expect(live.body.maximum_model).toBe('PRE_CRASH_SUPREMUM_V4');
      expect(live.body.combined_odds).toBe(9);
    }

    const crashMs = startMs + Math.ceil((math.crashAtSeconds as number) * 1000);
    jest.spyOn(Date, 'now').mockReturnValue(crashMs);
    const crashed = await quote(rewardId, `v4-${mode}`, `v4-bet-${mode}`);
    expect(crashed.body.reason_code).toBe(ReasonCode.RIDE_CRASHED);
    expect(crashed.body.current_boost_pct).toBe(0);
    expect(crashed.body.theoretical_max_boost_pct).toBe(ride.maximumBefore(math.crashAtSeconds as number));
    expect(crashed.body.ride_crash_at_offset_seconds).toBe(Math.round((math.crashAtSeconds as number) * 1000) / 1000);
    expect(crashed.body.ride_path).toHaveLength(60);
    for (const point of crashed.body.ride_path) {
      expect(point.baseBoostValue).toBe(ride.boostAt(point.timePct * math.rideDurationSeconds));
      expect(point.baseBoostValue).toBeLessThanOrEqual(crashed.body.theoretical_max_boost_pct);
    }

    jest.spyOn(Date, 'now').mockReturnValue(liveMomentMs(math));
    const locked = await lock(rewardId, `v4-${mode}`, `v4-bet-${mode}`);
    expect(locked.status).toBe(201);
    expect(locked.body.locked_boost_pct).toBe(ride.boostAt((liveMomentMs(math) - startMs) / 1000));
    expect(locked.body.theoretical_max_boost_pct).toBe(math.preCrashMaximumPct);
    const read = await request(app).get(`/api/boost/lock/v4-bet-${mode}?brand_id=brand-a`).set('X-API-Key', API_KEY);
    expect(read.body).toEqual(locked.body);
  });

  it('answers NOT_OPTED_IN for another bet on an entered reward', async () => {
    const { rewardId } = await enter('v4-other-bet', 'v4-own-bet');
    const res = await quote(rewardId, 'v4-other-bet', 'someone-elses-bet');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ eligible: false, reason_code: ReasonCode.NOT_OPTED_IN });
  });

  it('never rebuilds a ride of a retired math version or a damaged snapshot (422), and the expiry job falls back to the end time', async () => {
    const { rewardId, math } = await enter('v4-retired', 'v4-retired-bet');
    await updateSnapshot(rewardId, (snapshot) => {
      snapshot.rideMath = { version: 3, crashPct: 0.5, startTime: math.startTime, endTime: math.endTime };
    });
    const quoted = await quote(rewardId, 'v4-retired', 'v4-retired-bet');
    expect(quoted.status).toBe(422);
    expect(quoted.body.code).toBe(ReasonCode.INVALID_CONFIGURATION);
    const locked = await lock(rewardId, 'v4-retired', 'v4-retired-bet');
    expect(locked.status).toBe(422);
    expect(locked.body.code).toBe(ReasonCode.INVALID_CONFIGURATION);

    const row = await db('user_rewards').where({ id: rewardId }).first();
    const endMs = Date.parse(row.end_time);
    expect((await expireRewards(new Date(endMs - 1), 0)).entered_expired).toBe(0);
    expect((await expireRewards(new Date(endMs), 0)).entered_expired).toBe(1);

    // A V4 snapshot whose frozen crash time was edited is refused too.
    const second = await enter('v4-tampered', 'v4-tampered-bet');
    await updateSnapshot(second.rewardId, (snapshot) => {
      (snapshot.rideMath as RideMathSnapshotV4).crashAtSeconds = second.math.rideDurationSeconds;
    });
    const tampered = await quote(second.rewardId, 'v4-tampered', 'v4-tampered-bet');
    expect(tampered.status).toBe(422);
    expect(tampered.body.code).toBe(ReasonCode.INVALID_CONFIGURATION);
  });

  it('re-checks the stored ticket against the frozen minimums', async () => {
    const { rewardId, math } = await enter('v4-recheck', 'v4-recheck-bet');
    await updateSnapshot(rewardId, (snapshot) => {
      snapshot.selections = SELECTIONS.slice(0, 2);
    });
    jest.spyOn(Date, 'now').mockReturnValue(liveMomentMs(math));
    const res = await quote(rewardId, 'v4-recheck', 'v4-recheck-bet');
    expect(res.body).toMatchObject({
      eligible: false,
      reason_code: ReasonCode.MIN_SELECTIONS_NOT_MET,
      qualifying_selection_count: 2,
      combined_odds: 5,
      effective_min_boost_pct: math.effectiveMinBoostPct,
      current_boost_pct: null,
    });
  });

  it('carries combined odds beyond the double range as exact strings, never Infinity or NaN', async () => {
    const huge = Array.from({ length: 100 }, (_, i) => ({ id: `h${i}`, odds: 10000 }));
    const { rewardId, math } = await enter('v4-huge', 'v4-huge-bet', 'WAVES', huge);
    expect(math.combinedOddsExact).toBe('1' + '0'.repeat(400));
    expect(math.ticketStrength).toBe(1);
    jest.spyOn(Date, 'now').mockReturnValue(liveMomentMs(math));

    const live = await quote(rewardId, 'v4-huge', 'v4-huge-bet');
    expect(live.status).toBe(200);
    expect(live.body.eligible).toBe(true);
    expect(live.body.combined_odds).toBe('1' + '0'.repeat(400));
    expect(live.body.boost_model.odds_ratio).toBe(1);
    expect(live.body.current_boost_pct).toBeGreaterThan(0);

    const locked = await lock(rewardId, 'v4-huge', 'v4-huge-bet');
    expect(locked.status).toBe(201);
    expect(locked.body.qualifying_odds).toBe('1' + '0'.repeat(400));
    for (const body of [live.body, locked.body]) {
      for (const value of Object.values(body)) {
        if (typeof value === 'number') expect(Number.isFinite(value)).toBe(true);
      }
    }
    const stored = await db('bet_boost_locks').where({ bet_id: 'v4-huge-bet' }).first();
    expect(JSON.parse(stored.snapshot).combinedOddsExact).toBe('1' + '0'.repeat(400));

    // The lock read endpoint answers exactly like the lock itself (never the column's Number.MAX_VALUE).
    const read = await request(app).get('/api/boost/lock/v4-huge-bet?brand_id=brand-a').set('X-API-Key', API_KEY);
    expect(read.status).toBe(200);
    expect(read.body.qualifying_odds).toBe('1' + '0'.repeat(400));
    expect(read.body).toEqual(locked.body);
    // A replay of the lock too.
    const replay = await lock(rewardId, 'v4-huge', 'v4-huge-bet');
    expect(replay.status).toBe(201);
    expect(replay.body).toEqual(locked.body);
  });

  it('freezes the resolved math and timing inputs at opt-in despite later profile and config changes', async () => {
    const { rewardId, profileId, math } = await enter('v4-frozen', 'v4-frozen-bet', 'WAVES');
    const before = await db('user_rewards').where({ id: rewardId }).first();
    const at = liveMomentMs(math);
    jest.spyOn(Date, 'now').mockReturnValue(at);
    const quoteBefore = await quote(rewardId, 'v4-frozen', 'v4-frozen-bet');
    expect(quoteBefore.body.eligible).toBe(true);

    // Later edits: every ride-math field of the profile, and the service's ride limits.
    const edit = await request(app).put(`/api/profiles/${profileId}`).set('X-API-Key', API_KEY).send({
      min_selections: 4,
      min_combined_odds: 50,
      min_selection_odds: 1.9,
      min_boost_pct: 0.2,
      max_boost_pct: 0.9,
      max_boost_min_selections: 8,
      max_boost_min_combined_odds: 100,
      effective_min_floor_rate: 0.6,
      ride_mode: 'LINEAR',
    });
    expect([200, 201]).toContain(edit.status);
    const savedRide = { ...config.ride };
    Object.assign(config.ride, { minDurationSeconds: 3, maxDurationSeconds: 4, minCrashSeconds: 2 });
    try {
      const quoteAfter = await quote(rewardId, 'v4-frozen', 'v4-frozen-bet');
      expect(quoteAfter.status).toBe(200);
      expect(quoteAfter.body).toEqual(quoteBefore.body);
      const locked = await lock(rewardId, 'v4-frozen', 'v4-frozen-bet');
      expect(locked.status).toBe(201);
      expect(locked.body.locked_boost_pct).toBe(quoteBefore.body.current_boost_pct);
      expect(locked.body.effective_min_boost_pct).toBe(math.effectiveMinBoostPct);
      expect(locked.body.effective_max_boost_pct).toBe(math.effectiveMaxBoostPct);
      expect(locked.body.ride_end_at_offset_seconds).toBe(Math.round(math.rideDurationSeconds * 1000) / 1000);
    } finally {
      Object.assign(config.ride, savedRide);
    }
    // The ride snapshot itself was never rewritten.
    const after = await db('user_rewards').where({ id: rewardId }).first();
    expect(JSON.parse(after.ticket_snapshot).rideMath).toEqual(JSON.parse(before.ticket_snapshot).rideMath);
    expect(after.end_time).toBe(before.end_time);
  });

  it.each([
    ['crash', CRASH_SEED, ReasonCode.RIDE_CRASHED],
    ['end', END_SEED, ReasonCode.RIDE_ENDED],
  ] as const)('reads the clock once: 1 ms before the %s is live, at and 1 ms after it terminal; quote and lock agree', async (name, seed, code) => {
    const userId = `v4-edge-${name}`;
    const betId = `v4-edge-bet-${name}`;
    const { rewardId, math } = await enter(userId, betId, 'WAVES', SELECTIONS, seed);
    const edgeMs = name === 'crash'
      ? firstMsAtOrAfter(math, math.crashAtSeconds as number)
      : Date.parse(math.endTime);
    if (name === 'end') expect(math.crashAtSeconds).toBeNull();

    // Pins the clock and counts the reads made from service code (libraries may read the clock too).
    let serviceReads = 0;
    const singleRead = (at: number) => {
      serviceReads = 0;
      jest.spyOn(Date, 'now').mockImplementation(() => {
        // The direct caller: the first frame outside this test file and the jest mock machinery.
        const caller = (new Error().stack ?? '').split('\n').slice(1)
          .find((line) => !line.includes('v4Wiring.test') && !line.includes('jest-mock'));
        if (caller && /src[\\/]services[\\/]/.test(caller)) serviceReads += 1;
        return at;
      });
    };
    const input = { userId, rewardId, betId };

    for (const offset of [0, 1]) {
      singleRead(edgeMs + offset);
      const terminalQuote = await boostQuoteService.getQuote(input);
      expect(serviceReads).toBe(1);
      expect(terminalQuote.data?.reason_code).toBe(code);
      expect(terminalQuote.data?.current_boost_pct).toBe(0);
      singleRead(edgeMs + offset);
      const terminalLock = await boostLockService.lockBoost(input);
      expect(serviceReads).toBe(1);
      expect(terminalLock.error?.code).toBe(code);
      expect((terminalLock.error?.details as { ride_path: unknown }).ride_path).toEqual(terminalQuote.data?.ride_path);
      jest.restoreAllMocks();
    }

    singleRead(edgeMs - 1);
    const liveQuote = await boostQuoteService.getQuote(input);
    expect(serviceReads).toBe(1);
    expect(liveQuote.data?.reason_code).toBe(ReasonCode.ELIGIBLE);
    expect(liveQuote.data?.current_boost_pct).toBeGreaterThan(0);
    singleRead(edgeMs - 1);
    const liveLock = await boostLockService.lockBoost(input);
    expect(serviceReads).toBe(1);
    expect(liveLock.success).toBe(true);
    expect(liveLock.data?.locked_boost_pct).toBe(liveQuote.data?.current_boost_pct);
    expect(liveLock.data?.ride_stop_at_offset_seconds).toBe(Math.round(edgeMs - 1 - Date.parse(math.startTime)) / 1000);
  });

  it('fails closed when the frozen end time does not match the ride or the reward row', async () => {
    const first = await enter('v4-end-a', 'v4-end-a-bet');
    const shifted = new Date(Date.parse(first.math.endTime) + 1).toISOString();
    await updateSnapshot(first.rewardId, (snapshot) => {
      (snapshot.rideMath as RideMathSnapshotV4).endTime = shifted;
    });
    await db('user_rewards').where({ id: first.rewardId }).update({ end_time: shifted });
    expect((await quote(first.rewardId, 'v4-end-a', 'v4-end-a-bet')).body.code).toBe(ReasonCode.INVALID_CONFIGURATION);

    const second = await enter('v4-end-b', 'v4-end-b-bet');
    await db('user_rewards').where({ id: second.rewardId })
      .update({ end_time: new Date(Date.parse(second.math.endTime) + 5_000).toISOString() });
    const res = await quote(second.rewardId, 'v4-end-b', 'v4-end-b-bet');
    expect(res.status).toBe(422);
    expect(res.body.code).toBe(ReasonCode.INVALID_CONFIGURATION);
    expect((await lock(second.rewardId, 'v4-end-b', 'v4-end-b-bet')).body.code).toBe(ReasonCode.INVALID_CONFIGURATION);
  });

  it('opts in, quotes and locks when timestamp columns come back as Dates (pg row shape), and still fails closed 1 ms off', async () => {
    // pg parses `timestamp` columns into Dates; the repository's `as string` casts pass them through unchanged.
    const toDate = (value: string | null | undefined) => (value == null ? value : new Date(value));
    const pgShaped = (reward: UserReward | null): UserReward | null => reward && ({
      ...reward,
      startTime: toDate(reward.startTime),
      endTime: toDate(reward.endTime),
      optedInAt: toDate(reward.optedInAt),
      validUntil: toDate(reward.validUntil),
      createdAt: toDate(reward.createdAt),
      updatedAt: toDate(reward.updatedAt),
    } as unknown as UserReward);
    const findById = userRewardRepository.findById;
    const pgRead = jest.spyOn(userRewardRepository, 'findById')
      .mockImplementation(async (id, tx) => pgShaped(await findById(id, tx)));

    const { rewardId, math } = await enter('v4-pg', 'v4-pg-bet');
    const row = await db('user_rewards').where({ id: rewardId }).first();
    expect(row.end_time).toBe(math.endTime);
    jest.spyOn(Date, 'now').mockReturnValue(liveMomentMs(math));
    const live = await quote(rewardId, 'v4-pg', 'v4-pg-bet');
    expect(live.status).toBe(200);
    expect(live.body.reason_code).toBe(ReasonCode.ELIGIBLE);
    const locked = await lock(rewardId, 'v4-pg', 'v4-pg-bet');
    expect(locked.status).toBe(201);
    expect(locked.body.locked_boost_pct).toBe(live.body.current_boost_pct);
    expect(await lock(rewardId, 'v4-pg', 'v4-pg-bet').then((r) => r.body)).toEqual(locked.body);
    expect(pgRead).toHaveBeenCalled();
    expect(await pgRead.mock.results[0].value).toMatchObject({ endTime: expect.any(Date) });

    const off = await enter('v4-pg-off', 'v4-pg-off-bet');
    await db('user_rewards').where({ id: off.rewardId })
      .update({ end_time: new Date(Date.parse(off.math.endTime) + 1).toISOString() });
    jest.spyOn(Date, 'now').mockReturnValue(liveMomentMs(off.math));
    const offQuote = await quote(off.rewardId, 'v4-pg-off', 'v4-pg-off-bet');
    expect(offQuote.status).toBe(422);
    expect(offQuote.body.code).toBe(ReasonCode.INVALID_CONFIGURATION);
    const offLock = await lock(off.rewardId, 'v4-pg-off', 'v4-pg-off-bet');
    expect(offLock.status).toBe(422);
    expect(offLock.body.code).toBe(ReasonCode.INVALID_CONFIGURATION);
  });
});
