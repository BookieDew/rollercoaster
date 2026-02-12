import request from 'supertest';
import { app } from '../../src/index';
import db from '../../src/db/connection';

describe('Public Endpoint Error Path Integration Tests', () => {
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
    await db('audit_logs').del();
    await db('reward_profile_versions').del();
  });

  it('returns 400 for invalid quote and lock payloads', async () => {
    const invalidQuoteRes = await request(app)
      .post('/api/boost/quote')
      .set('X-API-Key', API_KEY)
      .send({
        user_id: 'u1',
        reward_id: 'not-a-uuid',
      });
    expect(invalidQuoteRes.status).toBe(400);
    expect(invalidQuoteRes.body.code).toBe('VALIDATION_ERROR');

    const invalidLockRes = await request(app)
      .post('/api/boost/lock')
      .set('X-API-Key', API_KEY)
      .send({
        user_id: 'u1',
        reward_id: 'not-a-uuid',
        bet_id: '',
      });
    expect(invalidLockRes.status).toBe(400);
    expect(invalidLockRes.body.code).toBe('VALIDATION_ERROR');
  });

  it('returns 404 for lock and settlement reads when bet is missing', async () => {
    const lockRes = await request(app)
      .get('/api/boost/lock/missing-bet')
      .set('X-API-Key', API_KEY);
    expect(lockRes.status).toBe(404);
    expect(lockRes.body.error).toBe('Not Found');

    const settlementRes = await request(app)
      .get('/api/settlement/missing-bet')
      .set('X-API-Key', API_KEY);
    expect(settlementRes.status).toBe(404);
    expect(settlementRes.body.error).toBe('Not Found');
  });

  it('returns 400 for invalid settlement payload', async () => {
    const res = await request(app)
      .post('/api/settlement')
      .set('X-API-Key', API_KEY)
      .send({
        bet_id: 'bet-1',
        outcome: 'NOT_REAL',
        winnings: -1,
      });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('returns reward/profile not found branches in reward controller', async () => {
    const grantMissingProfileRes = await request(app)
      .post('/api/rewards')
      .set('X-API-Key', API_KEY)
      .send({
        user_id: 'user-a',
        profile_version_id: '00000000-0000-0000-0000-000000000000',
      });
    expect(grantMissingProfileRes.status).toBe(404);
    expect(grantMissingProfileRes.body.code).toBe('PROFILE_NOT_FOUND');

    const rewardMissingRes = await request(app)
      .get('/api/rewards/00000000-0000-0000-0000-000000000000')
      .set('X-API-Key', API_KEY);
    expect(rewardMissingRes.status).toBe(404);
    expect(rewardMissingRes.body.code).toBe('REWARD_NOT_FOUND');
  });

  it('returns empty active reward and reward list for user with no rewards', async () => {
    const listRes = await request(app)
      .get('/api/rewards/user/empty-user')
      .set('X-API-Key', API_KEY);
    expect(listRes.status).toBe(200);
    expect(listRes.body.count).toBe(0);
    expect(Array.isArray(listRes.body.rewards)).toBe(true);

    const activeRes = await request(app)
      .get('/api/rewards/user/empty-user/active')
      .set('X-API-Key', API_KEY);
    expect(activeRes.status).toBe(200);
    expect(activeRes.body.active_reward).toBeNull();
  });
});
