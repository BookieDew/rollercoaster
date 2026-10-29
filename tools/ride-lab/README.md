# ride-lab

Measures a ride engine: distribution checks (95% intervals), payout under lock policies, a sample
gallery and a golden corpus. Reads math, changes none.

    npm run ride-lab -- --engine v3 --n 20000 --out <dir> [--golden 200] [--seed-base ride-lab-v1] [--step-ms 50]

Outputs in `<dir>`: `report.md`, `results.json`, `gallery.html` (self-contained SVG, 8 rides per
ticket config per mode), and with `--golden N` `golden-corpus.json` (N seeds per config: seed, config,
duration, outcome, terminal time, 60-point path over the full duration).

## Adding an engine
Create `tools/ride-lab/<name>Adapter.ts` exporting `adapter: EngineAdapter` (see `adapter.ts`) and run
with `--engine <name>`. `sample(seed, config)` returns duration, outcome, terminal time, optional
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
