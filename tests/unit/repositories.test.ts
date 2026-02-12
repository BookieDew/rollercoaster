import { v4 as uuidv4 } from 'uuid';
import db from '../../src/db/connection';
import { rewardProfileRepository } from '../../src/db/repositories/rewardProfileRepository';
import { auditLogRepository } from '../../src/db/repositories/auditLogRepository';
import { betBoostLockRepository } from '../../src/db/repositories/betBoostLockRepository';
import { settlementRepository } from '../../src/db/repositories/settlementRepository';
import type { LockSnapshot } from '../../src/types/betBoostLock';

async function clearDb(): Promise<void> {
  await db('settlement_records').del();
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
    it('creates/reads lock records and settlement records', async () => {
      const fixture1 = await createRewardFixture({ betId: 'repo-bet-1' });
      const fixture2 = await createRewardFixture({ betId: 'repo-bet-2' });

      const lock1 = await betBoostLockRepository.create({
        betId: fixture1.betId,
        rewardId: fixture1.rewardId,
        lockedBoostPct: 0.2,
        qualifyingSelections: 5,
        qualifyingOdds: 11.2,
        ticketStrength: 0.6,
        snapshot: makeSnapshot(fixture1.profileId),
      });
      const lock2 = await betBoostLockRepository.create({
        betId: fixture2.betId,
        rewardId: fixture2.rewardId,
        lockedBoostPct: 0.3,
        qualifyingSelections: 6,
        qualifyingOdds: 13.5,
        ticketStrength: 0.7,
        snapshot: makeSnapshot(fixture2.profileId),
      });

      expect(await betBoostLockRepository.existsByBetId(fixture1.betId)).toBe(true);
      expect(await betBoostLockRepository.existsByBetId('missing-bet')).toBe(false);

      const byBet = await betBoostLockRepository.findByBetId(fixture1.betId);
      expect(byBet?.id).toBe(lock1.id);

      const byId = await betBoostLockRepository.findById(lock1.id);
      expect(byId?.betId).toBe(fixture1.betId);

      const byReward = await betBoostLockRepository.findByRewardId(fixture2.rewardId);
      expect(byReward).toHaveLength(1);
      expect(byReward[0].id).toBe(lock2.id);

      const settlement1 = await settlementRepository.create({
        betId: fixture1.betId,
        outcome: 'WIN',
        winnings: 100,
        bonusAmount: 20,
      });
      const settlement2 = await settlementRepository.create({
        betId: fixture2.betId,
        outcome: 'LOSS',
        winnings: 0,
        bonusAmount: 0,
      });

      expect((await settlementRepository.findByBetId(fixture1.betId))?.id).toBe(settlement1.id);
      expect((await settlementRepository.findById(settlement2.id))?.betId).toBe(fixture2.betId);
      expect(await settlementRepository.findByBetId('missing-bet')).toBeNull();

      expect(await settlementRepository.existsByBetId(fixture1.betId)).toBe(true);
      expect(await settlementRepository.existsByBetId('missing-bet')).toBe(false);

      const start = new Date(Date.now() - 60_000).toISOString();
      const end = new Date(Date.now() + 60_000).toISOString();
      const inRange = await settlementRepository.findByDateRange(start, end);
      expect(inRange.length).toBeGreaterThanOrEqual(2);

      expect(await settlementRepository.sumBonusByOutcome('WIN')).toBe(20);
      expect(await settlementRepository.sumBonusByOutcome('CASHOUT')).toBe(0);
    });
  });
});
