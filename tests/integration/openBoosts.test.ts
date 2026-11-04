import request from 'supertest';
import { app } from '../../src/index';
import db from '../../src/db/connection';
import { ReasonCode } from '../../src/types/reasonCodes';
import { userRewardRepository } from '../../src/db/repositories/userRewardRepository';
import { expireRewards } from '../../src/services/rewardExpiryService';
import { liveMomentMs } from '../helpers/v4Rides';
import { createIsolatedKnex, parseJsonColumn } from '../helpers/testDb';

/** Slice API-3: open boosts are granted at the player's click on a qualifying bet. */
const API_KEY = 'test-api-key';
const BRAND = 'open-a';
const OTHER_BRAND = 'open-b';

/** Fields that would reveal the boost range, the ride or its timing: never in an offer. */
const HIDDEN_OFFER_FIELDS = [
  'max_boost_pct', 'min_boost_pct', 'max_bonus_minor', 'bonus_cap_minor', 'ride_path', 'ride_duration_seconds',
  'end_time', 'start_time', 'seed', 'current_boost_pct', 'theoretical_max_boost_pct', 'effective_max_boost_pct',
];

function auth(req: request.Test): request.Test {
  return req.set('X-API-Key', API_KEY);
}

function profileBody(brandId: string, extra: Record<string, unknown> = {}) {
  return {
    name: `Open profile ${brandId}`,
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

async function createProfile(brandId: string, extra: Record<string, unknown> = {}): Promise<string> {
  const res = await auth(request(app).post('/api/profiles')).send(profileBody(brandId, extra));
  expect(res.status).toBe(201);
  return res.body.id as string;
}

async function createOpenProfile(brandId: string, extra: Record<string, unknown> = {}): Promise<string> {
  return createProfile(brandId, { availability: 'OPEN', ...extra });
}

/** Makes `ids` strictly ordered by created_at, oldest first, so "newest wins" is deterministic. */
async function orderCreated(...ids: string[]): Promise<void> {
  for (const [index, id] of ids.entries()) {
    await db('reward_profile_versions').where({ id })
      .update({ created_at: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString() });
  }
}

function inOneHour(): string {
  return new Date(Date.now() + 3_600_000).toISOString();
}

function anHourAgo(): string {
  return new Date(Date.now() - 3_600_000).toISOString();
}

/** A qualifying 3-fold (combined odds 5.4) with kick-offs in the future. */
function prematchSelections(overrides: Array<Record<string, unknown>> = []) {
  const base = [
    { id: 'a', odds: 1.5, starts_at: inOneHour() },
    { id: 'b', odds: 2.0, starts_at: inOneHour() },
    { id: 'c', odds: 1.8, live: true },
  ];
  return base.map((selection, index) => ({ ...selection, ...(overrides[index] ?? {}) }));
}

function offers(body: Record<string, unknown>) {
  return auth(request(app).post('/api/boost/offers')).send({
    brand_id: BRAND,
    user_id: 'player-1',
    ticket: { selections: prematchSelections() },
    ...body,
  });
}

function openOptIn(body: Record<string, unknown> = {}) {
  return auth(request(app).post('/api/boost/open-opt-in')).send({
    brand_id: BRAND,
    user_id: 'player-1',
    bet_id: 'bet-1',
    stake_minor: 1000,
    currency: 'EUR',
    ticket: { selections: prematchSelections() },
    ...body,
  });
}

function personalOptIn(rewardId: string, body: Record<string, unknown> = {}) {
  return auth(request(app).post(`/api/rewards/${rewardId}/opt-in`)).send({
    user_id: 'player-1',
    bet_id: 'bet-1',
    stake_minor: 1000,
    currency: 'EUR',
    ticket: { selections: [{ id: 'a', odds: 1.5 }, { id: 'b', odds: 2.0 }, { id: 'c', odds: 1.8 }] },
    ...body,
  });
}

async function grantPersonal(profileId: string, userId = 'player-1'): Promise<string> {
  const res = await auth(request(app).post('/api/rewards')).send({ user_id: userId, profile_version_id: profileId });
  expect(res.status).toBe(201);
  return res.body.id as string;
}

async function counts() {
  const rewards = (await db('user_rewards').count('* as c').first())!.c;
  const audits = (await db('audit_logs').count('* as c').first())!.c;
  return { rewards: Number(rewards), audits: Number(audits) };
}

async function rewardAudits(rewardId: string) {
  // Audit ids are UUIDs: callers find rows by action, never by position.
  const rows = await db('audit_logs').where({ entity_type: 'user_reward', entity_id: rewardId });
  return rows.map((row) => ({ action: row.action as string, payload: parseJsonColumn(row.payload) }));
}

describe('Open boosts (API-3)', () => {
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

  describe('profile availability', () => {
    it('defaults to PERSONAL, accepts OPEN on create and update, and rejects other values', async () => {
      const personal = await auth(request(app).post('/api/profiles')).send(profileBody(BRAND));
      expect(personal.body.availability).toBe('PERSONAL');

      const open = await auth(request(app).post('/api/profiles')).send(profileBody(BRAND, { availability: 'OPEN' }));
      expect(open.status).toBe(201);
      expect(open.body.availability).toBe('OPEN');
      expect((await auth(request(app).get(`/api/profiles/${open.body.id}`))).body.availability).toBe('OPEN');

      const toOpen = await auth(request(app).put(`/api/profiles/${personal.body.id}`)).send({ availability: 'OPEN' });
      expect(toOpen.status).toBe(200);
      expect(toOpen.body.availability).toBe('OPEN');
      const untouched = await auth(request(app).put(`/api/profiles/${personal.body.id}`)).send({ name: 'Renamed' });
      expect(untouched.body.availability).toBe('OPEN');
      const back = await auth(request(app).put(`/api/profiles/${personal.body.id}`)).send({ availability: 'PERSONAL' });
      expect(back.body.availability).toBe('PERSONAL');

      const bad = await auth(request(app).post('/api/profiles')).send(profileBody(BRAND, { availability: 'EVERYONE' }));
      expect(bad.status).toBe(400);
      expect(bad.body.code).toBe(ReasonCode.VALIDATION_ERROR);
      const badUpdate = await auth(request(app).put(`/api/profiles/${open.body.id}`)).send({ availability: 'open' });
      expect(badUpdate.status).toBe(400);
    });

    it('keeps the personal grant and opt-in unchanged; timing is checked only when sent', async () => {
      const profileId = await createProfile(BRAND);
      const rewardId = await grantPersonal(profileId);
      const reward = await auth(request(app).get(`/api/rewards/${rewardId}`));
      expect(reward.body.status).toBe('GRANTED');
      const grantAudit = (await rewardAudits(rewardId)).find((row) => row.action === 'GRANT')!;
      expect(grantAudit.payload).not.toHaveProperty('trigger');

      // Fields sent: a started prematch selection or a settled one is refused and leaves the reward GRANTED.
      const started = await personalOptIn(rewardId, {
        ticket: { selections: prematchSelections([{ starts_at: anHourAgo() }]) },
      });
      expect(started.status).toBe(422);
      expect(started.body.code).toBe(ReasonCode.SELECTION_ALREADY_STARTED);
      const settled = await personalOptIn(rewardId, {
        ticket: { selections: prematchSelections([{}, {}, { settled: true }]) },
      });
      expect(settled.status).toBe(422);
      expect(settled.body.code).toBe(ReasonCode.SELECTION_ALREADY_SETTLED);
      expect((await db('user_rewards').where({ id: rewardId }).first()).status).toBe('GRANTED');

      // No timing fields: accepted exactly as before.
      const ok = await personalOptIn(rewardId);
      expect(ok.status).toBe(200);
      expect(ok.body).toEqual({
        reward_id: rewardId,
        brand_id: BRAND,
        status: 'ENTERED',
        ride_started: true,
        stake_minor: 1000,
        currency: 'EUR',
        bonus_cap_minor: 50_000,
        end_time: null,
      });
      const optInAudit = (await rewardAudits(rewardId)).find((row) => row.action === 'OPT_IN')!;
      expect(optInAudit.payload).not.toHaveProperty('trigger');
    });
  });

  describe('POST /api/boost/offers', () => {
    it('reports NO_OPEN_PROFILE when only personal, inactive or other-brand profiles exist', async () => {
      await createProfile(BRAND);
      const inactive = await createOpenProfile(BRAND);
      await auth(request(app).put(`/api/profiles/${inactive}`)).send({ is_active: false });
      await createOpenProfile(OTHER_BRAND);
      await createOpenProfile(BRAND, { segment: 'VIP' });

      const res = await offers({});
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        brand_id: BRAND,
        user_id: 'player-1',
        qualifies: false,
        reason_code: ReasonCode.NO_OPEN_PROFILE,
        reason_codes: [ReasonCode.NO_OPEN_PROFILE],
        profile: null,
        qualifying_selection_count: null,
        total_selection_count: 3,
        combined_odds: null,
      });
    });

    it('shows the applicable profile and qualifies a slip without writing anything or revealing the boost', async () => {
      const profileId = await createOpenProfile(BRAND, { description: 'Any 3-fold' });
      const before = await counts();

      const res = await offers({ stake_minor: 1000, currency: 'EUR' });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        qualifies: true,
        reason_code: ReasonCode.ELIGIBLE,
        reason_codes: [],
        qualifying_selection_count: 3,
        total_selection_count: 3,
        combined_odds: 5.4,
      });
      expect(res.body.profile).toEqual({
        profile_version_id: profileId,
        name: `Open profile ${BRAND}`,
        description: 'Any 3-fold',
        segment: null,
        min_selections: 3,
        min_combined_odds: 3,
        min_selection_odds: 1.2,
      });
      const serialized = JSON.stringify(res.body);
      for (const field of HIDDEN_OFFER_FIELDS) expect(serialized).not.toContain(`"${field}"`);
      expect(await counts()).toEqual(before);
    });

    it('lists every failing reason, most serious timing first', async () => {
      await createOpenProfile(BRAND);
      const res = await offers({
        currency: 'USD',
        ticket: {
          selections: [
            { id: 'a', odds: 1.5, starts_at: anHourAgo() },
            { id: 'b', odds: 2.0, settled: true },
            { id: 'c', odds: 1.1 },
          ],
        },
      });
      expect(res.status).toBe(200);
      expect(res.body.qualifies).toBe(false);
      expect(res.body.reason_code).toBe(ReasonCode.CURRENCY_NOT_SUPPORTED);
      expect(res.body.reason_codes).toEqual([
        ReasonCode.CURRENCY_NOT_SUPPORTED,
        ReasonCode.SELECTION_ALREADY_SETTLED,
        ReasonCode.SELECTION_ALREADY_STARTED,
        ReasonCode.SELECTION_TIMING_REQUIRED,
        ReasonCode.MIN_SELECTIONS_NOT_MET,
      ]);
      expect(res.body.qualifying_selection_count).toBe(2);

      const lowOdds = await offers({
        ticket: { selections: prematchSelections([{ odds: 1.25 }, { odds: 1.25 }, { odds: 1.25 }]) },
      });
      expect(lowOdds.body.reason_codes).toEqual([ReasonCode.MIN_COMBINED_ODDS_NOT_MET]);
    });

    it('validates the body and requires authentication', async () => {
      const badTime = await offers({ ticket: { selections: [{ id: 'a', odds: 1.5, starts_at: 'tomorrow' }] } });
      expect(badTime.status).toBe(400);
      expect(badTime.body.code).toBe(ReasonCode.VALIDATION_ERROR);
      const badSegment = await offers({ segments: ['bad/segment'] });
      expect(badSegment.status).toBe(400);
      const noBrand = await offers({ brand_id: undefined });
      expect(noBrand.status).toBe(400);

      const unauthenticated = await request(app).post('/api/boost/offers').send({});
      expect(unauthenticated.status).toBe(401);
      const unauthenticatedOptIn = await request(app).post('/api/boost/open-opt-in').send({});
      expect(unauthenticatedOptIn.status).toBe(401);
    });
  });

  describe('profile pick', () => {
    it('prefers a matching segment profile over everyone, then the newest; ignores segments the player lacks', async () => {
      const everyoneOld = await createOpenProfile(BRAND, { name: 'everyone old' });
      const everyoneNew = await createOpenProfile(BRAND, { name: 'everyone new' });
      const vipOld = await createOpenProfile(BRAND, { segment: 'VIP', name: 'vip old' });
      const vipNew = await createOpenProfile(BRAND, { segment: 'VIP', name: 'vip new' });
      const newPlayer = await createOpenProfile(BRAND, { segment: 'NEW', name: 'new players' });
      await orderCreated(vipOld, vipNew, everyoneOld, everyoneNew, newPlayer);

      const pick = async (segments?: string[]) =>
        (await offers(segments === undefined ? {} : { segments })).body.profile.profile_version_id;

      expect(await pick()).toBe(everyoneNew);
      expect(await pick([])).toBe(everyoneNew);
      expect(await pick(['LATAM'])).toBe(everyoneNew);
      // A segment match beats a newer everyone profile.
      expect(await pick(['VIP'])).toBe(vipNew);
      // Two matching segment profiles: the newest.
      expect(await pick(['VIP', 'NEW'])).toBe(newPlayer);

      // The pick is the same in the opt-in.
      const used = await openOptIn({ segments: ['VIP'] });
      expect(used.status).toBe(200);
      const row = await db('user_rewards').where({ id: used.body.reward_id }).first();
      expect(row.profile_version_id).toBe(vipNew);
      expect(row.segment).toBe('VIP');
    });

    it('accepts an explicit open profile of the brand and refuses every other one with a ReasonCode', async () => {
      const everyone = await createOpenProfile(BRAND);
      const vip = await createOpenProfile(BRAND, { segment: 'VIP' });
      const personal = await createProfile(BRAND);
      const inactive = await createOpenProfile(BRAND);
      await auth(request(app).put(`/api/profiles/${inactive}`)).send({ is_active: false });
      const otherBrand = await createOpenProfile(OTHER_BRAND);
      const before = await counts();

      const cases: Array<[string, Record<string, unknown>, number, ReasonCode]> = [
        ['other brand', { profile_version_id: otherBrand }, 404, ReasonCode.PROFILE_NOT_FOUND],
        ['unknown', { profile_version_id: '00000000-0000-4000-8000-000000000000' }, 404, ReasonCode.PROFILE_NOT_FOUND],
        ['inactive', { profile_version_id: inactive }, 422, ReasonCode.PROFILE_INACTIVE],
        ['personal', { profile_version_id: personal }, 422, ReasonCode.PROFILE_NOT_OPEN],
        ['segment not given', { profile_version_id: vip }, 422, ReasonCode.PROFILE_SEGMENT_MISMATCH],
        ['other segment', { profile_version_id: vip, segments: ['NEW'] }, 422, ReasonCode.PROFILE_SEGMENT_MISMATCH],
      ];
      for (const [label, body, status, code] of cases) {
        const res = await openOptIn(body);
        expect({ label, status: res.status, code: res.body.code }).toEqual({ label, status, code });
      }
      expect(await counts()).toEqual(before);

      // Explicit names win over the automatic pick (the VIP profile would otherwise be chosen).
      const named = await openOptIn({ profile_version_id: everyone, segments: ['VIP'], bet_id: 'named-1' });
      expect(named.status).toBe(200);
      expect((await db('user_rewards').where({ id: named.body.reward_id }).first()).profile_version_id).toBe(everyone);
      const namedVip = await openOptIn({ profile_version_id: vip, segments: ['VIP'], bet_id: 'named-2' });
      expect(namedVip.status).toBe(200);

      const none = await openOptIn({ brand_id: 'no-profiles', bet_id: 'named-3' });
      expect(none.status).toBe(422);
      expect(none.body.code).toBe(ReasonCode.NO_OPEN_PROFILE);
    });
  });

  describe('POST /api/boost/open-opt-in', () => {
    it('grants and enters a reward in one step with the personal opt-in response shape and audit trail', async () => {
      const profileId = await createOpenProfile(BRAND, { segment: 'VIP' });
      const res = await openOptIn({ segments: ['VIP'] });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        reward_id: expect.any(String),
        brand_id: BRAND,
        status: 'ENTERED',
        ride_started: true,
        stake_minor: 1000,
        currency: 'EUR',
        bonus_cap_minor: 50_000,
        end_time: null,
      });

      const rewardId = res.body.reward_id as string;
      const row = await db('user_rewards').where({ id: rewardId }).first();
      expect(row).toMatchObject({
        brand_id: BRAND,
        user_id: 'player-1',
        profile_version_id: profileId,
        status: 'ENTERED',
        bet_id: 'bet-1',
        currency: 'EUR',
        segment: 'VIP',
      });
      expect(Number(row.stake_minor)).toBe(1000);
      expect(Number(row.bonus_cap_minor)).toBe(50_000);
      expect(row.valid_until).not.toBeNull();
      const snapshot = parseJsonColumn(row.ticket_snapshot);
      expect(snapshot.rideMath.version).toBe(4);
      expect(snapshot.selections).toHaveLength(3);

      const audits = await rewardAudits(rewardId);
      expect(audits.map((audit) => audit.action).sort()).toEqual(['GRANT', 'OPT_IN']);
      const grantAudit = audits.find((audit) => audit.action === 'GRANT')!;
      const optInAudit = audits.find((audit) => audit.action === 'OPT_IN')!;
      expect(grantAudit.payload).toMatchObject({ brandId: BRAND, userId: 'player-1', trigger: 'OPEN', segment: 'VIP' });
      expect(optInAudit.payload).toMatchObject({ brandId: BRAND, betId: 'bet-1', trigger: 'OPEN', stakeMinor: 1000 });
      expect(JSON.stringify(audits)).not.toContain(row.seed);

      // The reward reads like any other and never exposes the seed or ride end while live.
      const read = await auth(request(app).get(`/api/rewards/${rewardId}`));
      expect(read.body).toMatchObject({ status: 'ENTERED', bet_id: 'bet-1', end_time: null });
      expect(read.body).not.toHaveProperty('seed');
      // No GRANTED open reward survives the transaction.
      expect(await db('user_rewards').where({ status: 'GRANTED' })).toHaveLength(0);
    });

    it('applies no per-player limit: every qualifying bet gets its own boost', async () => {
      await createOpenProfile(BRAND);
      for (const betId of ['bet-1', 'bet-2', 'bet-3']) {
        expect((await openOptIn({ bet_id: betId })).status).toBe(200);
      }
      expect(await db('user_rewards').where({ user_id: 'player-1', status: 'ENTERED' })).toHaveLength(3);
    });

    it('refuses timing, currency and eligibility failures and leaves no trace', async () => {
      await createOpenProfile(BRAND);
      const before = await counts();
      const cases: Array<[string, Record<string, unknown>, ReasonCode]> = [
        ['timing missing', { ticket: { selections: prematchSelections([{ starts_at: undefined }]) } },
          ReasonCode.SELECTION_TIMING_REQUIRED],
        ['live false without kick-off', { ticket: { selections: prematchSelections([{}, {}, { live: false }]) } },
          ReasonCode.SELECTION_TIMING_REQUIRED],
        ['kicked off', { ticket: { selections: prematchSelections([{ starts_at: anHourAgo() }]) } },
          ReasonCode.SELECTION_ALREADY_STARTED],
        ['settled live', { ticket: { selections: prematchSelections([{}, {}, { settled: true }]) } },
          ReasonCode.SELECTION_ALREADY_SETTLED],
        ['currency', { currency: 'USD' }, ReasonCode.CURRENCY_NOT_SUPPORTED],
        ['too few', { ticket: { selections: prematchSelections().slice(0, 2) } }, ReasonCode.MIN_SELECTIONS_NOT_MET],
        ['low odds', { ticket: { selections: prematchSelections([{ odds: 1.25 }, { odds: 1.25 }, { odds: 1.25 }]) } },
          ReasonCode.MIN_COMBINED_ODDS_NOT_MET],
      ];
      for (const [label, body, code] of cases) {
        const res = await openOptIn(body);
        expect({ label, status: res.status, code: res.body.code }).toEqual({ label, status: 422, code });
      }
      expect(await counts()).toEqual(before);

      // A live selection whose event started long ago is still fine until it is settled.
      const live = await openOptIn({ ticket: { selections: prematchSelections([{ starts_at: anHourAgo(), live: true }]) } });
      expect(live.status).toBe(200);
    });

    it('validates the body like the personal opt-in', async () => {
      await createOpenProfile(BRAND);
      const duplicateIds = await openOptIn({
        ticket: { selections: prematchSelections([{}, { id: 'a' }]) },
      });
      expect(duplicateIds.status).toBe(400);
      expect((await openOptIn({ stake_minor: 0 })).status).toBe(400);
      expect((await openOptIn({ bet_id: undefined })).status).toBe(400);
      expect((await openOptIn({ profile_version_id: 'not-a-uuid' })).status).toBe(400);
    });
  });

  describe('one boost per (brand_id, bet_id)', () => {
    it('refuses a second open or personal boost on the same bet, in any order, but not in another brand', async () => {
      await createOpenProfile(BRAND);
      const personalProfile = await createProfile(BRAND);
      await createOpenProfile(OTHER_BRAND);

      const first = await openOptIn();
      expect(first.status).toBe(200);
      const before = await counts();

      // Same player, same bet: the personal-replay answer with the reward id, nothing written.
      const replay = await openOptIn();
      expect(replay.status).toBe(409);
      expect(replay.body.code).toBe(ReasonCode.ALREADY_OPTED_IN);
      expect(replay.body.details).toEqual({ reward_id: first.body.reward_id });
      // Answered before any other check, even when the slip would no longer pass (kick-off passed).
      const lateReplay = await openOptIn({ ticket: { selections: prematchSelections([{ starts_at: anHourAgo() }]) } });
      expect(lateReplay.status).toBe(409);
      expect(lateReplay.body.code).toBe(ReasonCode.ALREADY_OPTED_IN);
      const otherPlayer = await openOptIn({ user_id: 'player-2' });
      expect(otherPlayer.status).toBe(409);
      expect(otherPlayer.body.code).toBe(ReasonCode.BET_ALREADY_BOUND);
      expect(await counts()).toEqual(before);

      const rewardId = await grantPersonal(personalProfile);
      const personal = await personalOptIn(rewardId);
      expect(personal.status).toBe(409);
      expect(personal.body.code).toBe(ReasonCode.BET_ALREADY_BOUND);
      expect((await db('user_rewards').where({ id: rewardId }).first()).status).toBe('GRANTED');

      // Personal first, then open on the same bet.
      expect((await personalOptIn(rewardId, { bet_id: 'bet-2' })).status).toBe(200);
      const openAfterPersonal = await openOptIn({ bet_id: 'bet-2' });
      expect(openAfterPersonal.status).toBe(409);
      expect(openAfterPersonal.body.code).toBe(ReasonCode.BET_ALREADY_BOUND);

      // The same bet id in another brand is another bet.
      expect((await openOptIn({ brand_id: OTHER_BRAND })).status).toBe(200);
    });

    it('a concurrent other player on the same bet gets BET_ALREADY_BOUND; still exactly one reward', async () => {
      await createOpenProfile(BRAND);
      const responses = await Promise.all([
        openOptIn({ bet_id: 'shared-bet', user_id: 'player-1' }),
        openOptIn({ bet_id: 'shared-bet', user_id: 'player-2' }),
      ]);
      expect(responses.map((res) => res.status).sort()).toEqual([200, 409]);
      expect(responses.find((r) => r.status === 409)!.body.code).toBe(ReasonCode.BET_ALREADY_BOUND);
      expect(await db('user_rewards')).toHaveLength(1);
    });

    it('concurrent duplicate open opt-ins create exactly one reward', async () => {
      await createOpenProfile(BRAND);
      const responses = await Promise.all(Array.from({ length: 5 }, () => openOptIn({ bet_id: 'race-bet' })));

      expect(responses.map((res) => res.status).sort()).toEqual([200, 409, 409, 409, 409]);
      const winner = responses.find((r) => r.status === 200)!;
      for (const res of responses.filter((r) => r.status === 409)) {
        expect(res.body.code).toBe(ReasonCode.ALREADY_OPTED_IN);
        expect(res.body.details).toEqual({ reward_id: winner.body.reward_id });
      }
      expect(await db('user_rewards')).toHaveLength(1);
      expect(await db('audit_logs').where({ entity_type: 'user_reward', action: 'GRANT' })).toHaveLength(1);
      expect(await db('audit_logs').where({ entity_type: 'user_reward', action: 'OPT_IN' })).toHaveLength(1);
    });

    it('maps a unique-index violation on the bet binding to BET_ALREADY_BOUND and rolls back the grant', async () => {
      await createOpenProfile(BRAND);
      jest.spyOn(userRewardRepository, 'updateRideStart').mockRejectedValueOnce(Object.assign(
        new Error('UNIQUE constraint failed: user_rewards.brand_id, user_rewards.bet_id'),
        { code: 'SQLITE_CONSTRAINT' }
      ));
      const res = await openOptIn();
      expect(res.status).toBe(409);
      expect(res.body.code).toBe(ReasonCode.BET_ALREADY_BOUND);
      expect(await counts()).toEqual({ rewards: 0, audits: 1 }); // only the profile CREATE audit
    });

    it('rolls back every write when a later step fails unexpectedly', async () => {
      await createOpenProfile(BRAND);
      jest.spyOn(userRewardRepository, 'updateRideStart').mockRejectedValueOnce(new Error('injected failure'));
      const res = await openOptIn();
      expect(res.status).toBe(500);
      expect(res.body.code).toBe(ReasonCode.INTERNAL_ERROR);
      expect(await counts()).toEqual({ rewards: 0, audits: 1 });
    });
  });

  describe('personal grants of open profiles (MVP: refused)', () => {
    it('refuses single and bulk grants of an OPEN profile with PROFILE_IS_OPEN and writes nothing', async () => {
      const openProfile = await createOpenProfile(BRAND);
      const before = await counts();
      const single = await auth(request(app).post('/api/rewards')).send({ user_id: 'p1', profile_version_id: openProfile });
      expect(single.status).toBe(422);
      expect(single.body.code).toBe(ReasonCode.PROFILE_IS_OPEN);
      const bulk = await auth(request(app).post('/api/rewards/bulk'))
        .send({ user_ids: ['p1', 'p2', 'p3'], profile_version_id: openProfile });
      expect(bulk.status).toBe(422);
      expect(bulk.body.code).toBe(ReasonCode.PROFILE_IS_OPEN);
      expect(await counts()).toEqual(before);
    });

    it('a reward granted before its profile became OPEN needs open slip timing at opt-in', async () => {
      const profileId = await createProfile(BRAND);
      const rewardId = await grantPersonal(profileId);
      await auth(request(app).put(`/api/profiles/${profileId}`)).send({ availability: 'OPEN' });

      const bare = await personalOptIn(rewardId);
      expect(bare.status).toBe(422);
      expect(bare.body.code).toBe(ReasonCode.SELECTION_TIMING_REQUIRED);
      expect((await db('user_rewards').where({ id: rewardId }).first()).status).toBe('GRANTED');

      const timed = await personalOptIn(rewardId, { ticket: { selections: prematchSelections() } });
      expect(timed.status).toBe(200);
    });
  });

  describe('lock, settle and expiry on open rewards', () => {
    async function lockAtLiveMoment(rewardId: string, betId: string, userId = 'player-1'): Promise<void> {
      const row = await db('user_rewards').where({ id: rewardId }).first();
      jest.spyOn(Date, 'now').mockReturnValue(liveMomentMs(parseJsonColumn(row.ticket_snapshot).rideMath));
      const lock = await auth(request(app).post('/api/boost/lock'))
        .send({ user_id: userId, reward_id: rewardId, bet_id: betId });
      expect(lock.status).toBe(201);
      jest.restoreAllMocks();
    }

    function settle(betId: string, body: Record<string, unknown>) {
      return auth(request(app).post('/api/settlement')).send({ brand_id: BRAND, bet_id: betId, ...body });
    }

    function resettle(betId: string, body: Record<string, unknown>) {
      return auth(request(app).post('/api/settlement/resettle'))
        .send({ brand_id: BRAND, bet_id: betId, reason: 'correction', ...body });
    }

    const ALL_WON = { outcome: 'SETTLED', legs: ['a', 'b', 'c'].map((id) => ({ selection_id: id, result: 'WON' })) };

    async function settlementAudit(action: 'SETTLE' | 'RESETTLE') {
      const row = await db('audit_logs').where({ entity_type: 'bet_settlement', action }).first();
      return parseJsonColumn(row.payload);
    }

    it('a cancelled open-boost bet returns no token, says why, and keeps saying it on replay and read', async () => {
      const profileId = await createOpenProfile(BRAND);
      const rewardId = (await openOptIn()).body.reward_id as string;
      await lockAtLiveMoment(rewardId, 'bet-1');
      // Frozen at opt-in: switching the profile to PERSONAL afterwards does not make this a personal bet.
      await auth(request(app).put(`/api/profiles/${profileId}`)).send({ availability: 'PERSONAL' });

      const cancelled = await settle('bet-1', { outcome: 'CANCELLED' });
      expect(cancelled.status).toBe(201);
      expect(cancelled.body).toMatchObject({
        bet_result: 'CANCELLED',
        bonus_minor: 0,
        replacement_reward_id: null,
        replacement_status: 'NOT_ISSUED_OPEN_BOOST',
      });
      expect(await db('user_rewards')).toHaveLength(1);
      expect(await settlementAudit('SETTLE')).toMatchObject({
        openBoost: true,
        replacementRewardId: null,
        replacementStatus: 'NOT_ISSUED_OPEN_BOOST',
      });

      const replay = await settle('bet-1', { outcome: 'CANCELLED' });
      expect(replay.body.replacement_status).toBe('NOT_ISSUED_OPEN_BOOST');
      const read = await auth(request(app).get(`/api/settlement/bet-1?brand_id=${BRAND}`));
      expect(read.status).toBe(200);
      expect(read.body.replacement_status).toBe('NOT_ISSUED_OPEN_BOOST');
    });

    it('a resettlement to CANCELLED of an open-boost bet returns no token either', async () => {
      await createOpenProfile(BRAND);
      const rewardId = (await openOptIn()).body.reward_id as string;
      await lockAtLiveMoment(rewardId, 'bet-1');
      expect((await settle('bet-1', ALL_WON)).status).toBe(201);

      const corrected = await resettle('bet-1', { outcome: 'CANCELLED' });
      expect(corrected.status).toBe(201);
      expect(corrected.body).toMatchObject({
        revision: 2,
        replacement_reward_id: null,
        replacement_status: 'NOT_ISSUED_OPEN_BOOST',
      });
      expect(await db('user_rewards')).toHaveLength(1);
      expect(await settlementAudit('RESETTLE')).toMatchObject({ openBoost: true, replacementStatus: 'NOT_ISSUED_OPEN_BOOST' });

      const back = await resettle('bet-1', ALL_WON);
      expect(back.status).toBe(201);
      expect(back.body.replacement_status).toBeNull();
    });

    it('a cancelled personal bet still returns its token (decision #6 unchanged)', async () => {
      const profileId = await createProfile(BRAND);
      const rewardId = await grantPersonal(profileId);
      expect((await personalOptIn(rewardId)).status).toBe(200);
      await lockAtLiveMoment(rewardId, 'bet-1');

      const cancelled = await settle('bet-1', { outcome: 'CANCELLED' });
      expect(cancelled.status).toBe(201);
      expect(cancelled.body.replacement_status).toBe('ISSUED');
      expect(cancelled.body.replacement_reward_id).toEqual(expect.any(String));
      const audit = await settlementAudit('SETTLE');
      expect(audit.replacementStatus).toBe('ISSUED');
      expect(audit).not.toHaveProperty('openBoost');
      const token = await db('user_rewards').where({ id: cancelled.body.replacement_reward_id }).first();
      expect(token).toMatchObject({ status: 'GRANTED', replaces_reward_id: rewardId });
    });

    it('locks and settles an open reward like a personal one', async () => {
      await createOpenProfile(BRAND);
      const res = await openOptIn();
      const rewardId = res.body.reward_id as string;
      const row = await db('user_rewards').where({ id: rewardId }).first();
      jest.spyOn(Date, 'now').mockReturnValue(liveMomentMs(parseJsonColumn(row.ticket_snapshot).rideMath));

      const quote = await auth(request(app).post('/api/boost/quote'))
        .send({ user_id: 'player-1', reward_id: rewardId, bet_id: 'bet-1' });
      expect(quote.status).toBe(200);
      const lock = await auth(request(app).post('/api/boost/lock'))
        .send({ user_id: 'player-1', reward_id: rewardId, bet_id: 'bet-1' });
      expect(lock.status).toBe(201);
      jest.restoreAllMocks();
      expect((await db('user_rewards').where({ id: rewardId }).first()).status).toBe('USED');

      const settle = await auth(request(app).post('/api/settlement')).send({
        brand_id: BRAND,
        bet_id: 'bet-1',
        outcome: 'SETTLED',
        legs: ['a', 'b', 'c'].map((id) => ({ selection_id: id, result: 'WON' })),
      });
      expect(settle.status).toBe(201);
      expect(settle.body.bet_id).toBe('bet-1');
    });

    it('expires an unlocked open ride by the ENTERED grace rule only', async () => {
      await createOpenProfile(BRAND);
      const rewardId = (await openOptIn()).body.reward_id as string;

      // Validity has no effect on an ENTERED reward: only the ride being over (plus grace) expires it.
      const nothing = await expireRewards(new Date(), 0);
      expect(nothing.total_expired).toBe(0);
      const farFuture = new Date(Date.now() + 400 * 86_400_000);
      const result = await expireRewards(farFuture, 0);
      expect(result).toMatchObject({ granted_expired: 0, entered_expired: 1 });
      expect((await db('user_rewards').where({ id: rewardId }).first()).status).toBe('EXPIRED');
      const expiry = (await rewardAudits(rewardId)).find((audit) => audit.action === 'EXPIRE')!;
      expect(expiry.payload).toMatchObject({ reason: 'RIDE_OVER_WITHOUT_LOCK', previousStatus: 'ENTERED' });
    });
  });

  describe('migration 019', () => {
    it('adds availability defaulting existing profiles to PERSONAL and rolls back cleanly', async () => {
      const { knex, cleanup } = await createIsolatedKnex();
      try {
        for (let i = 0; i < 18; i += 1) await knex.migrate.up();
        expect(await knex.schema.hasColumn('reward_profile_versions', 'availability')).toBe(false);
        const now = new Date().toISOString();
        await knex('reward_profile_versions').insert({
          id: '11111111-1111-4111-8111-111111111111', name: 'legacy', min_selections: 3, min_combined_odds: 3,
          min_selection_odds: 1.2, min_boost_pct: 0.05, max_boost_pct: 0.5, ride_duration_seconds: 60,
          checkpoint_count: 12, volatility: 0.5, is_active: true, created_at: now, updated_at: now,
        });

        const [, applied] = await knex.migrate.up();
        expect(applied).toEqual(['019_open_profiles.ts']);
        expect((await knex('reward_profile_versions').first()).availability).toBe('PERSONAL');

        await knex('reward_profile_versions').update({ availability: 'OPEN' });
        await knex.migrate.down();
        expect(await knex.schema.hasColumn('reward_profile_versions', 'availability')).toBe(false);
        expect(await knex('reward_profile_versions')).toHaveLength(1);

        const [, again] = await knex.migrate.latest();
        expect(again).toEqual(['019_open_profiles.ts']);
        expect((await knex('reward_profile_versions').first()).availability).toBe('PERSONAL');
      } finally {
        await cleanup();
      }
    });
  });
});
