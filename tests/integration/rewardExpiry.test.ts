import request from 'supertest';
import { createHmac } from 'crypto';
import { app } from '../../src/index';
import db from '../../src/db/connection';
import { expireRewards } from '../../src/services/rewardExpiryService';
import { userRewardRepository } from '../../src/db/repositories/userRewardRepository';
import { findSeed } from '../helpers/v4Rides';

/** V4 seeds (test ride limits): one that crashes at least 1 s before its end, one that never crashes. */
const CRASH_SEED = findSeed('expiry-crash', (p) => p.outcome === 'CRASHED' && (p.crashAtSeconds as number) < p.durationSeconds - 1);
const END_SEED = findSeed('expiry-end', (p) => p.outcome === 'ENDED');

const API_KEY = 'test-api-key';
const HMAC_SECRET = 'test-hmac-secret';
const SELECTIONS = [
  { id: 's1', odds: 1.5 },
  { id: 's2', odds: 2.0 },
  { id: 's3', odds: 1.8 },
  { id: 's4', odds: 2.5 },
];

async function createProfile(brandId = 'brand-a'): Promise<string> {
  const res = await request(app).post('/api/profiles').set('X-API-Key', API_KEY).send({
    brand_id: brandId,
    name: 'Expiry Profile',
    min_selections: 3,
    min_combined_odds: 3.0,
    min_selection_odds: 1.2,
    min_boost_pct: 0.05,
    max_boost_pct: 0.5,
    ride_duration_seconds: 3600,
    max_bonus_minor: { EUR: 50_000 },
    reward_validity_seconds: 3600,
  });
  expect(res.status).toBe(201);
  return res.body.id as string;
}

async function grant(userId: string, profileId: string): Promise<string> {
  const res = await request(app).post('/api/rewards').set('X-API-Key', API_KEY)
    .send({ user_id: userId, profile_version_id: profileId });
  expect(res.status).toBe(201);
  return res.body.id as string;
}

async function optIn(rewardId: string, userId: string, betId: string) {
  const res = await request(app).post(`/api/rewards/${rewardId}/opt-in`).set('X-API-Key', API_KEY).send({
    user_id: userId, bet_id: betId, stake_minor: 1000, currency: 'EUR', ticket: { selections: SELECTIONS },
  });
  expect(res.status).toBe(200);
}

async function setValidUntil(rewardId: string, validUntil: string | null): Promise<void> {
  await db('user_rewards').where({ id: rewardId }).update({ valid_until: validUntil });
}

/** Gives a GRANTED reward a chosen V4 seed, so its ride outcome is known before opt-in. */
async function useSeed(rewardId: string, seed: string): Promise<void> {
  await db('user_rewards').where({ id: rewardId }).update({ seed });
}

async function rideOf(rewardId: string): Promise<{ startMs: number; endMs: number; durationMs: number; crashMs: number | null }> {
  const row = await db('user_rewards').where({ id: rewardId }).first();
  const math = JSON.parse(row.ticket_snapshot).rideMath;
  const startMs = Date.parse(math.startTime);
  const endMs = Date.parse(math.endTime);
  const crashMs = math.crashAtSeconds === null ? null : startMs + math.crashAtSeconds * 1000;
  return { startMs, endMs, durationMs: endMs - startMs, crashMs };
}

async function expireAudit(rewardId: string) {
  return db('audit_logs').where({ entity_id: rewardId, action: 'EXPIRE' });
}

