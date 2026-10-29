# Demo UI verification

The demo uses server samples, not a browser payout model. These checks are separate
from Jest backend coverage.

```sh
node --test tests/ui/ride-observer.test.cjs
npm run build
node tests/ui/demo-server.cjs
```

The last command starts the real application on `127.0.0.1:4318`, with a new
SQLite file inside an OS temporary directory on every run. It does not read or
write `dev.db`. Its console prints the PID/database path. API/admin key:
`demo-ui-test-key`. Stop only that owned PID when done.

Use a named Playwright CLI browser session, open
`http://127.0.0.1:4318/demo/`, and take a snapshot before running workflows:

```sh
playwright-cli -s=rollercoaster-ui open http://127.0.0.1:4318/demo/ --headed
playwright-cli -s=rollercoaster-ui snapshot
playwright-cli -s=rollercoaster-ui run-code --filename tests/ui/real-workflow.js
playwright-cli -s=rollercoaster-ui run-code --filename tests/ui/editor-mobile.js
playwright-cli -s=rollercoaster-ui run-code --filename tests/ui/browser-regressions.js
playwright-cli -s=rollercoaster-ui run-code --filename tests/ui/modern-responsive.js
playwright-cli -s=rollercoaster-ui run-code --filename tests/ui/modern-high-boost.js
playwright-cli -s=rollercoaster-ui run-code --filename tests/ui/desktop-scrolling.js
playwright-cli -s=rollercoaster-ui run-code --filename tests/ui/terminal-display.js
```

Use the installed CLI or the skill wrapper; no project dependency is required.
This workstation's cached executable is
`/Users/bookiedew/.npm/_npx/31e32ef8478fbf80/node_modules/@playwright/cli/playwright-cli.js`
(run with `node`). In this execution environment, keeping the opening command's
PTY alive avoids the CLI browser daemon being terminated with its parent.

- `real-workflow.js`: real profile/grant/precheck/start, at least four progressive
  observations, then exact lock in WAVES and LINEAR; V2 discriminator, current vs
  marker equality, no active full path, frozen outcome, adaptive desktop chart
  (320px minimum; mobile retains 260px),
  terminal full-sample mapping and rendered coordinates, plus after-stop reveal.
- `editor-mobile.js`: real SGP/exclusion/low-odds workflow, retained leg/row edits,
  typed HTML treated as text, 375/390px clipping checks, mobile live path and lock.
- `browser-regressions.js`: deterministic intercepted HTTP fixtures for late
  quotes across lock and a new ride, failure gaps, non-monotonic timestamps,
  crash/end zero, serialized slow polling, ambiguous lock recovery, terminal lock
  errors, null/ineligible values, and lost opt-in response recovery. These fixtures
  test UI behavior and are not evidence about server payout math.
- `modern-responsive.js`: six viewport sizes (including 1100px), exact ride/setup column alignment,
  observed time below the metric, visible controls, fixed fine chart
  stroke, computed label/action contrast, keyboard focus, reduced motion,
  technical disclosures, actual DOM ride-first order, compact desktop setup and
  absence of sticky/fixed or nested scrolling panes.
- `terminal-display.js`: deterministic UI direction checks (first, rising, falling,
  flat, stale, error/gap, pause/manual, uncertain and final), no reveal from active
  or mismatched results, retry acceptance, frozen results, reset and unavailable
  legacy/malformed replay fallback. HTTP fixtures do not validate server math.
- `desktop-scrolling.js`: real live/locked controls, hidden JSON updates, keyboard
  View JSON button, payload retention, all eight Calculation details readouts and
  scrollable ancestors for default setup, expanded 12-leg SGP/preview, and open
  full terminal JSON. Wheel input over JSON must move the document.
- `modern-high-boost.js`: a real allowed 1,000% boost and lock, verifying all
  y-axis tick glyphs fit inside the SVG at 375px and 1440px.

Current two-block screenshots are written under `output/playwright/two-block/`,
with previous `desktop-layout/`, `modern-ui/` and earlier evidence preserved. The real workflow's default
production minimum crash time is two seconds; its live screenshot and lock happen
before that minimum. Browser/host scheduling delays can make this timing check
fail and should be investigated rather than accepted as a payout discrepancy.

For a real long WAVES ride on phase V3, run `long-v3-prepare.js` in the same
browser. It prints a granted reward ID. Set its seed using
`node tests/ui/seed-qa-reward.cjs QA_DB REWARD_ID SEED`; this helper refuses any
path outside the isolated `rollercoaster-demo-*/qa.sqlite` directories and refuses
rewards that were already opted in. Then run `long-v3-ride.js` in the browser.
No HTTP mocking is used by these long-ride scripts.
For a deliberately late natural-end quote, open `/demo/?qaLate=1`, use the
no-crash seed below, and run the same sequence. It pauses after five seconds and
requests the next quote seven seconds later, preserving event and observed times.
For a real long LINEAR ride, open `/demo/?qaMode=LINEAR` before running the same
prepare/seed/ride sequence. The query parameter is read only by the QA script;
it does not change the demo application or API behavior.

Controlled seeds with the default starter ticket/profile:

- Crash: `50ec922f16e59e2251feb46dd5bdc2b659913f9b44fc00a15b77ccfd9b60005d`,
  duration 8.354 seconds, crash offset 7.2145144 seconds; repaired DOWN phase.
- Natural end: `6a5b4b6615a07d3888365bb6966da193b9da43267b053eca6304e4b293b20415`,
  duration 10.185 seconds; no crash.

The long script compares every plotted point with a real quote, captures the
initial floor and changed path after four seconds, verifies a terminal observed
zero and preserved raw path, checks both rising and falling observations for
WAVES, and returns all sample times/values. It scrolls to the header before live
captures. Generic
`v3-long-before.png`/`v3-long-after.png` files are overwritten per run; copy them
with scenario-specific names when retaining both cases.

`node tests/ui/inspect-qa-snapshots.cjs QA_DB` validates that all opted-in rewards
in that isolated DB have snapshot version 3 and reports the phase model,
maximum model, and incoming-segment metadata count. Phase version 3 retains the
`WAVES_PRE_CRASH_SUPREMUM_V2` maximum-model discriminator.

For a midride full-reveal preview, use the crash seed with `long-v3-prepare.js`,
then run `two-block-preview.js` instead of `long-v3-ride.js`. It captures an actual
rising/falling observed WAVES segment, locks after four seconds, and verifies
the exact independent stop plus the remaining server-sampled path.

The terminal display stores a frozen copy only after an accepted terminal result.
Path rates are already effective boosts; timePct is a fraction of full duration.
The dashed sampled path leaves a gap across the reported crash/end boundary with
millisecond rounding tolerance. It does not infer an exact precursor boost or
maximum. Observations, raw JSON, exact stop and server maximum remain separate.
Malformed/missing replay metadata falls back to the exact observed outcome.
