import { createHash } from 'crypto';
import { createV4Ride, type V4LinearPace, type V4Mode, type V4RideConfig } from '../../../src/computations/v4';
import golden from './goldenVectors.fixture.json';

/**
 * Bit-exact pins for V4: 21 seeds x both modes (42 rides), covering EARLY/MID/LATE, UP/PEAK/DOWN,
 * no-crash rides, weak and strong tickets, all three LINEAR paces, and the two short-ride edge cases
 * (PEAK and DOWN anchors just after the 2 s climb end). Any change to the RNG, the draws or the shape
 * changes these numbers and needs a new math version.
 * Seeds: sha256("v4-golden-<n>"); samples at fixed times plus 1 ms before the crash.
 */
const CONFIGS: Record<string, Omit<V4RideConfig, 'mode' | 'linearPace'>> = {
  weak: { minBoostPct: 0.05, maxBoostPct: 1, effectiveMin: 0.083555, effectiveMax: 0.351792, ticketStrength: 0.042476, minDurationSeconds: 2, maxDurationSeconds: 15, minCrashSeconds: 2 },
  strong: { minBoostPct: 0.05, maxBoostPct: 1, effectiveMin: 0.3825, effectiveMax: 1, ticketStrength: 0.497082, minDurationSeconds: 2, maxDurationSeconds: 15, minCrashSeconds: 2 },
};

interface GoldenRide {
  id: string;
  seed: string;
  config: string;
  mode: V4Mode;
  pace: V4LinearPace;
  params: Record<string, unknown>;
  samples: [number, number][];
}

const rides = golden as unknown as GoldenRide[];

describe('V4 golden vectors', () => {
  it('covers at least 10 seeds in both modes and every bucket and phase', () => {
    const seeds = new Set(rides.map((r) => r.seed));
    expect(seeds.size).toBeGreaterThanOrEqual(10);
    for (const seed of seeds) {
      expect(rides.filter((r) => r.seed === seed).map((r) => r.mode).sort()).toEqual(['LINEAR', 'WAVES']);
    }
    const waves = rides.filter((r) => r.mode === 'WAVES').map((r) => r.params);
    for (const bucket of ['EARLY', 'MID', 'LATE']) expect(waves.some((p) => p.crashBucket === bucket)).toBe(true);
    for (const phase of ['UP', 'PEAK', 'DOWN']) expect(waves.some((p) => p.crashPhase === phase)).toBe(true);
    expect(waves.some((p) => p.outcome === 'ENDED')).toBe(true);
  });

  it.each(rides.map((r) => [`${r.id} ${r.mode} ${r.config}`, r] as const))('%s reproduces bit-exactly', (_name, r) => {
    expect(createHash('sha256').update(r.id).digest('hex')).toBe(r.seed);
    const ride = createV4Ride(r.seed, { ...CONFIGS[r.config], mode: r.mode, linearPace: r.pace });
    expect({ ...ride.params }).toEqual(r.params);
    for (const [t, value] of r.samples) expect([t, ride.boostAt(t)]).toEqual([t, value]);
  });
});
