import request from 'supertest';
import { app } from '../../src/index';
import db from '../../src/db/connection';
import { ReasonCode } from '../../src/types/reasonCodes';
import { auditLogRepository } from '../../src/db/repositories/auditLogRepository';
import { createIsolatedKnex, isPg } from '../helpers/testDb';

/** Slice API-2: operator segment labels on profiles and rewards, and the all-or-nothing bulk grant. */
const API_KEY = 'test-api-key';

/** SQLite returns json columns as text, Postgres as parsed objects. */
function readPayload(payload: unknown): Record<string, unknown> {
  return (typeof payload === 'string' ? JSON.parse(payload) : payload) as Record<string, unknown>;
}

function profileBody(brandId: string, extra: Record<string, unknown> = {}) {
  return {
    name: `Segment profile ${brandId}`,
    min_selections: 3,
    min_combined_odds: 3.0,
    min_selection_odds: 1.2,
    min_boost_pct: 0.05,
    max_boost_pct: 0.5,
    ride_duration_seconds: 15,
    brand_id: brandId,
    max_bonus_minor: { EUR: 50_000 },
    reward_validity_seconds: 86_400,
    ...extra,
  };
}

function createProfile(brandId: string, extra: Record<string, unknown> = {}) {
  return request(app).post('/api/profiles').set('X-API-Key', API_KEY).send(profileBody(brandId, extra));
}

function grant(body: Record<string, unknown>) {
  return request(app).post('/api/rewards').set('X-API-Key', API_KEY).send(body);
}

function bulk(body: Record<string, unknown>) {
  return request(app).post('/api/rewards/bulk').set('X-API-Key', API_KEY).send(body);
}

async function counts() {
  const rewards = (await db('user_rewards').count('* as c').first())!.c;
  const grants = (await db('audit_logs').where({ entity_type: 'user_reward', action: 'GRANT' }).count('* as c').first())!.c;
  return { rewards: Number(rewards), grants: Number(grants) };
}

