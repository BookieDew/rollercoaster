# Combo Boost Rollercoaster API - Implementation Plan

## Overview
A REST API service for a time-based "rollercoaster" loyalty reward that provides dynamic boost percentages for combo/parlay bets. The boost oscillates over time and can crash to 0%, creating urgency for users to lock in their boost.

## Tech Stack
- **Runtime**: Node.js with TypeScript
- **Framework**: Express.js
- **Database**: SQLite (local/dev), Postgres-ready via Knex
- **Testing**: Jest + Supertest
- **Validation**: Zod

---

## Implementation Checklist

### Phase 1: Project Setup

- [ ] `package.json`
  - **Goal**: Define project metadata, scripts (dev, build, test, migrate), and dependencies (express, knex, better-sqlite3, uuid, typescript, jest, supertest, zod).

- [ ] `tsconfig.json`
  - **Goal**: Configure TypeScript with strict mode, ES2020 target, and path aliases for clean imports.

- [ ] `.env.example`
  - **Goal**: Document required environment variables (DATABASE_URL, API_KEY_SECRET, NODE_ENV, PORT).

- [ ] `src/index.ts`
  - **Goal**: Application entry point that initializes Express, loads middleware, mounts routes, and starts the HTTP server on the configured port.

- [ ] `src/config/index.ts`
  - **Goal**: Centralize environment variable loading and validation with sensible defaults; export a typed config object.

---

### Phase 2: Database Layer

- [ ] `knexfile.ts`
  - **Goal**: Configure Knex for SQLite (development) and Postgres (production) with migration and seed directory paths.

- [ ] `src/db/connection.ts`
  - **Goal**: Export a configured Knex instance that reads from config and can be imported throughout the application.

- [ ] `migrations/001_create_reward_profile_versions.ts`
  - **Goal**: Create table `reward_profile_versions` with columns: id, name, min_selections, min_combined_odds, min_selection_odds, min_boost_pct, max_boost_pct, ride_duration_seconds, created_at, updated_at.

- [ ] `migrations/002_create_user_rewards.ts`
  - **Goal**: Create table `user_rewards` with columns: id, user_id, profile_version_id, status (GRANTED/ENTERED/EXPIRED/USED), start_time, end_time, seed, opted_in_at, created_at.

- [ ] `migrations/003_create_ride_definitions.ts`
  - **Goal**: Create table `ride_definitions` with columns: id, reward_id, checkpoint_index, time_offset_pct (0-100), base_boost_value (0-100), to store the deterministic ride curve checkpoints.

- [ ] `migrations/004_create_bet_boost_locks.ts`
  - **Goal**: Create table `bet_boost_locks` with columns: id, bet_id (unique), reward_id, locked_boost_pct, qualifying_selections_count, qualifying_combined_odds, ticket_strength, snapshot_json (full audit data), locked_at.

- [ ] `migrations/005_create_settlement_records.ts`
  - **Goal**: Create table `settlement_records` with columns: id, bet_id, outcome (WIN/LOSS/VOID/CASHOUT), winnings, bonus_amount, settled_at.

- [ ] `migrations/006_create_audit_logs.ts`
  - **Goal**: Create table `audit_logs` with columns: id, entity_type, entity_id, action, payload_json, created_at, for full decision traceability.

- [ ] `src/db/repositories/rewardProfileRepository.ts`
  - **Goal**: Provide data access functions: create, findById, findAll, update, delete for reward profile versions.

- [ ] `src/db/repositories/userRewardRepository.ts`
  - **Goal**: Provide data access functions: create, findById, findByUserId, findActiveByUserId, updateStatus, markOptedIn.

- [ ] `src/db/repositories/rideDefinitionRepository.ts`
  - **Goal**: Provide data access functions: bulkInsertCheckpoints, findByRewardId to store and retrieve ride curve data.

- [ ] `src/db/repositories/betBoostLockRepository.ts`
  - **Goal**: Provide data access functions: create (with idempotency check on bet_id), findByBetId, findByRewardId.

- [ ] `src/db/repositories/settlementRepository.ts`
  - **Goal**: Provide data access functions: create (idempotent on bet_id), findByBetId.

- [ ] `src/db/repositories/auditLogRepository.ts`
  - **Goal**: Provide data access function: append(entityType, entityId, action, payload) for audit trail.

