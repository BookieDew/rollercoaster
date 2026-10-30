import { linearBoostAt, LINEAR_PACE_SECONDS } from './linear';
import { drawOutcome, type V4OutcomeDraws } from './outcome';
import { levelToPayout, payoutBand, round6, type PayoutBand } from './payout';
import { openStreams } from './rng';
import type { V4Ride, V4RideConfig, V4RideParams } from './types';
import { buildWavesSkeleton, highestLevel, levelAt, type WavesSkeleton } from './waves';

/**
 * Internal module. `createV4Ride` is re-exported by the public barrel (index.ts). `inspectV4Ride` is not:
 * it returns the full future path and the crash anchor, so it is for server-side tests and audit tooling
 * only and must never feed a response.
 */

/**
 * Creates a V4 ride from the secret 64-hex seed. Pure and deterministic: same seed and config give
 * a bit-identical ride. The seed is used only while building; the returned object does not hold it.
 */
export function createV4Ride(seedHex: string, config: V4RideConfig): V4Ride {
  return inspectV4Ride(seedHex, config).ride;
}

export interface V4RideInspection {
  ride: V4Ride;
  draws: V4OutcomeDraws;
  /** WAVES only. Contains the full future path: server-side tests and audit tooling only. */
  skeleton: WavesSkeleton | null;
}

/** Like createV4Ride, plus the raw draws and WAVES skeleton. Never for responses (see module note). */
export function inspectV4Ride(seedHex: string, config: V4RideConfig): V4RideInspection {
  validateConfig(config);
  const streams = openStreams(seedHex);
  try {
    const draws = drawOutcome(streams.draw, config);
    const shapeDraw = (counter: number) => streams.draw('shape', counter);
    const band = payoutBand(config);
    const rideMaximum = round6(levelToPayout(highestLevel(shapeDraw), band));
    const linearStart = round6(config.effectiveMin);
    const isWaves = config.mode === 'WAVES';
    const skeleton = isWaves
      ? buildWavesSkeleton(shapeDraw, {
          durationSeconds: draws.durationSeconds,
          anchorSeconds: draws.anchorSeconds,
          phase: draws.phase,
          phasePosition: draws.phasePosition,
          ticketStrength: config.ticketStrength,
        })
      : null;
    const params: V4RideParams = Object.freeze({
      mathVersion: 'V4',
      mode: config.mode,
      durationSeconds: draws.durationSeconds,
      outcome: draws.crashes ? 'CRASHED' : 'ENDED',
      crashAtSeconds: draws.crashes ? draws.anchorSeconds : null,
      crashBucket: draws.crashes ? draws.bucket : null,
      crashPhase: draws.crashes && isWaves ? draws.phase : null,
      linearPace: isWaves ? null : config.linearPace!,
      bandMin: round6(band.min),
      bandMax: round6(band.max),
      rideMaximum,
      linearCap: rideMaximum,
      linearStart,
      peakCount: skeleton ? skeleton.peakCount : null,
    } as const);
    const live = skeleton
      ? wavesCurve(skeleton, band)
      : linearCurve(linearStart, params.bandMax, rideMaximum, config.linearPace!);
    return { ride: makeRide(params, live), draws, skeleton };
  } finally {
    streams.close();
  }
}

function wavesCurve(skeleton: WavesSkeleton, band: PayoutBand): (t: number) => number {
  const path = { times: skeleton.times.slice(), levels: skeleton.levels.slice() };
  const frozenBand = { min: band.min, max: band.max };
  return (t) => round6(levelToPayout(levelAt(path, t), frozenBand));
}

function linearCurve(start: number, bandTop: number, cap: number, pace: NonNullable<V4RideConfig['linearPace']>) {
  return (t: number) => linearBoostAt(t, start, bandTop, cap, pace);
}

function makeRide(params: V4RideParams, live: (t: number) => number): V4Ride {
  const end = params.durationSeconds;
  const crash = params.crashAtSeconds;
  const at = (t: number, withCrash: boolean): number => {
    if (!Number.isFinite(t)) throw new Error('V4 boostAt needs a finite time');
    const time = t > 0 ? t : 0;
    if (time >= end) return 0;
    if (withCrash && crash !== null && time >= crash) return 0;
    return live(time);
  };
  return Object.freeze({
    params,
    boostAt: (t: number) => at(t, true),
    uncrashedBoostAt: (t: number) => at(t, false),
  });
}

function validateConfig(c: V4RideConfig): void {
  const finite = (name: string, value: number, min = 0) => {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < min) {
      throw new Error(`V4 config ${name} must be a finite number >= ${min}`);
    }
  };
  if (c.mode !== 'WAVES' && c.mode !== 'LINEAR') throw new Error('V4 config mode must be WAVES or LINEAR');
  finite('minBoostPct', c.minBoostPct);
  finite('maxBoostPct', c.maxBoostPct, c.minBoostPct);
  finite('effectiveMin', c.effectiveMin);
  finite('effectiveMax', c.effectiveMax, c.effectiveMin);
  finite('ticketStrength', c.ticketStrength);
  if (c.ticketStrength > 1) throw new Error('V4 config ticketStrength must be <= 1');
  finite('minDurationSeconds', c.minDurationSeconds, Number.MIN_VALUE);
  finite('maxDurationSeconds', c.maxDurationSeconds, c.minDurationSeconds);
  finite('minCrashSeconds', c.minCrashSeconds);
  if (c.minCrashSeconds > c.minDurationSeconds || c.minCrashSeconds >= c.maxDurationSeconds) {
    throw new Error(
      'V4 config minCrashSeconds must be <= minDurationSeconds and < maxDurationSeconds ' +
        '(otherwise short rides could never crash and the duration would predict the outcome)'
    );
  }
  if (c.mode === 'LINEAR' && !(c.linearPace && Object.prototype.hasOwnProperty.call(LINEAR_PACE_SECONDS, c.linearPace))) {
    throw new Error('V4 LINEAR config needs linearPace FAST, MEDIUM or SLOW');
  }
}
