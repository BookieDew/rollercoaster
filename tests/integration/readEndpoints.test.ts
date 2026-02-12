import request from 'supertest';
import { app } from '../../src/index';
import db from '../../src/db/connection';

describe('Read Endpoints Integration Tests', () => {
  const API_KEY = 'test-api-key';

  beforeAll(async () => {
    await db.migrate.latest();
  });

  afterAll(async () => {
    await db.destroy();
  });

  beforeEach(async () => {
    await db('settlement_records').del();
    await db('bet_boost_locks').del();
    await db('ride_definitions').del();
    await db('user_rewards').del();
    await db('reward_profile_versions').del();
    await db('audit_logs').del();
  });

  async function createProfile(name = 'Read Test Profile'): Promise<string> {
    const profileRes = await request(app)
      .post('/api/profiles')
      .set('X-API-Key', API_KEY)
      .send({
        name,
        min_selections: 3,
        min_combined_odds: 3.0,
        min_selection_odds: 1.2,
        min_boost_pct: 0.05,
        max_boost_pct: 0.5,
        ride_duration_seconds: 15,
      });

    expect(profileRes.status).toBe(201);
    return profileRes.body.id;
  }

  async function grantReward(userId: string, profileId: string): Promise<string> {
    const rewardRes = await request(app)
      .post('/api/rewards')
      .set('X-API-Key', API_KEY)
      .send({
        user_id: userId,
        profile_version_id: profileId,
      });

    expect(rewardRes.status).toBe(201);
    return rewardRes.body.id;
  }

  async function startRideAndLock(userId: string, rewardId: string, betId: string): Promise<void> {
    const selections = [
      { id: 's1', odds: 1.5 },
      { id: 's2', odds: 2.0 },
      { id: 's3', odds: 1.8 },
    ];

    const optInRes = await request(app)
      .post(`/api/rewards/${rewardId}/opt-in`)
      .set('X-API-Key', API_KEY)
      .send({
        user_id: userId,
        bet_id: betId,
        ticket: { selections },
      });

    expect(optInRes.status).toBe(200);

    const lockRes = await request(app)
      .post('/api/boost/lock')
      .set('X-API-Key', API_KEY)
      .send({
        user_id: userId,
        reward_id: rewardId,
        bet_id: betId,
      });

    expect(lockRes.status).toBe(201);
  }

  it('returns reward by ID', async () => {
    const profileId = await createProfile();
    const rewardId = await grantReward('read-user-1', profileId);

    const rewardRes = await request(app)
      .get(`/api/rewards/${rewardId}`)
      .set('X-API-Key', API_KEY);

    expect(rewardRes.status).toBe(200);
    expect(rewardRes.body.id).toBe(rewardId);
    expect(rewardRes.body.user_id).toBe('read-user-1');
  });

  it('returns user rewards and active reward', async () => {
    const profileId = await createProfile();
    const userId = 'read-user-2';
    const rewardIdOne = await grantReward(userId, profileId);
    const rewardIdTwo = await grantReward(userId, profileId);

    const rewardsRes = await request(app)
      .get(`/api/rewards/user/${userId}`)
      .set('X-API-Key', API_KEY);

    expect(rewardsRes.status).toBe(200);
    expect(rewardsRes.body.count).toBe(2);
    const rewardIds = rewardsRes.body.rewards.map((reward: { id: string }) => reward.id);
    expect(rewardIds).toEqual(expect.arrayContaining([rewardIdOne, rewardIdTwo]));

    const activeRes = await request(app)
      .get(`/api/rewards/user/${userId}/active`)
      .set('X-API-Key', API_KEY);

    expect(activeRes.status).toBe(200);
    expect(activeRes.body.active_reward).toBeTruthy();
    expect(activeRes.body.active_reward.user_id).toBe(userId);
    expect(activeRes.body.active_reward.status).toBe('GRANTED');
  });

  it('returns lock by bet ID', async () => {
    const profileId = await createProfile();
    const userId = 'read-user-3';
    const rewardId = await grantReward(userId, profileId);
    const betId = 'read-bet-lock-1';

    await startRideAndLock(userId, rewardId, betId);

    const lockRes = await request(app)
      .get(`/api/boost/lock/${betId}`)
      .set('X-API-Key', API_KEY);

    expect(lockRes.status).toBe(200);
    expect(lockRes.body.bet_id).toBe(betId);
    expect(lockRes.body.reward_id).toBe(rewardId);
    expect(lockRes.body.locked_boost_pct).toBeGreaterThan(0);
    expect(Array.isArray(lockRes.body.ride_path)).toBe(true);
  });

  it('returns settlement by bet ID', async () => {
    const profileId = await createProfile();
    const userId = 'read-user-4';
    const rewardId = await grantReward(userId, profileId);
    const betId = 'read-bet-settlement-1';

    await startRideAndLock(userId, rewardId, betId);

    const settleRes = await request(app)
      .post('/api/settlement')
      .set('X-API-Key', API_KEY)
      .send({
        bet_id: betId,
        outcome: 'WIN',
        winnings: 100,
      });

    expect(settleRes.status).toBe(201);

    const getSettlementRes = await request(app)
      .get(`/api/settlement/${betId}`)
      .set('X-API-Key', API_KEY);

    expect(getSettlementRes.status).toBe(200);
    expect(getSettlementRes.body.bet_id).toBe(betId);
    expect(getSettlementRes.body.outcome).toBe('WIN');
    expect(getSettlementRes.body.locked_boost_pct).toBeGreaterThan(0);
  });
});
