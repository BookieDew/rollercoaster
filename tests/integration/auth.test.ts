import request from 'supertest';
import express from 'express';
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
  const API_KEY = 'test-api-key';
  let profileId: string;

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

    const profileRes = await request(app)
      .post('/api/profiles')
      .set('X-API-Key', API_KEY)
      .send({
        name: 'HMAC Test Profile',
        min_selections: 3,
        min_combined_odds: 3.0,
        min_selection_odds: 1.2,
        min_boost_pct: 0.05,
        max_boost_pct: 0.5,
        ride_duration_seconds: 15,
        brand_id: 'brand-a',
        max_bonus_minor: { EUR: 50_000 },
        reward_validity_seconds: 86_400,
      });

    expect(profileRes.status).toBe(201);
    profileId = profileRes.body.id;
  });

  it('accepts valid HMAC signatures', async () => {
    const body = {
      user_id: 'hmac-user-valid',
      profile_version_id: profileId,
    };
    const timestamp = Date.now().toString();
    const signature = signRequest('POST', '/api/rewards', body, timestamp);

    const res = await request(app)
      .post('/api/rewards')
      .set('X-Timestamp', timestamp)
      .set('X-Signature', signature)
      .send(body);

    expect(res.status).toBe(201);
    expect(res.body.id).toBeDefined();
  });

  it('rejects invalid HMAC signatures', async () => {
    const body = {
      user_id: 'hmac-user-invalid',
      profile_version_id: profileId,
    };
    const timestamp = Date.now().toString();
    const signature = 'deadbeef';

    const res = await request(app)
      .post('/api/rewards')
      .set('X-Timestamp', timestamp)
      .set('X-Signature', signature)
      .send(body);

    expect(res.status).toBe(401);
  });

  it('rejects replayed HMAC signatures within the time window', async () => {
    const body = {
      user_id: 'hmac-user-replay',
      profile_version_id: profileId,
    };
    const timestamp = Date.now().toString();
    const signature = signRequest('POST', '/api/rewards', body, timestamp);

    const first = await request(app)
      .post('/api/rewards')
      .set('X-Timestamp', timestamp)
      .set('X-Signature', signature)
      .send(body);

    expect(first.status).toBe(201);

    const replay = await request(app)
      .post('/api/rewards')
      .set('X-Timestamp', timestamp)
      .set('X-Signature', signature)
      .send(body);

    expect(replay.status).toBe(401);
  });

  it('rejects expired HMAC timestamps', async () => {
    const body = {
      user_id: 'hmac-user-expired',
      profile_version_id: profileId,
    };
    const staleTimestamp = (Date.now() - 10 * 60 * 1000).toString();
    const signature = signRequest('POST', '/api/rewards', body, staleTimestamp);

    const res = await request(app)
      .post('/api/rewards')
      .set('X-Timestamp', staleTimestamp)
      .set('X-Signature', signature)
      .send(body);

    expect(res.status).toBe(401);
  });

  async function postSignedReward(userId: string, mutate: (sig: string) => string = (sig) => sig) {
    const body = { user_id: userId, profile_version_id: profileId };
    const timestamp = Date.now().toString();
    const signature = signRequest('POST', '/api/rewards', body, timestamp);
    return {
      body,
      timestamp,
      signature,
      res: await request(app)
        .post('/api/rewards')
        .set('X-Timestamp', timestamp)
        .set('X-Signature', mutate(signature))
        .send(body),
    };
  }

  async function countRewards(userId: string): Promise<number> {
    const row = await db('user_rewards').where({ user_id: userId }).count({ n: '*' }).first();
    return Number(row?.n ?? 0);
  }

  it('accepts an uppercase signature once and rejects its lowercase replay', async () => {
    const first = await postSignedReward('hmac-user-upper', (sig) => sig.toUpperCase());
    expect(first.res.status).toBe(201);

    const replay = await request(app)
      .post('/api/rewards')
      .set('X-Timestamp', first.timestamp)
      .set('X-Signature', first.signature.toLowerCase())
      .send(first.body);
    expect(replay.status).toBe(401);
    expect(await countRewards('hmac-user-upper')).toBe(1);
  });

  it('rejects letter-case variants of an already used signature', async () => {
    const first = await postSignedReward('hmac-user-case');
    expect(first.res.status).toBe(201);

    const variants = [
      first.signature.toUpperCase(),
      first.signature.slice(0, 32).toUpperCase() + first.signature.slice(32),
    ];
    for (const variant of variants) {
      const replay = await request(app)
        .post('/api/rewards')
        .set('X-Timestamp', first.timestamp)
        .set('X-Signature', variant)
        .send(first.body);
      expect(replay.status).toBe(401);
    }
    expect(await countRewards('hmac-user-case')).toBe(1);
  });

  it('rejects signatures with extra, missing or non-hex characters', async () => {
    const malformed: Array<(sig: string) => string> = [
      (sig) => `${sig}zz`,
      (sig) => `${sig}0`,
      (sig) => `${sig}00`,
      (sig) => sig.slice(0, 63),
      (sig) => `0x${sig}`,
      (sig) => `${sig.slice(0, 63)}g`,
      () => 'z'.repeat(64),
    ];
    for (const mutate of malformed) {
      const attempt = await postSignedReward('hmac-user-malformed', mutate);
      expect(attempt.res.status).toBe(401);
    }
    expect(await countRewards('hmac-user-malformed')).toBe(0);

    // The same request is accepted once with the exact signature.
    const valid = await postSignedReward('hmac-user-malformed');
    expect(valid.res.status).toBe(201);
  });

  it('rejects correctly signed requests whose timestamp is not digits only', async () => {
    const body = { user_id: 'hmac-user-timestamp', profile_version_id: profileId };
    const now = Date.now();
    const timestamps = [`${now}abc`, `${now}.0`, `+${now}`, `-${now}`, `${now}e0`, `0x${now.toString(16)}`];
    for (const timestamp of timestamps) {
      const res = await request(app)
        .post('/api/rewards')
        .set('X-Timestamp', timestamp)
        .set('X-Signature', signRequest('POST', '/api/rewards', body, timestamp))
        .send(body);
      expect(res.status).toBe(401);
    }
    expect(await countRewards('hmac-user-timestamp')).toBe(0);
  });
});

