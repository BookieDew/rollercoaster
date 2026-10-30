# ride-lab

Measures a ride engine: distribution checks (95% intervals), payout under lock policies, a sample
gallery and a golden corpus. Reads math, changes none.

    npm run ride-lab -- --engine v3 --n 20000 --out <dir> [--golden 200] [--seed-base ride-lab-v1] [--step-ms 50]

Outputs in `<dir>`: `report.md`, `results.json`, `gallery.html` (self-contained SVG, 8 rides per
ticket config per mode), and with `--golden N` `golden-corpus.json` (N seeds per config: seed, config,
duration, outcome, terminal time, 60-point path over the full duration).

`results.json` holds no wall-clock fields except `generatedAt`, so the same arguments give the same file
(ignoring `generatedAt`). Console lines carry the per-config run time.

## V4 and the V3 -> V4 comparison
`v4Adapter.ts` builds rides only through the public `src/computations/v4` API, with the same profile/ticket
mapping and duration bounds as `v3Adapter.ts` (2-15 s, minimum crash 2 s). It reports the engine's crash
phase and the crash-free curve (F8 baseline). LINEAR needs a pace: `--linear-pace fast|medium|slow`
(any engine that exports `createAdapter({ linearPace })`; WAVES ignores it).

    for p in fast medium slow; do
      npm run ride-lab -- --engine v4 --linear-pace $p --n 20000 --out docs/ai/audits/2026-10-30-v4-evidence/v4-$p
    done
    npm run ride-lab:compare            # -> docs/ai/audits/2026-10-30-v4-evidence/comparison.md

`compare.ts` reads the V3 baseline (`docs/ai/audits/2026-10-29-v3-baseline/results.json`) and the three V4
`results.json` files and writes one plain-language file for the owner (no clock or randomness: byte-identical
for identical inputs). Options: `--v3 <results.json>`, `--v4-dir <dir with v4-fast|v4-medium|v4-slow>`,
`--out <file>`. It refuses to compare runs with different n, seed base or step, and checks that WAVES and the
crash outcomes do not depend on the LINEAR pace.

## Adding an engine
Create `tools/ride-lab/<name>Adapter.ts` exporting `adapter: EngineAdapter` (see `adapter.ts`) and run
with `--engine <name>`. Optionally also export `createAdapter(opts)` (used for `--linear-pace`). `sample(seed, config)` returns duration, outcome, terminal time, optional
engine-reported crash phase, `boostAt(t)` (final payout rate, 0 at/after terminal), optional
`uncrashedBoostAt(t)` (needed for the F8 baseline), and effective min/max.

## Seeds
64-hex, `HMAC-SHA256(key = seed base, msg = "ride-lab|<label>|<counter>")`; same base and n give the
same report. Labels: `ride`, `lock`, `gallery`, `golden`, `f8-<config>`.

## Configs (`configs.ts`)
One profile (boost 5%-100%, min 3 selections / odds 3, full cap at 6 selections / odds 20, weights
.75/.25, floor .35) and weak/medium/strong tickets (3 sel odds 3.5; 5 sel odds 10; 8 sel odds 60), for
WAVES and LINEAR.

## Measure definitions
Documented in the report itself (observed phase, peak/turn rule, plateau, horn proxy, F8 tell and its
baseline) and in `metrics.ts` / `policies.ts`. Rates are read from the time grid (default 50 ms).

Note: `tools/` is type-checked by `npm run typecheck` (tsconfig include) but is not part of the build output.