---

### Phase 3: Core Computation Modules

- [ ] `src/computations/qualifyingSelectionFilter.ts`
  - **Goal**: Export function `filterQualifyingSelections(selections, minSelectionOdds)` that returns only selections with odds >= threshold; these count toward eligibility.

- [ ] `src/computations/combinedOddsCalculator.ts`
  - **Goal**: Export function `calculateCombinedOdds(selections)` that multiplies all selection odds together and returns the combined decimal odds.

- [ ] `src/computations/ticketStrengthScorer.ts`
  - **Goal**: Export function `calculateTicketStrength(qualifyingCount, combinedOdds, profile)` that computes a non-linear (parabolic/convex) strength factor; use formula like `strength = (selectionFactor^1.5) * (oddsFactor^1.3)` where factors are normalized ratios.

- [ ] `src/computations/deterministicRideGenerator.ts`
  - **Goal**: Export functions `generateRideCheckpoints(seed, durationSeconds, minBoost, maxBoost)` to create oscillating checkpoints, and `interpolateBoostAtTime(checkpoints, elapsedPct)` to get current boost; use seeded PRNG (e.g., seedrandom) for determinism.

- [ ] `src/computations/finalBoostCalculator.ts`
  - **Goal**: Export function `calculateFinalBoost(rideValue, ticketStrength, minCap, maxCap, hasEnded)` that multiplies ride value by strength, clamps to min/max caps, and returns 0 if ride has ended (crash override).

- [ ] `src/computations/index.ts`
  - **Goal**: Re-export all computation functions from a single entry point for convenient imports.

---

### Phase 4: Service Layer

- [ ] `src/services/rewardProfileService.ts`
  - **Goal**: Business logic for CRUD on reward profiles; validate that min_boost < max_boost, min_selections >= 1, etc.

- [ ] `src/services/rewardEntitlementService.ts`
  - **Goal**: Handle CRM grant: validate profile exists, create user_reward with status=GRANTED, generate deterministic seed from hash(reward_id + user_id + profile_version), store record.

- [ ] `src/services/rewardOptInService.ts`
  - **Goal**: Handle user opt-in: verify reward exists and status=GRANTED and not expired, generate ride checkpoints using seed, persist checkpoints, update status to ENTERED, record opted_in_at.

- [ ] `src/services/boostQuoteService.ts`
  - **Goal**: Compute current boost for a prospective slip: filter selections, calculate combined odds, check eligibility (min selections, min odds), compute ticket strength, get current ride value based on elapsed time, calculate final boost; return eligibility flag, reason codes if ineligible, and current boost (never expose time remaining).

- [ ] `src/services/boostLockService.ts`
  - **Goal**: Handle bet placement lock: check idempotency by bet_id, validate reward is ENTERED and not expired, recompute boost at current instant, store immutable lock record with full snapshot, return locked boost.

- [ ] `src/services/settlementService.ts`
  - **Goal**: Handle bet outcome: check idempotency, retrieve lock record, on WIN calculate bonus = winnings * locked_boost_pct, on LOSS/VOID/CASHOUT return bonus = 0 (configurable), persist settlement record.

- [ ] `src/services/simulationService.ts`
  - **Goal**: Admin service to generate sample ride curves for tuning: given a profile and optional ticket params, output array of {time_pct, boost_value} for visualization (internal only, never expose to end users).

---

### Phase 5: API Routes & Controllers

- [ ] `src/middleware/authMiddleware.ts`
  - **Goal**: Validate X-API-Key header against configured secret; reject with 401 if missing or invalid.

- [ ] `src/middleware/errorHandler.ts`
  - **Goal**: Global Express error handler that catches all errors, logs them, and returns consistent JSON error response with status code and message.

- [ ] `src/middleware/requestLogger.ts`
  - **Goal**: Log each request with method, path, response time, and status code using console or a logger.

- [ ] `src/routes/index.ts`
  - **Goal**: Import and mount all route modules: /api/profiles, /api/rewards, /api/boost, /api/settlement, /api/simulation.

- [ ] `src/routes/rewardProfiles.ts`
  - **Goal**: Define Express router with routes: POST / (create), GET /:id (read), PUT /:id (update), DELETE /:id (delete), GET / (list all).

