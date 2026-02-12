import request from 'supertest';
import { createHmac } from 'crypto';
import { app } from '../../src/index';
import db from '../../src/db/connection';

describe('Admin Endpoints Integration Tests', () => {
  const API_KEY = 'test-api-key';
  const HMAC_SECRET = 'test-hmac-secret';

  function sign(method: string, path: string, body: unknown, timestamp: string): string {
    const bodyString = body ? JSON.stringify(body) : '';
    const message = `${timestamp}\n${method}\n${path}\n${bodyString}`;
    return createHmac('sha256', HMAC_SECRET).update(message).digest('hex');
  }

  async function createProfile(name = 'Admin Test Profile'): Promise<string> {
    const res = await request(app)
      .post('/api/profiles')
      .set('X-API-Key', API_KEY)
      .send({
        name,
        min_selections: 5,
        min_combined_odds: 10,
        min_selection_odds: 1.3,
        min_boost_pct: 0.05,
        max_boost_pct: 1,
        max_boost_min_selections: 10,
        max_boost_min_combined_odds: 50,
        max_eligibility_selection_weight: 0.75,
        max_eligibility_odds_weight: 0.25,
        effective_min_floor_rate: 0.35,
        ride_mode: 'WAVES',
        ride_duration_seconds: 300,
      });

    expect(res.status).toBe(201);
    return res.body.id as string;
  }

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

  it('rejects admin routes when authenticated with HMAC only', async () => {
    const payload = {
      name: 'HMAC blocked',
      min_selections: 3,
      min_combined_odds: 5,
      min_selection_odds: 1.2,
      min_boost_pct: 0.05,
      max_boost_pct: 0.5,
      ride_duration_seconds: 120,
    };
    const timestamp = Date.now().toString();
    const signature = sign('POST', '/api/profiles', payload, timestamp);

    const res = await request(app)
      .post('/api/profiles')
      .set('X-Signature', signature)
      .set('X-Timestamp', timestamp)
      .send(payload);

    expect(res.status).toBe(403);
    expect(res.body.message).toContain('Admin API key required');
  });

  it('supports profile CRUD and active filter', async () => {
    const profileId = await createProfile('CRUD Profile');

    const getRes = await request(app)
      .get(`/api/profiles/${profileId}`)
      .set('X-API-Key', API_KEY);
    expect(getRes.status).toBe(200);
    expect(getRes.body.id).toBe(profileId);

    const updateRes = await request(app)
      .put(`/api/profiles/${profileId}`)
      .set('X-API-Key', API_KEY)
      .send({
        name: 'CRUD Profile Updated',
        ride_mode: 'LINEAR',
        is_active: false,
      });
    expect(updateRes.status).toBe(200);
    expect(updateRes.body.name).toBe('CRUD Profile Updated');
    expect(updateRes.body.ride_mode).toBe('LINEAR');
    expect(updateRes.body.is_active).toBe(false);

    const listAllRes = await request(app)
      .get('/api/profiles')
      .set('X-API-Key', API_KEY);
    expect(listAllRes.status).toBe(200);
    expect(listAllRes.body.count).toBe(1);

    const listActiveRes = await request(app)
      .get('/api/profiles?active=true')
      .set('X-API-Key', API_KEY);
    expect(listActiveRes.status).toBe(200);
    expect(listActiveRes.body.count).toBe(0);

    const deleteRes = await request(app)
      .delete(`/api/profiles/${profileId}`)
      .set('X-API-Key', API_KEY);
    expect(deleteRes.status).toBe(204);

    const missingRes = await request(app)
      .get(`/api/profiles/${profileId}`)
      .set('X-API-Key', API_KEY);
    expect(missingRes.status).toBe(404);
  });

  it('returns validation errors for invalid profile payloads', async () => {
    const createRes = await request(app)
      .post('/api/profiles')
      .set('X-API-Key', API_KEY)
      .send({
        name: 'Invalid Profile',
        min_selections: 5,
        min_combined_odds: 10,
        min_selection_odds: 1.3,
        min_boost_pct: 0.9,
        max_boost_pct: 0.1,
        ride_duration_seconds: 300,
      });

    expect(createRes.status).toBe(400);
    expect(createRes.body.code).toBe('VALIDATION_ERROR');
  });

  it('returns service-level config errors on updates', async () => {
    const profileId = await createProfile('Service Validation');

    const selectionThresholdRes = await request(app)
      .put(`/api/profiles/${profileId}`)
      .set('X-API-Key', API_KEY)
      .send({
        min_selections: 12,
      });
    expect(selectionThresholdRes.status).toBe(422);
    expect(selectionThresholdRes.body.code).toBe('INVALID_CONFIGURATION');

    const oddsThresholdRes = await request(app)
      .put(`/api/profiles/${profileId}`)
      .set('X-API-Key', API_KEY)
      .send({
        min_combined_odds: 100,
      });
    expect(oddsThresholdRes.status).toBe(422);
    expect(oddsThresholdRes.body.code).toBe('INVALID_CONFIGURATION');
  });

  it('returns 404 for update/delete on missing profile', async () => {
    const missingId = '00000000-0000-0000-0000-000000000000';

    const updateRes = await request(app)
      .put(`/api/profiles/${missingId}`)
      .set('X-API-Key', API_KEY)
      .send({ name: 'Nope' });
    expect(updateRes.status).toBe(404);

    const deleteRes = await request(app)
      .delete(`/api/profiles/${missingId}`)
      .set('X-API-Key', API_KEY);
    expect(deleteRes.status).toBe(404);
  });

  it('simulates ride using profile config and returns curve', async () => {
    const profileId = await createProfile('Simulation Profile');

    const simulationRes = await request(app)
      .post('/api/simulation')
      .set('X-API-Key', API_KEY)
      .send({
        profile_id: profileId,
        seed: 'sim-integration-seed',
        sample_points: 30,
        ticket: {
          selections: [
            { id: 'a', odds: 1.4 },
            { id: 'b', odds: 1.6 },
            { id: 'c', odds: 1.8 },
            { id: 'd', odds: 2.0 },
            { id: 'e', odds: 1.2 },
          ],
        },
      });

    expect(simulationRes.status).toBe(200);
    expect(simulationRes.body.config).toBeDefined();
    expect(simulationRes.body.ticket_analysis).toBeDefined();
    expect(simulationRes.body.curve).toHaveLength(31);
  });

  it('returns 404 for simulation with missing profile', async () => {
    const simulationRes = await request(app)
      .post('/api/simulation')
      .set('X-API-Key', API_KEY)
      .send({
        profile_id: '00000000-0000-0000-0000-000000000000',
        seed: 'sim-missing-profile',
      });

    expect(simulationRes.status).toBe(404);
    expect(simulationRes.body.code).toBe('PROFILE_NOT_FOUND');
  });

  it('returns validation error for invalid simulation payload', async () => {
    const simulationRes = await request(app)
      .post('/api/simulation')
      .set('X-API-Key', API_KEY)
      .send({
        sample_points: 5, // below minimum
      });

    expect(simulationRes.status).toBe(400);
    expect(simulationRes.body.code).toBe('VALIDATION_ERROR');
  });
});
