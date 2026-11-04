import request from 'supertest';
import { app } from '../../src/index';
import db from '../../src/db/connection';
import { ReasonCode } from '../../src/types/reasonCodes';
import { findSeed } from '../helpers/v4Rides';
import { parseJsonColumn } from '../helpers/testDb';
import type { RideMathSnapshotV4 } from '../../src/types/ride';

/** Slice API-1: operators can tell per bet whether it is boosted. */
const API_KEY = 'test-api-key';
const SELECTIONS = [
  { id: 's1', odds: 1.5 },
  { id: 's2', odds: 2.0 },
  { id: 's3', odds: 1.8 },
];
const CRASH_SEED = findSeed('flag-crash', (p) => p.outcome === 'CRASHED' && (p.crashAtSeconds as number) > 1);

async function enter(brandId: string, userId: string, betId: string, seed?: string) {
  const profile = await request(app).post('/api/profiles').set('X-API-Key', API_KEY).send({
    name: `Flag ${brandId}`,
    min_selections: 3,
    min_combined_odds: 3.0,
    min_selection_odds: 1.2,
    min_boost_pct: 0.05,
    max_boost_pct: 0.5,
    ride_duration_seconds: 15,
    brand_id: brandId,
    max_bonus_minor: { EUR: 50_000 },
    reward_validity_seconds: 86_400,
  });
  expect(profile.status).toBe(201);
  const grant = await request(app).post('/api/rewards').set('X-API-Key', API_KEY)
    .send({ user_id: userId, profile_version_id: profile.body.id });
  expect(grant.status).toBe(201);
  const rewardId = grant.body.id as string;
  if (seed) await db('user_rewards').where({ id: rewardId }).update({ seed });
  const optIn = await request(app).post(`/api/rewards/${rewardId}/opt-in`).set('X-API-Key', API_KEY).send({
    stake_minor: 1000, currency: 'EUR', user_id: userId, bet_id: betId, ticket: { selections: SELECTIONS },
  });
  expect(optIn.status).toBe(200);
  return rewardId;
}

function lock(rewardId: string, userId: string, betId: string) {
  return request(app).post('/api/boost/lock').set('X-API-Key', API_KEY)
    .send({ user_id: userId, reward_id: rewardId, bet_id: betId });
}

function bet(betId: string, brandId?: string) {
  const query = brandId ? `?brand_id=${brandId}` : '';
  return request(app).get(`/api/boost/bets/${betId}${query}`).set('X-API-Key', API_KEY);
}

describe('Boosted-bet flag', () => {
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
    await db('reward_profile_versions').del();
    await db('audit_logs').del();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('flags a locked bet on lock, replay, GET lock and the bet read', async () => {
    const rewardId = await enter('brand-a', 'flag-user-1', 'flag-bet-1');
    const created = await lock(rewardId, 'flag-user-1', 'flag-bet-1');
    expect(created.status).toBe(201);
    expect(created.body.boosted_bet).toBe(true);

    const replay = await lock(rewardId, 'flag-user-1', 'flag-bet-1');
    expect(replay.status).toBe(201);
    expect(replay.body.boosted_bet).toBe(true);

    const read = await request(app).get('/api/boost/lock/flag-bet-1?brand_id=brand-a').set('X-API-Key', API_KEY);
    expect(read.status).toBe(200);
    expect(read.body.boosted_bet).toBe(true);
    expect(read.body).toEqual(created.body);

    const status = await bet('flag-bet-1', 'brand-a');
    expect(status.status).toBe(200);
    expect(status.body).toEqual({
      brand_id: 'brand-a',
      bet_id: 'flag-bet-1',
      boosted_bet: true,
      locked_boost_pct: created.body.locked_boost_pct,
      locked_at: created.body.locked_at,
    });
  });

  it('answers false with nulls when there is no lock', async () => {
    const status = await bet('flag-bet-unknown', 'brand-a');
    expect(status.status).toBe(200);
    expect(status.body).toEqual({
      brand_id: 'brand-a',
      bet_id: 'flag-bet-unknown',
      boosted_bet: false,
      locked_boost_pct: null,
      locked_at: null,
    });
  });

  it('answers false for an entered ride that has not been locked', async () => {
    await enter('brand-a', 'flag-user-2', 'flag-bet-2');
    const status = await bet('flag-bet-2', 'brand-a');
    expect(status.status).toBe(200);
    expect(status.body.boosted_bet).toBe(false);
  });

  it('answers false when the ride crashed before a lock', async () => {
    const rewardId = await enter('brand-a', 'flag-user-3', 'flag-bet-3', CRASH_SEED);
    const row = await db('user_rewards').where({ id: rewardId }).first();
    const math = parseJsonColumn(row.ticket_snapshot).rideMath as RideMathSnapshotV4;
    const crashMs = Date.parse(math.startTime) + Math.ceil((math.crashAtSeconds as number) * 1000) + 1;
    jest.spyOn(Date, 'now').mockReturnValue(crashMs);
    const crashed = await lock(rewardId, 'flag-user-3', 'flag-bet-3');
    expect(crashed.status).toBeGreaterThanOrEqual(400);
    expect(crashed.body.code).toBe(ReasonCode.RIDE_CRASHED);

    const status = await bet('flag-bet-3', 'brand-a');
    expect(status.status).toBe(200);
    expect(status.body.boosted_bet).toBe(false);
    expect(status.body.locked_boost_pct).toBeNull();
  });

  it('does not show another brand\'s lock for the same bet id', async () => {
    const rewardId = await enter('brand-a', 'flag-user-4', 'flag-bet-shared');
    expect((await lock(rewardId, 'flag-user-4', 'flag-bet-shared')).status).toBe(201);

    expect((await bet('flag-bet-shared', 'brand-a')).body.boosted_bet).toBe(true);
    const other = await bet('flag-bet-shared', 'brand-b');
    expect(other.status).toBe(200);
    expect(other.body.boosted_bet).toBe(false);
    expect(other.body.brand_id).toBe('brand-b');
  });

  it('rejects a missing or malformed brand_id with 400 VALIDATION_ERROR', async () => {
    const missing = await bet('flag-bet-1');
    expect(missing.status).toBe(400);
    expect(missing.body.code).toBe('VALIDATION_ERROR');
    const malformed = await bet('flag-bet-1', 'bad%20brand');
    expect(malformed.status).toBe(400);
    expect(malformed.body.code).toBe('VALIDATION_ERROR');
  });
});
