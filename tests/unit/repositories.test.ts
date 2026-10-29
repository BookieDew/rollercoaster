import { v4 as uuidv4 } from 'uuid';
import db from '../../src/db/connection';
import { rewardProfileRepository } from '../../src/db/repositories/rewardProfileRepository';
import { auditLogRepository } from '../../src/db/repositories/auditLogRepository';
import { betBoostLockRepository } from '../../src/db/repositories/betBoostLockRepository';
import { settlementRepository } from '../../src/db/repositories/settlementRepository';
import { userRewardRepository, BetAlreadyBoundError } from '../../src/db/repositories/userRewardRepository';
import { runInTransaction } from '../../src/db/repositories/transaction';
import type { LockSnapshot } from '../../src/types/betBoostLock';

async function clearDb(): Promise<void> {
  await db('bet_settlements').del();
  await db('bet_boost_locks').del();
  await db('ride_definitions').del();
  await db('user_rewards').del();
  await db('audit_logs').del();
  await db('reward_profile_versions').del();
}

async function createRewardFixture(overrides?: { rewardId?: string; betId?: string }): Promise<{
  profileId: string;
  rewardId: string;
  betId: string;
}> {
  const profileId = uuidv4();
  const rewardId = overrides?.rewardId ?? uuidv4();
  const betId = overrides?.betId ?? `bet-${uuidv4()}`;
  const now = new Date().toISOString();

  await db('reward_profile_versions').insert({
    id: profileId,
    name: 'Repo Profile',
    description: null,
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
    checkpoint_count: 12,
    volatility: 0.5,
    is_active: true,
    created_at: now,
    updated_at: now,
  });

  await db('user_rewards').insert({
    id: rewardId,
    user_id: 'repo-user',
    profile_version_id: profileId,
    status: 'ENTERED',
    start_time: now,
    end_time: now,
    seed: `seed-${rewardId}`,
    opted_in_at: now,
    bet_id: betId,
    ticket_snapshot: JSON.stringify({ selections: [{ id: 's1', odds: 1.5 }] }),
    created_at: now,
    updated_at: now,
  });

  return { profileId, rewardId, betId };
}

function makeSnapshot(profileId: string): LockSnapshot {
  return {
    selections: [{ id: 's1', odds: 1.5 }],
    disqualifiedSelections: [],
    profileId,
    rideMode: 'WAVES',
    minSelections: 5,
    minCombinedOdds: 10,
    minSelectionOdds: 1.3,
    minBoostPct: 0.05,
    maxBoostPct: 1,
    maxBoostMinSelections: 10,
    maxBoostMinCombinedOdds: 50,
    maxEligibilitySelectionWeight: 0.75,
    maxEligibilityOddsWeight: 0.25,
    effectiveMinFloorRate: 0.35,
    rideDurationSeconds: 10,
    checkpointCount: 12,
    volatility: 0.5,
    seed: 'seed',
    crashPct: 0.8,
    totalSelectionCount: 1,
    qualifyingSelectionCount: 1,
    combinedOdds: 1.5,
    ticketStrength: 0.4,
    rideValue: 0.3,
    maxRideValue: 0.8,
    elapsedPct: 0.4,
    effectiveMinBoostPct: 0.05,
    maxEligibleBoostPct: 0.3,
    maxPossibleBoostPct: 0.5,
    boostModel: {
      selectionWeight: 0.75,
      oddsWeight: 0.25,
      maxEligibilityExponent: 1.2,
      effectiveMinFloorRate: 0.35,
      selectionRatio: 0.5,
      oddsRatio: 0.5,
      eligibilityFactor: 0.5,
    },
    ridePath: [{ timePct: 0, baseBoostValue: 0.2 }, { timePct: 1, baseBoostValue: 0 }],
  };
}

