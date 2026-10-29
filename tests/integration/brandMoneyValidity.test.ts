import request from 'supertest';
import { app } from '../../src/index';
import db from '../../src/db/connection';
import { userRewardRepository } from '../../src/db/repositories/userRewardRepository';
import { isUniqueViolation } from '../../src/db/repositories/transaction';
import { ReasonCode } from '../../src/types/reasonCodes';

const API_KEY = 'test-api-key';
const SELECTIONS = [
  { id: 's1', odds: 1.5 },
  { id: 's2', odds: 2.0 },
  { id: 's3', odds: 1.8 },
  { id: 's4', odds: 2.5 },
];

function auth(req: request.Test): request.Test {
  return req.set('X-API-Key', API_KEY);
}

function profileBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    brand_id: 'brand-a',
    name: 'Brand Test Profile',
    min_selections: 3,
    min_combined_odds: 3.0,
    min_selection_odds: 1.2,
    min_boost_pct: 0.05,
    max_boost_pct: 0.5,
    ride_duration_seconds: 3600,
    max_bonus_minor: { EUR: 50_000, USD: 60_000 },
    reward_validity_seconds: 86_400,
    ...overrides,
  };
}

async function createProfile(overrides: Record<string, unknown> = {}): Promise<string> {
  const res = await auth(request(app).post('/api/profiles')).send(profileBody(overrides));
  expect(res.status).toBe(201);
  return res.body.id as string;
}

async function grant(userId: string, profileId: string): Promise<string> {
  const res = await auth(request(app).post('/api/rewards')).send({ user_id: userId, profile_version_id: profileId });
  expect(res.status).toBe(201);
  return res.body.id as string;
}

function optIn(rewardId: string, userId: string, betId: string, extra: Record<string, unknown> = {}) {
  return auth(request(app).post(`/api/rewards/${rewardId}/opt-in`)).send({
    user_id: userId,
    bet_id: betId,
    stake_minor: 1000,
    currency: 'EUR',
    ticket: { selections: SELECTIONS },
    ...extra,
  });
}

