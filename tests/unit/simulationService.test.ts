import { simulationService } from '../../src/services/simulationService';
import { rewardProfileRepository } from '../../src/db/repositories/rewardProfileRepository';
import { ReasonCode } from '../../src/types/reasonCodes';
import type { RewardProfileVersion } from '../../src/types/rewardProfile';

function makeProfile(overrides: Partial<RewardProfileVersion> = {}): RewardProfileVersion {
  const now = new Date().toISOString();
  return {
    id: 'profile-sim',
    name: 'Simulation Profile',
    description: null,
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
    rideMode: 'WAVES',
    rideDurationSeconds: 3600,
    isActive: true,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe('simulationService', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('returns PROFILE_NOT_FOUND when profile does not exist', async () => {
    jest.spyOn(rewardProfileRepository, 'findById').mockResolvedValue(null);

    const result = await simulationService.simulateRide({
      profileId: 'missing-profile',
      seed: 'sim-seed-missing',
    });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe(ReasonCode.PROFILE_NOT_FOUND);
  });

  it('simulates default wave ride without ticket', async () => {
    const result = await simulationService.simulateRide({
      seed: 'sim-seed-default',
      samplePoints: 20,
    });

    expect(result.success).toBe(true);
    expect(result.data).toBeDefined();
    expect(result.data?.config.ride_mode).toBe('WAVES');
    expect(result.data?.ticket_analysis).toBeUndefined();
    expect(result.data?.curve).toHaveLength(21);
    expect(result.data?.checkpoints.length).toBeGreaterThanOrEqual(3);
  });

  it('uses profile config and computes ticket analysis', async () => {
    const profile = makeProfile({
      rideMode: 'WAVES',
      maxBoostMinSelections: 12,
      maxBoostMinCombinedOdds: 80,
      maxEligibilitySelectionWeight: 0.8,
      maxEligibilityOddsWeight: 0.2,
      effectiveMinFloorRate: 0.4,
    });
    jest.spyOn(rewardProfileRepository, 'findById').mockResolvedValue(profile);

    const result = await simulationService.simulateRide({
      profileId: profile.id,
      seed: 'sim-seed-ticket',
      samplePoints: 40,
      ticket: {
        selections: [
          { id: 's1', odds: 1.6 },
          { id: 's2', odds: 1.9 },
          { id: 's3', odds: 2.1 },
          { id: 's4', odds: 1.25 }, // filtered out by min selection odds
          { id: 's5', odds: 1.8 },
        ],
      },
    });

    expect(result.success).toBe(true);
    expect(result.data?.config.max_eligibility_selection_weight).toBe(0.8);
    expect(result.data?.config.max_eligibility_odds_weight).toBe(0.2);
    expect(result.data?.config.effective_min_floor_rate).toBe(0.4);
    expect(result.data?.ticket_analysis).toBeDefined();
    expect(result.data?.ticket_analysis?.qualifying_selections).toBe(4);
    expect(result.data?.ticket_analysis?.combined_odds).toBeGreaterThan(1);
    expect(result.data?.ticket_analysis?.ticket_strength).toBeGreaterThanOrEqual(0);
    expect(result.data?.curve).toHaveLength(41);
  });

  it('supports linear ride mode from profile', async () => {
    const profile = makeProfile({
      rideMode: 'LINEAR',
      minBoostPct: 0.1,
      maxBoostPct: 0.8,
      maxBoostMinSelections: 8,
      maxBoostMinCombinedOdds: 20,
    });
    jest.spyOn(rewardProfileRepository, 'findById').mockResolvedValue(profile);

    const result = await simulationService.simulateRide({
      profileId: profile.id,
      seed: 'sim-seed-linear',
      samplePoints: 50,
      ticket: {
        selections: [
          { id: 'a', odds: 1.5 },
          { id: 'b', odds: 1.6 },
          { id: 'c', odds: 1.7 },
          { id: 'd', odds: 1.8 },
          { id: 'e', odds: 1.9 },
        ],
      },
    });

    expect(result.success).toBe(true);
    expect(result.data?.config.ride_mode).toBe('LINEAR');
    const curve = result.data?.curve ?? [];
    expect(curve.length).toBe(51);
    expect(curve[curve.length - 1].final_boost_pct).toBe(0);

    // Linear mode should be non-decreasing before crash in effective boost.
    let seenDrop = false;
    for (let i = 1; i < curve.length; i++) {
      if ((curve[i].final_boost_pct ?? 0) === 0 && (curve[i - 1].final_boost_pct ?? 0) > 0) {
        break;
      }
      if ((curve[i].final_boost_pct ?? 0) < (curve[i - 1].final_boost_pct ?? 0)) {
        seenDrop = true;
        break;
      }
    }
    expect(seenDrop).toBe(false);
  });
});
