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
7) The sportsbook settles the locked bet with leg results (`POST /api/settlement`); the server computes total return and bonus = total return * locked boost (capped per currency) from the frozen snapshots
8) Lost / cashed-out / all-push bets pay 0; a cancelled bet returns the token; corrections use `POST /api/settlement/resettle`. Crash/end prevents a new lock but cannot alter an existing lock

## Key behaviors
- Ride is deterministic per reward: the seed is 32 random bytes (hex) generated at grant and stored; the saved seed plus the frozen opt-in snapshot rebuild it exactly. It is not derivable from public IDs and is never returned by the API; audit rows hold only `seedCommitment` (SHA-256 of the seed bytes).
- Ride duration is short and random: `2-15s` (internal config).
- Default minimum crash setting is `2s` (config requires 0.4 <= min crash <= min duration, and < max duration, so every ride length can crash).
- V4 outcome: 8% of rides do not crash. Otherwise the crash time falls in the window after the minimum crash time, in a weighted bucket (EARLY `10%`, MID `65%`, LATE `25%`) with a crash phase (UP `50%`, PEAK `20%`, DOWN `30%`). Draws come from keyed (HMAC) streams of the seed, so bucket, phase and duration are independent.
- Active boost quotes return no countdown or future path/schedule, and withhold `theoretical_max_boost_pct` (null) while the ride is live; terminal quotes and locks keep it. Reward/opt-in responses return `end_time: null` until the reward is `USED` or `EXPIRED`.
- Grant, opt-in, lock and settlement each write atomically (`runInTransaction` in `src/db/repositories/transaction.ts`; the transaction starts lazily on the first scoped query). Opt-in claims `GRANTED` → `ENTERED` and lock `ENTERED` → `USED` with conditional updates.
- One bet binds to one reward **per brand**: `(brand_id, bet_id)` is unique (409 `BET_ALREADY_BOUND`; the opt-in transaction checks it and the unique index `user_rewards_brand_id_bet_id_unique` backs it, so a race that reaches the index is also 409, never 500); lock replay requires the same reward and owner (else 409 `BET_ALREADY_LOCKED`); locks are unique per `(brand_id, bet_id)` (`bet_boost_locks_brand_id_bet_id_unique`); a conflicting settlement replay is 409 `BET_ALREADY_SETTLED`.
- Ticket strength weighting is `75%` qualifying selection count and `25%` combined odds.
- Effective minimum boost can rise with ticket quality when max-access targets are configured (`effective_min_floor_rate`, default `0.35`). The profile max-access weights are separate from ticket-strength weights.
- Single-use reward: lock consumes the token.
- Optional max-boost thresholds: `max_boost_min_selections`, `max_boost_min_combined_odds`.
- Responses distinguish `RIDE_CRASHED` vs `RIDE_ENDED`.
- Ride modes are profile-configurable: `WAVES` or `LINEAR`.
- Ride path (60 samples) is returned for lock responses and for crashed/ended quote responses.
- Selections can be excluded via `eligible: false` (optional `ineligible_reason`).
- SGP model uses explicit selection metadata:
  - `selection_type`: `STANDARD | SGP_COMPOSITE | SGP_LEG`
  - `sgp_group_id` required for `SGP_COMPOSITE` and `SGP_LEG`
  - `SGP_LEG` selections are always excluded from qualification math
  - duplicate `SGP_COMPOSITE` entries in the same `sgp_group_id` are ignored

