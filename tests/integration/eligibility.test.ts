import request from 'supertest';
import { app } from '../../src/index';
import db from '../../src/db/connection';
import { ReasonCode } from '../../src/types/reasonCodes';

describe('Eligibility Integration Tests', () => {
  const API_KEY = 'test-api-key';
  let profileId: string;
  let rewardId: string;

  beforeAll(async () => {
    await db.migrate.latest();
  });

  afterAll(async () => {
    await db.destroy();
  });

  beforeEach(async () => {
    // Clean up tables
    await db('settlement_records').del();
    await db('bet_boost_locks').del();
    await db('ride_definitions').del();
    await db('user_rewards').del();
    await db('reward_profile_versions').del();
    await db('audit_logs').del();

    // Create profile
    const profileRes = await request(app)
      .post('/api/profiles')
      .set('X-API-Key', API_KEY)
      .send({
        name: 'Eligibility Test Profile',
        min_selections: 3,
        min_combined_odds: 5.0,
        min_selection_odds: 1.3,
        min_boost_pct: 0.05,
        max_boost_pct: 0.5,
        ride_duration_seconds: 3600,
      });
    profileId = profileRes.body.id;

    // Grant reward (ride starts on opt-in)
    const grantRes = await request(app)
      .post('/api/rewards')
      .set('X-API-Key', API_KEY)
      .send({
        user_id: 'eligibility-user',
        profile_version_id: profileId,
      });
    rewardId = grantRes.body.id;
  });

  describe('Minimum selections requirement', () => {
    it('should return MIN_SELECTIONS_NOT_MET when not enough qualifying selections', async () => {
      const optInRes = await request(app)
        .post(`/api/rewards/${rewardId}/opt-in`)
        .set('X-API-Key', API_KEY)
        .send({
          user_id: 'eligibility-user',
          bet_id: 'bet-min-selections',
          ticket: {
            selections: [
              { id: 's1', odds: 1.5 },
              { id: 's2', odds: 2.0 },
              // Only 2 qualifying selections, need 3
            ],
          },
        });

      expect(optInRes.status).toBe(422);
      expect(optInRes.body.code).toBe(ReasonCode.MIN_SELECTIONS_NOT_MET);
    });

    it('should filter out selections below minimum odds threshold', async () => {
      const optInRes = await request(app)
        .post(`/api/rewards/${rewardId}/opt-in`)
        .set('X-API-Key', API_KEY)
        .send({
          user_id: 'eligibility-user',
          bet_id: 'bet-min-odds',
          ticket: {
            selections: [
              { id: 's1', odds: 1.5 },
              { id: 's2', odds: 2.0 },
              { id: 's3', odds: 1.1 }, // Below 1.3 threshold
              { id: 's4', odds: 1.2 }, // Below 1.3 threshold
            ],
          },
        });

      expect(optInRes.status).toBe(422);
      expect(optInRes.body.code).toBe(ReasonCode.MIN_SELECTIONS_NOT_MET);
    });
  });

  describe('Minimum combined odds requirement', () => {
    it('should return MIN_COMBINED_ODDS_NOT_MET when combined odds too low', async () => {
      const optInRes = await request(app)
        .post(`/api/rewards/${rewardId}/opt-in`)
        .set('X-API-Key', API_KEY)
        .send({
          user_id: 'eligibility-user',
          bet_id: 'bet-min-combined',
          ticket: {
            selections: [
              { id: 's1', odds: 1.3 },
              { id: 's2', odds: 1.3 },
              { id: 's3', odds: 1.3 },
              // Combined: 1.3^3 = 2.197, need 5.0
            ],
          },
        });

      expect(optInRes.status).toBe(422);
      expect(optInRes.body.code).toBe(ReasonCode.MIN_COMBINED_ODDS_NOT_MET);
    });
  });

  describe('Reward state validations', () => {
    it('should allow precheck before opt-in when reward is granted', async () => {
      const precheckRes = await request(app)
        .post(`/api/rewards/${rewardId}/eligibility`)
        .set('X-API-Key', API_KEY)
        .send({
          user_id: 'eligibility-user',
          ticket: {
            selections: [
              { id: 's1', odds: 2.0 },
              { id: 's2', odds: 2.5 },
              { id: 's3', odds: 1.8 },
            ],
          },
        });

      expect(precheckRes.status).toBe(200);
      expect(precheckRes.body.eligible).toBe(true);
      expect(precheckRes.body.reason_code).toBe(ReasonCode.ELIGIBLE);
    });

    it('should return numeric ticket strength in precheck threshold failures', async () => {
      const precheckRes = await request(app)
        .post(`/api/rewards/${rewardId}/eligibility`)
        .set('X-API-Key', API_KEY)
        .send({
          user_id: 'eligibility-user',
          ticket: {
            selections: [
              { id: 's1', odds: 2.0 },
              { id: 's2', odds: 2.2 },
            ],
          },
        });

      expect(precheckRes.status).toBe(200);
      expect(precheckRes.body.eligible).toBe(false);
      expect(precheckRes.body.reason_code).toBe(ReasonCode.MIN_SELECTIONS_NOT_MET);
      expect(precheckRes.body.ticket_strength).toBe(0);
    });

    it('should return REWARD_NOT_FOUND for invalid reward ID', async () => {
      const quoteRes = await request(app)
        .post('/api/boost/quote')
        .set('X-API-Key', API_KEY)
        .send({
          user_id: 'eligibility-user',
          reward_id: '00000000-0000-0000-0000-000000000000',
          bet_id: 'missing-reward-bet',
        });

      expect(quoteRes.status).toBe(200);
      expect(quoteRes.body.eligible).toBe(false);
      expect(quoteRes.body.reason_code).toBe(ReasonCode.REWARD_NOT_FOUND);
    });

    it('should return REWARD_NOT_FOUND when user_id does not match', async () => {
      const quoteRes = await request(app)
        .post('/api/boost/quote')
        .set('X-API-Key', API_KEY)
        .send({
          user_id: 'different-user',
          reward_id: rewardId,
          bet_id: 'wrong-user-bet',
        });

      expect(quoteRes.status).toBe(200);
      expect(quoteRes.body.eligible).toBe(false);
      expect(quoteRes.body.reason_code).toBe(ReasonCode.REWARD_NOT_FOUND);
    });

    it('should return NOT_OPTED_IN for reward not yet opted into', async () => {
      // Create new reward without opting in
      const grantRes = await request(app)
        .post('/api/rewards')
        .set('X-API-Key', API_KEY)
        .send({
          user_id: 'not-opted-user',
          profile_version_id: profileId,
        });
      const newRewardId = grantRes.body.id;

      const quoteRes = await request(app)
        .post('/api/boost/quote')
        .set('X-API-Key', API_KEY)
        .send({
          user_id: 'not-opted-user',
          reward_id: newRewardId,
          bet_id: 'not-opted-bet',
        });

      expect(quoteRes.status).toBe(200);
      expect(quoteRes.body.eligible).toBe(false);
      expect(quoteRes.body.reason_code).toBe(ReasonCode.NOT_OPTED_IN);
    });

    it('should return ALREADY_OPTED_IN when trying to opt in twice', async () => {
      await request(app)
        .post(`/api/rewards/${rewardId}/opt-in`)
        .set('X-API-Key', API_KEY)
        .send({
          user_id: 'eligibility-user',
          bet_id: 'bet-already-opted',
          ticket: {
            selections: [
              { id: 's1', odds: 2.0 },
              { id: 's2', odds: 2.5 },
              { id: 's3', odds: 1.8 },
            ],
          },
        });

      const optInRes = await request(app)
        .post(`/api/rewards/${rewardId}/opt-in`)
        .set('X-API-Key', API_KEY)
        .send({
          user_id: 'eligibility-user',
          bet_id: 'bet-already-opted',
          ticket: {
            selections: [
              { id: 's1', odds: 2.0 },
              { id: 's2', odds: 2.5 },
              { id: 's3', odds: 1.8 },
            ],
          },
        });

      expect(optInRes.status).toBe(409); // Conflict - already opted in
      expect(optInRes.body.code).toBe(ReasonCode.ALREADY_OPTED_IN);
    });

    it('should return REWARD_ALREADY_USED after lock', async () => {
      await request(app)
        .post(`/api/rewards/${rewardId}/opt-in`)
        .set('X-API-Key', API_KEY)
        .send({
          user_id: 'eligibility-user',
          bet_id: 'used-bet',
          ticket: {
            selections: [
              { id: 's1', odds: 2.0 },
              { id: 's2', odds: 2.0 },
              { id: 's3', odds: 2.0 },
            ],
          },
        });

      // Lock the reward
      await request(app)
        .post('/api/boost/lock')
        .set('X-API-Key', API_KEY)
        .send({
          user_id: 'eligibility-user',
          reward_id: rewardId,
          bet_id: 'used-bet',
        });

      // Try to get a quote with the used reward
      const quoteRes = await request(app)
        .post('/api/boost/quote')
        .set('X-API-Key', API_KEY)
        .send({
          user_id: 'eligibility-user',
          reward_id: rewardId,
          bet_id: 'used-bet',
        });

      expect(quoteRes.status).toBe(200);
      expect(quoteRes.body.eligible).toBe(false);
      expect(quoteRes.body.reason_code).toBe(ReasonCode.REWARD_ALREADY_USED);
    });
  });

  describe('Successful eligibility', () => {
    it('should return eligible with all criteria met', async () => {
      await request(app)
        .post(`/api/rewards/${rewardId}/opt-in`)
        .set('X-API-Key', API_KEY)
        .send({
          user_id: 'eligibility-user',
          bet_id: 'bet-eligible',
          ticket: {
            selections: [
              { id: 's1', odds: 2.0 },
              { id: 's2', odds: 2.5 },
              { id: 's3', odds: 1.8 },
              // Combined: 2.0 * 2.5 * 1.8 = 9.0, meets 5.0 threshold
            ],
          },
        });

      const quoteRes = await request(app)
        .post('/api/boost/quote')
        .set('X-API-Key', API_KEY)
        .send({
          user_id: 'eligibility-user',
          reward_id: rewardId,
          bet_id: 'bet-eligible',
        });

      expect(quoteRes.status).toBe(200);
      expect(quoteRes.body.eligible).toBe(true);
      expect(quoteRes.body.reason_code).toBe(ReasonCode.ELIGIBLE);
      expect(quoteRes.body.qualifying_selection_count).toBe(3);
      expect(quoteRes.body.combined_odds).toBeCloseTo(9.0, 2);
      expect(quoteRes.body.current_boost_pct).toBeGreaterThan(0);
      expect(quoteRes.body.ticket_strength).toBeGreaterThan(0);
    });
  });
});
