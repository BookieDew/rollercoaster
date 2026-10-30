import { createHash, randomBytes } from 'crypto';
import { rewardProfileRepository } from '../db/repositories/rewardProfileRepository';
import { config } from '../config';
import { computeBoostModelDetails } from '../computations';
import {
  createV4Ride,
  type V4CrashBucket,
  type V4CrashPhase,
  type V4LinearPace,
  type V4Outcome,
} from '../computations/v4';
import type { Selection } from '../types/ticket';
import { ReasonCode } from '../types/reasonCodes';
import { MAXIMUM_MODEL_V4, type MaximumModel } from '../types/ride';
import { LINEAR_PACE } from './rideMathSnapshot';
import { evaluateTicket } from './ticketEvaluation';

export interface SimulationInput {
  profileId?: string;
  /** Any string. A 64-hex seed is used as is; any other string is hashed (SHA-256) into one. */
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
  /** Payout of the ride at this time (0 at/after the crash and at the end), whatever the ticket's eligibility. */
  base_ride_value: number;
  /** base_ride_value for an eligible or exploratory ticket; null for an ineligible ticket. */
  final_boost_pct: number | null;
}

export interface SimulationResult {
  seed: string;
  evaluation_mode: 'TICKET' | 'EXPLORATORY';
  eligible: boolean | null;
  reason_code: ReasonCode | null;
  /** Both sample times and boost values retain the existing four-decimal serialization. */
  serialization_decimals: 4;
  maximum_model: MaximumModel;
  math_snapshot_version: 4;
  /** The whole ride, future included: admin simulation only, never a live response. */
  ride: {
    duration_seconds: number;
    outcome: V4Outcome;
    crash_at_seconds: number | null;
    crash_bucket: V4CrashBucket | null;
    crash_phase: V4CrashPhase | null;
    linear_pace: V4LinearPace | null;
    peak_count: number | null;
    band_min_pct: number;
    band_max_pct: number;
    ride_maximum_pct: number;
    pre_crash_maximum_pct: number;
  };
  config: {
    crash_pct: number;
    min_boost_pct: number;
    max_boost_pct: number;
    max_boost_min_selections: number | null;
    max_boost_min_combined_odds: number | null;
    max_eligibility_selection_weight: number;
    max_eligibility_odds_weight: number;
    effective_min_floor_rate: number;
    ride_mode: 'WAVES' | 'LINEAR';
    effective_min_boost_pct: number;
    effective_max_boost_pct: number;
    ticket_strength: number;
  };
  ticket_analysis?: {
    qualifying_selections: number;
    /** Exact decimal string when the combined odds are beyond the double range. */
    combined_odds: number | string;
    ticket_strength: number;
  };
  curve: SimulationPoint[];
}

/** Exploratory simulations (no ticket) use this ticket strength. */
const EXPLORATORY_TICKET_STRENGTH = 0.5;
const HEX_SEED = /^[0-9a-fA-F]{64}$/;

