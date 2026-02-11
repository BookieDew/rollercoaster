import { rewardProfileRepository } from '../db/repositories/rewardProfileRepository';
import { config } from '../config';
import {
  generateRide,
  deriveRideParams,
  deriveRideDurationSeconds,
  interpolateRideValue,
  computeTicketStrength,
  calculateFinalBoost,
  computeBoostModelDetails,
  calculateCombinedOdds,
  filterQualifyingSelections,
  calculateLinearBoostPctAtElapsed,
} from '../computations';
import type { Selection } from '../types/ticket';
import { ReasonCode } from '../types/reasonCodes';

export interface SimulationInput {
  profileId?: string;
  seed?: string;
  minBoostPct?: number;
  maxBoostPct?: number;
  samplePoints?: number;
  ticket?: {
    selections: Selection[];
  };
}

export interface SimulationPoint {
  time_pct: number;
  base_ride_value: number;
  final_boost_pct: number | null;
}

export interface SimulationResult {
  seed: string;
  config: {
    checkpoint_count: number;
    volatility: number;
    crash_pct: number;
    min_boost_pct: number;
    max_boost_pct: number;
    max_boost_min_selections: number | null;
    max_boost_min_combined_odds: number | null;
    max_eligibility_selection_weight: number;
    max_eligibility_odds_weight: number;
    effective_min_floor_rate: number;
    ride_mode: 'WAVES' | 'LINEAR';
  };
  ticket_analysis?: {
    qualifying_selections: number;
    combined_odds: number;
    ticket_strength: number;
  };
  checkpoints: Array<{
    index: number;
    time_offset_pct: number;
    base_boost_value: number;
  }>;
  curve: SimulationPoint[];
}

export interface ServiceResult<T> {
  success: boolean;
  data?: T;
  error?: {
    code: ReasonCode;
    message: string;
  };
}

/**
 * Admin-only service to output sample ride curves for a given profile/ticket configuration.
 * Used for internal tuning and visualization.
 */