describe('repository coverage', () => {
  beforeAll(async () => {
    await db.migrate.latest();
  });

  afterAll(async () => {
    await db.destroy();
  });

  beforeEach(async () => {
    await clearDb();
  });

  describe('rewardProfileRepository', () => {
    it('handles create/find/update/remove and defaults', async () => {
      const created = await rewardProfileRepository.create({
        brandId: 'brand-a',
        maxBonusMinor: { EUR: 50_000 },
        rewardValiditySeconds: 86_400,
        name: 'Repo Test Profile',
        minSelections: 5,
        minCombinedOdds: 10,
        minSelectionOdds: 1.3,
        minBoostPct: 0.05,
        maxBoostPct: 1,
        rideDurationSeconds: 300,
      });

      expect(created.maxBoostMinSelections).toBeNull();
      expect(created.maxBoostMinCombinedOdds).toBeNull();
      expect(created.maxEligibilitySelectionWeight).toBe(0.75);
      expect(created.maxEligibilityOddsWeight).toBe(0.25);
      expect(created.effectiveMinFloorRate).toBe(0.35);
      expect(created.rideMode).toBe('WAVES');

      const byId = await rewardProfileRepository.findById(created.id);
      expect(byId?.id).toBe(created.id);

      const missing = await rewardProfileRepository.findById('00000000-0000-0000-0000-000000000000');
      expect(missing).toBeNull();

      const fullUpdate = await rewardProfileRepository.update(created.id, {
        name: 'Updated',
        description: 'desc',
        minSelections: 6,
        minCombinedOdds: 12,
        minSelectionOdds: 1.4,
        minBoostPct: 0.1,
        maxBoostPct: 1.2,
        maxBoostMinSelections: 11,
        maxBoostMinCombinedOdds: 60,
        maxEligibilitySelectionWeight: 0.7,
        maxEligibilityOddsWeight: 0.3,
        effectiveMinFloorRate: 0.4,
        rideMode: 'LINEAR',
        rideDurationSeconds: 400,
        isActive: false,
      });
      expect(fullUpdate?.name).toBe('Updated');
      expect(fullUpdate?.rideMode).toBe('LINEAR');
      expect(fullUpdate?.isActive).toBe(false);

      const emptyUpdate = await rewardProfileRepository.update(created.id, {});
      expect(emptyUpdate?.id).toBe(created.id);

      const activeProfiles = await rewardProfileRepository.findActive();
      expect(activeProfiles).toHaveLength(0);

      const allProfiles = await rewardProfileRepository.findAll();
      expect(allProfiles).toHaveLength(1);

      const removed = await rewardProfileRepository.remove(created.id);
      expect(removed).toBe(true);

      const removedAgain = await rewardProfileRepository.remove(created.id);
      expect(removedAgain).toBe(false);

      const missingUpdate = await rewardProfileRepository.update('00000000-0000-0000-0000-000000000000', {
        name: 'nope',
      });
      expect(missingUpdate).toBeNull();
    });
  });

  describe('userRewardRepository', () => {
    it('updates status conditionally and reports a lost compare-and-set as null', async () => {
      const { rewardId } = await createRewardFixture();

      const wrongFrom = await userRewardRepository.updateStatus(rewardId, 'USED', undefined, { fromStatus: 'GRANTED' });
      expect(wrongFrom).toBeNull();
      expect((await userRewardRepository.findById(rewardId))?.status).toBe('ENTERED');

      const used = await userRewardRepository.updateStatus(rewardId, 'USED', undefined, { fromStatus: 'ENTERED' });
      expect(used?.status).toBe('USED');

      expect(await userRewardRepository.updateStatus('00000000-0000-0000-0000-000000000000', 'USED')).toBeNull();
      const unconditional = await userRewardRepository.updateStatus(rewardId, 'EXPIRED', '2026-10-29T00:00:00.000Z');
      expect(unconditional?.status).toBe('EXPIRED');
      expect(unconditional?.optedInAt).toBe('2026-10-29T00:00:00.000Z');
    });

    it('refuses to bind a bet already attached to another reward, but rebinds the same reward', async () => {
      const first = await createRewardFixture({ betId: 'bound-bet' });
      const second = await createRewardFixture({ betId: 'other-bet' });
      const start = new Date().toISOString();

      await expect(userRewardRepository.updateRideStart(second.rewardId, start, start, 'bound-bet', { a: 1 }))
        .rejects.toBeInstanceOf(BetAlreadyBoundError);
      expect((await userRewardRepository.findById(second.rewardId))?.betId).toBe('other-bet');

      const same = await userRewardRepository.updateRideStart(first.rewardId, start, start, 'bound-bet', { b: 2 });
      expect(same?.betId).toBe('bound-bet');
      expect(same?.ticketSnapshot).toEqual({ b: 2 });
    });

    it('creates and reads through a transaction scope, rolling back together', async () => {
      const { profileId } = await createRewardFixture();
      const now = new Date().toISOString();

      await expect(runInTransaction(async (tx) => {
        const created = await userRewardRepository.create({
          brandId: 'brand-a', userId: 'tx-user', profileVersionId: profileId, startTime: now, endTime: now, seed: 's',
        }, tx);
        expect((await userRewardRepository.findById(created.id, tx))?.userId).toBe('tx-user');
        throw new Error('abort');
      })).rejects.toThrow('abort');

      expect(await userRewardRepository.findByUserId('brand-a', 'tx-user')).toHaveLength(0);
    });
  });

  describe('auditLogRepository', () => {
    it('appends and queries logs by entity and date ranges', async () => {
      await auditLogRepository.append({
        entityType: 'reward_profile',
        entityId: 'entity-1',
        action: 'CREATE',
        payload: { a: 1 },
      });
      await auditLogRepository.append({
        entityType: 'reward_profile',
        entityId: 'entity-1',
        action: 'UPDATE',
      });
      await auditLogRepository.append({
        entityType: 'user_reward',
        entityId: 'entity-2',
        action: 'GRANT',
      });

      const byEntity = await auditLogRepository.findByEntity('reward_profile', 'entity-1');
      expect(byEntity).toHaveLength(2);
      expect(byEntity[0].payload === null || typeof byEntity[0].payload === 'object').toBe(true);

      const byType = await auditLogRepository.findByEntityType('reward_profile', 10);
      expect(byType).toHaveLength(2);

      const start = new Date(Date.now() - 60_000).toISOString();
      const end = new Date(Date.now() + 60_000).toISOString();
      const byDate = await auditLogRepository.findByDateRange(start, end);
      expect(byDate.length).toBeGreaterThanOrEqual(3);
    });
  });

  describe('betBoostLockRepository + settlementRepository', () => {
    it('creates/reads lock records and settlement revisions', async () => {
      const fixture1 = await createRewardFixture({ betId: 'repo-bet-1' });
      const fixture2 = await createRewardFixture({ betId: 'repo-bet-2' });

      const lock1 = await betBoostLockRepository.create({
        brandId: 'default',
        betId: fixture1.betId,
        rewardId: fixture1.rewardId,
        lockedBoostPct: 0.2,
        qualifyingSelections: 5,
        qualifyingOdds: 11.2,
        ticketStrength: 0.6,
        snapshot: makeSnapshot(fixture1.profileId),
      });
      const lock2 = await betBoostLockRepository.create({
        brandId: 'default',
        betId: fixture2.betId,
        rewardId: fixture2.rewardId,
        lockedBoostPct: 0.3,
        qualifyingSelections: 6,
        qualifyingOdds: 13.5,
        ticketStrength: 0.7,
        snapshot: makeSnapshot(fixture2.profileId),
      });

      expect(await betBoostLockRepository.existsByBetId(fixture1.betId, 'default')).toBe(true);
      expect(await betBoostLockRepository.existsByBetId(fixture1.betId, 'other-brand')).toBe(false);
      expect(await betBoostLockRepository.existsByBetId('missing-bet', 'default')).toBe(false);

      const byBet = await betBoostLockRepository.findByBetId(fixture1.betId, 'default');
      expect(byBet?.id).toBe(lock1.id);

      const byId = await betBoostLockRepository.findById(lock1.id);
      expect(byId?.betId).toBe(fixture1.betId);

      const byReward = await betBoostLockRepository.findByRewardId(fixture2.rewardId);
      expect(byReward).toHaveLength(1);
      expect(byReward[0].id).toBe(lock2.id);

      const base = {
        brandId: 'default',
        betId: fixture1.betId,
        lockId: lock1.id,
        outcome: 'SETTLED' as const,
        legs: [{ selection_id: 'a', result: 'WON' as const }],
        currency: 'EUR',
        stakeMinor: 1000,
        lockedBoostPct: 0.2,
        bonusCapMinor: 50_000,
        replacementRewardId: null,
        reason: null,
        settledAt: new Date().toISOString(),
      };
      const first = await settlementRepository.create({
        ...base,
        id: uuidv4(),
        revision: 1,
        betResult: 'WON',
        totalReturnMinor: '9975',
        bonusMinor: 1995,
        capApplied: false,
        minimumsMet: null,
      });
      expect(first).toMatchObject({ revision: 1, isCurrent: true, bonusMinor: 1995, minimumsMet: null });

      const read = await settlementRepository.findCurrentByLockId(lock1.id);
      expect(read).toMatchObject({
        id: first.id, isCurrent: true, legs: base.legs, totalReturnMinor: '9975', capApplied: false, minimumsMet: null,
      });
      expect((await settlementRepository.findCurrentByBet('default', fixture1.betId))?.id).toBe(first.id);
      expect(await settlementRepository.findCurrentByBet('other-brand', fixture1.betId)).toBeNull();

      // A second current revision for the same lock is refused by the partial unique index.
      await expect(settlementRepository.create({
        ...base, id: uuidv4(), revision: 2, betResult: 'LOST', totalReturnMinor: '0', bonusMinor: 0,
        capApplied: false, minimumsMet: null,
      })).rejects.toMatchObject({ code: 'SQLITE_CONSTRAINT' });

      const second = await runInTransaction(async (tx) => {
        expect(await settlementRepository.markSuperseded(first.id, tx)).toBe(true);
        expect(await settlementRepository.markSuperseded(first.id, tx)).toBe(false);
        return settlementRepository.create({
          ...base, id: uuidv4(), revision: 2, outcome: 'CANCELLED', legs: null, betResult: 'CANCELLED',
          totalReturnMinor: null, bonusMinor: 0, capApplied: false, minimumsMet: true,
          replacementRewardId: fixture2.rewardId, reason: 'void',
        }, tx);
      });
      const current = await settlementRepository.findCurrentByLockId(lock1.id);
      expect(current).toMatchObject({
        id: second.id, revision: 2, legs: null, totalReturnMinor: null, minimumsMet: true,
        replacementRewardId: fixture2.rewardId, reason: 'void',
      });
      expect((await settlementRepository.findRevision(lock1.id, 1))?.isCurrent).toBe(false);
      expect(await settlementRepository.findRevision(lock1.id, 3)).toBeNull();
      expect((await settlementRepository.findAllByLockId(lock1.id)).map((row) => row.revision)).toEqual([1, 2]);
      expect(await settlementRepository.findCurrentByLockId(lock2.id)).toBeNull();

      // total_return_minor is stored exactly as text, whatever its size (100 legs at 10,000 on 1e12).
      const huge = `1${'0'.repeat(412)}`;
      const big = await settlementRepository.create({
        ...base, id: uuidv4(), betId: fixture2.betId, lockId: lock2.id, revision: 1, betResult: 'WON',
        totalReturnMinor: huge, bonusMinor: 50_000, capApplied: true, minimumsMet: null,
      });
      expect(big.totalReturnMinor).toBe(huge);
      expect((await settlementRepository.findCurrentByLockId(lock2.id))?.totalReturnMinor).toBe(huge);
      expect((await db('bet_settlements').where({ id: big.id }).first()).total_return_minor).toBe(huge);

      // A stored value that is not an exact non-negative integer is rejected, never rounded.
      await db('bet_settlements').where({ id: big.id }).update({ total_return_minor: '1.5' });
      await expect(settlementRepository.findCurrentByLockId(lock2.id)).rejects.toThrow(/not an exact non-negative integer/);
    });
  });
});