## Brands, money, caps and validity (Phase 1a)
- `brand_id` (`^[A-Za-z0-9_-]{1,64}$`) is required on profile create and immutable. Rewards copy it from the profile at grant; locks copy it from the reward. Player = `(brand_id, user_id)`, bet = `(brand_id, bet_id)`. Legacy rows are brand `default`.
- Brand-scoped reads: `GET /api/rewards/user/:userId[/active]`, `GET /api/boost/lock/:betId` and `GET /api/settlement/:betId` require `?brand_id=`. Quote, lock and opt-in take the brand from the reward; settle/resettle carry `brand_id` in the body. `betBoostLockRepository.findByBetId(betId, brandId)` always takes the brand; migration 015 replaced `unique(bet_id)` with `unique(brand_id, bet_id)`, so each brand can lock its own `bet_id`.
- Money: integer minor units + `^[A-Z]{3}$`, no floats (`src/money/minorUnits.ts`). Opt-in requires `stake_minor` (1..1e12) and `currency`; `ticket.stake` is deprecated and ignored. Rounding for derived amounts is half-up.
- Profile `max_bonus_minor` (currency to positive integer, at least one) and `reward_validity_seconds` (60..31,536,000) are required on create and updatable (future grants/opt-ins only). Opt-in copies `stake_minor`, `currency` and `bonus_cap_minor` onto the reward, so profile edits never change an in-flight bet. A currency missing from the map is 422 `CURRENCY_NOT_SUPPORTED`.
- `valid_until = granted_at + reward_validity_seconds`; legacy rows are `NULL` (no expiry). Opt-in after `valid_until` expires the reward (conditional update + audit) and returns 422 `REWARD_EXPIRED`.
- `rewardExpiryService.expireRewards(now, graceSeconds = RIDE_EXPIRY_GRACE_SECONDS)` is idempotent (conditional updates, one audit row per changed reward): GRANTED past `valid_until`, and ENTERED whose ride had already ended or crashed at `now - grace` (existing `calculateElapsedPct`/`hasRideEnded` evaluated at that instant, no re-derived math; grace default 900 s), become EXPIRED. Quote and lock for an EXPIRED reward that entered a ride for that bet still run the ride evaluation and report `RIDE_CRASHED`/`RIDE_ENDED` with unchanged details; only rewards that never entered a ride (or another bet, or an expired ride that is somehow not over) get `REWARD_EXPIRED`, and such a reward is never locked. Triggers: admin `POST /api/admin/rewards/expire` and an in-process interval `REWARD_EXPIRY_INTERVAL_SECONDS` (default 300, 0 disables) started from `startServer()` only, never in test, cleared when the HTTP server closes.
- Migrations 012-014 are data preserving: 012 adds columns/indexes (defaults `default`, `{}`, NULL), 013 renames historical duplicate bet bindings (`<bet_id>~legacy-<first 8 of reward id>`, keeper = the reward owning the lock or the earliest, one `LEGACY_BET_ID_RENAMED` audit row each; `down` restores them), 014 creates the unique index.
- Migration 015 drops the legacy `settlement_records` table **only when it is empty** (otherwise it aborts with instructions and changes nothing), replaces the lock index with `unique(brand_id, bet_id)` (dropping the redundant non-unique `bet_boost_locks_brand_id_bet_id_index`; `down` recreates it) and creates `bet_settlements`. Its `down` restores both, refusing while `bet_settlements` has rows or a `bet_id` is locked in two brands.

## Settlement (Phase 1a)
- `POST /api/settlement` `{brand_id, bet_id, outcome: SETTLED|CASHOUT|CANCELLED, legs?}`; `legs` (one `{selection_id, result: WON|LOST|PUSH|CANCELLED}` per bet leg = every stored selection except `SGP_LEG`) is required for SETTLED and forbidden otherwise. Opt-in now rejects duplicate selection ids (400) so every leg can be matched.
- `settlementService` loads the lock by `(brand_id, bet_id)` (404 `LOCK_NOT_FOUND` for opted-in-but-unlocked bets), the reward's whole stored ticket and money snapshot (missing stake/currency/cap/ticket or lock minimums: 422 `SETTLEMENT_UNAVAILABLE`, never a default), and calls the pure BigInt calculator `src/computations/settlementCalculator.ts` (frozen). Calculator `INVALID_LEGS` maps to 400 `VALIDATION_ERROR` with problems in `details`; `INVALID_INPUT` (stored data, no client cause) to 422 `SETTLEMENT_UNAVAILABLE`. There is no size limit: the calculator returns the total return as an exact BigInt (sportsbook returns can exceed 2^53; max payout is the sportsbook's responsibility), the service carries it as a decimal-integer string, and the API returns `total_return_minor` as that string; the bonus is capped, so it stays a number. `selectionSchema` rejects odds with more than 6 decimal places (judged from `String(odds)`, like the calculator) at opt-in and lock.
- `bet_settlements`: one row per revision; bigint money columns except `total_return_minor`, which is exact decimal-integer text; `unique(lock_id, revision)` plus a partial unique index on `lock_id WHERE is_current` (one current revision per lock). `legs` stores the normalized legs (sorted by `selection_id`); replay compares the normalized `(outcome, legs)`: identical returns the current revision (201), different is 409 `BET_ALREADY_SETTLED`.
- Resettle `POST /api/settlement/resettle` (+ `reason` 1-500) supersedes revision n with a conditional `is_current` update and inserts n+1 in one transaction with its audit row; the response adds `previous_bonus_minor` / `bonus_delta_minor` (null on revision 1). Replay only matches the current revision, so the original `POST /settlement` after a resettle is 409. A lost race (conditional update or unique violation) re-reads: identical payload is a replay, otherwise 409.
- Replacement tokens (`rewardEntitlementService.issueReplacementReward`): CANCELLED issues a new GRANTED reward (fresh seed, same brand/user/profile, `replaces_reward_id`, copied `valid_until`, `GRANT_REPLACEMENT` audit) unless the original validity has passed (`replacement_status: NOT_ISSUED_EXPIRED`). Leaving CANCELLED revokes a still-GRANTED replacement (conditional `GRANTED -> EXPIRED`, `EXPIRE` audit with reason `REVOKED_BY_RESETTLEMENT`); if the conditional revoke loses a race the reward is re-read in the same transaction (used: 409, expired/gone unused: treated as revoked); a replacement that was already opted into makes the resettle 409 `REPLACEMENT_ALREADY_USED` with nothing changed. `replacement_status` is derived from `bet_result` and `replacement_reward_id`.
- Reward entity fields added in this phase (`brandId`, `validUntil`, money snapshot, `replacesRewardId`) are typed optional only so older fixtures type-check; repositories always set them.