- [ ] `src/routes/rewards.ts`
  - **Goal**: Define Express router with routes: POST / (grant entitlement from CRM), POST /:id/opt-in (user enters rollercoaster mode).

- [ ] `src/routes/boost.ts`
  - **Goal**: Define Express router with routes: POST /quote (get current boost for slip), POST /lock (lock boost to placed bet).

- [ ] `src/routes/settlement.ts`
  - **Goal**: Define Express router with route: POST / (settle bet outcome and compute bonus).

- [ ] `src/routes/simulation.ts`
  - **Goal**: Define Express router with route: POST / (admin-only simulation endpoint for ride curve tuning).

- [ ] `src/controllers/rewardProfileController.ts`
  - **Goal**: Handle HTTP layer for profile routes: parse request, call service, format response; handle validation errors.

- [ ] `src/controllers/rewardController.ts`
  - **Goal**: Handle HTTP layer for grant and opt-in routes: parse request body, call service, return 201/200 or error.

- [ ] `src/controllers/boostController.ts`
  - **Goal**: Handle HTTP layer for quote and lock routes: validate payload, call service, return boost data or eligibility errors.

- [ ] `src/controllers/settlementController.ts`
  - **Goal**: Handle HTTP layer for settlement: validate payload, call service, return settlement result.

- [ ] `src/controllers/simulationController.ts`
  - **Goal**: Handle HTTP layer for simulation: validate admin auth, call service, return ride curve data.

---

### Phase 6: Types & Validation

- [ ] `src/types/rewardProfile.ts`
  - **Goal**: Define TypeScript interfaces: RewardProfileVersion (entity), CreateProfileDTO, UpdateProfileDTO, ProfileResponse.

- [ ] `src/types/userReward.ts`
  - **Goal**: Define TypeScript interfaces: UserReward (entity), RewardStatus enum (GRANTED, ENTERED, EXPIRED, USED), GrantRewardDTO, RewardResponse.

- [ ] `src/types/ticket.ts`
  - **Goal**: Define TypeScript interfaces: Selection {id, odds}, TicketInput {selections[]}, QuoteResponse {qualifyingCount, qualifyingCombinedOdds, eligible, reasonCodes[], currentBoostPct}.

- [ ] `src/types/betBoostLock.ts`
  - **Goal**: Define TypeScript interfaces: LockRequest {betId, rewardId, stake, totalOdds, selections[]}, LockResponse {betId, lockedBoostPct, lockedAt}, BetBoostLock (entity).

- [ ] `src/types/settlement.ts`
  - **Goal**: Define TypeScript interfaces: SettlementRequest {betId, outcome, winnings?}, SettlementResponse {betId, outcome, bonusAmount}, BetOutcome enum (WIN, LOSS, VOID, CASHOUT).

- [ ] `src/types/reasonCodes.ts`
  - **Goal**: Define enum ReasonCode with values:
    - `ELIGIBLE`
    - `MIN_SELECTIONS_NOT_MET`, `MIN_ODDS_NOT_MET`, `MIN_COMBINED_ODDS_NOT_MET`
    - `REWARD_NOT_FOUND`, `REWARD_EXPIRED`, `REWARD_ALREADY_USED`, `NOT_OPTED_IN`, `ALREADY_OPTED_IN`, `RIDE_ENDED`
    - `BET_ALREADY_LOCKED`, `LOCK_NOT_FOUND`
    - `BET_ALREADY_SETTLED`, `INVALID_OUTCOME`
    - `PROFILE_NOT_FOUND`, `PROFILE_INACTIVE`, `INVALID_CONFIGURATION`
    - `VALIDATION_ERROR`, `INTERNAL_ERROR`

- [ ] `src/validation/schemas.ts`
  - **Goal**: Define Zod schemas for all API request payloads: createProfileSchema, grantRewardSchema, optInSchema, quoteRequestSchema, lockRequestSchema, settlementRequestSchema.

---

### Phase 7: Testing

- [ ] `tests/unit/qualifyingSelectionFilter.test.ts`
  - **Goal**: Test that selections below min odds are filtered out; test edge cases (empty array, all qualify, none qualify).

- [ ] `tests/unit/combinedOddsCalculator.test.ts`
  - **Goal**: Test multiplication of odds; test single selection, multiple selections, and precision handling.

