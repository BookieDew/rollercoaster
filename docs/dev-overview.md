# Developer Overview

This doc is the quickest on-ramp for engineers reviewing the Combo Boost Rollercoaster API.

## Start here
- `docs/api-examples.md` - concrete endpoint payloads and responses
- `docs/overview.md` - business-facing product behavior
- `IMPLEMENTATION_PLAN.md` - historical architecture/build checklist; not current completion status
- `src/routes/` - HTTP routes
- `src/services/` - business logic
- `src/computations/` - core math (ticket strength, ride generation, boost calculation)
- `public/demo/index.html` - local demo UI (served at `/demo`)

## End-to-end flow (current)
1) CRM grants reward token
2) User places a qualifying combo bet
3) Optional precheck validates ticket before ride start
4) User opts in to start the ride
5) Boost updates in real time (no countdown)
6) User locks boost by stopping the ride
7) On win, bonus payout = winnings * locked boost
8) On loss, bonus = 0; crash/end prevents a new lock but cannot alter an existing lock

## Key behaviors
- Ride is deterministic per reward: `generateSeed` hashes reward/user/profile IDs; saved seed, inputs, and checkpoints support replay.
- Ride duration is short and random: `2-15s` (internal config).
- Default minimum crash setting is `2s`. The existing rounded crash fraction can produce a slightly earlier boundary for exact-minimum/short durations (for example, `2 * 0.9999 = 1.9998s`); this edge is characterized, not repaired.
- Crash timing uses weighted time buckets, renormalized when the configured minimum makes a bucket infeasible:
  - EARLY: `10%`
  - MID: `65%`
  - LATE: `25%`
- New v3 WAVES uses a domain-separated phase draw with UP/PEAK/DOWN targets 50/20/30 only for feasible repaired rides. Early/timing-constrained, flat/rounding-degenerate, and no-crash rides keep their baseline trajectory and separate diagnostic status. Historical generator phase labels describe checkpoint shaping, not guaranteed effective near-crash direction.
- Active boost quotes return no countdown or future path/schedule. Existing reward/opt-in DTOs still contain start/end timestamps; these contracts have not been removed.
- Ticket strength weighting is `75%` qualifying selection count and `25%` combined odds.
- Effective minimum boost can rise with ticket quality when max-access targets are configured (`effective_min_floor_rate`, default `0.35`). The profile max-access weights are separate from ticket-strength weights.
- Generation uses a two-second minimum peak-delay shaping parameter where feasible; this is not a guarantee that the final clamped payout has no earlier plateau.
- Single-use reward: lock consumes the token.
- Optional max-boost thresholds: `max_boost_min_selections`, `max_boost_min_combined_odds`.
- Responses distinguish `RIDE_CRASHED` vs `RIDE_ENDED`.
- Ride modes are profile-configurable: `WAVES` or `LINEAR`.
- Ride path is returned for lock responses and for crashed/ended quote responses.
- Selections can be excluded via `eligible: false` (optional `ineligible_reason`).
- SGP model uses explicit selection metadata:
  - `selection_type`: `STANDARD | SGP_COMPOSITE | SGP_LEG`
  - `sgp_group_id` required for `SGP_COMPOSITE` and `SGP_LEG`
  - `SGP_LEG` selections are always excluded from qualification math
  - duplicate `SGP_COMPOSITE` entries in the same `sgp_group_id` are ignored

## Authoritative math and response semantics

New opt-ins save `ticketSnapshot.rideMath.version = 3`: resolved profile/mode,
start/end time, duration, checkpoint count, volatility, crash fraction, peak-delay
parameter, maximum model, phase diagnostics, and authoritative checkpoint doubles.
`phaseModel` is `FEASIBLE_WAVES_PHASE_V3`; the maximum model remains the separately
versioned `WAVES_PRE_CRASH_SUPREMUM_V2`.

V3 consumers use the frozen JSON checkpoints, not the legacy table's decimal(10,6)
copy. Same-time raw checkpoint pairs preserve effective continuity at clamp
transitions. An inserted point's optional `incomingSegmentEnd` preserves the
original incoming interpolation arithmetic, including round6 boundaries; retain
it during copying/replay. Unknown snapshot versions and malformed v3 checkpoint
metadata fail closed instead of switching to mutable profile/table data.
Version 1/2 snapshots retain their saved profile/timing and original table-backed
curves; rides without a math snapshot use the explicit legacy fallback. Existing
locks and settlements are never recalculated from a newer profile/model.

- `WAVES_PRE_CRASH_SUPREMUM_V2`: maximum before the open crash/end boundary, after the authoritative payout transform. V2 includes the left boundary limit as well as preceding checkpoints. V3 preserves that baseline true maximum while changing eligible WAVES suffixes; the maximum calculation accounts for both sides of paired raw transitions.
- `LEGACY_CHECKPOINT_MAX_V1`: historical checkpoint-only reference. Actual WAVES values between checkpoints can exceed this reported reference.
- LINEAR rises from its effective floor toward the v2 same-seed WAVES maximum. The v2 endpoint correction increased LINEAR payouts on affected seeds; v3 leaves those LINEAR values unchanged. Unversioned/v1 LINEAR keeps its older checkpoint reference. At crash/end the payable value is zero in both modes.
- `effective_max_boost_pct` is the ticket-adjusted cap; `theoretical_max_boost_pct` is model-dependent and is not guaranteed attainable at a finite server sample. Neither equals a guaranteed payout or the sampled/observed chart peak.
- `maximum_model` distinguishes these models on eligible/terminal quote, POST lock, and GET lock responses. Existing locks without stored model metadata omit it.
- `ride_elapsed_seconds` gives the authoritative quote sampling offset from ride start, with millisecond precision. Evaluation and terminal status use the same instant. It is not normalized progress or time remaining; terminal samples may be later than crash/end.
- `ride_path` has 60 samples after lock or terminal quote. Each `baseBoostValue` is the authoritative effective boost at that `timePct`, despite its historical name; crash/end samples are zero. LINEAR coordinates retain full sample precision. Successful locks report the exact `locked_boost_pct` and `ride_stop_at_offset_seconds` independently of that sampled path.