describe('Authenticated principal labels', () => {
  const SERVICE_KEY = 'svc-7Qm2xR9vLp4Tz8Kw1Nb6Hc3Yd5Fg0Js';
  const ADMIN_KEY = 'adm-3Vn8Pq1Wx6Lr9Bt4Mz2Kc7Hd0Yf5Gs';
  const HMAC_KEY = 'mac-5Rw0Tz7Kq2Lp9Xv4Nb1Hc6Yd3Fg8Js';
  const originalEnv = process.env;

  type AuthModule = typeof import('../../src/middleware/authMiddleware');

  function loadIsolatedAuth(overrides: Record<string, string>): AuthModule {
    let auth!: AuthModule;
    process.env = {
      ...originalEnv,
      API_KEY_SECRET: SERVICE_KEY,
      ADMIN_API_KEY_SECRET: ADMIN_KEY,
      HMAC_SECRET: HMAC_KEY,
      ...overrides,
    };
    try {
      jest.isolateModules(() => {
        // eslint-disable-next-line global-require
        auth = require('../../src/middleware/authMiddleware');
      });
    } finally {
      process.env = originalEnv;
    }
    return auth;
  }

  function probeApp(auth: AuthModule) {
    const probe = express();
    probe.use(express.json({
      verify: (req, _res, buf) => {
        (req as { rawBody?: string }).rawBody = buf.toString('utf8');
      },
    }));
    const echo = (req: import('../../src/middleware/authMiddleware').AuthenticatedRequest, res: express.Response) => {
      res.json({ apiKeyId: req.apiKeyId, authMethod: req.authMethod });
    };
    probe.post('/probe', auth.authMiddleware, echo);
    probe.post('/admin-probe', auth.authMiddleware, auth.adminOnlyMiddleware, echo);
    return probe;
  }

  function hmacHeaders(path: string, body: Record<string, unknown>) {
    const timestamp = Date.now().toString();
    const message = `${timestamp}\nPOST\n${path}\n${JSON.stringify(body)}`;
    return {
      'X-Timestamp': timestamp,
      'X-Signature': createHmac('sha256', HMAC_KEY).update(message).digest('hex'),
    };
  }

  function expectNotDerivedFromSecrets(apiKeyId: string) {
    for (const secret of [SERVICE_KEY, ADMIN_KEY, HMAC_KEY]) {
      for (let start = 0; start + 4 <= secret.length; start++) {
        expect(apiKeyId).not.toContain(secret.slice(start, start + 4));
      }
    }
  }

  it('labels the service key, admin key and HMAC caller without using secret material', async () => {
    const probe = probeApp(loadIsolatedAuth({}));

    const service = await request(probe).post('/probe').set('X-API-Key', SERVICE_KEY).send({ a: 1 });
    expect(service.status).toBe(200);
    expect(service.body).toEqual({ apiKeyId: 'service', authMethod: 'api_key' });

    const admin = await request(probe).post('/probe').set('X-API-Key', ADMIN_KEY).send({ a: 1 });
    expect(admin.status).toBe(200);
    expect(admin.body).toEqual({ apiKeyId: 'admin', authMethod: 'api_key' });

    const body = { a: 2 };
    const hmac = await request(probe).post('/probe').set(hmacHeaders('/probe', body)).send(body);
    expect(hmac.status).toBe(200);
    expect(hmac.body).toEqual({ apiKeyId: 'hmac', authMethod: 'hmac' });

    for (const id of [service.body.apiKeyId, admin.body.apiKeyId, hmac.body.apiKeyId]) {
      expectNotDerivedFromSecrets(id);
    }
  });

  it('keeps the admin gate on the admin key only', async () => {
    const probe = probeApp(loadIsolatedAuth({}));

    const admin = await request(probe).post('/admin-probe').set('X-API-Key', ADMIN_KEY).send({});
    expect(admin.status).toBe(200);
    expect(admin.body.apiKeyId).toBe('admin');

    const service = await request(probe).post('/admin-probe').set('X-API-Key', SERVICE_KEY).send({});
    expect(service.status).toBe(403);

    const body = { b: 1 };
    const hmac = await request(probe).post('/admin-probe').set(hmacHeaders('/admin-probe', body)).send(body);
    expect(hmac.status).toBe(403);

    const wrong = await request(probe).post('/probe').set('X-API-Key', `${SERVICE_KEY}x`).send({});
    expect(wrong.status).toBe(401);
  });

  it('labels a shared service/admin key as admin', async () => {
    const probe = probeApp(loadIsolatedAuth({ ADMIN_API_KEY_SECRET: SERVICE_KEY }));
    const res = await request(probe).post('/probe').set('X-API-Key', SERVICE_KEY).send({});
    expect(res.body).toEqual({ apiKeyId: 'admin', authMethod: 'api_key' });
  });

  it('keeps accepting fresh signatures when the replay cache is full', async () => {
    const probe = probeApp(loadIsolatedAuth({ HMAC_REPLAY_CACHE_SIZE: '1' }));
    for (const n of [1, 2, 3]) {
      const body = { n };
      const res = await request(probe).post('/probe').set(hmacHeaders('/probe', body)).send(body);
      expect(res.status).toBe(200);
    }
  });
});