- [ ] `tests/unit/ticketStrengthScorer.test.ts`
  - **Goal**: Test non-linear scaling: verify that 4 selections at 5.0 odds produces disproportionately higher score than 2 selections at 2.5 odds.

- [ ] `tests/unit/deterministicRideGenerator.test.ts`
  - **Goal**: Test determinism (same seed produces identical checkpoints), test oscillation (values go up and down), test crash-to-zero at 100% elapsed.

- [ ] `tests/unit/finalBoostCalculator.test.ts`
  - **Goal**: Test clamping behavior at min/max caps; test crash override when hasEnded=true.

- [ ] `tests/integration/rewardFlow.test.ts`
  - **Goal**: Full E2E test: grant reward, opt-in, quote boost (verify eligible), lock boost, settle as WIN, verify bonus calculated correctly.

- [ ] `tests/integration/idempotency.test.ts`
  - **Goal**: Test that calling lock twice with same bet_id returns same result without creating duplicate; same for settlement.

- [ ] `tests/integration/eligibility.test.ts`
  - **Goal**: Test various ineligibility scenarios: too few selections, odds too low, expired reward, not opted in; verify correct reason codes returned.

- [ ] `jest.config.js`
  - **Goal**: Configure Jest for TypeScript, set test paths, enable coverage reporting with 80% threshold.

---

### Phase 8: Documentation & Examples

- [ ] `docs/api-examples.md`
  - **Goal**: Provide copy-paste ready JSON request/response examples for every endpoint, including success and error cases.

- [ ] `seeds/001_sample_profile.ts`
  - **Goal**: Insert a sample reward profile (min 3 selections, min 2.50 combined odds, min 1.20 per selection, 5-40% boost range, 300 second ride) for local testing.

---

### Phase 9: Final Alignment, Security, and Audit Hardening

**A) Schema & API Alignment**
- [ ] Extend `reward_profile_versions` schema to include:
  - `description` (string, optional)
  - `checkpoint_count` (integer, required)
  - `volatility` (decimal, required)
  - `is_active` (boolean, default true)
- [ ] Update profile DTOs, validation schemas, and controllers to accept/return these fields.
- [ ] Ensure `docs/api-examples.md` matches actual request/response payloads.

**B) Read-Only Retrieval Endpoints**
- [ ] `src/routes/rewards.ts`: add routes to fetch reward data:
  - `GET /api/rewards/:id`
  - `GET /api/rewards/user/:userId`
  - `GET /api/rewards/user/:userId/active`
- [ ] `src/routes/boost.ts`: add `GET /api/boost/lock/:betId`
- [ ] `src/routes/settlement.ts`: add `GET /api/settlement/:betId`
- [ ] Implement corresponding controllers/services/repositories for these reads.

**C) HMAC Authentication (Monetary Security)**
- [ ] Add HMAC auth path using `X-Signature` + `X-Timestamp`.
- [ ] Define canonical signing string (method + path + timestamp + raw body).
- [ ] Enforce timestamp skew window (e.g., ±5 minutes).
- [ ] Reject replayed timestamps with a short-lived cache or DB table.
- [ ] Add tests for valid/invalid signatures and expired timestamps.

**D) Single-Use Reward Enforcement**
- [ ] On successful `lock`, mark reward status as `USED`.
- [ ] Reject additional locks for the same reward with reason code `REWARD_ALREADY_USED`.
- [ ] Add tests for single-use behavior and correct reason codes.

**E) Audit Completeness**
- [ ] Ensure `bet_boost_locks.snapshot_json` includes:
  - qualifying selections + combined odds
  - ticket strength
  - base ride value + final boost value
  - caps used (min/max)
  - seed + checkpoint reference
  - timestamp + elapsed_pct
- [ ] Optionally compute and store:
  - `max_possible_boost_pct` for this ride + ticket (for audits)
- [ ] Ensure settlement records include locked boost reference and payout calculation.

**F) Tests & Validation**
- [ ] Add tests for new read-only endpoints.
- [ ] Add tests validating schema/response alignment for new profile fields.
- [ ] Expand reason code coverage in integration tests (e.g., `REWARD_ALREADY_USED`, `NOT_OPTED_IN`, `RIDE_ENDED`).

---

## Folder Structure

