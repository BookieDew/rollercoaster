# Developer Overview

This doc is the quickest on-ramp for engineers reviewing the Combo Boost Rollercoaster API.

## Start here
- `docs/api-examples.md` - concrete endpoint payloads and responses
- `IMPLEMENTATION_PLAN.md` - architecture breakdown and build plan
- `src/routes/` - HTTP routes
- `src/services/` - business logic
- `src/computations/` - core math (ticket strength, ride generation, boost calculation)
- `public/demo/index.html` - local demo UI (served at `/demo`)

## End-to-end flow (high level)
1) CRM grants reward token
2) User places a qualifying combo bet
3) User opts in to start the ride
4) Boost updates in real time (no countdown)
5) User locks boost by stopping the ride
6) On win, bonus payout = winnings * locked boost
7) On loss, bonus = 0

## Key behaviors
- Ride duration is short (2–15 seconds), crash can happen anytime.
- No time remaining is returned to bettors.
- Deterministic ride based on seed (reward_id + user_id + profile_version).
- Single-use reward: lock consumes the token.
- Optional max-boost thresholds: `max_boost_min_selections`, `max_boost_min_combined_odds`.
- Responses distinguish `RIDE_CRASHED` vs `RIDE_ENDED`.
- Ride path is returned only after lock (for UI animation/sharing).
- Selections can be excluded via `eligible: false` (optional `ineligible_reason`).

## Core modules (what to review)
- `src/computations/ticketStrengthScorer.ts` (non-linear strength)
- `src/computations/deterministicRideGenerator.ts` (seeded ride + crash)
- `src/computations/finalBoostCalculator.ts` (boost calculation + caps)
- `src/services/boostQuoteService.ts` (dynamic quote)
- `src/services/boostLockService.ts` (lock + snapshot)
- `src/services/settlementService.ts` (bonus settlement)

## Running tests
```
npm run test:all
```

## Demo UI
Run the API and open:
```
http://localhost:3000/demo
```
