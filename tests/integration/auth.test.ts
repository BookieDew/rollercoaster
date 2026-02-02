import request from 'supertest';
import { createHmac } from 'crypto';
import { app } from '../../src/index';
import db from '../../src/db/connection';

function signRequest(
  method: string,
  path: string,
  body: Record<string, unknown>,
  timestamp: string
): string {
  const payload = JSON.stringify(body);
  const message = `${timestamp}\n${method.toUpperCase()}\n${path}\n${payload}`;
  const secret = process.env.HMAC_SECRET ?? 'test-hmac-secret';
  return createHmac('sha256', secret).update(message).digest('hex');
}

describe('HMAC Authentication', () => {
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

  it('accepts valid HMAC signatures', async () => {
    const body = {
      name: 'HMAC Profile',
      min_selections: 3,
      min_combined_odds: 3.0,
      min_selection_odds: 1.2,
      min_boost_pct: 0.05,
      max_boost_pct: 0.5,
      ride_duration_seconds: 3600,
    };
    const timestamp = Date.now().toString();
    const signature = signRequest('POST', '/api/profiles', body, timestamp);

    const res = await request(app)
      .post('/api/profiles')
      .set('X-Timestamp', timestamp)
      .set('X-Signature', signature)
      .send(body);

    expect(res.status).toBe(201);
    expect(res.body.id).toBeDefined();
  });

  it('rejects invalid HMAC signatures', async () => {
    const body = {
      name: 'Bad HMAC Profile',
      min_selections: 3,
      min_combined_odds: 3.0,
      min_selection_odds: 1.2,
      min_boost_pct: 0.05,
      max_boost_pct: 0.5,
      ride_duration_seconds: 3600,
    };
    const timestamp = Date.now().toString();
    const signature = 'deadbeef';

    const res = await request(app)
      .post('/api/profiles')
      .set('X-Timestamp', timestamp)
      .set('X-Signature', signature)
      .send(body);

    expect(res.status).toBe(401);
  });

  it('rejects replayed HMAC signatures within the time window', async () => {
    const body = {
      name: 'Replay HMAC Profile',
      min_selections: 3,
      min_combined_odds: 3.0,
      min_selection_odds: 1.2,
      min_boost_pct: 0.05,
      max_boost_pct: 0.5,
      ride_duration_seconds: 3600,
    };
    const timestamp = Date.now().toString();
    const signature = signRequest('POST', '/api/profiles', body, timestamp);

    const first = await request(app)
      .post('/api/profiles')
      .set('X-Timestamp', timestamp)
      .set('X-Signature', signature)
      .send(body);

    expect(first.status).toBe(201);

    const replay = await request(app)
      .post('/api/profiles')
      .set('X-Timestamp', timestamp)
      .set('X-Signature', signature)
      .send(body);

    expect(replay.status).toBe(401);
  });
});
