import request from 'supertest';
import { app } from '../../src/index';
import db from '../../src/db/connection';
import { betBoostLockRepository } from '../../src/db/repositories/betBoostLockRepository';
import { userRewardRepository } from '../../src/db/repositories/userRewardRepository';
import { ReasonCode } from '../../src/types/reasonCodes';

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
    await db('bet_settlements').del();
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
        brand_id: 'brand-a',
        max_bonus_minor: { EUR: 50_000 },
        reward_validity_seconds: 86_400,
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
          stake_minor: 1000,
          currency: 'EUR',
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
          stake_minor: 1000,
          currency: 'EUR',
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
      const responses = await Promise.all([
        request(app).post('/api/boost/lock').set('X-API-Key', API_KEY).send(lockPayload),
        request(app).post('/api/boost/lock').set('X-API-Key', API_KEY).send(lockPayload),
        request(app).post('/api/boost/lock').set('X-API-Key', API_KEY).send(lockPayload),
      ]);

      for (const response of responses) {
        expect(response.status).toBe(201);
      }
      const uniqueLockIds = new Set(responses.map((response) => response.body.lock_id));
      expect(uniqueLockIds.size).toBe(1);

      // Check database has only one lock
      const locks = await db('bet_boost_locks').where({ bet_id: 'idempotent-bet-2' });
      expect(locks).toHaveLength(1);
    });
  });

  describe('Lock race: lock committed between the idempotency check and the reward read', () => {
    const selections = [
      { id: 's1', odds: 1.5 },
      { id: 's2', odds: 2.0 },
      { id: 's3', odds: 1.8 },
    ];

    afterEach(() => {
      jest.restoreAllMocks();
    });

    async function enterRide(betId: string): Promise<void> {
      const optInRes = await request(app)
        .post(`/api/rewards/${rewardId}/opt-in`)
        .set('X-API-Key', API_KEY)
        .send({ stake_minor: 1000, currency: 'EUR', user_id: 'idempotent-user', bet_id: betId, ticket: { selections } });
      expect(optInRes.status).toBe(200);

      // Pin evaluation inside the pre-crash window so the race, not ride timing, decides the outcome.
      const row = await db('user_rewards').where({ id: rewardId }).first();
      const math = JSON.parse(row.ticket_snapshot).rideMath;
      const liveMs = Date.parse(math.startTime)
        + Math.floor(math.rideDurationSeconds * math.crashPct * 1000 * 0.4);
      jest.spyOn(Date, 'now').mockReturnValue(liveMs);
    }

    /**
     * Forces the interleaving: the next lock request reads "no lock for this bet",
     * then a competing request locks and commits (reward becomes USED), and only
     * then does the first request read the reward.
     */
    function interleaveCompetingLockAfterIdempotencyCheck(competing: () => Promise<request.Response>) {
      const competingResponse: { value?: request.Response } = {};
      const realFindByBetId = betBoostLockRepository.findByBetId.bind(betBoostLockRepository);
      jest.spyOn(betBoostLockRepository, 'findByBetId').mockImplementationOnce(async (betId: string, brandId: string) => {
        const before = await realFindByBetId(betId, brandId);
        competingResponse.value = await competing();
        return before;
      });
      return competingResponse;
    }

    it('replays the committed lock (201) to the same reward and owner instead of REWARD_ALREADY_USED', async () => {
      await enterRide('race-bet');
      const payload = { user_id: 'idempotent-user', reward_id: rewardId, bet_id: 'race-bet' };
      const lockRequest = () => request(app).post('/api/boost/lock').set('X-API-Key', API_KEY).send(payload);

      const competing = interleaveCompetingLockAfterIdempotencyCheck(lockRequest);
      const findReward = jest.spyOn(userRewardRepository, 'findById');
      const late = await lockRequest();

      expect(competing.value?.status).toBe(201);
      // The late request saw no lock, then read the reward only after it became USED.
      expect(findReward).toHaveBeenCalled();
      expect(late.status).toBe(201);
      expect(late.body.lock_id).toBe(competing.value!.body.lock_id);
      expect(late.body).toEqual(competing.value!.body);
      expect(await db('bet_boost_locks').where({ bet_id: 'race-bet' })).toHaveLength(1);
      expect((await db('user_rewards').where({ id: rewardId }).first()).status).toBe('USED');
    });

    it('still answers REWARD_ALREADY_USED when the used reward has no lock for this bet', async () => {
      await enterRide('used-bet');
      await db('user_rewards').where({ id: rewardId }).update({ status: 'USED' });

      const res = await request(app)
        .post('/api/boost/lock')
        .set('X-API-Key', API_KEY)
        .send({ user_id: 'idempotent-user', reward_id: rewardId, bet_id: 'used-bet' });
      expect(res.status).toBe(422);
      expect(res.body.code).toBe(ReasonCode.REWARD_ALREADY_USED);
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
          stake_minor: 1000,
          currency: 'EUR',
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

    const settledPayload = (legs: Array<{ selection_id: string; result: string }>) => ({
      brand_id: 'brand-a',
      bet_id: betId,
      outcome: 'SETTLED',
      legs,
    });

    it('should return same settlement on duplicate settlement requests, whatever the leg order', async () => {
      const legs = [
        { selection_id: 's1', result: 'WON' },
        { selection_id: 's2', result: 'WON' },
        { selection_id: 's3', result: 'PUSH' },
      ];

      const firstRes = await request(app)
        .post('/api/settlement')
        .set('X-API-Key', API_KEY)
        .send(settledPayload(legs));

      expect(firstRes.status).toBe(201);
      expect(firstRes.body.bet_result).toBe('WON');

      // Same legs in another order: the normalized payload is identical.
      const secondRes = await request(app)
        .post('/api/settlement')
        .set('X-API-Key', API_KEY)
        .send(settledPayload([...legs].reverse()));

      expect(secondRes.status).toBe(201);
      expect(secondRes.body).toEqual(firstRes.body);
    });

    it('should only create one settlement record in database', async () => {
      const payload = { brand_id: 'brand-a', bet_id: betId, outcome: 'CASHOUT' };

      await request(app).post('/api/settlement').set('X-API-Key', API_KEY).send(payload);
      await request(app).post('/api/settlement').set('X-API-Key', API_KEY).send(payload);
      await request(app).post('/api/settlement').set('X-API-Key', API_KEY).send(payload);

      const settlements = await db('bet_settlements').where({ bet_id: betId });
      expect(settlements).toHaveLength(1);
      expect(await db('audit_logs').where({ action: 'SETTLE' })).toHaveLength(1);
    });
  });
});
