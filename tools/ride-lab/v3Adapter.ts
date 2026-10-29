import type { EngineAdapter, LabConfig, SampledRide } from './adapter';
import {
  deriveRideDurationSeconds,
  deriveRideParams,
  generatePhaseCorrectedRide,
  interpolateRideValue,
  calculateFinalBoost,
  computeBoostModelDetails,
  calculateLinearBoostPctAtElapsed,
  computeLinearModeMaxBoostPct,
  deriveFeasibleCrashPhase,
} from '../../src/computations';

const MIN_DURATION = 2;
const MAX_DURATION = 15;
const MIN_CRASH = 2;

/** Current (V3) engine, built the way rewardOptInService / simulationService build a ride. */
export const adapter: EngineAdapter = {
  name: 'v3',
  sample(seed: string, cfg: LabConfig): SampledRide {
    const { profile, ticket } = cfg;
    const duration = deriveRideDurationSeconds(seed, MIN_DURATION, MAX_DURATION);
    const derived = deriveRideParams(seed, duration, MIN_CRASH);
    const finalCfg = {
      minBoostPct: profile.minBoostPct,
      maxBoostPct: profile.maxBoostPct,
      maxBoostMinSelections: profile.maxBoostMinSelections,
      maxBoostMinCombinedOdds: profile.maxBoostMinCombinedOdds,
      maxEligibilitySelectionWeight: profile.maxEligibilitySelectionWeight,
      maxEligibilityOddsWeight: profile.maxEligibilityOddsWeight,
      effectiveMinFloorRate: profile.effectiveMinFloorRate,
    };
    const ride = generatePhaseCorrectedRide(seed, {
      checkpointCount: derived.checkpointCount,
      volatility: derived.volatility,
      minBoostPct: profile.minBoostPct,
      maxBoostPct: profile.maxBoostPct,
      rideMode: cfg.mode,
      ticketStrength: ticket.ticketStrength,
      durationSeconds: duration,
      crashPct: derived.crashPct,
      minPeakDelaySeconds: 2,
      qualifyingSelections: ticket.qualifyingSelections,
      combinedOdds: ticket.combinedOdds,
      finalBoostConfig: finalCfg,
    });
    const model = computeBoostModelDetails(ticket.qualifyingSelections, ticket.combinedOdds, finalCfg);
    const crashPct = derived.crashPct;
    const crashed = crashPct < 1;
    const terminal = crashed ? crashPct * duration : duration;
    const cps = ride.checkpoints.map((cp) => ({ ...cp }));

    let linearMax = 0;
    if (cfg.mode === 'LINEAR') {
      linearMax = computeLinearModeMaxBoostPct({
        seed,
        checkpointCount: derived.checkpointCount,
        volatility: derived.volatility,
        rideDurationSeconds: duration,
        maximumModel: 'WAVES_PRE_CRASH_SUPREMUM_V2',
        crashPct,
        ticketStrength: ticket.ticketStrength,
        qualifyingSelections: ticket.qualifyingSelections,
        combinedOdds: ticket.combinedOdds,
        config: finalCfg,
        minBoostPct: profile.minBoostPct,
        maxBoostPct: profile.maxBoostPct,
      });
    }

    const live = (t: number): number => {
      const pct = t / duration;
      if (cfg.mode === 'LINEAR') {
        return calculateLinearBoostPctAtElapsed(pct, crashPct, model.effectiveMinBoost, linearMax);
      }
      return calculateFinalBoost({
        rideValue: interpolateRideValue(cps, pct),
        ticketStrength: ticket.ticketStrength,
        qualifyingSelections: ticket.qualifyingSelections,
        combinedOdds: ticket.combinedOdds,
        hasRideEnded: false,
        config: finalCfg,
      });
    };

    return {
      durationSeconds: duration,
      outcome: crashed ? 'CRASHED' : 'ENDED',
      terminalAtSeconds: terminal,
      // Only meaningful when the phase repair actually shaped the ride.
      reportedCrashPhase:
        cfg.mode === 'WAVES' && crashed && ride.phaseDiagnostics.status === 'REPAIRED'
          ? deriveFeasibleCrashPhase(seed)
          : undefined,
      boostAt: (t) => (t < 0 || t >= terminal ? 0 : live(t)),
      uncrashedBoostAt: (t) => live(Math.min(Math.max(t, 0), duration)),
      effectiveMin: model.effectiveMinBoost,
      effectiveMax: cfg.mode === 'LINEAR' ? linearMax : model.effectiveMaxBoost,
    };
  },
};
