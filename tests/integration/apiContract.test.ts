import request from 'supertest';
import { app } from '../../src/index';
import db from '../../src/db/connection';
import { ReasonCode } from '../../src/types/reasonCodes';
import { userRewardRepository } from '../../src/db/repositories/userRewardRepository';

const API_KEY = 'test-api-key';
const VALID_UUID = '00000000-0000-4000-8000-000000000000';
const LONG_ID = 'x'.repeat(256);

describe('API contract: validation, error codes and routing', () => {
  beforeAll(async () => {
    await db.migrate.latest();
  });

  afterAll(async () => {
    await db.destroy();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('path parameters', () => {
    it.each([
      ['GET', '/api/rewards/not-a-uuid'],
      ['POST', '/api/rewards/not-a-uuid/opt-in'],
      ['POST', '/api/rewards/not-a-uuid/eligibility'],
      ['GET', '/api/profiles/not-a-uuid'],
      ['PUT', '/api/profiles/not-a-uuid'],
      ['DELETE', '/api/profiles/not-a-uuid'],
      ['GET', `/api/rewards/user/${LONG_ID}?brand_id=brand-a`],
      ['GET', `/api/rewards/user/${LONG_ID}/active?brand_id=brand-a`],
      ['GET', `/api/boost/lock/${LONG_ID}?brand_id=brand-a`],
      ['GET', `/api/settlement/${LONG_ID}?brand_id=brand-a`],
    ])('%s %s -> 400 VALIDATION_ERROR', async (method, path) => {
      const agent = request(app);
      const req = method === 'GET' ? agent.get(path)
        : method === 'POST' ? agent.post(path)
          : method === 'PUT' ? agent.put(path)
            : agent.delete(path);
      const res = await req.set('X-API-Key', API_KEY).send({});
      expect(res.status).toBe(400);
      expect(res.body.code).toBe(ReasonCode.VALIDATION_ERROR);
    });

    it('accepts 255-character user and bet IDs', async () => {
      const id255 = 'y'.repeat(255);
      const rewards = await request(app).get(`/api/rewards/user/${id255}?brand_id=brand-a`).set('X-API-Key', API_KEY);
      expect(rewards.status).toBe(200);
      const lock = await request(app).get(`/api/boost/lock/${id255}?brand_id=brand-a`).set('X-API-Key', API_KEY);
      expect(lock.status).toBe(404);
      expect(lock.body.code).toBe(ReasonCode.LOCK_NOT_FOUND);
    });
  });

  describe('body bounds', () => {
    const selections = [{ id: 's1', odds: 2 }, { id: 's2', odds: 2 }, { id: 's3', odds: 2 }];
    const MONEY = { stake_minor: 1000, currency: 'EUR' };

    it.each([
      ['user_id over 255', { user_id: LONG_ID, bet_id: 'b', ...MONEY, ticket: { selections } }],
      ['bet_id over 255', { user_id: 'u', bet_id: LONG_ID, ...MONEY, ticket: { selections } }],
      ['selection id over 255', { user_id: 'u', bet_id: 'b', ...MONEY, ticket: { selections: [{ id: LONG_ID, odds: 2 }] } }],
      ['selection name over 255', { user_id: 'u', bet_id: 'b', ...MONEY, ticket: { selections: [{ id: 's', odds: 2, name: LONG_ID }] } }],
      ['selection market over 255', { user_id: 'u', bet_id: 'b', ...MONEY, ticket: { selections: [{ id: 's', odds: 2, market: LONG_ID }] } }],
      ['selection event over 255', { user_id: 'u', bet_id: 'b', ...MONEY, ticket: { selections: [{ id: 's', odds: 2, event: LONG_ID }] } }],
      ['odds over 10,000', { user_id: 'u', bet_id: 'b', ...MONEY, ticket: { selections: [{ id: 's', odds: 10000.01 }] } }],
      ['more than 100 selections', {
        user_id: 'u',
        bet_id: 'b',
        ...MONEY,
        ticket: { selections: Array.from({ length: 101 }, (_, i) => ({ id: `s${i}`, odds: 1.5 })) },
      }],
      ['duplicate selection ids', {
        user_id: 'u', bet_id: 'b', ...MONEY, ticket: { selections: [...selections, { id: 's2', odds: 3 }] },
      }],
    ])('opt-in rejects %s with 400', async (_label, body) => {
      const res = await request(app)
        .post(`/api/rewards/${VALID_UUID}/opt-in`)
        .set('X-API-Key', API_KEY)
        .send(body);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe(ReasonCode.VALIDATION_ERROR);
    });

    it('rejects over-long identifiers on grant, quote, lock and settlement', async () => {
      const cases: Array<[string, Record<string, unknown>]> = [
        ['/api/rewards', { user_id: LONG_ID, profile_version_id: VALID_UUID }],
        ['/api/boost/quote', { user_id: 'u', reward_id: VALID_UUID, bet_id: LONG_ID }],
        ['/api/boost/lock', { user_id: LONG_ID, reward_id: VALID_UUID, bet_id: 'b' }],
        ['/api/settlement', { brand_id: 'brand-a', bet_id: LONG_ID, outcome: 'CASHOUT' }],
        ['/api/settlement/resettle', { brand_id: 'brand-a', bet_id: LONG_ID, outcome: 'CASHOUT', reason: 'r' }],
      ];
      for (const [path, body] of cases) {
        const res = await request(app).post(path).set('X-API-Key', API_KEY).send(body);
        expect(res.status).toBe(400);
        expect(res.body.code).toBe(ReasonCode.VALIDATION_ERROR);
      }
    });
  });

  describe('error responses', () => {
    it('returns JSON 404 ROUTE_NOT_FOUND for unknown /api routes', async () => {
      const unknownTop = await request(app).get('/api/does-not-exist').set('X-API-Key', API_KEY);
      expect(unknownTop.status).toBe(404);
      expect(unknownTop.headers['content-type']).toMatch(/application\/json/);
      expect(unknownTop.body).toMatchObject({ error: 'Not Found', code: ReasonCode.ROUTE_NOT_FOUND });

      const unknownNested = await request(app)
        .post(`/api/rewards/${VALID_UUID}/does-not-exist`)
        .set('X-API-Key', API_KEY)
        .send({});
      expect(unknownNested.status).toBe(404);
      expect(unknownNested.body.code).toBe(ReasonCode.ROUTE_NOT_FOUND);

      const wrongMethod = await request(app).delete('/api/settlement').set('X-API-Key', API_KEY);
      expect(wrongMethod.status).toBe(404);
      expect(wrongMethod.body.code).toBe(ReasonCode.ROUTE_NOT_FOUND);
    });

    it('returns coded 404s for missing lock and settlement', async () => {
      const lock = await request(app).get('/api/boost/lock/missing-bet?brand_id=brand-a').set('X-API-Key', API_KEY);
      expect(lock.status).toBe(404);
      expect(lock.body).toMatchObject({ error: 'Not Found', code: ReasonCode.LOCK_NOT_FOUND });

      const settlement = await request(app).get('/api/settlement/missing-bet?brand_id=brand-a').set('X-API-Key', API_KEY);
      expect(settlement.status).toBe(404);
      expect(settlement.body).toMatchObject({ error: 'Not Found', code: ReasonCode.SETTLEMENT_NOT_FOUND });
    });

    it('returns 400 VALIDATION_ERROR for malformed JSON without echoing the body', async () => {
      const res = await request(app)
        .post('/api/rewards')
        .set('X-API-Key', API_KEY)
        .set('Content-Type', 'application/json')
        .send('{"user_id": "secret-fragment",');
      expect(res.status).toBe(400);
      expect(res.body.code).toBe(ReasonCode.VALIDATION_ERROR);
      expect(JSON.stringify(res.body)).not.toContain('secret-fragment');
    });

    it('returns 413 VALIDATION_ERROR for an oversized body', async () => {
      const res = await request(app)
        .post('/api/rewards')
        .set('X-API-Key', API_KEY)
        .set('Content-Type', 'application/json')
        .send(JSON.stringify({ user_id: 'u', padding: 'p'.repeat(2 * 1024 * 1024) }));
      expect(res.status).toBe(413);
      expect(res.body.code).toBe(ReasonCode.VALIDATION_ERROR);
    });

    it.each(['production', 'test'])('never leaks a driver error (%s mode)', async (env) => {
      jest.spyOn(console, 'error').mockImplementation(() => undefined);
      jest.spyOn(userRewardRepository, 'findByUserId').mockImplementation(async () => {
        await db.raw('select * from missing_table_for_leak_check where user_id = ?', ['bound-value-secret']);
        return [];
      });

      const previousEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = env;
      let res: request.Response;
      try {
        res = await request(app).get('/api/rewards/user/leak-user?brand_id=brand-a').set('X-API-Key', API_KEY);
      } finally {
        process.env.NODE_ENV = previousEnv;
      }

      expect(res.status).toBe(500);
      expect(res.body).toEqual({
        error: 'Internal Server Error',
        code: ReasonCode.INTERNAL_ERROR,
        message: 'An unexpected error occurred',
      });
      const text = JSON.stringify(res.body);
      expect(text).not.toMatch(/SQLITE|missing_table_for_leak_check|bound-value-secret|select/i);
      // The full error is still logged server-side.
      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining('/api/rewards/user/leak-user'),
        expect.objectContaining({ stack: expect.any(String) })
      );
    });
  });
});
