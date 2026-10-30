import type { EngineAdapter, LabConfig, SampledRide } from './adapter';
import { computeBoostModelDetails } from '../../src/computations';
import { createV4Ride, LINEAR_PACE_SECONDS, type V4LinearPace } from '../../src/computations/v4';

// Same bounds as v3Adapter / the production ride builders.
const MIN_DURATION = 2;
const MAX_DURATION = 15;
const MIN_CRASH = 2;

export const LINEAR_PACES: readonly V4LinearPace[] = ['FAST', 'MEDIUM', 'SLOW'];

export function isLinearPace(value: string): value is V4LinearPace {
  return (LINEAR_PACES as readonly string[]).includes(value);
}

const ENGINE_FINAL_KEYS = (profile: LabConfig['profile']) => ({
  minBoostPct: profile.minBoostPct,
  maxBoostPct: profile.maxBoostPct,
  maxBoostMinSelections: profile.maxBoostMinSelections,
  maxBoostMinCombinedOdds: profile.maxBoostMinCombinedOdds,
  maxEligibilitySelectionWeight: profile.maxEligibilitySelectionWeight,
  maxEligibilityOddsWeight: profile.maxEligibilityOddsWeight,
  effectiveMinFloorRate: profile.effectiveMinFloorRate,
});

function buildRide(seed: string, cfg: LabConfig, pace: V4LinearPace) {
  const { profile, ticket } = cfg;
  const model = computeBoostModelDetails(ticket.qualifyingSelections, ticket.combinedOdds, ENGINE_FINAL_KEYS(profile));
  const ride = createV4Ride(seed, {
    mode: cfg.mode,
    minBoostPct: profile.minBoostPct,
    maxBoostPct: profile.maxBoostPct,
    effectiveMin: model.effectiveMinBoost,
    effectiveMax: model.effectiveMaxBoost,
    ticketStrength: ticket.ticketStrength,
    minDurationSeconds: MIN_DURATION,
    maxDurationSeconds: MAX_DURATION,
    minCrashSeconds: MIN_CRASH,
    linearPace: cfg.mode === 'LINEAR' ? pace : undefined,
  });
  return { ride, model };
}

/**
 * LINEAR only: when the ride's own climb reaches this ride's cap (independent of crash and ride length),
 * and when the ride ends or crashes. The climb is start + (bandTop - start) * g(t / T) with
 * g(s) = 0.4 s + 0.6 s^2, stopped at the cap, so the cap is reached where g(s) = (cap - start) / (bandTop - start).
 */
export function linearCapReach(seed: string, cfg: LabConfig, pace: V4LinearPace): { capSeconds: number; terminalSeconds: number } {
  if (cfg.mode !== 'LINEAR') throw new Error('linearCapReach is LINEAR only');
  const p = buildRide(seed, cfg, pace).ride.params;
  const span = p.bandMax - p.linearStart;
  const r = span > 0 ? Math.min(1, Math.max(0, (p.linearCap - p.linearStart) / span)) : 1;
  const s = (-0.4 + Math.sqrt(0.16 + 2.4 * r)) / 1.2;
  return {
    capSeconds: s * LINEAR_PACE_SECONDS[pace],
    terminalSeconds: p.outcome === 'CRASHED' ? (p.crashAtSeconds as number) : p.durationSeconds,
  };
}

/**
 * V4 engine, built through the public V4 API only. `linearPace` only affects LINEAR configs
 * (WAVES rides are identical for every pace).
 */
export function createAdapter(opts: { linearPace?: string } = {}): EngineAdapter {
  const pace = opts.linearPace ?? 'MEDIUM';
  if (!isLinearPace(pace)) throw new Error(`bad linear pace: ${pace} (expected FAST, MEDIUM or SLOW)`);
  return {
    name: 'v4',
    sample(seed: string, cfg: LabConfig): SampledRide {
      const { ride, model } = buildRide(seed, cfg, pace);
      const p = ride.params;
      const crashed = p.outcome === 'CRASHED';
      return {
        durationSeconds: p.durationSeconds,
        outcome: p.outcome,
        terminalAtSeconds: crashed ? (p.crashAtSeconds as number) : p.durationSeconds,
        reportedCrashPhase: p.crashPhase ?? undefined,
        boostAt: (t) => ride.boostAt(t),
        uncrashedBoostAt: (t) => ride.uncrashedBoostAt(t),
        effectiveMin: model.effectiveMinBoost,
        // Like v3: LINEAR measures against its own cap (the ride maximum), WAVES against the ticket cap.
        effectiveMax: cfg.mode === 'LINEAR' ? p.linearCap : model.effectiveMaxBoost,
      };
    },
  };
}

export const adapter: EngineAdapter = createAdapter();
