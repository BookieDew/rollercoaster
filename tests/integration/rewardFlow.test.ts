import request from 'supertest';
import { app } from '../../src/index';
import db from '../../src/db/connection';

describe('Reward Flow Integration Tests', () => {
  const API_KEY = 'test-api-key';

  beforeAll(async () => {
    // Run migrations
    await db.migrate.latest();
  });

  afterAll(async () => {
    await db.destroy();
  });

  beforeEach(async () => {
    // Clean up tables before each test
    await db('settlement_records').del();
    await db('bet_boost_locks').del();
    await db('ride_definitions').del();
    await db('user_rewards').del();
    await db('reward_profile_versions').del();
    await db('audit_logs').del();
  });

  describe('Full reward lifecycle', () => {
    it('should complete the full flow: grant -> opt-in -> quote -> lock -> settle', async () => {
      // Step 1: Create a reward profile
      const profileRes = await request(app)
        .post('/api/profiles')
        .set('X-API-Key', API_KEY)
        .send({
          name: 'Test Profile',
          description: 'Integration test profile',
          min_selections: 3,
          min_combined_odds: 3.0,
          min_selection_odds: 1.2,
          min_boost_pct: 0.05,
          max_boost_pct: 0.5,
          ride_duration_seconds: 3600,
        });

      expect(profileRes.status).toBe(201);
      const profileId = profileRes.body.id;
      expect(profileId).toBeDefined();

      // Step 2: Grant a reward to a user
      const grantRes = await request(app)
        .post('/api/rewards')
        .set('X-API-Key', API_KEY)
        .send({
          user_id: 'user-123',
          profile_version_id: profileId,
          duration_seconds: 3600,
        });

      expect(grantRes.status).toBe(201);
      const rewardId = grantRes.body.id;
      expect(rewardId).toBeDefined();
      expect(grantRes.body.status).toBe('GRANTED');

      // Step 3: User opts into the reward
      const optInRes = await request(app)
        .post(`/api/rewards/${rewardId}/opt-in`)
        .set('X-API-Key', API_KEY)
        .send({
          user_id: 'user-123',
          bet_id: 'bet-456',
          ticket: {
            selections: [
              { id: 's1', odds: 1.5, name: 'Selection 1' },
              { id: 's2', odds: 2.0, name: 'Selection 2' },
              { id: 's3', odds: 1.8, name: 'Selection 3' },
              { id: 's4', odds: 2.5, name: 'Selection 4' },
            ],
          },
        });

      expect(optInRes.status).toBe(200);
      expect(optInRes.body.status).toBe('ENTERED');
      expect(optInRes.body.ride_started).toBe(true);

      // Step 4: Get a quote for a ticket
      const quoteRes = await request(app)
        .post('/api/boost/quote')
        .set('X-API-Key', API_KEY)
        .send({
          user_id: 'user-123',
          reward_id: rewardId,
          bet_id: 'bet-456',
        });

      expect(quoteRes.status).toBe(200);
      expect(quoteRes.body.eligible).toBe(true);
      expect(quoteRes.body.qualifying_selection_count).toBe(4);
      expect(quoteRes.body.current_boost_pct).toBeGreaterThan(0);

      // Step 5: Lock the boost for a bet
      const lockRes = await request(app)
        .post('/api/boost/lock')
        .set('X-API-Key', API_KEY)
        .send({
          user_id: 'user-123',
          reward_id: rewardId,
          bet_id: 'bet-456',
        });

      expect(lockRes.status).toBe(201);
      expect(lockRes.body.bet_id).toBe('bet-456');
      expect(lockRes.body.locked_boost_pct).toBeGreaterThan(0);
      const lockedBoostPct = lockRes.body.locked_boost_pct;

      // Step 6: Settle the bet as a win
      const settleRes = await request(app)
        .post('/api/settlement')
        .set('X-API-Key', API_KEY)
        .send({
          bet_id: 'bet-456',
          outcome: 'WIN',
          winnings: 100,
        });

      expect(settleRes.status).toBe(201);
      expect(settleRes.body.outcome).toBe('WIN');
      expect(settleRes.body.winnings).toBe(100);
      expect(settleRes.body.locked_boost_pct).toBe(lockedBoostPct);
      expect(settleRes.body.bonus_amount).toBeCloseTo(100 * lockedBoostPct, 2);
    });

    it('should handle loss settlement with zero bonus', async () => {
      // Setup: Create profile, grant reward, opt-in, lock
      const profileRes = await request(app)
        .post('/api/profiles')
        .set('X-API-Key', API_KEY)
        .send({
          name: 'Loss Test Profile',
          min_selections: 3,
          min_combined_odds: 3.0,
          min_selection_odds: 1.2,
          min_boost_pct: 0.05,
          max_boost_pct: 0.5,
          ride_duration_seconds: 3600,
        });

      const profileId = profileRes.body.id;

      const grantRes = await request(app)
        .post('/api/rewards')
        .set('X-API-Key', API_KEY)
        .send({
          user_id: 'user-loss',
          profile_version_id: profileId,
        });

      const rewardId = grantRes.body.id;

      await request(app)
        .post(`/api/rewards/${rewardId}/opt-in`)
        .set('X-API-Key', API_KEY)
        .send({
          user_id: 'user-loss',
          bet_id: 'bet-loss',
          ticket: {
            selections: [
              { id: 's1', odds: 1.5 },
              { id: 's2', odds: 2.0 },
              { id: 's3', odds: 1.8 },
            ],
          },
        });

      await request(app)
        .post('/api/boost/lock')
        .set('X-API-Key', API_KEY)
        .send({
          user_id: 'user-loss',
          reward_id: rewardId,
          bet_id: 'bet-loss',
        });

      // Settle as loss
      const settleRes = await request(app)
        .post('/api/settlement')
        .set('X-API-Key', API_KEY)
        .send({
          bet_id: 'bet-loss',
          outcome: 'LOSS',
          winnings: 0,
        });

      expect(settleRes.status).toBe(201);
      expect(settleRes.body.outcome).toBe('LOSS');
      expect(settleRes.body.bonus_amount).toBe(0);
    });
  });
});
