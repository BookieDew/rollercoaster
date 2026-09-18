import { createHash } from 'crypto';
import { generateRide, type RideConfig, type RideCheckpoint, type CrashPhase } from './deterministicRideGenerator';
import { calculateFinalBoost, computeBoostModelDetails, type FinalBoostConfig } from './finalBoostCalculator';
import { getMaxRideValue } from './rideReferenceMaximum';
import type { RidePhaseDiagnostics } from '../types/ride';

export interface PhaseRideConfig extends RideConfig {
  qualifyingSelections: number;
  combinedOdds: number;
  finalBoostConfig: FinalBoostConfig;
  durationSeconds: number;
  crashPct: number;
  /** Operator no-ticket exploration retains its distinct evaluation strength. */
  evaluationTicketStrength?: number;
}

export function deriveFeasibleCrashPhase(seed: string): CrashPhase {
  const roll = parseInt(createHash('sha256').update(`crash-phase-v2:${seed}`).digest('hex').slice(0, 8), 16) / 2 ** 32;
  return roll < 0.5 ? 'UP' : roll < 0.7 ? 'PEAK' : 'DOWN';
}

/** New-ride model only. The legacy generator and its random draws stay intact. */
export function generatePhaseCorrectedRide(seed: string, config: PhaseRideConfig): {
  seed: string;
  checkpoints: RideCheckpoint[];
  phaseDiagnostics: RidePhaseDiagnostics;
} {
  const original = generateRide(seed, config);
  const diagnostic: RidePhaseDiagnostics = {
    model: 'FEASIBLE_WAVES_PHASE_V3', status: 'NOT_APPLICABLE_LINEAR',
    checkpointStorage: 'MATH_SNAPSHOT_JSON_V3',
  };
  const unchanged = () => ({ ...original, phaseDiagnostics: diagnostic });
  if (config.rideMode === 'LINEAR') return unchanged();

  const strength = config.evaluationTicketStrength ?? config.ticketStrength ?? 0;
  const payout = (rideValue: number) => calculateFinalBoost({
    rideValue, ticketStrength: strength, qualifyingSelections: config.qualifyingSelections,
    combinedOdds: config.combinedOdds, hasRideEnded: false, config: config.finalBoostConfig,
  });
  const model = computeBoostModelDetails(config.qualifyingSelections, config.combinedOdds, config.finalBoostConfig);
  const maximumRaw = getMaxRideValue(original.checkpoints, config.crashPct, 'WAVES_PRE_CRASH_SUPREMUM_V2');
  const maximum = payout(maximumRaw);
  const lower = Math.max(model.effectiveMinBoost, payout(config.minBoostPct));
  Object.assign(diagnostic, { baselineMaximumBoostPct: maximum, reachableLowerBoostPct: lower });
  if (config.crashPct >= 1) {
    diagnostic.status = 'NO_CRASH_UNCHANGED';
    return unchanged();
  }
  const range = maximum - lower;
  if (range <= 0.00002) {
    diagnostic.status = 'FLAT_OR_ROUNDING_DEGENERATE';
    return unchanged();
  }
  const crashSeconds = config.crashPct * config.durationSeconds;
  const last = original.checkpoints.filter(cp => cp.timeOffsetPct < config.crashPct).slice(-1)[0];
  const lastSeconds = last.timeOffsetPct * config.durationSeconds;
  const suffixStart = Math.max(2, crashSeconds - 0.8,
    crashSeconds - lastSeconds >= 0.6 - 1e-9 ? lastSeconds : 0);
  if (crashSeconds - suffixStart < 0.6 - 1e-9) {
    diagnostic.status = 'TIMING_CONSTRAINED';
    return unchanged();
  }

  const phase = deriveFeasibleCrashPhase(seed);
  const volatility = 0.5 + strength * 0.8;
  const multiplier = 0.4 + strength * 0.6;
  const midpoint = (model.effectiveMinBoost + model.effectiveMaxBoost) / 2;
  const inverse = (value: number) => (value / multiplier - midpoint * (1 - volatility)) / volatility;
  const rawForPayout = (target: number) => {
    const ideal = inverse(target);
    const nearest = round6(ideal);
    // The interpolator rounds raw boosts before the final affine transform. A
    // target produced by that transform may need an adjacent raw micro-unit.
    for (const offset of [0, 1, -1, 2, -2]) {
      const candidate = round6(nearest + offset * 0.000001);
      if (payout(candidate) === target) return candidate;
    }
    // Some interior final micro-units are unreachable at high strength. Keep
    // the exact inverse and retain the existing evaluator's <=1e-6 rounding.
    return ideal;
  };
  const startPct = suffixStart / config.durationSeconds;
  const startRaw = interpolateUnrounded(original.checkpoints, startPct);
  const points = original.checkpoints.filter(cp => cp.timeOffsetPct < startPct).map(cp => ({ ...cp }));
  // Do not round this inserted collinear point or its timestamp: doing so changes
  // the original interpolated prefix. V3 stores these doubles in immutable JSON.
  const originalUpper = original.checkpoints.find(cp => cp.timeOffsetPct >= startPct)!;
  points.push({
    index: points.length, timeOffsetPct: startPct, baseBoostValue: startRaw,
    incomingSegmentEnd: { timeOffsetPct: originalUpper.timeOffsetPct, baseBoostValue: originalUpper.baseBoostValue },
  });
  const retainedMax = Math.max(...points.map(cp => payout(round6(cp.baseBoostValue))));
  const effectiveStartRaw = rawForPayout(payout(round6(startRaw)));
  // A clamped raw value can lie outside the affine inverse of its payout. The
  // paired boundary retains the exact incoming raw segment, then starts the
  // outgoing segment at the equivalent payout. Equal timestamps are deliberate:
  // interpolateRideValue skips zero-width pairs, with no effective-value jump.
  if (effectiveStartRaw !== startRaw) {
    points.push({ index: points.length, timeOffsetPct: startPct, baseBoostValue: effectiveStartRaw });
  }
  let anchorSeconds: number | undefined;
  if (retainedMax < maximum) {
    anchorSeconds = suffixStart + (crashSeconds - suffixStart - 0.4) / 2;
    const anchorRaw = rawForPayout(maximum);
    if (payout(round6(anchorRaw)) !== maximum) throw new Error('Unrepresentable preserved phase maximum');
    points.push({ index: points.length, timeOffsetPct: anchorSeconds / config.durationSeconds, baseBoostValue: anchorRaw });
  }

  const targets = phase === 'UP' ? [0.65, 0.85] : phase === 'DOWN' ? [0.85, 0.65] : [0.975, 0.99];
  for (let i = 0; i < targets.length; i++) {
    const target = round6(lower + targets[i] * range);
    points.push({
      index: points.length,
      timeOffsetPct: i === 0 ? (crashSeconds - 0.4) / config.durationSeconds : config.crashPct,
      baseBoostValue: rawForPayout(target),
    });
  }
  points.push({ index: points.length, timeOffsetPct: 1, baseBoostValue: 0 });
  return {
    seed, checkpoints: points,
    phaseDiagnostics: {
      ...diagnostic, status: 'REPAIRED', phase, suffixStartSeconds: suffixStart,
      phaseWindowSeconds: 0.4, ...(anchorSeconds === undefined ? {} : { maximumAnchorSeconds: anchorSeconds }),
    },
  };
}

function interpolateUnrounded(points: RideCheckpoint[], time: number): number {
  for (let i = 1; i < points.length; i++) {
    if (time <= points[i].timeOffsetPct) {
      const before = points[i - 1], after = points[i];
      return before.baseBoostValue + (after.baseBoostValue - before.baseBoostValue) *
        ((time - before.timeOffsetPct) / (after.timeOffsetPct - before.timeOffsetPct));
    }
  }
  return points[points.length - 1].baseBoostValue;
}

function round6(value: number): number { return Math.round(value * 1e6) / 1e6; }