/** Default: 32 random bytes from the OS CSPRNG. An explicit seed is kept; non-hex strings are hashed into a key. */
function simulationSeed(explicit: string | undefined): { seed: string; key: string } {
  if (explicit === undefined) {
    const seed = randomBytes(32).toString('hex');
    return { seed, key: seed };
  }
  return {
    seed: explicit,
    key: HEX_SEED.test(explicit) ? explicit : createHash('sha256').update(explicit, 'utf8').digest('hex'),
  };
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
  const { seed, key } = simulationSeed(input.seed);

  let simulationConfig: {
    minBoostPct: number;
    maxBoostPct: number;
    maxBoostMinSelections: number | null;
    maxBoostMinCombinedOdds: number | null;
    maxEligibilitySelectionWeight: number;
    maxEligibilityOddsWeight: number;
    effectiveMinFloorRate: number;
    rideMode: 'WAVES' | 'LINEAR';
  } = {
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

  if (simulationConfig.minBoostPct > simulationConfig.maxBoostPct) {
    return {
      success: false,
      error: {
        code: ReasonCode.INVALID_CONFIGURATION,
        message: 'Resolved minimum boost must not exceed maximum boost',
      },
    };
  }

  // Analyze the ticket if provided (exact combined odds); otherwise explore at the max-boost targets.
  let ticketAnalysis: SimulationResult['ticket_analysis'];
  let eligibilityReason: ReasonCode | null = null;
  let ticketStrength = EXPLORATORY_TICKET_STRENGTH;
  let boostModel = computeBoostModelDetails(
    simulationConfig.maxBoostMinSelections ?? minSelections,
    simulationConfig.maxBoostMinCombinedOdds ?? minCombinedOdds,
    simulationConfig
  );
  if (input.ticket) {
    const ticket = evaluateTicket(input.ticket.selections, {
      ...simulationConfig,
      minSelections,
      minSelectionOdds,
      minCombinedOdds,
    });
    ticketStrength = ticket.ticketStrength;
    boostModel = ticket.boostModel;
    eligibilityReason = ticket.reason;
    ticketAnalysis = {
      qualifying_selections: ticket.qualifying.length,
      combined_odds: ticket.combinedOddsDisplay,
      ticket_strength: ticket.ticketStrength,
    };
  }

  const ride = createV4Ride(key, {
    mode: simulationConfig.rideMode,
    minBoostPct: simulationConfig.minBoostPct,
    maxBoostPct: simulationConfig.maxBoostPct,
    effectiveMin: boostModel.effectiveMinBoost,
    effectiveMax: boostModel.effectiveMaxBoost,
    ticketStrength,
    minDurationSeconds: config.ride.minDurationSeconds,
    maxDurationSeconds: config.ride.maxDurationSeconds,
    minCrashSeconds: config.ride.minCrashSeconds,
    linearPace: simulationConfig.rideMode === 'LINEAR' ? LINEAR_PACE : undefined,
  });
  const p = ride.params;
  const terminalSeconds = p.crashAtSeconds ?? p.durationSeconds;
  const isIneligible = input.ticket !== undefined && eligibilityReason !== ReasonCode.ELIGIBLE;

  // Generate sample curve points
  const samplePoints = input.samplePoints ?? 100;
  const curve: SimulationPoint[] = [];
  for (let i = 0; i <= samplePoints; i++) {
    const timePct = i / samplePoints;
    const value = ride.boostAt(timePct * p.durationSeconds);
    curve.push({
      time_pct: round4(timePct),
      base_ride_value: round4(value),
      final_boost_pct: isIneligible ? null : round4(value),
    });
  }

  return {
    success: true,
    data: {
      seed,
      evaluation_mode: input.ticket ? 'TICKET' : 'EXPLORATORY',
      eligible: input.ticket ? !isIneligible : null,
      reason_code: eligibilityReason,
      serialization_decimals: 4,
      maximum_model: MAXIMUM_MODEL_V4,
      math_snapshot_version: 4,
      ride: {
        duration_seconds: p.durationSeconds,
        outcome: p.outcome,
        crash_at_seconds: p.crashAtSeconds,
        crash_bucket: p.crashBucket,
        crash_phase: p.crashPhase,
        linear_pace: p.linearPace,
        peak_count: p.peakCount,
        band_min_pct: p.bandMin,
        band_max_pct: p.bandMax,
        ride_maximum_pct: p.rideMaximum,
        pre_crash_maximum_pct: ride.maximumBefore(terminalSeconds),
      },
      config: {
        crash_pct: terminalSeconds / p.durationSeconds,
        min_boost_pct: simulationConfig.minBoostPct,
        max_boost_pct: simulationConfig.maxBoostPct,
        max_boost_min_selections: simulationConfig.maxBoostMinSelections,
        max_boost_min_combined_odds: simulationConfig.maxBoostMinCombinedOdds,
        max_eligibility_selection_weight: simulationConfig.maxEligibilitySelectionWeight,
        max_eligibility_odds_weight: simulationConfig.maxEligibilityOddsWeight,
        effective_min_floor_rate: simulationConfig.effectiveMinFloorRate,
        ride_mode: simulationConfig.rideMode,
        effective_min_boost_pct: boostModel.effectiveMinBoost,
        effective_max_boost_pct: boostModel.effectiveMaxBoost,
        ticket_strength: ticketStrength,
      },
      ticket_analysis: ticketAnalysis,
      curve,
    },
  };
}

function round4(value: number): number {
  return Math.round(value * 10000) / 10000;
}

export const simulationService = {
  simulateRide,
};
