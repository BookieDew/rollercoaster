import { mkdirSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';
import type { EngineAdapter, LabConfig } from './adapter';
import { buildConfigs } from './configs';
import { summarize, toRecord, type RideRecord } from './metrics';
import { evaluatePolicies } from './policies';
import { renderReport, type ConfigResult } from './report';
import { renderGallery, type GalleryRide } from './gallery';
import { seedAt, uniformAt, uniformStream } from './seeds';

function parseArgs(argv: string[]) {
  const args: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) args[argv[i].slice(2)] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : 'true';
  }
  return args;
}

function loadAdapter(name: string): EngineAdapter {
  if (!/^[a-z0-9]+$/i.test(name)) throw new Error(`bad engine name: ${name}`);
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require(`./${name}Adapter`).adapter as EngineAdapter;
}

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / (xs.length || 1);

function main() {
  const args = parseArgs(process.argv.slice(2));
  const engine = args.engine ?? 'v3';
  const n = Number(args.n ?? 20000);
  const golden = Number(args.golden ?? 0);
  const seedBase = args['seed-base'] ?? 'ride-lab-v1';
  const stepMs = Number(args['step-ms'] ?? 50);
  const out = resolve(args.out ?? `docs/ai/audits/ride-lab-${engine}`);
  const adapter = loadAdapter(engine);
  const configs = buildConfigs();
  mkdirSync(out, { recursive: true });

  const results: ConfigResult[] = [];
  for (const cfg of configs) {
    const t0 = Date.now();
    const recs: RideRecord[] = [];
    for (let i = 0; i < n; i++) recs.push(toRecord(adapter.sample(seedAt(seedBase, 'ride', i), cfg), stepMs / 1000));
    const draws = recs.map((_, i) => uniformAt(seedBase, 'lock', i));
    results.push({
      config: cfg,
      effectiveMin: { mean: mean(recs.map((r) => r.effectiveMin)) },
      effectiveMax: { mean: mean(recs.map((r) => r.effectiveMax)) },
      distribution: summarize(recs, uniformStream(seedBase, `f8-${cfg.label}`)),
      policies: evaluatePolicies(recs, draws),
      runtimeSeconds: (Date.now() - t0) / 1000,
    });
    console.log(`${cfg.label}: ${n} rides in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  }

  const generatedAt = new Date().toISOString();
  writeFileSync(join(out, 'report.md'), renderReport({ engine, n, seedBase, stepMs, results, generatedAt }));
  writeFileSync(join(out, 'results.json'), JSON.stringify({ engine, n, seedBase, stepMs, generatedAt, results }, null, 1));

  const gallery: GalleryRide[] = [];
  for (const cfg of configs) {
    const perConfig = cfg.mode === 'WAVES' || cfg.mode === 'LINEAR' ? 8 : 8;
    for (let i = 0; i < perConfig; i++) {
      const seed = seedAt(seedBase, 'gallery', i);
      gallery.push({ seed, config: cfg, ride: adapter.sample(seed, cfg) });
    }
  }
  writeFileSync(join(out, 'gallery.html'), renderGallery(engine, gallery));

  if (golden > 0) writeFileSync(join(out, 'golden-corpus.json'), JSON.stringify(buildGolden(adapter, configs, seedBase, golden)));
  console.log(`wrote ${out}`);
}

function buildGolden(adapter: EngineAdapter, configs: LabConfig[], seedBase: string, count: number) {
  const rides = [];
  for (const cfg of configs) {
    for (let i = 0; i < count; i++) {
      const seed = seedAt(seedBase, 'golden', i);
      const r = adapter.sample(seed, cfg);
      // 60 points over the full duration, like the quote/lock effective-path samples.
      const path = Array.from({ length: 60 }, (_, k) => r.boostAt((k / 59) * r.durationSeconds));
      rides.push({
        seed, config: { label: cfg.label, mode: cfg.mode, ticket: cfg.ticket, profile: cfg.profile },
        durationSeconds: r.durationSeconds, outcome: r.outcome, terminalAtSeconds: r.terminalAtSeconds,
        effectiveMin: r.effectiveMin, effectiveMax: r.effectiveMax, path60: path,
      });
    }
  }
  return { engine: adapter.name, seedBase, count, rides };
}

main();
