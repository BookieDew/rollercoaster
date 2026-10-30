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
    expect(result.data?.math_snapshot_version).toBe(4);
    expect(result.data?.maximum_model).toBe('PRE_CRASH_SUPREMUM_V4');
    expect(result.data?.ride.duration_seconds).toBeGreaterThan(0);
  });

  it('is reproducible for an explicit seed (hex or any string) and random by default', async () => {
    const hex = 'ab'.repeat(32);
    const a = await simulationService.simulateRide({ seed: hex, samplePoints: 20 });
    const b = await simulationService.simulateRide({ seed: hex, samplePoints: 20 });
    expect(a.data?.seed).toBe(hex);
    expect(a.data).toEqual(b.data);
    const named = await simulationService.simulateRide({ seed: 'sim-seed-default', samplePoints: 20 });
    expect(named.data).toEqual((await simulationService.simulateRide({ seed: 'sim-seed-default', samplePoints: 20 })).data);
    expect(named.data?.curve).not.toEqual(a.data?.curve);

    const first = await simulationService.simulateRide({ samplePoints: 20 });
    const second = await simulationService.simulateRide({ samplePoints: 20 });
    expect(first.data?.seed).toMatch(/^[0-9a-f]{64}$/);
    expect(second.data?.seed).toMatch(/^[0-9a-f]{64}$/);
    expect(first.data?.seed).not.toBe(second.data?.seed);
    // The returned default seed replays the same ride.
    expect((await simulationService.simulateRide({ seed: first.data!.seed, samplePoints: 20 })).data).toEqual(first.data);
  });

  it('never uses Math.random for the default seed', async () => {
    const random = jest.spyOn(Math, 'random');
    await simulationService.simulateRide({ samplePoints: 10 });
    expect(random).not.toHaveBeenCalled();
  });

  it('reports the full V4 ride and zero from the crash or end on', async () => {
    const result = (await simulationService.simulateRide({ seed: 'sim-seed-shape', samplePoints: 200 })).data!;
    const terminal = result.ride.crash_at_seconds ?? result.ride.duration_seconds;
    for (const point of result.curve) {
      if (point.time_pct * result.ride.duration_seconds >= terminal + 1e-9) expect(point.base_ride_value).toBe(0);
    }
    expect(result.curve[result.curve.length - 1].final_boost_pct).toBe(0);
    expect(result.config.crash_pct).toBeCloseTo(terminal / result.ride.duration_seconds, 12);
    expect(result.ride.pre_crash_maximum_pct).toBeLessThanOrEqual(result.ride.ride_maximum_pct);
    const sampledMax = Math.max(...result.curve.map((p) => p.base_ride_value));
    expect(sampledMax).toBeLessThanOrEqual(Math.round(result.ride.pre_crash_maximum_pct * 10000) / 10000);
  });

  it('nulls final values for an ineligible ticket and keeps combined odds beyond the double range exact', async () => {
    const result = await simulationService.simulateRide({
      seed: 'sim-seed-huge',
      samplePoints: 10,
      ticket: { selections: Array.from({ length: 100 }, (_, i) => ({ id: `h${i}`, odds: 10000 })) },
    });
    expect(result.data?.eligible).toBe(true);
    expect(result.data?.ticket_analysis?.combined_odds).toBe('1' + '0'.repeat(400));
    expect(result.data?.ticket_analysis?.ticket_strength).toBe(1);
    for (const value of [...Object.values(result.data!.config), ...Object.values(result.data!.ride)]) {
      if (typeof value === 'number') expect(Number.isFinite(value)).toBe(true);
    }

    const ineligible = await simulationService.simulateRide({
      seed: 'sim-seed-huge',
      samplePoints: 10,
      ticket: { selections: [{ id: 'one', odds: 1.5 }] },
    });
    expect(ineligible.data?.eligible).toBe(false);
    expect(ineligible.data?.reason_code).toBe(ReasonCode.MIN_SELECTIONS_NOT_MET);
    expect(ineligible.data?.curve.every((p) => p.final_boost_pct === null)).toBe(true);
  });

  it('rejects a resolved minimum boost above the maximum', async () => {
    const result = await simulationService.simulateRide({ minBoostPct: 0.6, maxBoostPct: 0.5 });
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe(ReasonCode.INVALID_CONFIGURATION);
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