export async function simulateRide(
  input: SimulationInput
): Promise<ServiceResult<SimulationResult>> {
  const seed = input.seed ?? `sim-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const durationSeconds = deriveRideDurationSeconds(
    seed,
    config.ride.minDurationSeconds,
    config.ride.maxDurationSeconds
  );
  const derived = deriveRideParams(seed, durationSeconds, config.ride.minCrashSeconds);

  let simulationConfig: {
    checkpointCount: number;
    volatility: number;
    crashPct: number;
    minBoostPct: number;
    maxBoostPct: number;
    maxBoostMinSelections: number | null;
    maxBoostMinCombinedOdds: number | null;
    maxEligibilitySelectionWeight: number;
    maxEligibilityOddsWeight: number;
    effectiveMinFloorRate: number;
    rideMode: 'WAVES' | 'LINEAR';
  } = {
    checkpointCount: derived.checkpointCount,
    volatility: derived.volatility,
    crashPct: derived.crashPct,
    minBoostPct: input.minBoostPct ?? 0.01,
    maxBoostPct: input.maxBoostPct ?? 1.0,
    maxBoostMinSelections: null,
    maxBoostMinCombinedOdds: null,
    maxEligibilitySelectionWeight: 0.75,
    maxEligibilityOddsWeight: 0.25,
    effectiveMinFloorRate: 0.35,
    rideMode: 'WAVES',
  };
  let minSelections = 3;
  let minSelectionOdds = 1.2;
  let minCombinedOdds = 3.0;

  // If profile ID provided, use its configuration
  if (input.profileId) {
    const profile = await rewardProfileRepository.findById(input.profileId);
    if (!profile) {
      return {
        success: false,
        error: {
          code: ReasonCode.PROFILE_NOT_FOUND,
          message: `Profile with ID ${input.profileId} not found`,
        },
      };
    }

    simulationConfig = {
      checkpointCount: derived.checkpointCount,
      volatility: derived.volatility,
      crashPct: derived.crashPct,
      minBoostPct: input.minBoostPct ?? profile.minBoostPct,
      maxBoostPct: input.maxBoostPct ?? profile.maxBoostPct,
      maxBoostMinSelections: profile.maxBoostMinSelections,
      maxBoostMinCombinedOdds: profile.maxBoostMinCombinedOdds,
      maxEligibilitySelectionWeight: profile.maxEligibilitySelectionWeight,
      maxEligibilityOddsWeight: profile.maxEligibilityOddsWeight,
      effectiveMinFloorRate: profile.effectiveMinFloorRate,
      rideMode: profile.rideMode,
    };
    minSelections = profile.minSelections;
    minSelectionOdds = profile.minSelectionOdds;
    minCombinedOdds = profile.minCombinedOdds;
  }

  // Analyze ticket if provided
  let ticketAnalysis: SimulationResult['ticket_analysis'];
  let ticketStrength = 0.5; // Default for simulation without ticket
  let qualifyingSelectionsForBoost = simulationConfig.maxBoostMinSelections ?? minSelections;
  let combinedOddsForBoost = simulationConfig.maxBoostMinCombinedOdds ?? minCombinedOdds;
  let rideTicketStrength = 0;

  if (input.ticket && input.ticket.selections.length > 0) {
    const { qualifying } = filterQualifyingSelections(
      input.ticket.selections,
      minSelectionOdds
    );
    const combinedOdds = calculateCombinedOdds(qualifying);
    ticketStrength = computeTicketStrength(qualifying.length, combinedOdds, {
      minSelections,
    });
    rideTicketStrength = ticketStrength;
    qualifyingSelectionsForBoost = qualifying.length;
    combinedOddsForBoost = combinedOdds;

    ticketAnalysis = {
      qualifying_selections: qualifying.length,
      combined_odds: combinedOdds,
      ticket_strength: ticketStrength,
    };
  }

  // Generate ride
  const ride = generateRide(seed, {
    ...simulationConfig,
    rideMode: simulationConfig.rideMode,
    ticketStrength: rideTicketStrength,
    durationSeconds,
    crashPct: simulationConfig.crashPct,
    minPeakDelaySeconds: 2,
  });

  const boostModelDetails = computeBoostModelDetails(
    qualifyingSelectionsForBoost,
    combinedOddsForBoost,
    {
      minBoostPct: simulationConfig.minBoostPct,
      maxBoostPct: simulationConfig.maxBoostPct,
      maxBoostMinSelections: simulationConfig.maxBoostMinSelections,
      maxBoostMinCombinedOdds: simulationConfig.maxBoostMinCombinedOdds,
      maxEligibilitySelectionWeight: simulationConfig.maxEligibilitySelectionWeight,
      maxEligibilityOddsWeight: simulationConfig.maxEligibilityOddsWeight,
      effectiveMinFloorRate: simulationConfig.effectiveMinFloorRate,
    }
  );

  // Generate sample curve points
  const samplePoints = input.samplePoints ?? 100;
  const curve: SimulationPoint[] = [];

  for (let i = 0; i <= samplePoints; i++) {
    const timePct = i / samplePoints;
    const baseRideValue = timePct >= simulationConfig.crashPct
      ? 0
      : interpolateRideValue(
          ride.checkpoints.map((cp) => ({
            index: cp.index,
            timeOffsetPct: cp.timeOffsetPct,
            baseBoostValue: cp.baseBoostValue,
          })),
          timePct
        );

    const hasEnded = timePct >= simulationConfig.crashPct;
    const finalBoostPct = hasEnded
      ? 0
      : simulationConfig.rideMode === 'LINEAR'
        ? calculateLinearBoostPctAtElapsed(
            timePct,
            simulationConfig.crashPct,
            boostModelDetails.effectiveMinBoost,
            boostModelDetails.effectiveMaxBoost
          )
        : calculateFinalBoost({
            rideValue: baseRideValue,
            ticketStrength,
            qualifyingSelections: qualifyingSelectionsForBoost,
            combinedOdds: combinedOddsForBoost,
            hasRideEnded: false,
            config: {
              minBoostPct: simulationConfig.minBoostPct,
              maxBoostPct: simulationConfig.maxBoostPct,
              maxBoostMinSelections: simulationConfig.maxBoostMinSelections,
              maxBoostMinCombinedOdds: simulationConfig.maxBoostMinCombinedOdds,
              maxEligibilitySelectionWeight: simulationConfig.maxEligibilitySelectionWeight,
              maxEligibilityOddsWeight: simulationConfig.maxEligibilityOddsWeight,
              effectiveMinFloorRate: simulationConfig.effectiveMinFloorRate,
            },
          });

    curve.push({
      time_pct: Math.round(timePct * 10000) / 10000,
      base_ride_value: Math.round(baseRideValue * 10000) / 10000,
      final_boost_pct: hasEnded ? 0 : Math.round(finalBoostPct * 10000) / 10000,
    });
  }

  return {
    success: true,
    data: {
      seed,
      config: {
        checkpoint_count: simulationConfig.checkpointCount,
        volatility: simulationConfig.volatility,
        crash_pct: simulationConfig.crashPct,
        min_boost_pct: simulationConfig.minBoostPct,
        max_boost_pct: simulationConfig.maxBoostPct,
        max_boost_min_selections: simulationConfig.maxBoostMinSelections,
        max_boost_min_combined_odds: simulationConfig.maxBoostMinCombinedOdds,
        max_eligibility_selection_weight: simulationConfig.maxEligibilitySelectionWeight,
        max_eligibility_odds_weight: simulationConfig.maxEligibilityOddsWeight,
        effective_min_floor_rate: simulationConfig.effectiveMinFloorRate,
        ride_mode: simulationConfig.rideMode,
      },
      ticket_analysis: ticketAnalysis,
      checkpoints: ride.checkpoints.map((cp) => ({
        index: cp.index,
        time_offset_pct: cp.timeOffsetPct,
        base_boost_value: cp.baseBoostValue,
      })),
      curve,
    },
  };
}

export const simulationService = {
  simulateRide,
};