Simulation uses the current v3 phase model and v2 maximum model. Supplied tickets pass the same
selection/combined-odds gates as live rides; ineligible simulations still return
HTTP 200 with `eligible: false`, a reason code, and null `final_boost_pct` for every
sample. No-ticket calls are explicitly `EXPLORATORY` with null eligibility/reason.
Curve fields retain four-decimal serialization (`serialization_decimals: 4`);
resolved min/max overrides must satisfy min <= max. Operator responses additionally
include `math_snapshot_version: 3`, `phase_diagnostics`, and optional
`checkpoints[].incoming_segment_end` for exact replay of inserted boundaries.
Active player responses do not expose phase assignments, future phase timing, or
these raw checkpoint diagnostics.

## V3 phase behavior and limits

For WAVES, keep the original seed-derived duration, crash fraction/no-crash choice,
scorer, eligibility, effective floor/cap, and true maximum. Let M be that maximum
and L = max(effective floor, finalBoost(profile minimum)). L is a reachable shaping
reference, not a replacement floor. No-crash rides stay unchanged. If M-L <=
0.00002, classify `FLAT_OR_ROUNDING_DEGENERATE`; if fewer than 600ms remain after
the allowed suffix start, classify `TIMING_CONSTRAINED`.

A repaired suffix begins no earlier than two seconds and is at most 800ms long.
It uses the final original segment when that segment has enough room, otherwise
extends into the preceding portion within that bound. Original prefix evaluation
is preserved. A maximum anchor is inserted only when needed to retain M. Over the
last 400ms, the effective targets in [L,M] are UP 65→85%, DOWN 85→65%, and PEAK
97.5→99%, subject to the existing arithmetic rounding. Phase comes from SHA256
`crash-phase-v2:` plus seed, using the first 32 bits and thresholds .5/.7.
The targets concern repaired rides; finite samples need not have exact 50/20/30
counts. `NOT_APPLICABLE_LINEAR` explicitly separates LINEAR.

The ideal 200ms observation grid sees the final phase, but network latency/gaps may
prevent a client from receiving those samples. Preserving bounds and maxima does
not preserve the time or likelihood of locking particular boosts: v3 changes WAVES
stopping opportunities. This local implementation is not release approval, an RTP
estimate, or a universal exposure guarantee. Total peak counts and suffix aesthetics
remain subjects of curve review; no universal 2–4-peak claim is made.

## Core modules (what to review)
- `src/computations/ticketStrengthScorer.ts` (non-linear strength)
- `src/computations/deterministicRideGenerator.ts` (legacy seeded ride/crash and shared interpolation)
- `src/computations/feasibleRidePhase.ts` (v3 feasible suffix correction and diagnostics)
- `src/computations/linearRideMode.ts` (linear mode path/quote math)
- `src/computations/rideReferenceMaximum.ts` (versioned checkpoint reference / pre-crash supremum)
- `src/computations/ridePathBuilder.ts` (authoritative effective path samples)
- `src/services/rideMathSnapshot.ts` (opt-in math snapshot and legacy fallback)
- `src/computations/finalBoostCalculator.ts` (boost calculation + caps)
- `src/services/rewardOptInService.ts` (precheck on ride start and ride definition creation)
- `src/services/boostQuoteService.ts` (dynamic quote)
- `src/services/boostLockService.ts` (lock + snapshot)
- `src/services/settlementService.ts` (bonus settlement)
- `src/middleware/authMiddleware.ts` (API key + HMAC auth, admin endpoint gate)

## Profile model (operator-tunable)
- Eligibility: `min_selections`, `min_combined_odds`, `min_selection_odds`
- Cap range: `min_boost_pct`, `max_boost_pct`
- Max-eligibility thresholds: `max_boost_min_selections`, `max_boost_min_combined_odds`
- Boost model tuning:
  - `max_eligibility_selection_weight`
  - `max_eligibility_odds_weight`
  - `effective_min_floor_rate`
- Ride mode: `ride_mode` = `WAVES | LINEAR`

## Running tests
```
npm run build
npm run test:coverage
```

Coverage runs unit and integration tests and enforces 80% global statements, branches, functions, and lines. `npm test` alone runs only unit tests. Deterministic parity regressions are in `tests/unit/rideMathParity.test.ts`; passing the suite does not replace review of model/behavior differences.

## Demo UI
Run the API and open:
```
http://localhost:3000/demo
```

The demo draws an observed polyline progressively from accepted server samples,
keeps gaps visible when samples are unavailable, rejects stale responses, and
freezes exact lock/terminal results. It does not draw the returned full path into
the live chart or show a future maximum. Raw JSON remains available. Source-level
behavior described here is not a claim of completed browser acceptance; use the
separate UI workflow checks in addition to backend tests.