describe('Segment labels and bulk grant', () => {
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

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('profile segment', () => {
    it('round-trips on create, read, list and update, and is null when absent', async () => {
      const none = await createProfile('seg-a');
      expect(none.status).toBe(201);
      expect(none.body.segment).toBeNull();

      const created = await createProfile('seg-a', { segment: '  VIP:tier-1  ' });
      expect(created.status).toBe(201);
      expect(created.body.segment).toBe('VIP:tier-1'); // trimmed

      const read = await request(app).get(`/api/profiles/${created.body.id}`).set('X-API-Key', API_KEY);
      expect(read.body.segment).toBe('VIP:tier-1');

      const updated = await request(app).put(`/api/profiles/${created.body.id}`).set('X-API-Key', API_KEY)
        .send({ segment: 'New players' });
      expect(updated.status).toBe(200);
      expect(updated.body.segment).toBe('New players');

      // An update without segment leaves it; null clears it.
      const renamed = await request(app).put(`/api/profiles/${created.body.id}`).set('X-API-Key', API_KEY)
        .send({ name: 'Renamed' });
      expect(renamed.body.segment).toBe('New players');
      const cleared = await request(app).put(`/api/profiles/${created.body.id}`).set('X-API-Key', API_KEY)
        .send({ segment: null });
      expect(cleared.body.segment).toBeNull();
    });

    it('rejects invalid segment values', async () => {
      for (const bad of ['', '   ', 'x'.repeat(65), 'bad/char', 'emoji🙂', 5]) {
        const res = await createProfile('seg-a', { segment: bad });
        expect(res.status).toBe(400);
        expect(res.body.code).toBe(ReasonCode.VALIDATION_ERROR);
      }
      const ok = await createProfile('seg-a', { segment: 'x'.repeat(64) });
      expect(ok.status).toBe(201);
      const nullSeg = await createProfile('seg-a', { segment: null });
      expect(nullSeg.status).toBe(201);
      expect(nullSeg.body.segment).toBeNull();
    });

    it('filters GET /api/profiles by segment together with brand and active filters', async () => {
      const vipA = await createProfile('seg-a', { segment: 'VIP' });
      const newA = await createProfile('seg-a', { segment: 'NEW' });
      const vipB = await createProfile('seg-b', { segment: 'VIP' });
      const plainA = await createProfile('seg-a');
      await request(app).put(`/api/profiles/${vipA.body.id}`).set('X-API-Key', API_KEY).send({ is_active: false });

      const ids = (res: request.Response) => (res.body.profiles as Array<{ id: string }>).map((p) => p.id).sort();
      const list = (query: string) => request(app).get(`/api/profiles?${query}`).set('X-API-Key', API_KEY);

      expect(ids(await list('segment=VIP'))).toEqual([vipA.body.id, vipB.body.id].sort());
      expect(ids(await list('segment=VIP&brand_id=seg-a'))).toEqual([vipA.body.id]);
      expect(ids(await list('segment=VIP&brand_id=seg-a&active=true'))).toEqual([]);
      expect(ids(await list('segment=VIP&active=true'))).toEqual([vipB.body.id]);
      expect(ids(await list('segment=NEW'))).toEqual([newA.body.id]);
      expect(ids(await list('segment=NONE'))).toEqual([]);
      expect(ids(await list('brand_id=seg-a'))).toEqual([vipA.body.id, newA.body.id, plainA.body.id].sort());
      expect((await list('segment=bad/char')).status).toBe(400);
    });
  });

  describe('single grant segment', () => {
    it('defaults to the profile version segment and an explicit segment overrides it', async () => {
      const profile = await createProfile('seg-a', { segment: 'VIP' });
      const plain = await createProfile('seg-a');

      const inherited = await grant({ user_id: 'u1', profile_version_id: profile.body.id });
      expect(inherited.status).toBe(201);
      expect(inherited.body.segment).toBe('VIP');

      const overridden = await grant({ user_id: 'u1', profile_version_id: profile.body.id, segment: 'Promo.Q4' });
      expect(overridden.body.segment).toBe('Promo.Q4');

      const cleared = await grant({ user_id: 'u1', profile_version_id: profile.body.id, segment: null });
      expect(cleared.body.segment).toBeNull();

      const unlabeled = await grant({ user_id: 'u1', profile_version_id: plain.body.id });
      expect(unlabeled.body.segment).toBeNull();

      // Later profile edits never rewrite existing rewards.
      await request(app).put(`/api/profiles/${profile.body.id}`).set('X-API-Key', API_KEY).send({ segment: 'Other' });
      const reread = await request(app).get(`/api/rewards/${inherited.body.id}`).set('X-API-Key', API_KEY);
      expect(reread.body.segment).toBe('VIP');

      const audit = await db('audit_logs').where({ entity_id: overridden.body.id, action: 'GRANT' }).first();
      expect(readPayload(audit.payload).segment).toBe('Promo.Q4');

      expect((await grant({ user_id: 'u1', profile_version_id: profile.body.id, segment: 'a/b' })).status).toBe(400);
    });

    it('filters GET /api/rewards/user/:userId by segment', async () => {
      const vip = await createProfile('seg-a', { segment: 'VIP' });
      const plain = await createProfile('seg-a');
      const r1 = await grant({ user_id: 'u1', profile_version_id: vip.body.id });
      const r2 = await grant({ user_id: 'u1', profile_version_id: plain.body.id });
      await grant({ user_id: 'u1', profile_version_id: plain.body.id, segment: 'VIP' });

      const list = (query: string) =>
        request(app).get(`/api/rewards/user/u1?brand_id=seg-a${query}`).set('X-API-Key', API_KEY);

      expect((await list('')).body.count).toBe(3);
      const vipOnly = await list('&segment=VIP');
      expect(vipOnly.body.count).toBe(2);
      expect(vipOnly.body.rewards.map((r: { id: string }) => r.id)).toContain(r1.body.id);
      expect(vipOnly.body.rewards.map((r: { id: string }) => r.id)).not.toContain(r2.body.id);
      expect((await list('&segment=OTHER')).body.count).toBe(0);
      expect((await list('&segment=a/b')).status).toBe(400);
    });
  });

  describe('POST /api/rewards/bulk', () => {
    it('grants one profile version to many players in input order with an audit row each', async () => {
      const profile = await createProfile('seg-a', { segment: 'VIP' });
      const userIds = ['bulk-3', 'bulk-1', 'bulk-2', 'bulk-4'];

      const res = await bulk({ profile_version_id: profile.body.id, user_ids: userIds });
      expect(res.status).toBe(201);
      expect(res.body.profile_version_id).toBe(profile.body.id);
      expect(res.body.segment).toBe('VIP');
      expect(res.body.count).toBe(4);
      expect(res.body.rewards.map((r: { user_id: string }) => r.user_id)).toEqual(userIds);
      for (const reward of res.body.rewards) {
        expect(reward).toMatchObject({
          brand_id: 'seg-a', status: 'GRANTED', segment: 'VIP', profile_version_id: profile.body.id,
        });
        expect(reward.end_time).toBeNull();
        expect(reward.seed).toBeUndefined();
        expect(new Date(reward.valid_until).getTime()).toBeGreaterThan(Date.now());
      }
      expect(new Set(res.body.rewards.map((r: { id: string }) => r.id)).size).toBe(4);
      expect(await counts()).toEqual({ rewards: 4, grants: 4 });

      for (const reward of res.body.rewards) {
        const audit = await db('audit_logs').where({ entity_id: reward.id, action: 'GRANT' });
        expect(audit).toHaveLength(1);
        expect(readPayload(audit[0].payload)).toMatchObject({ brandId: 'seg-a', segment: 'VIP', userId: reward.user_id });
      }

      // The grants are readable per player.
      const mine = await request(app).get('/api/rewards/user/bulk-2?brand_id=seg-a').set('X-API-Key', API_KEY);
      expect(mine.body.count).toBe(1);
      expect(mine.body.rewards[0].segment).toBe('VIP');
    });

    it('uses the body segment when given: override, or null for none', async () => {
      const profile = await createProfile('seg-a', { segment: 'VIP' });
      const override = await bulk({ profile_version_id: profile.body.id, user_ids: ['a'], segment: 'Campaign 1' });
      expect(override.status).toBe(201);
      expect(override.body.segment).toBe('Campaign 1');
      expect(override.body.rewards[0].segment).toBe('Campaign 1');

      const none = await bulk({ profile_version_id: profile.body.id, user_ids: ['b'], segment: null });
      expect(none.body.segment).toBeNull();
      expect(none.body.rewards[0].segment).toBeNull();

      const plain = await createProfile('seg-a');
      const inherited = await bulk({ profile_version_id: plain.body.id, user_ids: ['c'] });
      expect(inherited.body.segment).toBeNull();
    });

    it('rolls back every reward and audit row when a later player fails mid-batch', async () => {
      const profile = await createProfile('seg-a', { segment: 'VIP' });
      const before = await counts();

      const realAppend = auditLogRepository.append;
      let calls = 0;
      jest.spyOn(auditLogRepository, 'append').mockImplementation(async (entry, tx) => {
        calls += 1;
        if (calls === 3) throw new Error('simulated failure for the third player');
        return realAppend(entry, tx);
      });

      const res = await bulk({ profile_version_id: profile.body.id, user_ids: ['m1', 'm2', 'm3', 'm4'] });
      expect(res.status).toBe(500);
      expect(res.body.code).toBe(ReasonCode.INTERNAL_ERROR);
      expect(calls).toBe(3);
      expect(await counts()).toEqual(before);

      jest.restoreAllMocks();
      // The same batch succeeds afterwards: nothing was left half-written.
      const retry = await bulk({ profile_version_id: profile.body.id, user_ids: ['m1', 'm2', 'm3', 'm4'] });
      expect(retry.status).toBe(201);
      expect(await counts()).toEqual({ rewards: 4, grants: 4 });
    });

    it('enforces the size limits and uniqueness without writing anything', async () => {
      const profile = await createProfile('seg-a');
      const profileId = profile.body.id as string;
      const before = await counts();
      const ids = (n: number) => Array.from({ length: n }, (_, i) => `limit-${i}`);

      for (const body of [
        { profile_version_id: profileId, user_ids: [] },
        { profile_version_id: profileId, user_ids: ids(501) },
        { profile_version_id: profileId, user_ids: ['dup', 'x', 'dup'] },
        { profile_version_id: profileId, user_ids: ['ok', ''] },
        { profile_version_id: profileId, user_ids: ['ok', 7] },
        { profile_version_id: profileId, user_ids: 'u1' },
        { profile_version_id: profileId },
        { profile_version_id: 'not-a-uuid', user_ids: ['u1'] },
        { profile_version_id: profileId, user_ids: ['u1'], segment: 'a/b' },
        { profile_version_id: profileId, user_ids: ['u1'], duration_seconds: 0 },
      ]) {
        const res = await bulk(body);
        expect(res.status).toBe(400);
        expect(res.body.code).toBe(ReasonCode.VALIDATION_ERROR);
      }
      expect(await counts()).toEqual(before);

      const maxBatch = await bulk({ profile_version_id: profileId, user_ids: ids(500) });
      expect(maxBatch.status).toBe(201);
      expect(maxBatch.body.count).toBe(500);
      expect(await counts()).toEqual({ rewards: 500, grants: 500 });
    });

    it('returns the existing profile error codes for unknown and inactive profiles and writes nothing', async () => {
      const profile = await createProfile('seg-a');
      await request(app).put(`/api/profiles/${profile.body.id}`).set('X-API-Key', API_KEY).send({ is_active: false });

      const inactive = await bulk({ profile_version_id: profile.body.id, user_ids: ['u1', 'u2'] });
      expect(inactive.status).toBe(422);
      expect(inactive.body.code).toBe(ReasonCode.PROFILE_INACTIVE);
      const single = await grant({ user_id: 'u1', profile_version_id: profile.body.id });
      expect(single.status).toBe(inactive.status);
      expect(single.body.code).toBe(inactive.body.code);

      const unknown = await bulk({
        profile_version_id: '99999999-9999-4999-8999-999999999999', user_ids: ['u1'],
      });
      expect(unknown.status).toBe(404);
      expect(unknown.body.code).toBe(ReasonCode.PROFILE_NOT_FOUND);

      expect(await counts()).toEqual({ rewards: 0, grants: 0 });
    });

    it('scopes rewards to the profile brand and requires authentication', async () => {
      const a = await createProfile('seg-a', { segment: 'VIP' });
      const b = await createProfile('seg-b', { segment: 'VIP' });
      await bulk({ profile_version_id: a.body.id, user_ids: ['shared-user', 'only-a'] });
      await bulk({ profile_version_id: b.body.id, user_ids: ['shared-user'] });

      const inA = await request(app).get('/api/rewards/user/shared-user?brand_id=seg-a').set('X-API-Key', API_KEY);
      const inB = await request(app).get('/api/rewards/user/shared-user?brand_id=seg-b').set('X-API-Key', API_KEY);
      expect(inA.body.count).toBe(1);
      expect(inA.body.rewards[0]).toMatchObject({ brand_id: 'seg-a', profile_version_id: a.body.id });
      expect(inB.body.count).toBe(1);
      expect(inB.body.rewards[0]).toMatchObject({ brand_id: 'seg-b', profile_version_id: b.body.id });
      const onlyInA = await request(app).get('/api/rewards/user/only-a?brand_id=seg-b').set('X-API-Key', API_KEY);
      expect(onlyInA.body.count).toBe(0);

      const anonymous = await request(app).post('/api/rewards/bulk')
        .send({ profile_version_id: a.body.id, user_ids: ['x'] });
      expect(anonymous.status).toBe(401);
    });
  });

  describe('migration 018', () => {
    it('adds nullable segment columns and the profile index, keeps existing rows null, and rolls back cleanly', async () => {
      const { knex, cleanup } = await createIsolatedKnex();
      const indexNames = async (): Promise<string[]> => {
        if (isPg) {
          const result = await knex.raw(
            "SELECT indexname AS name FROM pg_indexes WHERE schemaname = current_schema() AND tablename = 'reward_profile_versions'"
          ) as { rows: Array<{ name: string }> };
          return result.rows.map((row) => row.name);
        }
        const rows = await knex.raw("PRAGMA index_list('reward_profile_versions')") as Array<{ name: string }>;
        return rows.map((row) => row.name);
      };
      try {
        for (let i = 0; i < 17; i += 1) await knex.migrate.up();
        expect(await knex.schema.hasColumn('reward_profile_versions', 'segment')).toBe(false);
        expect(await knex.schema.hasColumn('user_rewards', 'segment')).toBe(false);

        const now = new Date().toISOString();
        const profileId = '11111111-1111-4111-8111-111111111111';
        await knex('reward_profile_versions').insert({
          id: profileId, name: 'Before 018', min_selections: 3, min_combined_odds: 3, min_selection_odds: 1.2,
          min_boost_pct: 0.05, max_boost_pct: 0.5, ride_duration_seconds: 60, checkpoint_count: 12,
          volatility: 0.5, is_active: true, created_at: now, updated_at: now,
        });
        await knex('user_rewards').insert({
          id: '22222222-2222-4222-8222-222222222222', user_id: 'legacy', profile_version_id: profileId,
          status: 'GRANTED', start_time: now, end_time: now, seed: 's', created_at: now, updated_at: now,
        });

        const [, applied] = await knex.migrate.up();
        expect(applied).toEqual(['018_segments.ts']);
        expect(await knex.schema.hasColumn('reward_profile_versions', 'segment')).toBe(true);
        expect(await knex.schema.hasColumn('user_rewards', 'segment')).toBe(true);
        expect(await indexNames()).toContain('reward_profile_versions_brand_id_segment_index');
        expect((await knex('reward_profile_versions').first()).segment).toBeNull();
        expect((await knex('user_rewards').first()).segment).toBeNull();

        await knex('reward_profile_versions').update({ segment: 'VIP' });
        await knex('user_rewards').update({ segment: 'VIP' });

        await knex.migrate.down();
        expect(await knex.schema.hasColumn('reward_profile_versions', 'segment')).toBe(false);
        expect(await knex.schema.hasColumn('user_rewards', 'segment')).toBe(false);
        expect(await indexNames()).not.toContain('reward_profile_versions_brand_id_segment_index');
        expect(await knex('reward_profile_versions')).toHaveLength(1);
        expect(await knex('user_rewards')).toHaveLength(1);

        const [, again] = await knex.migrate.latest();
        expect(again).toEqual(['018_segments.ts']);
      } finally {
        await cleanup();
      }
    });
  });
});