## Authoritative math and response semantics

New opt-ins save `ticketSnapshot.rideMath.version = 4` (`mathVersion: 'V4'`): resolved profile/mode, start/end time,
duration bounds, qualifying selection count, exact combined odds (decimal string), ticket strength, effective min/max,
and the ride parameters (duration, outcome, crash time, bucket, phase, linear pace, payout band, ride maximum,
pre-crash maximum) plus the seed commitment. Each quote or lock rebuilds the ride from the stored seed with
`createV4Ride` and refuses it (422 `INVALID_CONFIGURATION`) if any value differs from the snapshot, so a damaged
snapshot fails closed instead of switching to mutable profile data. V4 writes no `ride_definitions` rows.

Rides that were in flight under older math were closed by migration 016 (reward `EXPIRED`, one audit row each); locks
and settlements stored earlier keep their stored values and label.

- WAVES is a multi-peak ride. LINEAR climbs from its effective floor toward this ride's maximum at the MEDIUM pace
  (`LINEAR_PACE` in `rideMathSnapshot.ts`; 9 seconds to the top of the band) and stops at that maximum. At crash/end the
  payable value is zero in both modes.
- `PRE_CRASH_SUPREMUM_V4` is the `maximum_model`: the exact highest value before the open crash/end boundary, computed
  from the ride's knots without sampling. It is `theoretical_max_boost_pct` once the ride is over, and is null in live quotes.
- Combined odds are an exact BigInt product; `combined_odds` and `qualifying_odds` are numbers, or exact decimal strings
  when beyond the double range.
- `effective_max_boost_pct` is the ticket-adjusted cap; `theoretical_max_boost_pct` is model-dependent and is not guaranteed attainable at a finite server sample. Neither equals a guaranteed payout or the sampled/observed chart peak.
- `maximum_model` appears on eligible/terminal quote, POST lock, and GET lock responses. Locks stored before V4 keep their stored label, or omit it if none was stored.
- `ride_elapsed_seconds` gives the authoritative quote sampling offset from ride start, with millisecond precision. Evaluation and terminal status use the same instant. It is not normalized progress or time remaining; terminal samples may be later than crash/end.
- `ride_path` has 60 samples after lock or terminal quote. Each `baseBoostValue` is the authoritative effective boost at that `timePct`, despite its historical name; crash/end samples are zero. LINEAR coordinates retain full sample precision. Successful locks report the exact `locked_boost_pct` and `ride_stop_at_offset_seconds` independently of that sampled path.

Simulation always uses V4. Supplied tickets pass the same
selection/combined-odds gates as live rides; ineligible simulations still return
HTTP 200 with `eligible: false`, a reason code, and null `final_boost_pct` for every
sample. No-ticket calls are explicitly `EXPLORATORY` with null eligibility/reason and
ticket strength 0.5. Curve fields retain four-decimal serialization
(`serialization_decimals: 4`); resolved min/max overrides must satisfy min <= max.
Responses carry `math_snapshot_version: 4`, a `ride` block (duration, outcome, crash
time, bucket, phase, pace, peak count, band, ride and pre-crash maximum) and `config`
with the effective min/max and ticket strength. The default seed is 32 random bytes;
an explicit 64-hex seed is used as is and any other string is SHA-256 hashed into a key.
Active player responses never carry the `ride` block or any future path.

## Core modules (what to review)
- `src/computations/ticketStrengthScorer.ts` (non-linear strength)
- `src/computations/v4/` (the only ride math: seeded keyed RNG, outcome draws, WAVES skeleton, LINEAR climb, payout band, exact odds)
- `src/services/rideMathSnapshot.ts` (opt-in snapshot, rebuild-and-verify, 60-point path sampling)
- `src/services/ticketEvaluation.ts` (shared ticket evaluation: filter, exact odds, eligibility, strength)
- `src/computations/finalBoostCalculator.ts` (boost calculation + caps)
- `src/services/rewardOptInService.ts` (precheck on ride start and ride definition creation)
- `src/services/boostQuoteService.ts` (dynamic quote)
- `src/services/boostLockService.ts` (lock + snapshot)
- `src/computations/settlementCalculator.ts` (pure BigInt settlement math)
- `src/services/settlementService.ts` (settle / resettle / replacement tokens)
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
- Money and lifetime: `brand_id` (immutable), `max_bonus_minor`, `reward_validity_seconds`

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
