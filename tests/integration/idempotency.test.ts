import request from 'supertest';
import { app } from '../../src/index';
import db from '../../src/db/connection';

describe('Idempotency Integration Tests', () => {
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
        name: 'Idempotency Test Profile',
        min_selections: 3,
        min_combined_odds: 3.0,
        min_selection_odds: 1.2,
        min_boost_pct: 0.05,
        max_boost_pct: 0.5,
        ride_duration_seconds: 3600,
      });
    profileId = profileRes.body.id;

    // Grant and opt into reward
    const grantRes = await request(app)
      .post('/api/rewards')
      .set('X-API-Key', API_KEY)
      .send({
        user_id: 'idempotent-user',
        profile_version_id: profileId,
      });
    rewardId = grantRes.body.id;
  });

  describe('Lock endpoint idempotency', () => {
    it('should return same lock on duplicate lock requests', async () => {
      await request(app)
        .post(`/api/rewards/${rewardId}/opt-in`)
        .set('X-API-Key', API_KEY)
        .send({
          user_id: 'idempotent-user',
          bet_id: 'idempotent-bet-1',
          ticket: {
            selections: [
              { id: 's1', odds: 1.5 },
              { id: 's2', odds: 2.0 },
              { id: 's3', odds: 1.8 },
            ],
          },
        });

      const lockPayload = {
        user_id: 'idempotent-user',
        reward_id: rewardId,
        bet_id: 'idempotent-bet-1',
      };

      // First lock request
      const firstRes = await request(app)
        .post('/api/boost/lock')
        .set('X-API-Key', API_KEY)
        .send(lockPayload);

      expect(firstRes.status).toBe(201);
      const firstLockId = firstRes.body.lock_id;
      const firstLockedPct = firstRes.body.locked_boost_pct;

      // Second lock request with same bet_id should return same lock
      const secondRes = await request(app)
        .post('/api/boost/lock')
        .set('X-API-Key', API_KEY)
        .send(lockPayload);

      expect(secondRes.status).toBe(201);
      expect(secondRes.body.lock_id).toBe(firstLockId);
      expect(secondRes.body.locked_boost_pct).toBe(firstLockedPct);

      // Third request - same result
      const thirdRes = await request(app)
        .post('/api/boost/lock')
        .set('X-API-Key', API_KEY)
        .send(lockPayload);

      expect(thirdRes.status).toBe(201);
      expect(thirdRes.body.lock_id).toBe(firstLockId);
    });

    it('should only create one lock record in database', async () => {
      await request(app)
        .post(`/api/rewards/${rewardId}/opt-in`)
        .set('X-API-Key', API_KEY)
        .send({
          user_id: 'idempotent-user',
          bet_id: 'idempotent-bet-2',
          ticket: {
            selections: [
              { id: 's1', odds: 1.5 },
              { id: 's2', odds: 2.0 },
              { id: 's3', odds: 1.8 },
            ],
          },
        });
      const lockPayload = {
        user_id: 'idempotent-user',
        reward_id: rewardId,
        bet_id: 'idempotent-bet-2',
      };

      // Make multiple requests
      await Promise.all([
        request(app).post('/api/boost/lock').set('X-API-Key', API_KEY).send(lockPayload),
        request(app).post('/api/boost/lock').set('X-API-Key', API_KEY).send(lockPayload),
        request(app).post('/api/boost/lock').set('X-API-Key', API_KEY).send(lockPayload),
      ]);

      // Check database has only one lock
      const locks = await db('bet_boost_locks').where({ bet_id: 'idempotent-bet-2' });
      expect(locks).toHaveLength(1);
    });
  });

  describe('Settlement endpoint idempotency', () => {
    let betId: string;

    beforeEach(async () => {
      betId = 'settlement-idempotent-bet';

      // Create a lock first
      await request(app)
        .post(`/api/rewards/${rewardId}/opt-in`)
        .set('X-API-Key', API_KEY)
        .send({
          user_id: 'idempotent-user',
          bet_id: betId,
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
          user_id: 'idempotent-user',
          reward_id: rewardId,
          bet_id: betId,
        });
    });

    it('should return same settlement on duplicate settlement requests', async () => {
      const settlePayload = {
        bet_id: betId,
        outcome: 'WIN',
        winnings: 100,
      };

      // First settlement
      const firstRes = await request(app)
        .post('/api/settlement')
        .set('X-API-Key', API_KEY)
        .send(settlePayload);

      expect(firstRes.status).toBe(201);
      const firstSettlementId = firstRes.body.settlement_id;
      const firstBonusAmount = firstRes.body.bonus_amount;

      // Second settlement with same bet_id
      const secondRes = await request(app)
        .post('/api/settlement')
        .set('X-API-Key', API_KEY)
        .send(settlePayload);

      expect(secondRes.status).toBe(201);
      expect(secondRes.body.settlement_id).toBe(firstSettlementId);
      expect(secondRes.body.bonus_amount).toBe(firstBonusAmount);
    });

    it('should only create one settlement record in database', async () => {
      const settlePayload = {
        bet_id: betId,
        outcome: 'WIN',
        winnings: 50,
      };

      // Make multiple requests
      await request(app).post('/api/settlement').set('X-API-Key', API_KEY).send(settlePayload);
      await request(app).post('/api/settlement').set('X-API-Key', API_KEY).send(settlePayload);
      await request(app).post('/api/settlement').set('X-API-Key', API_KEY).send(settlePayload);

      // Check database
      const settlements = await db('settlement_records').where({ bet_id: betId });
      expect(settlements).toHaveLength(1);
    });
  });
});
