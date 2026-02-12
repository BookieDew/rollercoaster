# Developer Overview

This doc is the quickest on-ramp for engineers reviewing the Combo Boost Rollercoaster API.

## Start here
- `docs/api-examples.md` - concrete endpoint payloads and responses
- `docs/overview.md` - business-facing product behavior
- `IMPLEMENTATION_PLAN.md` - architecture breakdown and build plan
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
8) On loss / crash / ride end, bonus = 0

## Key behaviors
- Ride is deterministic per reward: seed = `reward_id + user_id + profile_version_id`.
- Ride duration is short and random: `2-15s` (internal config).
- Hard minimum crash time is `2s`.
- Crash timing uses weighted time buckets:
  - EARLY: `10%`
  - MID: `65%`
  - LATE: `25%`
- Crash phase near boundary is weighted:
  - `UP: 50%`, `PEAK: 20%`, `DOWN: 30%`
- No time remaining is returned to bettors.
- Ticket strength weighting is `75%` qualifying selection count and `25%` combined odds.
- Effective min boost floor rises with ticket quality (`effective_min_floor_rate`, default `0.35`).
- Earliest theoretical peak is constrained to be at least 2 seconds after start (when timing allows).
- Single-use reward: lock consumes the token.
- Optional max-boost thresholds: `max_boost_min_selections`, `max_boost_min_combined_odds`.
- Responses distinguish `RIDE_CRASHED` vs `RIDE_ENDED`.
- Ride modes are profile-configurable: `WAVES` or `LINEAR`.
- Ride path is returned for lock responses and for crashed/ended quote responses.
- Selections can be excluded via `eligible: false` (optional `ineligible_reason`).

## Core modules (what to review)
- `src/computations/ticketStrengthScorer.ts` (non-linear strength)
- `src/computations/deterministicRideGenerator.ts` (seeded ride + crash)
- `src/computations/linearRideMode.ts` (linear mode path/quote math)
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
npm run test:all
```

As of `v0.9.8`, expected baseline is `11/11` suites passing.

## Demo UI
Run the API and open:
```
http://localhost:3000/demo
```
