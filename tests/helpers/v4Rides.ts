import { createHash } from 'crypto';
import { createV4Ride, type V4RideParams } from '../../src/computations/v4';
import { config } from '../../src/config';
import type { RideMathSnapshotV4 } from '../../src/types/ride';

/** The retired V1 seed derivation from public IDs: new seeds must never equal it. */
export function legacyPublicIdSeed(rewardId: string, userId: string, profileVersionId: string): string {
  return createHash('sha256').update(`${rewardId}:${userId}:${profileVersionId}`).digest('hex');
}

/** Deterministic 64-hex test seed. */
export function testSeed(label: string): string {
  return createHash('sha256').update(`test-seed|${label}`).digest('hex');
}

/**
 * First test seed whose V4 ride (under the test ride limits) satisfies the predicate. Duration, outcome
 * and crash time depend only on the seed and the limits, never on the ticket, so any ticket works.
 */
export function findSeed(label: string, predicate: (params: V4RideParams) => boolean): string {
  for (let i = 0; i < 10_000; i += 1) {
    const seed = testSeed(`${label}-${i}`);
    const params = createV4Ride(seed, {
      mode: 'WAVES',
      minBoostPct: 0.05,
      maxBoostPct: 0.5,
      effectiveMin: 0.05,
      effectiveMax: 0.5,
      ticketStrength: 0.5,
      ...config.ride,
    }).params;
    if (predicate(params)) return seed;
  }
  throw new Error(`no test seed for ${label}`);
}

/** A moment (epoch ms) inside the live part of a frozen ride: 40 % of the way to its crash or end. */
export function liveMomentMs(math: RideMathSnapshotV4): number {
  const terminal = math.crashAtSeconds ?? math.rideDurationSeconds;
  return Date.parse(math.startTime) + Math.floor(terminal * 1000 * 0.4);
}