describe('Phase 1a: brands, money, bonus caps and validity', () => {
  beforeAll(async () => {
    await db.migrate.latest();
  });

  afterAll(async () => {
    await db.destroy();
  });

  beforeEach(async () => {
    jest.restoreAllMocks();
    await db('bet_settlements').del();
    await db('bet_boost_locks').del();
    await db('ride_definitions').del();
    await db('user_rewards').del();
    await db('reward_profile_versions').del();
    await db('audit_logs').del();
  });

  describe('profiles', () => {
    it('stores brand, caps and validity and returns them', async () => {
      const res = await auth(request(app).post('/api/profiles')).send(profileBody());
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({
        brand_id: 'brand-a',
        max_bonus_minor: { EUR: 50_000, USD: 60_000 },
        reward_validity_seconds: 86_400,
      });
      const fetched = await auth(request(app).get(`/api/profiles/${res.body.id}`));
      expect(fetched.body).toMatchObject({ brand_id: 'brand-a', max_bonus_minor: { EUR: 50_000, USD: 60_000 } });
    });

    it.each([
      ['missing brand_id', { brand_id: undefined }],
      ['brand_id with a space', { brand_id: 'brand a' }],
      ['brand_id over 64 characters', { brand_id: 'b'.repeat(65) }],
      ['missing max_bonus_minor', { max_bonus_minor: undefined }],
      ['empty max_bonus_minor', { max_bonus_minor: {} }],
      ['zero cap', { max_bonus_minor: { EUR: 0 } }],
      ['fractional cap', { max_bonus_minor: { EUR: 10.5 } }],
      ['lowercase currency key', { max_bonus_minor: { eur: 100 } }],
      ['missing reward_validity_seconds', { reward_validity_seconds: undefined }],
      ['validity under 60 seconds', { reward_validity_seconds: 59 }],
      ['validity over one year', { reward_validity_seconds: 31_536_001 }],
    ])('rejects %s with 400', async (_label, overrides) => {
      const res = await auth(request(app).post('/api/profiles')).send(profileBody(overrides));
      expect(res.status).toBe(400);
      expect(res.body.code).toBe(ReasonCode.VALIDATION_ERROR);
    });

    it.each([60, 31_536_000])('accepts the validity bound %p', async (seconds) => {
      const res = await auth(request(app).post('/api/profiles')).send(profileBody({ reward_validity_seconds: seconds }));
      expect(res.status).toBe(201);
    });

    it('never changes a profile brand but can update caps and validity', async () => {
      const profileId = await createProfile();
      const brandChange = await auth(request(app).put(`/api/profiles/${profileId}`)).send({ brand_id: 'brand-b' });
      expect(brandChange.status).toBe(400);
      expect(brandChange.body.code).toBe(ReasonCode.VALIDATION_ERROR);

      const updated = await auth(request(app).put(`/api/profiles/${profileId}`))
        .send({ max_bonus_minor: { GBP: 1234 }, reward_validity_seconds: 120 });
      expect(updated.status).toBe(200);
      expect(updated.body).toMatchObject({
        brand_id: 'brand-a', max_bonus_minor: { GBP: 1234 }, reward_validity_seconds: 120,
      });
    });

    it('filters the admin list by brand', async () => {
      await createProfile({ brand_id: 'brand-a', name: 'A' });
      await createProfile({ brand_id: 'brand-b', name: 'B' });
      const all = await auth(request(app).get('/api/profiles'));
      expect(all.body.count).toBe(2);
      const onlyB = await auth(request(app).get('/api/profiles?brand_id=brand-b'));
      expect(onlyB.body.profiles.map((p: { name: string }) => p.name)).toEqual(['B']);
      const bad = await auth(request(app).get('/api/profiles?brand_id=not%20ok'));
      expect(bad.status).toBe(400);
    });
  });

  describe('brand scoping', () => {
    it('grants inherit the profile brand and a validity deadline', async () => {
      const profileId = await createProfile({ reward_validity_seconds: 3600 });
      const before = Date.now();
      const res = await auth(request(app).post('/api/rewards')).send({ user_id: 'u1', profile_version_id: profileId });
      expect(res.status).toBe(201);
      expect(res.body.brand_id).toBe('brand-a');
      const validUntil = Date.parse(res.body.valid_until);
      expect(validUntil).toBeGreaterThanOrEqual(before + 3_600_000);
      expect(validUntil).toBeLessThanOrEqual(Date.now() + 3_600_000);
      const audit = await db('audit_logs').where({ entity_id: res.body.id, action: 'GRANT' }).first();
      expect(JSON.parse(audit.payload)).toMatchObject({ brandId: 'brand-a', validUntil: res.body.valid_until });
    });

    it('allows the same bet_id in two brands and returns 409 within one brand', async () => {
      const profileA = await createProfile({ brand_id: 'brand-a' });
      const profileB = await createProfile({ brand_id: 'brand-b' });
      const rewardA = await grant('user-1', profileA);
      const rewardB = await grant('user-1', profileB);
      const rewardA2 = await grant('user-2', profileA);

      expect((await optIn(rewardA, 'user-1', 'shared-bet')).status).toBe(200);
      expect((await optIn(rewardB, 'user-1', 'shared-bet')).status).toBe(200);

      const clash = await optIn(rewardA2, 'user-2', 'shared-bet');
      expect(clash.status).toBe(409);
      expect(clash.body.code).toBe(ReasonCode.BET_ALREADY_BOUND);
      // The failed attempt left the reward usable.
      expect((await userRewardRepository.findById(rewardA2))?.status).toBe('GRANTED');
      expect((await optIn(rewardA2, 'user-2', 'another-bet')).status).toBe(200);
    });

    it('maps a database unique violation on (brand_id, bet_id) to 409, never 500', async () => {
      const profileId = await createProfile();
      const first = await grant('user-1', profileId);
      const second = await grant('user-2', profileId);
      expect((await optIn(first, 'user-1', 'raced-bet')).status).toBe(200);

      // A real driver error from the unique index (what a race past the application check produces).
      let driverError: unknown;
      try {
        await db('user_rewards').where({ id: second }).update({ bet_id: 'raced-bet' });
      } catch (error) {
        driverError = error;
      }
      expect(isUniqueViolation(driverError)).toBe(true);

      jest.spyOn(userRewardRepository, 'updateRideStart').mockRejectedValueOnce(driverError);
      const res = await optIn(second, 'user-2', 'raced-bet');
      expect(res.status).toBe(409);
      expect(res.body.code).toBe(ReasonCode.BET_ALREADY_BOUND);
      expect((await userRewardRepository.findById(second))?.status).toBe('GRANTED');
    });

    it('does not map an unrelated unique violation to BET_ALREADY_BOUND', async () => {
      const profileId = await createProfile();
      const rewardId = await grant('user-1', profileId);
      jest.spyOn(console, 'error').mockImplementation(() => {});
      jest.spyOn(userRewardRepository, 'updateRideStart').mockRejectedValueOnce(Object.assign(
        new Error('UNIQUE constraint failed: ride_definitions.reward_id, ride_definitions.checkpoint_index'),
        { code: 'SQLITE_CONSTRAINT' }
      ));
      const res = await optIn(rewardId, 'user-1', 'bet-x');
      expect(res.status).toBe(500);
    });

    it('requires brand_id on the user and lock reads and scopes them to that brand', async () => {
      const profileA = await createProfile({ brand_id: 'brand-a' });
      const profileB = await createProfile({ brand_id: 'brand-b' });
      const rewardA = await grant('same-user', profileA);
      await grant('same-user', profileB);
      await grant('same-user', profileB);

      for (const path of [
        '/api/rewards/user/same-user',
        '/api/rewards/user/same-user/active',
        '/api/boost/lock/some-bet',
      ]) {
        const missing = await auth(request(app).get(path));
        expect(missing.status).toBe(400);
        expect(missing.body.code).toBe(ReasonCode.VALIDATION_ERROR);
        const invalid = await auth(request(app).get(`${path}?brand_id=no%20good`));
        expect(invalid.status).toBe(400);
      }

      const listA = await auth(request(app).get('/api/rewards/user/same-user?brand_id=brand-a'));
      expect(listA.body.count).toBe(1);
      expect(listA.body.rewards[0]).toMatchObject({ id: rewardA, brand_id: 'brand-a' });
      const listB = await auth(request(app).get('/api/rewards/user/same-user?brand_id=brand-b'));
      expect(listB.body.count).toBe(2);
      const listNone = await auth(request(app).get('/api/rewards/user/same-user?brand_id=brand-z'));
      expect(listNone.body.count).toBe(0);
      const activeNone = await auth(request(app).get('/api/rewards/user/same-user/active?brand_id=brand-z'));
      expect(activeNone.body.active_reward).toBeNull();
      const activeA = await auth(request(app).get('/api/rewards/user/same-user/active?brand_id=brand-a'));
      expect(activeA.body.active_reward.id).toBe(rewardA);
    });

    it('returns locks only inside their brand, with the brand in the response', async () => {
      const profileId = await createProfile({ ride_duration_seconds: 3600 });
      const rewardId = await grant('lock-user', profileId);
      expect((await optIn(rewardId, 'lock-user', 'lock-bet')).status).toBe(200);
      const lock = await auth(request(app).post('/api/boost/lock'))
        .send({ user_id: 'lock-user', reward_id: rewardId, bet_id: 'lock-bet' });
      expect(lock.status).toBe(201);
      expect(lock.body.brand_id).toBe('brand-a');
      const inBrand = await auth(request(app).get('/api/boost/lock/lock-bet?brand_id=brand-a'));
      expect(inBrand.status).toBe(200);
      expect(inBrand.body.brand_id).toBe('brand-a');
      const otherBrand = await auth(request(app).get('/api/boost/lock/lock-bet?brand_id=brand-b'));
      expect(otherBrand.status).toBe(404);
      expect(otherBrand.body.code).toBe(ReasonCode.LOCK_NOT_FOUND);
    });
  });

  describe('money snapshot at opt-in', () => {
    it.each([
      ['missing stake_minor', { stake_minor: undefined }],
      ['zero stake', { stake_minor: 0 }],
      ['negative stake', { stake_minor: -100 }],
      ['fractional stake', { stake_minor: 10.5 }],
      ['stake over 1e12', { stake_minor: 1_000_000_000_001 }],
      ['string stake', { stake_minor: '1000' }],
      ['missing currency', { currency: undefined }],
      ['lowercase currency', { currency: 'eur' }],
      ['four-letter currency', { currency: 'EURO' }],
    ])('rejects %s with 400 and leaves the reward untouched', async (_label, extra) => {
      const profileId = await createProfile();
      const rewardId = await grant('user-1', profileId);
      const res = await optIn(rewardId, 'user-1', 'bet-1', extra);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe(ReasonCode.VALIDATION_ERROR);
      expect((await userRewardRepository.findById(rewardId))?.status).toBe('GRANTED');
    });

    it('accepts the largest stake and freezes stake, currency and cap on the reward', async () => {
      const profileId = await createProfile();
      const rewardId = await grant('user-1', profileId);
      const res = await optIn(rewardId, 'user-1', 'bet-1', { stake_minor: 1_000_000_000_000, currency: 'USD' });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        reward_id: rewardId, brand_id: 'brand-a', status: 'ENTERED',
        stake_minor: 1_000_000_000_000, currency: 'USD', bonus_cap_minor: 60_000,
      });
      const reward = await auth(request(app).get(`/api/rewards/${rewardId}`));
      expect(reward.body).toMatchObject({ stake_minor: 1_000_000_000_000, currency: 'USD', bonus_cap_minor: 60_000 });
      const row = await db('user_rewards').where({ id: rewardId }).first();
      expect(Number(row.stake_minor)).toBe(1_000_000_000_000);
      expect(row.currency).toBe('USD');
      expect(Number(row.bonus_cap_minor)).toBe(60_000);
      const audit = await db('audit_logs').where({ entity_id: rewardId, action: 'OPT_IN' }).first();
      expect(JSON.parse(audit.payload)).toMatchObject({
        brandId: 'brand-a', stakeMinor: 1_000_000_000_000, currency: 'USD', bonusCapMinor: 60_000,
      });
    });

    it('ignores the deprecated decimal ticket.stake', async () => {
      const profileId = await createProfile();
      const rewardId = await grant('user-1', profileId);
      const res = await auth(request(app).post(`/api/rewards/${rewardId}/opt-in`)).send({
        user_id: 'user-1', bet_id: 'bet-1', stake_minor: 2500, currency: 'EUR',
        ticket: { selections: SELECTIONS, stake: 99.99 },
      });
      expect(res.status).toBe(200);
      expect(res.body.stake_minor).toBe(2500);
    });

    it('returns 422 CURRENCY_NOT_SUPPORTED for a currency missing from the cap map', async () => {
      const profileId = await createProfile({ max_bonus_minor: { EUR: 50_000 } });
      const rewardId = await grant('user-1', profileId);
      const res = await optIn(rewardId, 'user-1', 'bet-1', { currency: 'GBP' });
      expect(res.status).toBe(422);
      expect(res.body.code).toBe(ReasonCode.CURRENCY_NOT_SUPPORTED);
      const reward = await userRewardRepository.findById(rewardId);
      expect(reward?.status).toBe('GRANTED');
      expect(reward?.betId).toBeNull();
      expect(await db('audit_logs').where({ action: 'OPT_IN' })).toHaveLength(0);
      // The same reward still opts in with a supported currency.
      expect((await optIn(rewardId, 'user-1', 'bet-1', { currency: 'EUR' })).status).toBe(200);
    });

    it('treats a legacy profile with no caps as supporting no currency until it is updated', async () => {
      const profileId = await createProfile();
      await db('reward_profile_versions').where({ id: profileId }).update({ max_bonus_minor: '{}' });
      const rewardId = await grant('user-1', profileId);
      expect((await optIn(rewardId, 'user-1', 'bet-1')).body.code).toBe(ReasonCode.CURRENCY_NOT_SUPPORTED);
      const update = await auth(request(app).put(`/api/profiles/${profileId}`)).send({ max_bonus_minor: { EUR: 700 } });
      expect(update.status).toBe(200);
      const res = await optIn(rewardId, 'user-1', 'bet-1');
      expect(res.status).toBe(200);
      expect(res.body.bonus_cap_minor).toBe(700);
    });

    it('keeps the snapshot of an in-flight bet when the profile caps change later', async () => {
      const profileId = await createProfile({ max_bonus_minor: { EUR: 50_000 } });
      const rewardId = await grant('user-1', profileId);
      const res = await optIn(rewardId, 'user-1', 'bet-1', { stake_minor: 4321 });
      expect(res.body.bonus_cap_minor).toBe(50_000);

      const update = await auth(request(app).put(`/api/profiles/${profileId}`))
        .send({ max_bonus_minor: { EUR: 1 }, reward_validity_seconds: 60 });
      expect(update.status).toBe(200);

      const reward = await auth(request(app).get(`/api/rewards/${rewardId}`));
      expect(reward.body).toMatchObject({ stake_minor: 4321, currency: 'EUR', bonus_cap_minor: 50_000 });
      // Only future opt-ins see the new cap.
      const next = await grant('user-2', profileId);
      expect((await optIn(next, 'user-2', 'bet-2')).body.bonus_cap_minor).toBe(1);
    });
  });

  describe('validity at opt-in', () => {
    it('expires a reward opted into after valid_until, with an audit row', async () => {
      const profileId = await createProfile();
      const rewardId = await grant('user-1', profileId);
      await db('user_rewards').where({ id: rewardId }).update({
        valid_until: new Date(Date.now() - 1_000).toISOString(),
      });

      const res = await optIn(rewardId, 'user-1', 'bet-1');
      expect(res.status).toBe(422);
      expect(res.body.code).toBe(ReasonCode.REWARD_EXPIRED);
      const reward = await userRewardRepository.findById(rewardId);
      expect(reward?.status).toBe('EXPIRED');
      expect(reward?.betId).toBeNull();

      const audit = await db('audit_logs').where({ entity_id: rewardId, action: 'EXPIRE' });
      expect(audit).toHaveLength(1);
      expect(JSON.parse(audit[0].payload)).toMatchObject({
        brandId: 'brand-a', reason: 'VALIDITY_ELAPSED', trigger: 'OPT_IN', previousStatus: 'GRANTED',
      });

      // Retrying stays 422 REWARD_EXPIRED and adds no second audit row.
      const again = await optIn(rewardId, 'user-1', 'bet-1');
      expect(again.status).toBe(422);
      expect(again.body.code).toBe(ReasonCode.REWARD_EXPIRED);
      expect(await db('audit_logs').where({ entity_id: rewardId, action: 'EXPIRE' })).toHaveLength(1);
    });

    it('opts in normally right before valid_until and for legacy rewards without validity', async () => {
      const profileId = await createProfile();
      const fresh = await grant('user-1', profileId);
      expect((await optIn(fresh, 'user-1', 'bet-fresh')).status).toBe(200);

      const legacy = await grant('user-2', profileId);
      await db('user_rewards').where({ id: legacy }).update({ valid_until: null });
      expect((await optIn(legacy, 'user-2', 'bet-legacy')).status).toBe(200);
    });

    it('reports an expired validity in the eligibility precheck without changing the reward', async () => {
      const profileId = await createProfile();
      const rewardId = await grant('user-1', profileId);
      await db('user_rewards').where({ id: rewardId }).update({
        valid_until: new Date(Date.now() - 1_000).toISOString(),
      });
      const res = await auth(request(app).post(`/api/rewards/${rewardId}/eligibility`))
        .send({ user_id: 'user-1', ticket: { selections: SELECTIONS } });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ eligible: false, reason_code: ReasonCode.REWARD_EXPIRED });
      expect((await userRewardRepository.findById(rewardId))?.status).toBe('GRANTED');
    });

    it('does not list a GRANTED reward past valid_until as active', async () => {
      const profileId = await createProfile();
      const rewardId = await grant('user-1', profileId);
      await db('user_rewards').where({ id: rewardId }).update({
        valid_until: new Date(Date.now() - 1_000).toISOString(),
      });
      const res = await auth(request(app).get('/api/rewards/user/user-1/active?brand_id=brand-a'));
      expect(res.body.active_reward).toBeNull();
    });
  });
});
