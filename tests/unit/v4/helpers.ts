import { createHash, createHmac } from 'crypto';
import { computeBoostModelDetails, type FinalBoostConfig } from '../../../src/computations/finalBoostCalculator';
import { computeTicketStrength } from '../../../src/computations/ticketStrengthScorer';
import type { V4LinearPace, V4Mode, V4RideConfig } from '../../../src/computations/v4';

/** The ride-lab profile: boost 5 %..100 %, min 3 selections / odds 3, full cap at 6 selections / odds 20. */
export const PROFILE: FinalBoostConfig & { minSelections: number } = {
  minBoostPct: 0.05,
  maxBoostPct: 1,
  maxBoostMinSelections: 6,
  maxBoostMinCombinedOdds: 20,
  maxEligibilitySelectionWeight: 0.75,
  maxEligibilityOddsWeight: 0.25,
  effectiveMinFloorRate: 0.35,
  minSelections: 3,
};

export const TICKETS = {
  weak: { qualifyingSelections: 3, combinedOdds: 3.5 },
  medium: { qualifyingSelections: 5, combinedOdds: 10 },
  strong: { qualifyingSelections: 8, combinedOdds: 60 },
} as const;

export type TicketName = keyof typeof TICKETS;

/** V4 config built the way the services build V3 inputs (cap/floor and strength formulas unchanged). */
export function labConfig(ticket: TicketName, mode: V4Mode = 'WAVES', linearPace: V4LinearPace = 'MEDIUM'): V4RideConfig {
  const t = TICKETS[ticket];
  const model = computeBoostModelDetails(t.qualifyingSelections, t.combinedOdds, PROFILE);
  return {
    mode,
    minBoostPct: PROFILE.minBoostPct,
    maxBoostPct: PROFILE.maxBoostPct,
    effectiveMin: model.effectiveMinBoost,
    effectiveMax: model.effectiveMaxBoost,
    ticketStrength: computeTicketStrength(t.qualifyingSelections, t.combinedOdds, { minSelections: PROFILE.minSelections }),
    minDurationSeconds: 2,
    maxDurationSeconds: 15,
    minCrashSeconds: 2,
    ...(mode === 'LINEAR' ? { linearPace } : {}),
  };
}

export function namedSeed(label: string): string {
  return createHash('sha256').update(label).digest('hex');
}

/** Reproducible 64-hex seeds for sampling. */
export function sampleSeed(base: string, i: number): string {
  return createHmac('sha256', base).update(`seed|${i}`).digest('hex');
}

/** Independent uniform stream (for redrawn crash times in the F8 baseline). */
export function sampleUniform(base: string, i: number): number {
  const block = createHmac('sha256', base).update(`u|${i}`).digest();
  return (block.readUInt32BE(0) * 2 ** 21 + (block.readUInt32BE(4) >>> 11)) / 2 ** 53;
}

const Z999 = 3.2905;

/** Two-sided 99.9 % normal-approximation bound for a count of a proportion p in n trials. */
export function expectProportion(count: number, n: number, p: number, label: string): void {
  const half = Z999 * Math.sqrt(n * p * (1 - p)) + 0.5;
  const ok = Math.abs(count - n * p) <= half;
  if (!ok) {
    throw new Error(`${label}: ${count}/${n} = ${(count / n).toFixed(4)} outside 99.9% bound of ${p}`);
  }
}

export const DURATION_THIRDS = [
  { label: '2.0-6.3 s', from: 2, to: 2 + 13 / 3 },
  { label: '6.3-10.7 s', from: 2 + 13 / 3, to: 2 + 26 / 3 },
  { label: '10.7-15.0 s', from: 2 + 26 / 3, to: 15.000001 },
];

export function thirdOf(durationSeconds: number): number {
  return DURATION_THIRDS.findIndex((t) => durationSeconds >= t.from && durationSeconds < t.to);
}