describe('Reward expiry job', () => {
  const past = () => new Date(Date.now() - 60_000).toISOString();
  const future = () => new Date(Date.now() + 3_600_000).toISOString();

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
  });

  describe('admin endpoint', () => {
    it('rejects unauthenticated and HMAC-only callers', async () => {
      const none = await request(app).post('/api/admin/rewards/expire');
      expect(none.status).toBe(401);

      const timestamp = Date.now().toString();
      const signature = createHmac('sha256', HMAC_SECRET)
        .update(`${timestamp}\nPOST\n/api/admin/rewards/expire\n`).digest('hex');
      const hmacOnly = await request(app).post('/api/admin/rewards/expire')
        .set('X-Signature', signature).set('X-Timestamp', timestamp);
      expect(hmacOnly.status).toBe(403);
      expect(hmacOnly.body.message).toContain('Admin API key required');
    });

    it('expires GRANTED rewards past valid_until, returns counts and is idempotent', async () => {
      const profileId = await createProfile();
      const expiredA = await grant('u1', profileId);
      const expiredB = await grant('u2', profileId);
      const alive = await grant('u3', profileId);
      const legacy = await grant('u4', profileId);
      await setValidUntil(expiredA, past());
      await setValidUntil(expiredB, past());
      await setValidUntil(alive, future());
      await setValidUntil(legacy, null);

      const first = await request(app).post('/api/admin/rewards/expire').set('X-API-Key', API_KEY);
      expect(first.status).toBe(200);
      expect(first.body).toMatchObject({ granted_expired: 2, entered_expired: 0, total_expired: 2 });
      expect(Date.parse(first.body.evaluated_at)).not.toBeNaN();

      const status = async (id: string) => (await userRewardRepository.findById(id))?.status;
      expect(await status(expiredA)).toBe('EXPIRED');
      expect(await status(expiredB)).toBe('EXPIRED');
      expect(await status(alive)).toBe('GRANTED');
      expect(await status(legacy)).toBe('GRANTED');

      // One audit row per changed reward, none for the others.
      expect(await expireAudit(expiredA)).toHaveLength(1);
      expect(JSON.parse((await expireAudit(expiredA))[0].payload)).toMatchObject({
        brandId: 'brand-a', reason: 'VALIDITY_ELAPSED', trigger: 'JOB', previousStatus: 'GRANTED',
      });
      expect(await expireAudit(alive)).toHaveLength(0);
      expect(await expireAudit(legacy)).toHaveLength(0);
      expect(await db('audit_logs').where({ action: 'EXPIRE' })).toHaveLength(2);

      const second = await request(app).post('/api/admin/rewards/expire').set('X-API-Key', API_KEY);
      expect(second.body).toMatchObject({ granted_expired: 0, entered_expired: 0, total_expired: 0 });
      expect(await db('audit_logs').where({ action: 'EXPIRE' })).toHaveLength(2);
    });
  });

  describe('expireRewards(now)', () => {
    it('uses the supplied clock: validity boundary is "strictly after valid_until"', async () => {
      const profileId = await createProfile();
      const rewardId = await grant('u1', profileId);
      const validUntil = '2030-01-01T00:00:00.000Z';
      await setValidUntil(rewardId, validUntil);

      expect((await expireRewards(new Date('2029-12-31T23:59:59.999Z'))).total_expired).toBe(0);
      expect((await expireRewards(new Date(validUntil))).total_expired).toBe(0);
      const result = await expireRewards(new Date('2030-01-01T00:00:00.001Z'));
      expect(result).toMatchObject({ granted_expired: 1, entered_expired: 0, evaluated_at: '2030-01-01T00:00:00.001Z' });
      expect((await userRewardRepository.findById(rewardId))?.status).toBe('EXPIRED');
    });

    it('expires an ENTERED ride once its end time has passed, but not while it is live (no grace)', async () => {
      const profileId = await createProfile();
      const rewardId = await grant('u1', profileId);
      await optIn(rewardId, 'u1', 'live-bet');
      const { startMs, endMs } = await rideOf(rewardId);

      expect((await expireRewards(new Date(startMs), 0)).total_expired).toBe(0);
      expect((await userRewardRepository.findById(rewardId))?.status).toBe('ENTERED');

      const result = await expireRewards(new Date(endMs + 1_000), 0);
      expect(result).toMatchObject({ granted_expired: 0, entered_expired: 1, total_expired: 1 });
      expect((await userRewardRepository.findById(rewardId))?.status).toBe('EXPIRED');
      const audit = await expireAudit(rewardId);
      expect(audit).toHaveLength(1);
      expect(JSON.parse(audit[0].payload)).toMatchObject({
        reason: 'RIDE_OVER_WITHOUT_LOCK', previousStatus: 'ENTERED', betId: 'live-bet', rideExpiryGraceSeconds: 0,
      });

      expect((await expireRewards(new Date(endMs + 2_000), 0)).total_expired).toBe(0);
      expect(await expireAudit(rewardId)).toHaveLength(1);
    });

    it('expires an ENTERED ride after its crash even though the ride has not ended', async () => {
      const profileId = await createProfile();
      const rewardId = await grant('u1', profileId);
      // A seed that crashes at least 1 s before its end, so the test does not depend on a random seed.
      await useSeed(rewardId, CRASH_SEED);
      await optIn(rewardId, 'u1', 'crash-bet');
      const { startMs, endMs, crashMs } = await rideOf(rewardId);
      expect(crashMs).not.toBeNull();

      expect((await expireRewards(new Date(startMs + (crashMs! - startMs) * 0.8), 0)).total_expired).toBe(0);
      const result = await expireRewards(new Date(crashMs! + (endMs - crashMs!) / 2), 0);
      expect(result.entered_expired).toBe(1);
      expect((await userRewardRepository.findById(rewardId))?.status).toBe('EXPIRED');
    });

    it('waits RIDE_EXPIRY_GRACE_SECONDS (default 900) after the ride ended before expiring it', async () => {
      const profileId = await createProfile();
      const rewardId = await grant('u1', profileId);
      await useSeed(rewardId, END_SEED); // no crash: the ride ends at end_time
      await optIn(rewardId, 'u1', 'grace-bet');
      const { endMs, crashMs } = await rideOf(rewardId);
      expect(crashMs).toBeNull();

      // Default grace from config (900 s).
      expect((await expireRewards(new Date(endMs + 1_000))).total_expired).toBe(0);
      expect((await expireRewards(new Date(endMs + 899_999))).total_expired).toBe(0);
      expect((await userRewardRepository.findById(rewardId))?.status).toBe('ENTERED');
      const result = await expireRewards(new Date(endMs + 900_000));
      expect(result.entered_expired).toBe(1);
      expect(JSON.parse((await expireAudit(rewardId))[0].payload)).toMatchObject({ rideExpiryGraceSeconds: 900 });
    });

    it('measures the grace from the crash, not from the end time', async () => {
      const profileId = await createProfile();
      const rewardId = await grant('u1', profileId);
      await useSeed(rewardId, CRASH_SEED);
      await optIn(rewardId, 'u1', 'grace-crash-bet');
      const { crashMs, endMs } = await rideOf(rewardId);
      expect(endMs - crashMs!).toBeGreaterThan(1_000);

      expect((await expireRewards(new Date(crashMs! + 59_000), 60)).total_expired).toBe(0);
      expect((await expireRewards(new Date(crashMs! + 61_000), 60)).entered_expired).toBe(1);
    });

    it('never touches USED rewards or their locks', async () => {
      const profileId = await createProfile();
      const rewardId = await grant('u1', profileId);
      await optIn(rewardId, 'u1', 'locked-bet');
      const lock = await request(app).post('/api/boost/lock').set('X-API-Key', API_KEY)
        .send({ user_id: 'u1', reward_id: rewardId, bet_id: 'locked-bet' });
      expect(lock.status).toBe(201);
      const { endMs } = await rideOf(rewardId);

      const result = await expireRewards(new Date(endMs + 3_600_000));
      expect(result.total_expired).toBe(0);
      expect((await userRewardRepository.findById(rewardId))?.status).toBe('USED');
      expect(await db('bet_boost_locks')).toHaveLength(1);
    });

    it('expires every candidate exactly once when two runs race', async () => {
      const profileId = await createProfile();
      const ids: string[] = [];
      for (let i = 0; i < 6; i += 1) {
        const id = await grant(`race-${i}`, profileId);
        await setValidUntil(id, past());
        ids.push(id);
      }

      const results = await Promise.all([expireRewards(), expireRewards(), expireRewards()]);
      expect(results.reduce((sum, r) => sum + r.total_expired, 0)).toBe(6);
      expect(await db('audit_logs').where({ action: 'EXPIRE' })).toHaveLength(6);
      for (const id of ids) {
        expect(await expireAudit(id)).toHaveLength(1);
      }
    });

    it('handles more candidates than one batch', async () => {
      const profileId = await createProfile();
      const now = new Date();
      const rows = Array.from({ length: 520 }, (_, i) => ({
        id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
        brand_id: 'brand-a',
        user_id: `bulk-${i}`,
        profile_version_id: profileId,
        status: 'GRANTED',
        start_time: now.toISOString(),
        end_time: now.toISOString(),
        seed: 'seed',
        valid_until: past(),
        created_at: now.toISOString(),
        updated_at: now.toISOString(),
      }));
      for (let i = 0; i < rows.length; i += 100) {
        await db('user_rewards').insert(rows.slice(i, i + 100));
      }

      const result = await expireRewards();
      expect(result.granted_expired).toBe(520);
      expect(await db('user_rewards').where({ status: 'GRANTED' })).toHaveLength(0);
    });
  });

  describe('expiry never hides a ride outcome (quote and lock)', () => {
    afterEach(() => {
      jest.restoreAllMocks();
    });

    function quote(rewardId: string, betId: string) {
      return request(app).post('/api/boost/quote').set('X-API-Key', API_KEY)
        .send({ user_id: 'u1', reward_id: rewardId, bet_id: betId });
    }

    function lock(rewardId: string, betId: string) {
      return request(app).post('/api/boost/lock').set('X-API-Key', API_KEY)
        .send({ user_id: 'u1', reward_id: rewardId, bet_id: betId });
    }

    async function enteredReward(betId: string, seed: string) {
      const profileId = await createProfile();
      const rewardId = await grant('u1', profileId);
      await useSeed(rewardId, seed);
      await optIn(rewardId, 'u1', betId);
      return { rewardId, ...(await rideOf(rewardId)) };
    }

    it.each([
      ['RIDE_CRASHED', CRASH_SEED, (ride: { crashMs: number | null; endMs: number }) => ride.crashMs! + (ride.endMs - ride.crashMs!) / 2],
      ['RIDE_ENDED', END_SEED, (ride: { endMs: number }) => ride.endMs + 1_000],
    ])('reports %s unchanged after the job expired the reward', async (code, seed, evaluateAt) => {
      const ride = await enteredReward(`terminal-${code}`, seed);
      const at = evaluateAt(ride as never);
      jest.spyOn(Date, 'now').mockReturnValue(at);

      const quoteBefore = await quote(ride.rewardId, `terminal-${code}`);
      const lockBefore = await lock(ride.rewardId, `terminal-${code}`);
      expect(quoteBefore.body.reason_code).toBe(code);
      expect(quoteBefore.body.ride_path.length).toBeGreaterThan(0);
      expect(lockBefore.status).toBe(422);
      expect(lockBefore.body.code).toBe(code);
      expect(lockBefore.body.details.ride_path.length).toBeGreaterThan(0);

      expect((await expireRewards(new Date(at), 0)).entered_expired).toBe(1);
      expect((await userRewardRepository.findById(ride.rewardId))?.status).toBe('EXPIRED');

      const quoteAfter = await quote(ride.rewardId, `terminal-${code}`);
      const lockAfter = await lock(ride.rewardId, `terminal-${code}`);
      expect(quoteAfter.status).toBe(200);
      expect(quoteAfter.body).toEqual(quoteBefore.body);
      expect(lockAfter.status).toBe(422);
      expect(lockAfter.body).toEqual(lockBefore.body);
      expect(await db('bet_boost_locks')).toHaveLength(0);
      expect((await userRewardRepository.findById(ride.rewardId))?.status).toBe('EXPIRED');
    });

    it('reports REWARD_EXPIRED for a reward that never entered a ride', async () => {
      const profileId = await createProfile();
      const rewardId = await grant('u1', profileId);
      await setValidUntil(rewardId, past());
      expect((await expireRewards()).granted_expired).toBe(1);

      const quoted = await quote(rewardId, 'never-entered');
      expect(quoted.body).toMatchObject({ eligible: false, reason_code: 'REWARD_EXPIRED' });
      const locked = await lock(rewardId, 'never-entered');
      expect(locked.status).toBe(422);
      expect(locked.body.code).toBe('REWARD_EXPIRED');
    });

    it('reports REWARD_EXPIRED for another bet or while the expired ride is not over, and never locks', async () => {
      const ride = await enteredReward('expired-live-bet', CRASH_SEED);
      await db('user_rewards').where({ id: ride.rewardId }).update({ status: 'EXPIRED' });
      jest.spyOn(Date, 'now').mockReturnValue(ride.startMs + (ride.crashMs! - ride.startMs) * 0.4);

      expect((await quote(ride.rewardId, 'other-bet')).body.reason_code).toBe('REWARD_EXPIRED');
      expect((await lock(ride.rewardId, 'other-bet')).body.code).toBe('REWARD_EXPIRED');
      expect((await quote(ride.rewardId, 'expired-live-bet')).body.reason_code).toBe('REWARD_EXPIRED');
      const locked = await lock(ride.rewardId, 'expired-live-bet');
      expect(locked.status).toBe(422);
      expect(locked.body.code).toBe('REWARD_EXPIRED');
      expect(await db('bet_boost_locks')).toHaveLength(0);
      expect((await userRewardRepository.findById(ride.rewardId))?.status).toBe('EXPIRED');
    });

    it('reports REWARD_EXPIRED when an expired ride has no usable saved math', async () => {
      const ride = await enteredReward('expired-bad-math-bet', CRASH_SEED);
      const row = await db('user_rewards').where({ id: ride.rewardId }).first();
      const snapshot = JSON.parse(row.ticket_snapshot);
      snapshot.rideMath = { version: 3, broken: true };
      await db('user_rewards').where({ id: ride.rewardId })
        .update({ status: 'EXPIRED', ticket_snapshot: JSON.stringify(snapshot) });

      expect((await quote(ride.rewardId, 'expired-bad-math-bet')).body.reason_code).toBe('REWARD_EXPIRED');
      expect((await lock(ride.rewardId, 'expired-bad-math-bet')).body.code).toBe('REWARD_EXPIRED');
    });
  });
});
