import { buildConfigs } from '../../tools/ride-lab/configs';
import { computeCapTimes, renderComparison, type ResultsFile } from '../../tools/ride-lab/compare';
import { summarize, toRecord } from '../../tools/ride-lab/metrics';
import { evaluatePolicies } from '../../tools/ride-lab/policies';
import { seedAt, uniformAt, uniformStream } from '../../tools/ride-lab/seeds';
import type { EngineAdapter } from '../../tools/ride-lab/adapter';
import { adapter as v3 } from '../../tools/ride-lab/v3Adapter';
import { adapter as v4Default, createAdapter } from '../../tools/ride-lab/v4Adapter';

const N = 150;
const BASE = 'ride-lab-test';
const configs = buildConfigs();

function runLab(adapter: EngineAdapter, linearPace?: string): ResultsFile {
  return {
    engine: adapter.name,
    ...(linearPace ? { linearPace } : {}),
    n: N,
    seedBase: BASE,
    stepMs: 50,
    results: configs.map((cfg) => {
      const recs = Array.from({ length: N }, (_, i) => toRecord(adapter.sample(seedAt(BASE, 'ride', i), cfg), 0.05));
      return {
        config: cfg,
        effectiveMin: { mean: recs.reduce((a, r) => a + r.effectiveMin, 0) / N },
        effectiveMax: { mean: recs.reduce((a, r) => a + r.effectiveMax, 0) / N },
        distribution: summarize(recs, uniformStream(BASE, `f8-${cfg.label}`)),
        policies: evaluatePolicies(recs, recs.map((_, i) => uniformAt(BASE, 'lock', i))),
        runtimeSeconds: 0,
      };
    }),
  };
}

describe('ride lab v4 adapter', () => {
  it('samples rides inside the shared duration and crash bounds, deterministically', () => {
    const adapter = createAdapter({ linearPace: 'FAST' });
    for (const cfg of configs) {
      for (let i = 0; i < 60; i++) {
        const seed = seedAt(BASE, 'ride', i);
        const a = adapter.sample(seed, cfg);
        const b = adapter.sample(seed, cfg);
        expect(a.boostAt(1.234)).toBe(b.boostAt(1.234));
        expect(a.durationSeconds).toBeGreaterThanOrEqual(2);
        expect(a.durationSeconds).toBeLessThanOrEqual(15);
        expect(a.boostAt(a.terminalAtSeconds)).toBe(0);
        expect(a.boostAt(0)).toBeGreaterThan(0);
        expect(a.uncrashedBoostAt).toBeDefined();
        if (a.outcome === 'CRASHED') {
          expect(a.terminalAtSeconds).toBeGreaterThanOrEqual(2);
          expect(a.terminalAtSeconds).toBeLessThan(a.durationSeconds);
          // The crash-free curve keeps going where the real one is 0.
          expect(a.uncrashedBoostAt!(a.terminalAtSeconds)).toBeGreaterThan(0);
        } else {
          expect(a.terminalAtSeconds).toBe(a.durationSeconds);
        }
        // The engine only reports a phase for crashed WAVES rides.
        expect(a.reportedCrashPhase !== undefined).toBe(cfg.mode === 'WAVES' && a.outcome === 'CRASHED');
      }
    }
  });

  it('lets the pace change LINEAR but not WAVES, and rejects an unknown pace', () => {
    const wavesCfg = configs.find((c) => c.label === 'WAVES/medium')!;
    const linearCfg = configs.find((c) => c.label === 'LINEAR/medium')!;
    const seed = seedAt(BASE, 'ride', 3);
    const fast = createAdapter({ linearPace: 'FAST' });
    const slow = createAdapter({ linearPace: 'SLOW' });
    expect(fast.sample(seed, wavesCfg).boostAt(2.5)).toBe(slow.sample(seed, wavesCfg).boostAt(2.5));
    const f = fast.sample(seed, linearCfg);
    const s = slow.sample(seed, linearCfg);
    expect(f.outcome).toBe(s.outcome);
    expect(f.terminalAtSeconds).toBe(s.terminalAtSeconds);
    expect(f.boostAt(1.5)).toBeGreaterThan(s.boostAt(1.5));
    expect(() => createAdapter({ linearPace: 'TURBO' })).toThrow('bad linear pace');
    expect(v4Default.name).toBe('v4');
  });
});

describe('ride lab comparison report', () => {
  const v3Run = runLab(v3);
  const runs = { FAST: runLab(createAdapter({ linearPace: 'FAST' }), 'FAST'), MEDIUM: runLab(createAdapter({ linearPace: 'MEDIUM' }), 'MEDIUM'), SLOW: runLab(createAdapter({ linearPace: 'SLOW' }), 'SLOW') };
  const capTimes = computeCapTimes(N, BASE);
  const links = { v3: 'v3/gallery.html', v4: { FAST: 'f/gallery.html', MEDIUM: 'm/gallery.html', SLOW: 's/gallery.html' } };

  it('renders both modes, the pace section and every gallery link, byte-identically', () => {
    const a = renderComparison({ v3: v3Run, v4: runs, links, capTimes });
    const b = renderComparison({ v3: v3Run, v4: runs, links, capTimes });
    expect(a).toBe(b);
    for (const needle of ['## WAVES', '## LINEAR', 'comparing the three paces', 'v3/gallery.html', 'f/gallery.html', 'm/gallery.html', 's/gallery.html', 'giveaway gap', 'hindsight', 'ride still running at its cap', 'same for every ride of a ticket']) {
      expect(a).toContain(needle);
    }
    expect(a).toMatch(/V4 SLOW/);
    expect(a).not.toMatch(/NaN|undefined/);
  });

  it('measures the time to cap inside the pace time and ordered by pace', () => {
    for (const t of ['weak', 'medium', 'strong'] as const) {
      expect(capTimes.FAST[t].median).toBeGreaterThan(0);
      expect(capTimes.FAST[t].p90).toBeLessThanOrEqual(6);
      expect(capTimes.MEDIUM[t].p90).toBeLessThanOrEqual(9);
      expect(capTimes.SLOW[t].p90).toBeLessThanOrEqual(12);
      expect(capTimes.FAST[t].median).toBeLessThan(capTimes.MEDIUM[t].median);
      expect(capTimes.MEDIUM[t].median).toBeLessThan(capTimes.SLOW[t].median);
      expect(capTimes.SLOW[t].reachedShare).toBeLessThan(capTimes.FAST[t].reachedShare);
    }
  });

  it('refuses to compare runs made with different arguments', () => {
    expect(() => renderComparison({ v3: { ...v3Run, n: N + 1 }, v4: runs, links, capTimes })).toThrow('differ in n');
  });
});