```
MyAPIProject/
├── package.json
├── tsconfig.json
├── knexfile.ts
├── jest.config.js
├── .env.example
├── src/
│   ├── index.ts
│   ├── config/
│   │   └── index.ts
│   ├── db/
│   │   ├── connection.ts
│   │   └── repositories/
│   │       ├── rewardProfileRepository.ts
│   │       ├── userRewardRepository.ts
│   │       ├── rideDefinitionRepository.ts
│   │       ├── betBoostLockRepository.ts
│   │       ├── settlementRepository.ts
│   │       └── auditLogRepository.ts
│   ├── computations/
│   │   ├── index.ts
│   │   ├── qualifyingSelectionFilter.ts
│   │   ├── combinedOddsCalculator.ts
│   │   ├── ticketStrengthScorer.ts
│   │   ├── deterministicRideGenerator.ts
│   │   └── finalBoostCalculator.ts
│   ├── services/
│   │   ├── rewardProfileService.ts
│   │   ├── rewardEntitlementService.ts
│   │   ├── rewardOptInService.ts
│   │   ├── boostQuoteService.ts
│   │   ├── boostLockService.ts
│   │   ├── settlementService.ts
│   │   └── simulationService.ts
│   ├── controllers/
│   │   ├── rewardProfileController.ts
│   │   ├── rewardController.ts
│   │   ├── boostController.ts
│   │   ├── settlementController.ts
│   │   └── simulationController.ts
│   ├── routes/
│   │   ├── index.ts
│   │   ├── rewardProfiles.ts
│   │   ├── rewards.ts
│   │   ├── boost.ts
│   │   ├── settlement.ts
│   │   └── simulation.ts
│   ├── middleware/
│   │   ├── authMiddleware.ts
│   │   ├── errorHandler.ts
│   │   └── requestLogger.ts
│   ├── types/
│   │   ├── rewardProfile.ts
│   │   ├── userReward.ts
│   │   ├── ticket.ts
│   │   ├── betBoostLock.ts
│   │   ├── settlement.ts
│   │   └── reasonCodes.ts
│   └── validation/
│       └── schemas.ts
├── migrations/
│   ├── 001_create_reward_profile_versions.ts
│   ├── 002_create_user_rewards.ts
│   ├── 003_create_ride_definitions.ts
│   ├── 004_create_bet_boost_locks.ts
│   ├── 005_create_settlement_records.ts
│   └── 006_create_audit_logs.ts
├── seeds/
│   └── 001_sample_profile.ts
├── tests/
│   ├── unit/
│   │   ├── qualifyingSelectionFilter.test.ts
│   │   ├── combinedOddsCalculator.test.ts
│   │   ├── ticketStrengthScorer.test.ts
│   │   ├── deterministicRideGenerator.test.ts
│   │   └── finalBoostCalculator.test.ts
│   └── integration/
│       ├── rewardFlow.test.ts
│       ├── idempotency.test.ts
│       └── eligibility.test.ts
└── docs/
    └── api-examples.md
```

---

## API Endpoint Summary

| Method | Path | Description |
|--------|------|-------------|
| POST | /api/profiles | Create reward profile |
| GET | /api/profiles/:id | Get reward profile |
| PUT | /api/profiles/:id | Update reward profile |
| DELETE | /api/profiles/:id | Delete reward profile |
| GET | /api/profiles | List all profiles |
| POST | /api/rewards | Grant reward entitlement (CRM) |
| POST | /api/rewards/:id/opt-in | User opts into rollercoaster |
| POST | /api/boost/quote | Get current boost for slip |
| POST | /api/boost/lock | Lock boost to placed bet |
| POST | /api/settlement | Settle bet outcome |
| POST | /api/simulation | Admin ride curve simulation |

---

## Verification Steps

1. **Run Migrations**: `npm run migrate` to create all database tables
2. **Seed Data**: `npm run seed` to insert sample reward profile
3. **Run Unit Tests**: `npm test` to verify all computation modules
4. **Run Integration Tests**: `npm run test:integration` to verify full API flows
5. **Manual API Testing**: Use examples from `docs/api-examples.md` with curl
6. **Verify Determinism**: Call quote multiple times with same reward/user/ticket and confirm identical results
7. **Verify Idempotency**: Call lock twice with same bet_id and confirm no duplicate records
