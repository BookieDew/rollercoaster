# Combo Boost Rollercoaster API - Example Payloads

This document provides example JSON payloads for every API endpoint. For setup,
environment variables and running the service, see [README.md](../README.md).

## Authentication

All endpoints require authentication via one of:
- `X-API-Key` header with your API key
- `X-Signature` + `X-Timestamp` headers for HMAC authentication

Admin/config endpoints (`/api/profiles`, `/api/simulation`) require an admin API key in `X-API-Key`.

```bash
# Using API Key
curl -H "X-API-Key: your-api-key" ...

# Using HMAC Signature
curl -H "X-Signature: <hmac-hex>" -H "X-Timestamp: <unix-ms>" ...
```

### HMAC Signing (Recommended for Monetary Endpoints)

To generate `X-Signature`, build this exact string (including newlines):

```
<timestamp>\n<METHOD>\n<PATH_WITH_QUERY>\n<BODY>
```

- `timestamp` is Unix milliseconds (same value as `X-Timestamp`)
- `METHOD` is uppercase HTTP method (e.g., `POST`)
- `PATH_WITH_QUERY` is the full path as sent (e.g., `/api/boost/lock`)
- `BODY` is the raw JSON body string (empty string for no body)

Then compute:

```
HMAC_SHA256(signature_string, HMAC_SECRET) -> hex
```

Notes:
- `X-Signature` must be exactly 64 hexadecimal characters (the SHA-256 hex digest;
  upper or lower case). Anything else is rejected with 401.
- `X-Timestamp` must be digits only (no sign, decimal point or whitespace) and is
  Unix epoch milliseconds; any other format is rejected with 401. A value in seconds
  fails the time-window check.
- Requests outside the allowed time window (default: ±5 minutes) are rejected.
- Replays of the exact same signed request within the window are rejected, whatever
  the letter case of the signature.

### Demo UI

The local demo at `/demo` is served only when `DEMO_UI_ENABLED` is true. It defaults
to on in development/test and off in production; see [README.md](../README.md)
for configuration.

---

## Brands, money and validity

One shared back end serves several brands (B2C operators).

- `brand_id` is 1-64 characters of letters, digits, underscore or hyphen.
- A **profile belongs to one brand**: `brand_id` is required when creating it and
  can never be changed (a `brand_id` in a profile update is 400).
- A **reward inherits the brand of its profile** when it is granted.
- A **player is `(brand_id, user_id)`** and a **bet is `(brand_id, bet_id)`**. The
  same `bet_id` may exist in two brands; inside one brand a second reward bound to
  it gets 409 `BET_ALREADY_BOUND`. A database unique index on user rewards
  `(brand_id, bet_id)` backs this check, and a violation of it is also 409, never 500.
- `GET /api/rewards/user/:userId`, `GET /api/rewards/user/:userId/active`,
  `GET /api/boost/lock/:betId` and `GET /api/settlement/:betId` **require the query
  parameter `brand_id`**; a missing or malformed value is 400 `VALIDATION_ERROR`,
  and results never cross brands. Quote, lock and opt-in keep their bodies: the
  brand comes from the reward. Settle and resettle carry `brand_id` in the body.
- Locks are unique per `(brand_id, bet_id)` too, so two brands can each lock and
  settle their own `bet-789` independently.
- Rows created before brands existed belong to brand `default`.

**Money** is an integer number of minor units plus a currency code
(`^[A-Z]{3}$`, e.g. `EUR`). Floating-point money is never used. `stake_minor`
`1000` with currency `EUR` means 10.00 EUR. Derived amounts round **half-up** to
the nearest minor unit (2.5 becomes 3, 2.49 becomes 2).

**Bonus cap and validity** are profile settings:
- `max_bonus_minor`: object mapping a currency to a positive integer cap, at least
  one entry (for example `{ "EUR": 50000, "USD": 55000 }`).
- `reward_validity_seconds`: integer from 60 to 31,536,000 (365 days).

Both can be updated with `PUT /api/profiles/:id`; an update affects **future
grants and opt-ins only**. The stake, currency and cap are copied onto the reward
at opt-in, so editing a profile never changes a bet already in flight. A reward is
usable until `valid_until = granted_at + reward_validity_seconds`; legacy rewards
have `valid_until: null` and never expire. A legacy profile has no caps (`{}`), so
it needs a `PUT` with `max_bonus_minor` before it can accept new opt-ins.

### Worked examples (bonus = locked boost x total return)

Stake 10.00 EUR (`stake_minor` 1000), cap 500.00 EUR (`bonus_cap_minor` 50000):

| Case | Total return | Locked boost | Calculation | Bonus |
|------|-------------|--------------|-------------|-------|
| Three-leg win at 2.00 x 1.50 x 1.80 | 54.00 EUR (5400) | 25% | 5400 x 0.25 = 1350 | 13.50 EUR |
| Cap applies: stake 100.00, odds product 12.00 | 1200.00 EUR (120000) | 50% | 60000 capped at 50000 | 500.00 EUR (`cap_applied`) |
| Half-up rounding: return 0.05 EUR (5) | 0.05 EUR (5) | 50% | 5 x 0.5 = 2.5 rounds to 3 | 0.03 EUR |

Push versus cancel: a `PUSH` leg pays 1.00 and keeps counting with its original
odds for the minimums; a `CANCELLED` leg pays 1.00 and is removed, and the
minimums are re-checked on the remaining legs (a failure gives `WON_NO_BONUS`). A
fully cancelled bet returns the token. See [Settlement](#settlement) for the full
rules and worked examples.

---

## Reward Profiles

Ride checkpoint count, volatility, and crash timing are derived internally from the
stored seed. Default duration is 2–15 seconds. The profile's
`ride_duration_seconds` field remains in the API, but actual ride duration comes
from internal duration settings; it is not a countdown promise.

Optional `max_boost_min_selections` and `max_boost_min_combined_odds` control the
ticket-adjusted cap. Reaching these targets permits access to the profile cap;
it does not guarantee that this seeded ride reaches it. With both targets unset,
the effective cap equals the profile cap, but the per-ride maximum may be lower.

Operators can also tune boost-model behavior per profile:
- `max_eligibility_selection_weight` (default `0.75`)
- `max_eligibility_odds_weight` (default `0.25`)
- `effective_min_floor_rate` (default `0.35`)
- `ride_mode` (`WAVES` default, or `LINEAR`)

The two weights must sum to `1.0`. New LINEAR rides climb from their effective
floor toward the same-seed WAVES pre-crash maximum, not the effective cap.
Resolved settings are frozen when a new ride starts; editing a profile afterward
does not change that started ride or an existing locked payout.

### Create Profile

**POST** `/api/profiles`

```json
// Request
{
  "brand_id": "acme",
  "name": "Standard Combo Boost",
  "description": "Default boost profile for combo bets",
  "min_selections": 3,
  "min_combined_odds": 3.0,
  "min_selection_odds": 1.2,
  "min_boost_pct": 0.05,
  "max_boost_pct": 0.5,
  "max_boost_min_selections": 6,
  "max_boost_min_combined_odds": 12.0,
  "max_eligibility_selection_weight": 0.75,
  "max_eligibility_odds_weight": 0.25,
  "effective_min_floor_rate": 0.35,
  "ride_mode": "WAVES",
  "ride_duration_seconds": 3600,
  "max_bonus_minor": { "EUR": 50000, "USD": 55000 },
  "reward_validity_seconds": 604800
}

// Response (201 Created)
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "brand_id": "acme",
  "name": "Standard Combo Boost",
  "description": "Default boost profile for combo bets",
  "min_selections": 3,
  "min_combined_odds": 3.0,
  "min_selection_odds": 1.2,
  "min_boost_pct": 0.05,
  "max_boost_pct": 0.5,
  "max_boost_min_selections": 6,
  "max_boost_min_combined_odds": 12.0,
  "max_eligibility_selection_weight": 0.75,
  "max_eligibility_odds_weight": 0.25,
  "effective_min_floor_rate": 0.35,
  "ride_mode": "WAVES",
  "ride_duration_seconds": 3600,
  "max_bonus_minor": { "EUR": 50000, "USD": 55000 },
  "reward_validity_seconds": 604800,
  "is_active": true,
  "created_at": "2024-01-15T10:30:00.000Z",
  "updated_at": "2024-01-15T10:30:00.000Z"
}
```

`brand_id`, `max_bonus_minor` and `reward_validity_seconds` are required.
`max_bonus_minor` needs at least one currency with a positive integer cap, and
`reward_validity_seconds` must be 60-31,536,000; violations return 400
`VALIDATION_ERROR`.

### Get Profile

**GET** `/api/profiles/:id`

```json
// Response (200 OK)
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "name": "Standard Combo Boost",
  "description": "Default boost profile for combo bets",
  "min_selections": 3,
  "min_combined_odds": 3.0,
  "min_selection_odds": 1.2,
  "min_boost_pct": 0.05,
  "max_boost_pct": 0.5,
  "max_boost_min_selections": 6,
  "max_boost_min_combined_odds": 12.0,
  "max_eligibility_selection_weight": 0.75,
  "max_eligibility_odds_weight": 0.25,
  "effective_min_floor_rate": 0.35,
  "ride_mode": "WAVES",
  "ride_duration_seconds": 3600,
  "is_active": true,
  "created_at": "2024-01-15T10:30:00.000Z",
  "updated_at": "2024-01-15T10:30:00.000Z"
}
```

### List Profiles

**GET** `/api/profiles` or `/api/profiles?active=true`

Optional query `brand_id` limits the list to one brand (`/api/profiles?brand_id=acme&active=true`).

```json
// Response (200 OK)
{
  "profiles": [
    {
      "id": "550e8400-e29b-41d4-a716-446655440000",
      "name": "Standard Combo Boost",
      "min_selections": 3,
      "min_combined_odds": 3.0,
      "min_selection_odds": 1.2,
      "min_boost_pct": 0.05,
      "max_boost_pct": 0.5,
      "max_boost_min_selections": 6,
      "max_boost_min_combined_odds": 12.0,
      "max_eligibility_selection_weight": 0.75,
      "max_eligibility_odds_weight": 0.25,
      "effective_min_floor_rate": 0.35,
      "ride_mode": "WAVES",
      "ride_duration_seconds": 3600,
      "is_active": true,
      "created_at": "2024-01-15T10:30:00.000Z",
      "updated_at": "2024-01-15T10:30:00.000Z"
    }
  ],
  "count": 1
}
```

### Update Profile

**PUT** `/api/profiles/:id`

```json
// Request
{
  "max_boost_pct": 0.75,
  "max_boost_min_selections": 8,
  "max_boost_min_combined_odds": 20.0,
  "max_eligibility_selection_weight": 0.8,
  "max_eligibility_odds_weight": 0.2,
  "effective_min_floor_rate": 0.4,
  "ride_mode": "LINEAR",
  "max_bonus_minor": { "EUR": 75000 },
  "reward_validity_seconds": 259200,
  "is_active": true
}

// Response (200 OK)
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "name": "Standard Combo Boost",
  "max_boost_pct": 0.75,
  "is_active": true,
  // ... other fields
}
```

`max_bonus_minor` replaces the whole cap map and affects future opt-ins only;
`reward_validity_seconds` affects future grants only. `brand_id` cannot be updated
(400 `VALIDATION_ERROR`).

### Delete Profile

**DELETE** `/api/profiles/:id`

```
Response: 204 No Content
```

---

## Rewards

Selections can include optional flags to exclude them from qualification:
`eligible: false` and optional `ineligible_reason` (e.g., BOOSTED_ODDS, ZERO_MARGIN).
Excluded selections do not count toward qualifying selection count or combined odds.

For Same Game Parlay (SGP), use explicit selection metadata:
- `selection_type`: `STANDARD` (default), `SGP_COMPOSITE`, or `SGP_LEG`
- `sgp_group_id`: required when `selection_type` is `SGP_COMPOSITE` or `SGP_LEG`
- `SGP_LEG` entries never count toward qualifying selection count or combined odds
- If multiple `SGP_COMPOSITE` entries share the same `sgp_group_id`, only the first counts

Reward and profile `:id` path params must be UUIDs; `:userId` and `:betId` must be
1–255 characters. `user_id`, `bet_id` and selection `id`/`name`/`market`/`event` are
at most 255 characters, selection `odds` at most 10,000, and a ticket at most 100
selections. Violations return 400 `VALIDATION_ERROR`.

While a reward is playable (`GRANTED` or `ENTERED`), `end_time` is `null` in every
reward response (grant, get, list, active, opt-in), so ride length is never a
countdown. It is shown once the reward is `USED` or `EXPIRED`. The ride seed is
generated server-side from 32 random bytes and is never returned.

### Grant Reward

**POST** `/api/rewards`

```json
// Request
{
  "user_id": "user-12345",
  "profile_version_id": "550e8400-e29b-41d4-a716-446655440000",
  "duration_seconds": 7200  // Optional compatibility field; actual duration uses internal settings
}

// Response (201 Created)
{
  "id": "660e8400-e29b-41d4-a716-446655440001",
  "brand_id": "acme",
  "user_id": "user-12345",
  "profile_version_id": "550e8400-e29b-41d4-a716-446655440000",
  "status": "GRANTED",
  "start_time": "2024-01-15T12:00:00.000Z",
  "end_time": null,
  "opted_in_at": null,
  "valid_until": "2024-01-22T12:00:00.000Z",
  "bet_id": null,
  "stake_minor": null,
  "currency": null,
  "bonus_cap_minor": null,
  "replaces_reward_id": null,
  "created_at": "2024-01-15T12:00:00.000Z",
  "updated_at": "2024-01-15T12:00:00.000Z"
}
```

### Precheck Eligibility (Before Starting Ride)

**POST** `/api/rewards/:id/eligibility`

```json
// Request
{
  "user_id": "user-12345",
  "ticket": {
    "selections": [
      { "id": "sel-001", "odds": 1.85 },
      { "id": "sel-002", "odds": 2.10, "eligible": false, "ineligible_reason": "BOOSTED_ODDS" },
      { "id": "sel-003", "odds": 1.65 },
      { "id": "sgp-main", "odds": 2.40, "selection_type": "SGP_COMPOSITE", "sgp_group_id": "sgp-001" },
      { "id": "sgp-leg-1", "odds": 1.60, "selection_type": "SGP_LEG", "sgp_group_id": "sgp-001" }
    ]
  }
}

// Response (200 OK) - Eligible
{
  "eligible": true,
  "reason_code": "ELIGIBLE",
  "qualifying_selection_count": 3,
  "total_selection_count": 5,
  "combined_odds": 7.326,
  "ticket_strength": 0.050539
}

// Response (200 OK) - Not Eligible
{
  "eligible": false,
  "reason_code": "MIN_SELECTIONS_NOT_MET",
  "qualifying_selection_count": 2,
  "total_selection_count": 5,
  "combined_odds": 3.88,
  "ticket_strength": 0
}
```

### Get Reward

**GET** `/api/rewards/:id`

```json
// Response (200 OK)
{
  "id": "660e8400-e29b-41d4-a716-446655440001",
  "brand_id": "acme",
  "user_id": "user-12345",
  "profile_version_id": "550e8400-e29b-41d4-a716-446655440000",
  "status": "ENTERED",
  "start_time": "2024-01-15T12:05:00.000Z",
  "end_time": null,
  "opted_in_at": "2024-01-15T12:05:00.000Z",
  "valid_until": "2024-01-22T12:00:00.000Z",
  "bet_id": "bet-789",
  "stake_minor": 1000,
  "currency": "EUR",
  "bonus_cap_minor": 50000,
  "replaces_reward_id": null,
  "created_at": "2024-01-15T12:00:00.000Z",
  "updated_at": "2024-01-15T12:05:00.000Z"
}
```

### Get User Rewards

**GET** `/api/rewards/user/:userId?brand_id=acme`

`brand_id` is required (400 `VALIDATION_ERROR` when missing or malformed); only
that brand's rewards for the player are returned.

```json
// Response (200 OK)
{
  "rewards": [
    {
      "id": "660e8400-e29b-41d4-a716-446655440001",
      "user_id": "user-12345",
      "status": "ENTERED",
      // ... other fields
    }
  ],
  "count": 1
}
```

### Get Active Reward

**GET** `/api/rewards/user/:userId/active?brand_id=acme`

`brand_id` is required. A `GRANTED` reward past its `valid_until` is not active.

```json
// Response (200 OK) - with active reward
{
  "active_reward": {
    "id": "660e8400-e29b-41d4-a716-446655440001",
    "user_id": "user-12345",
    "status": "ENTERED",
    // ... other fields
  }
}

// Response (200 OK) - no active reward
{
  "active_reward": null
}
```

### Opt In to Reward

**POST** `/api/rewards/:id/opt-in`

The bet is already placed. This call starts the ride for that bet and freezes the
resolved profile/mode, the ticket inputs, the ride parameters (duration, outcome,
crash time, pace, payout band, maximums) and a commitment to the seed in
`ticketSnapshot.rideMath` (version 4). Quotes and locks rebuild the ride from the
stored seed and refuse it if anything differs from the snapshot. The snapshot is
internal, not a new opt-in response field. `end_time` is kept in the
response shape for compatibility but is always `null` for a live ride.

The body also carries the stake and its currency (see
[Brands, money and validity](#brands-money-and-validity)):
- `stake_minor`: required positive safe integer, at most 1e12 (1000 = 10.00).
- `currency`: required, `^[A-Z]{3}$`, and a key of the profile's `max_bonus_minor`
  map; otherwise 422 `CURRENCY_NOT_SUPPORTED` and the reward stays `GRANTED`.
- `ticket.stake` (the old decimal stake) is **deprecated**: it is still accepted,
  but ignored.
- Selection ids must be unique within the ticket (400 `VALIDATION_ERROR`
  otherwise), because settlement reports one result per `selection_id`.

The stake, currency and the profile's cap for that currency are frozen on the
reward. Opting in after `valid_until` marks the reward `EXPIRED` (with an audit
row) and returns 422 `REWARD_EXPIRED`.

A `bet_id` already attached to a different reward of the same brand (any status)
is rejected with 409 `BET_ALREADY_BOUND`. Re-opting the same reward keeps its existing answers
(`ALREADY_OPTED_IN`, `REWARD_ALREADY_USED`, `REWARD_EXPIRED`). The status change,
bet binding and audit row are written in one transaction; a
concurrent second opt-in of the same reward gets 409 `ALREADY_OPTED_IN`.

```json
// Request
{
  "user_id": "user-12345",
  "bet_id": "bet-789",
  "stake_minor": 1000,
  "currency": "EUR",
  "ticket": {
    "selections": [
      {
        "id": "sel-001",
        "odds": 1.85,
        "name": "Team A to Win",
        "market": "Match Result",
        "event": "Team A vs Team B"
      },
      {
        "id": "sel-002",
        "odds": 2.10,
        "name": "Over 2.5 Goals",
        "market": "Total Goals",
        "event": "Team C vs Team D"
      },
      {
        "id": "sel-003",
        "odds": 1.65,
        "name": "Player X Anytime Scorer",
        "market": "Goalscorer",
        "event": "Team E vs Team F"
      }
    ]
  }
}

// Response (200 OK)
{
  "reward_id": "660e8400-e29b-41d4-a716-446655440001",
  "brand_id": "acme",
  "status": "ENTERED",
  "ride_started": true,
  "stake_minor": 1000,
  "currency": "EUR",
  "bonus_cap_minor": 50000,
  "end_time": null
}
```

---

## Boost

Live values are authoritative server calculations. A successful lock freezes that
value; a later profile edit, simulation, chart sample, crash, or ride end cannot
recalculate the payout. Crash/end prevents a new lock and returns zero current boost.

| Field | Meaning |
|---|---|
| `effective_min_boost_pct` / `effective_max_boost_pct` | Ticket-adjusted floor/cap; the cap is not promised on each ride |
| `theoretical_max_boost_pct` | Exact highest value the ride reaches before the crash or end, not a guaranteed lockable payout. `null` in live (eligible) quotes; returned on terminal quotes, terminal lock errors and locks |
| `maximum_model` | `PRE_CRASH_SUPREMUM_V4` |
| `ride_elapsed_seconds` | Authoritative sampled offset from start, with millisecond precision; eligible/terminal quotes and terminal lock error details |
| `ride_stop_at_offset_seconds` | Successful lock's exact evaluation offset; pair it with `locked_boost_pct`, not interpolation of the sampled path |
| `ride_end_at_offset_seconds` / `ride_crash_at_offset_seconds` | Completed/locked schedule offsets; active quotes return null |
| `ride_path` | 60 full-ride samples, returned only after lock or terminal quote/lock error; never present in active quotes |

The maximum is the exact highest value before the open crash/end boundary, after
the payout transform. The exact crash/end value is zero, and finite server
sampling may never attain the maximum. In LINEAR the climb stops at this ride's
maximum. Rides that were in flight under older math were closed by migration 016: their
reward is `EXPIRED` and quote and lock answer `REWARD_EXPIRED`.

`ride_path` uses `{ "timePct": number, "baseBoostValue": number }`: `timePct` is
fractional ride duration and the historically named `baseBoostValue` is the actual
effective boost at that sample, with zero at/after crash/end. Path maxima and live
observed peaks can differ from the theoretical maximum. The demo progressively
plots accepted `(ride_elapsed_seconds, current_boost_pct)` samples, keeps gaps
visible, freezes the exact stop/terminal result, and retains raw JSON. It does not
forecast the future path.

`ride_elapsed_seconds` is not time remaining or normalized progress. A terminal
sample may arrive after the crash/end offset. Quote evaluation and status checks
use one server instant. Unrelated ineligibility omits this field.

Ride timing (V4): the ride is built from a secret 32-byte seed through keyed
(HMAC) random streams, so the same seed and settings always give the same ride.
The outcome is no-crash with 8% probability. Otherwise the crash falls in a
window after the minimum crash time, in a weighted bucket (EARLY 10%, MID 65%,
LATE 25%) with a crash phase (UP 50%, PEAK 20%, DOWN 30%). WAVES is a multi-peak
ride; LINEAR climbs from the effective floor toward this ride's maximum at the
MEDIUM pace (9 seconds to the top of the band). These are random draws per
ride, not guaranteed proportions in a finite sample or what every client
observes. This is local implementation behavior, not release approval or an RTP
promise.

### Get Quote

**POST** `/api/boost/quote`

```json
{
  "user_id": "user-12345",
  "reward_id": "660e8400-e29b-41d4-a716-446655440001",
  "bet_id": "bet-789"
}
```

The eligible example uses a controlled WAVES fixture: seed `audit-seed-42`, three
1.5 selections, eligibility minimums 3 selections / combined odds 3 / per-selection
odds 1.2, profile min/max 0.05/1, no max-access targets, and default weights/floor.
This fixture is independent of the earlier profile example; production reward
seeds are assigned by the server. At 1.390 seconds, the response is (the live
quote withholds `theoretical_max_boost_pct`; the fixture's maximum, 0.290494, is
revealed by the terminal quote and the lock below):

```json
{
  "eligible": true,
  "reason_code": "ELIGIBLE",
  "qualifying_selection_count": 3,
  "total_selection_count": 3,
  "combined_odds": 3.375,
  "current_boost_pct": 0.251138,
  "effective_min_boost_pct": 0.05,
  "effective_max_boost_pct": 1,
  "theoretical_max_boost_pct": null,
  "maximum_model": "PRE_CRASH_SUPREMUM_V4",
  "ticket_strength": 0.042009,
  "boost_model": {
    "selection_weight": 0.75,
    "odds_weight": 0.25,
    "max_eligibility_exponent": 1.2,
    "effective_min_floor_rate": 0.35,
    "selection_ratio": null,
    "odds_ratio": null,
    "eligibility_factor": 1
  },
  "ride_elapsed_seconds": 1.39,
  "ride_end_at_offset_seconds": null,
  "ride_crash_at_offset_seconds": null
}
```

For the same inputs in LINEAR, current boost at this instant is `0.170247`, with
the same floor, cap, strength, and (withheld) maximum. This shape difference is intentional.

Terminal response excerpts below omit ticket/model details and the full
`ride_path` array. No-crash end for the fixture above, sampled at 2.781 seconds:

```json
{
  "eligible": false,
  "reason_code": "RIDE_ENDED",
  "current_boost_pct": 0,
  "theoretical_max_boost_pct": 0.290494,
  "maximum_model": "PRE_CRASH_SUPREMUM_V4",
  "ride_elapsed_seconds": 2.781,
  "ride_end_at_offset_seconds": 2.78,
  "ride_crash_at_offset_seconds": 2.78
}
```

A separate crashing fixture, sampled at 2.041 seconds (duration 9.563 seconds,
crash fraction 0.2134), returns:

```json
{
  "eligible": false,
  "reason_code": "RIDE_CRASHED",
  "current_boost_pct": 0,
  "theoretical_max_boost_pct": 0.131805,
  "maximum_model": "PRE_CRASH_SUPREMUM_V4",
  "ride_elapsed_seconds": 2.041,
  "ride_end_at_offset_seconds": 9.563,
  "ride_crash_at_offset_seconds": 2.041
}
```

Reported schedule offsets round to milliseconds; evaluation uses the unrounded
crash fraction (2.0407442 seconds in that example). Selection/odds eligibility
failures return `current_boost_pct: null` and a reason such as
`MIN_SELECTIONS_NOT_MET`; these are not zero-valued ride-terminal samples. Their
computed ticket strength can still be numeric, even when the ticket is rejected.

### Lock Boost

**POST** `/api/boost/lock`

Use the same user/reward/bet fields as the quote request. Success returns HTTP 201,
consumes the reward (`USED`), and includes the frozen boost/model/path and timing.
The following excerpt is the WAVES fixture locked at the same 1.390-second instant;
the full response also includes `boost_model` and `ride_path`:

```json
{
  "lock_id": "770e8400-e29b-41d4-a716-446655440002",
  "brand_id": "acme",
  "bet_id": "bet-789",
  "reward_id": "660e8400-e29b-41d4-a716-446655440001",
  "locked_boost_pct": 0.251138,
  "qualifying_selections": 3,
  "qualifying_odds": 3.375,
  "ticket_strength": 0.042009,
  "locked_at": "2026-09-18T10:00:01.390Z",
  "effective_min_boost_pct": 0.05,
  "effective_max_boost_pct": 1,
  "theoretical_max_boost_pct": 0.290494,
  "maximum_model": "PRE_CRASH_SUPREMUM_V4",
  "ride_stop_at_offset_seconds": 1.39,
  "ride_end_at_offset_seconds": 2.78,
  "ride_crash_at_offset_seconds": 2.78
}
```

Repeat lock returns the saved result only for the same reward and its owning
user; the bet locked under a different reward or user returns 409
`BET_ALREADY_LOCKED`. Lock insert, the `ENTERED` → `USED` transition and the audit
row are one transaction. A lock attempted at/after crash or end fails
with `RIDE_CRASHED` or `RIDE_ENDED`; its error `details` include zero current boost,
`ride_elapsed_seconds`, schedule offsets, model metadata, and the full sampled path.

### Get Lock

**GET** `/api/boost/lock/:betId?brand_id=acme`

`brand_id` is required (400 `VALIDATION_ERROR` otherwise); a lock in another brand
returns 404. Locks are unique per `(brand_id, bet_id)`, so the same `bet_id` can be
locked once in each brand.

HTTP 200 returns the saved lock fields shown above, including the stored
`maximum_model` when available, `boost_model`, exact stop offset, and `ride_path`.
It does not recalculate against the current profile. Historical locks without model
metadata omit `maximum_model` on both read and repeated lock responses. A missing
lock returns 404 with code `LOCK_NOT_FOUND`.

---

## Settlement

Settlement applies to **locked** bets only. A bet that was opted in but never
locked has nothing to settle (404 `LOCK_NOT_FOUND`), and a ride that crashed or
ended without a lock returns no token.

The server computes the result from values frozen earlier, never from the request:

| Input | Frozen at | Source |
|-------|-----------|--------|
| Ticket legs and their odds (the whole stored ticket) | opt-in | reward |
| `stake_minor`, `currency`, `bonus_cap_minor` | opt-in | reward |
| `locked_boost_pct` | lock | lock |
| Profile minimums (selections, combined odds, selection odds) | opt-in / lock | lock snapshot |

Arithmetic is exact integer arithmetic (no floats). Odds and the locked boost are
read with at most 6 decimal places, and each amount is rounded once, half-up:

- `total_return_minor = round_half_up(stake_minor x product of leg odds)`, where a
  `WON` leg uses its original odds and a `PUSH` or `CANCELLED` leg uses 1.00;
- `bonus_minor = min(round_half_up(total_return_minor x locked_boost_pct), bonus_cap_minor)`;
  `cap_applied` is true only when the uncapped bonus is strictly above the cap.

A reward locked without a stake/currency/cap snapshot (legacy data) cannot be
settled: 422 `SETTLEMENT_UNAVAILABLE`; so is a stored ticket or money snapshot the
calculator rejects (for example stored odds with more than 6 decimal places). Odds
sent at opt-in or lock with more than 6 decimal places are rejected up front (400
`VALIDATION_ERROR`).

`total_return_minor` is an exact decimal-integer **string** (for example `"9975"`;
`"0"` for `LOST`, `null` for `CANCELLED` and `CASHED_OUT`) in every settlement
response, the GET and each revision, because a sportsbook return can exceed 2^53
(100 legs at odds 10,000 on a 1e12 stake return 10^412 minor units). It is stored
exactly as text. There is no size limit: every ticket the API accepts settles, and
max payout or max stake rules are the sportsbook's responsibility, not the boost's.
The bonus stays at most `bonus_cap_minor`, so `bonus_minor` and every other money
field remain JSON numbers.

### Settle Bet

**POST** `/api/settlement`

- `brand_id`, `bet_id`: the bet (a `bet_id` is unique inside its brand).
- `outcome`: `SETTLED`, `CASHOUT` or `CANCELLED`.
- `legs`: required for `SETTLED`, forbidden otherwise. Exactly one
  `{ "selection_id", "result" }` per **bet leg**, with `result` one of `WON`,
  `LOST`, `PUSH`, `CANCELLED`, in any order. Bet legs are all stored ticket
  selections except `SGP_LEG` (illustrative only), including excluded and
  ineligible selections. Missing, unknown, duplicate or `SGP_LEG` ids are 400
  `VALIDATION_ERROR` with one entry per problem in `details`.

Bet result, in this order:

| Condition | `bet_result` | Total return | Bonus | Token |
|-----------|--------------|--------------|-------|-------|
| `outcome` `CASHOUT` | `CASHED_OUT` | `null` | 0 | spent |
| `outcome` `CANCELLED`, or every leg `CANCELLED` | `CANCELLED` | `null` | 0 | **returned** as a new reward |
| any leg `LOST` | `LOST` | 0 | 0 | spent |
| no leg `WON` (all `PUSH`, or `PUSH` and `CANCELLED`) | `PUSHED` | the stake | 0 | spent |
| a leg `CANCELLED` and the minimums fail on the remaining legs | `WON_NO_BONUS` | computed | 0 | spent |
| otherwise | `WON` | computed | capped bonus | spent |

The minimums re-check runs only when at least one leg is `CANCELLED`. It applies
the opt-in qualifying filter to the non-cancelled bet legs; a `PUSH` leg counts
with its **original** odds (a push is a legitimate result, so it never triggers a
re-evaluation by itself). `minimums_met` is `true`/`false` when the re-check ran
and `null` otherwise. The locked boost rate never changes.

**Worked examples.** Profile minimums: 2 selections, combined odds 5.0, selection
odds 1.2. Stake 10.00 EUR (`stake_minor` 1000), legs `a` 2.10, `b` 1.90, `c` 2.50
(combined 9.975), locked boost 20%, cap 500.00 EUR (50000).

| Legs `a` / `b` / `c` | `bet_result` | `total_return_minor` | `bonus_minor` | `minimums_met` |
|----------------------|--------------|----------------------|---------------|----------------|
| WON / WON / WON | `WON` | 9975 (99.75 EUR) | 1995 (19.95 EUR) | `null` |
| WON / PUSH / WON | `WON` | 5250 | 1050 | `null` |
| PUSH / PUSH / PUSH | `PUSHED` | 1000 | 0 | `null` |
| WON / CANCELLED / WON (2.10 x 2.50 = 5.25 keeps the minimums) | `WON` | 5250 | 1050 | `true` |
| WON / WON / CANCELLED (2.10 x 1.90 = 3.99 < 5.0) | `WON_NO_BONUS` | 3990 | 0 | `false` |
| WON / CANCELLED / PUSH (re-check 2.10 x 2.50 at the push's original odds = 5.25) | `WON` | 2100 | 420 | `true` |
| WON / PUSH / CANCELLED (re-check 2.10 x 1.90 = 3.99) | `WON_NO_BONUS` | 2100 | 0 | `false` |
| WON / LOST / any | `LOST` | 0 | 0 | `null` |
| `outcome` `CASHOUT` (no legs) | `CASHED_OUT` | `null` | 0 | `null` |
| `outcome` `CANCELLED`, or all legs CANCELLED | `CANCELLED` | `null` | 0 | `null` |
| WON / WON / WON with a 15.00 EUR cap (1500) | `WON` | 9975 | 1500, `cap_applied: true` | `null` |

```json
// Request - every leg won
{
  "brand_id": "acme",
  "bet_id": "bet-789",
  "outcome": "SETTLED",
  "legs": [
    { "selection_id": "a", "result": "WON" },
    { "selection_id": "b", "result": "WON" },
    { "selection_id": "c", "result": "WON" }
  ]
}

// Response (201 Created)
{
  "settlement_id": "880e8400-e29b-41d4-a716-446655440003",
  "brand_id": "acme",
  "bet_id": "bet-789",
  "lock_id": "770e8400-e29b-41d4-a716-446655440002",
  "revision": 1,
  "outcome": "SETTLED",
  "bet_result": "WON",
  "legs": [
    { "selection_id": "a", "result": "WON" },
    { "selection_id": "b", "result": "WON" },
    { "selection_id": "c", "result": "WON" }
  ],
  "currency": "EUR",
  "stake_minor": 1000,
  "total_return_minor": "9975",
  "locked_boost_pct": 0.2,
  "bonus_minor": 1995,
  "bonus_cap_minor": 50000,
  "cap_applied": false,
  "minimums_met": null,
  "replacement_reward_id": null,
  "replacement_status": null,
  "reason": null,
  "previous_bonus_minor": null,
  "bonus_delta_minor": null,
  "settled_at": "2024-01-15T15:00:00.000Z"
}

// Request - one leg pushed: 1000 x 2.10 x 1.00 x 2.50 = 5250, bonus 1050
{
  "brand_id": "acme",
  "bet_id": "bet-789",
  "outcome": "SETTLED",
  "legs": [
    { "selection_id": "a", "result": "WON" },
    { "selection_id": "b", "result": "PUSH" },
    { "selection_id": "c", "result": "WON" }
  ]
}
// Response (201): "bet_result": "WON", "total_return_minor": "5250", "bonus_minor": 1050, "minimums_met": null

// Request - one leg cancelled, minimums kept: legs a WON, b CANCELLED, c WON
// Response (201): "bet_result": "WON", "total_return_minor": "5250", "bonus_minor": 1050, "minimums_met": true

// Request - one leg cancelled, minimums broken: legs a WON, b WON, c CANCELLED
// Response (201): "bet_result": "WON_NO_BONUS", "total_return_minor": "3990", "bonus_minor": 0, "minimums_met": false

// Request - a leg lost: legs a WON, b LOST, c WON
// Response (201): "bet_result": "LOST", "total_return_minor": "0", "bonus_minor": 0

// Request - cash-out (no legs)
{ "brand_id": "acme", "bet_id": "bet-789", "outcome": "CASHOUT" }
// Response (201): "bet_result": "CASHED_OUT", "total_return_minor": null, "bonus_minor": 0

// Request - whole bet cancelled (no legs)
{ "brand_id": "acme", "bet_id": "bet-789", "outcome": "CANCELLED" }

// Response (201 Created)
{
  "settlement_id": "880e8400-e29b-41d4-a716-446655440004",
  "brand_id": "acme",
  "bet_id": "bet-789",
  "lock_id": "770e8400-e29b-41d4-a716-446655440002",
  "revision": 1,
  "outcome": "CANCELLED",
  "bet_result": "CANCELLED",
  "legs": null,
  "currency": "EUR",
  "stake_minor": 1000,
  "total_return_minor": null,
  "locked_boost_pct": 0.2,
  "bonus_minor": 0,
  "bonus_cap_minor": 50000,
  "cap_applied": false,
  "minimums_met": null,
  "replacement_reward_id": "990e8400-e29b-41d4-a716-446655440005",
  "replacement_status": "ISSUED",
  "reason": null,
  "previous_bonus_minor": null,
  "bonus_delta_minor": null,
  "settled_at": "2024-01-15T15:00:00.000Z"
}
```

**Returned token.** A `CANCELLED` bet returns its token: a new `GRANTED` reward for
the same brand, user and profile, with a fresh ride seed, `replaces_reward_id` set
to the original reward and the original `valid_until` copied. The original reward
stays `USED`. If the original `valid_until` has already passed, no replacement is
issued: `replacement_reward_id` is `null` and `replacement_status` is
`NOT_ISSUED_EXPIRED`. `replacement_status` is `null` for every other result.

**Replays and conflicts.** Legs are compared after sorting by `selection_id`, so
the same results in another order are the same payload. Repeating a POST with an
identical payload returns the current revision (201). A different payload is 409
`BET_ALREADY_SETTLED` and nothing changes; correct a settlement with
`POST /api/settlement/resettle`. Concurrent settlements never return 500: two
identical requests create one row (the other is a replay), two different ones give
one 201 and one 409. The settlement revision, any replacement reward and the audit
rows are written in one transaction. A replay only matches the **current**
revision: after a resettlement, repeating the original `POST /api/settlement`
returns 409 `BET_ALREADY_SETTLED`.

```json
// Response (409 Conflict)
{
  "error": "Conflict",
  "code": "BET_ALREADY_SETTLED",
  "message": "Bet is already settled with a different result; use POST /api/settlement/resettle to correct it"
}

// Response (400 Bad Request) - legs do not match the stored ticket
{
  "error": "Bad Request",
  "code": "VALIDATION_ERROR",
  "message": "Settlement legs do not match the stored ticket",
  "details": [
    { "code": "DUPLICATE_LEG", "selection_id": "a", "message": "selection_id a is supplied more than once" },
    { "code": "UNKNOWN_SELECTION", "selection_id": "zzz", "message": "selection_id zzz is not on the stored ticket" },
    { "code": "MISSING_LEG", "selection_id": "b", "message": "Bet leg b has no result" }
  ]
}
```

### Resettle Bet

**POST** `/api/settlement/resettle`

Corrects a settled bet. The body is the settle body plus a required `reason`
(1-500 characters). The current revision `n` is kept and marked superseded, and
revision `n + 1` becomes current; the response adds `previous_bonus_minor` (the
bonus of revision `n`) and `bonus_delta_minor` (new bonus minus previous bonus,
negative when the bonus goes down); both are `null` when the response is revision 1.
A payload identical to the current revision
is a replay (201, nothing new is written; the `reason` text is not compared).
Resettling a bet that was never settled is 404 `SETTLEMENT_NOT_FOUND`.

Replacement tokens follow the `CANCELLED` transitions:
- to `CANCELLED` from any other result: a replacement is issued (same rules as above);
- from `CANCELLED` to any other result: the replacement is revoked if it is still
  `GRANTED` (it becomes `EXPIRED`, audit reason `REVOKED_BY_RESETTLEMENT`). If the
  player has already used it, the correction is 409 `REPLACEMENT_ALREADY_USED` and
  nothing changes;
- `CANCELLED` to `CANCELLED`: the existing replacement (or its absence) is kept.

Two concurrent corrections never return 500: one creates revision `n + 1`, the
other gets 409 `BET_ALREADY_SETTLED` (or a replay when its payload is identical).

```json
// Request - leg b is voided after the bet was settled as all WON (bonus 1995)
{
  "brand_id": "acme",
  "bet_id": "bet-789",
  "outcome": "SETTLED",
  "legs": [
    { "selection_id": "a", "result": "WON" },
    { "selection_id": "b", "result": "CANCELLED" },
    { "selection_id": "c", "result": "WON" }
  ],
  "reason": "Leg b voided by the feed"
}

// Response (201 Created)
{
  "settlement_id": "880e8400-e29b-41d4-a716-446655440006",
  "brand_id": "acme",
  "bet_id": "bet-789",
  "lock_id": "770e8400-e29b-41d4-a716-446655440002",
  "revision": 2,
  "outcome": "SETTLED",
  "bet_result": "WON",
  "legs": [
    { "selection_id": "a", "result": "WON" },
    { "selection_id": "b", "result": "CANCELLED" },
    { "selection_id": "c", "result": "WON" }
  ],
  "currency": "EUR",
  "stake_minor": 1000,
  "total_return_minor": "5250",
  "locked_boost_pct": 0.2,
  "bonus_minor": 1050,
  "bonus_cap_minor": 50000,
  "cap_applied": false,
  "minimums_met": true,
  "replacement_reward_id": null,
  "replacement_status": null,
  "reason": "Leg b voided by the feed",
  "previous_bonus_minor": 1995,
  "bonus_delta_minor": -945,
  "settled_at": "2024-01-16T09:30:00.000Z"
}

// Response (409 Conflict) - the cancelled bet's replacement was already used
{
  "error": "Conflict",
  "code": "REPLACEMENT_ALREADY_USED",
  "message": "The replacement reward issued for this cancelled bet has already been used; the settlement was not changed",
  "details": { "replacement_reward_id": "990e8400-e29b-41d4-a716-446655440005" }
}
```

### Get Settlement

**GET** `/api/settlement/:betId?brand_id=acme`

Returns the current revision in the same shape as above. `brand_id` is required
(400 `VALIDATION_ERROR` otherwise); a bet without a settlement in that brand
returns 404 `SETTLEMENT_NOT_FOUND`.

---

## Reward expiry (Admin)

### Expire Rewards

**POST** `/api/admin/rewards/expire`

Runs the expiry job once; admin key required. It is idempotent: every change is a
conditional status update with one audit row, so repeated or concurrent runs change
each reward once.
- `GRANTED` rewards past `valid_until` become `EXPIRED`.
- `ENTERED` rewards whose ride has been over without a lock (crash or end time
  passed) for at least `RIDE_EXPIRY_GRACE_SECONDS` (default 900) become `EXPIRED`.
  `USED` rewards and locks are never touched.

```json
// Response (200 OK)
{
  "granted_expired": 2,
  "entered_expired": 1,
  "total_expired": 3,
  "evaluated_at": "2024-01-15T12:00:00.000Z"
}
```

The same job runs in-process every `REWARD_EXPIRY_INTERVAL_SECONDS` seconds
(default 300; `0` disables it) while the server is running, and never in test.
Expiry never hides a ride outcome: quote and lock for an `EXPIRED` reward that
entered a ride for that bet still evaluate the ride and report `RIDE_CRASHED` /
`RIDE_ENDED` with the usual terminal details. `REWARD_EXPIRED` is reported for
rewards that never entered a ride (or for another bet), and such a reward can
never be locked.

---

## Simulation (Admin)

### Simulate Ride Curve

**POST** `/api/simulation`

Optional `profile_id` supplies eligibility, mode, and boost settings; explicit
`min_boost_pct`/`max_boost_pct` overrides take precedence. The resolved min must be
<= max, including when only one override is supplied. The endpoint always uses
V4 math (`math_snapshot_version: 4`). The `ride` block describes the whole
simulated ride (duration, outcome, crash time, bucket, phase, pace, peak count,
payout band, ride maximum and pre-crash maximum). `config` includes the
effective min/max and `ticket_strength`; an exploratory run (no ticket) uses
ticket strength 0.5. `combined_odds` is a number, or an exact decimal string
when the value is beyond the double range. These operator-only details are
not added to active player quotes.

Supplied tickets undergo the same exclusions, SGP handling, and eligibility gates
as live rides. An ineligible ticket still returns HTTP 200 with `eligible: false`,
a reason code, ticket analysis, and null `final_boost_pct` at every curve sample
(including terminal samples). A missing ticket is explicitly `EXPLORATORY`, with
null eligibility/reason and hypothetical values; it is not an eligible payout quote.

Reproducible eligible WAVES request using defaults except the stated boost range:

```json
{
  "seed": "audit-seed-42",
  "min_boost_pct": 0.05,
  "max_boost_pct": 1,
  "sample_points": 10,
  "ticket": {
    "selections": [
      { "id": "s1", "odds": 1.5 },
      { "id": "s2", "odds": 1.5 },
      { "id": "s3", "odds": 1.5 }
    ]
  }
}
```

Response excerpt (config, ride, curve detail omitted):

```json
{
  "seed": "audit-seed-42",
  "evaluation_mode": "TICKET",
  "eligible": true,
  "reason_code": "ELIGIBLE",
  "serialization_decimals": 4,
  "maximum_model": "PRE_CRASH_SUPREMUM_V4",
  "math_snapshot_version": 4,
  "ticket_analysis": {
    "qualifying_selections": 3,
    "combined_odds": 3.375,
    "ticket_strength": 0.042009
  }
}
```

The curve has `sample_points + 1` entries, including endpoints. Curve fields are
`time_pct`, `base_ride_value`, and `final_boost_pct`, serialized to four decimals.
Compare with live quote/lock values at the unrounded sampling fraction, particularly
near terminal boundaries. A non-hex `seed` string is hashed (SHA-256) into the key;
a 64-hex seed is used as is; omit it for a random one.

With only two qualifying selections, the response excerpt becomes:

```json
{
  "evaluation_mode": "TICKET",
  "eligible": false,
  "reason_code": "MIN_SELECTIONS_NOT_MET",
  "serialization_decimals": 4,
  "maximum_model": "PRE_CRASH_SUPREMUM_V4"
}
```

Every curve entry then has `final_boost_pct: null`. To explore without a ticket,
omit `ticket` entirely; `evaluation_mode` is `EXPLORATORY`, `eligible` and
`reason_code` are null, and `ticket_analysis` is omitted. Simulation exposes full
seed/ride/curve information for administrators; do not use it to populate an
active player chart.

---

## Error Responses

API error responses follow this format:

```json
{
  "error": "Unprocessable Entity",
  "code": "MIN_SELECTIONS_NOT_MET",
  "message": "Minimum 3 qualifying selections required, got 2"
}
```

`code` is always one of the reason codes below. Unexpected errors (including
database errors) return 500 `INTERNAL_ERROR` with the generic message
"An unexpected error occurred"; SQL and bound values are never returned.
Malformed JSON returns 400 and an oversized body 413, both with
`VALIDATION_ERROR`. Unknown `/api` routes return a JSON 404 `ROUTE_NOT_FOUND`.
(401/403 authentication responses are produced by the auth middleware.)

### Reason Codes

| Code | Description |
|------|-------------|
| `ELIGIBLE` | Ticket meets all eligibility criteria |
| `MIN_SELECTIONS_NOT_MET` | Not enough qualifying selections |
| `MIN_ODDS_NOT_MET` | Selection odds below threshold |
| `MIN_COMBINED_ODDS_NOT_MET` | Combined odds below threshold |
| `REWARD_NOT_FOUND` | Reward ID doesn't exist |
| `REWARD_EXPIRED` | Reward has expired |
| `REWARD_ALREADY_USED` | Reward has been locked to a bet |
| `NOT_OPTED_IN` | User hasn't opted into the reward |
| `ALREADY_OPTED_IN` | User already opted in |
| `BET_ALREADY_BOUND` | Bet ID is already attached to a different reward of the same brand (409) |
| `CURRENCY_NOT_SUPPORTED` | The opt-in currency is not a key of the profile's `max_bonus_minor` (422) |
| `RIDE_CRASHED` | Ride reached its pre-end crash boundary |
| `RIDE_ENDED` | Ride reached end time without an earlier crash event |
| `BET_ALREADY_LOCKED` | Bet ID is already locked for a different reward or user (409) |
| `LOCK_NOT_FOUND` | No lock exists for the bet in this brand (404); also returned when settling a bet that was never locked |
| `BET_ALREADY_SETTLED` | Bet already settled with a different payload, or corrected concurrently (409) |
| `SETTLEMENT_NOT_FOUND` | No settlement exists for the bet in this brand (404) |
| `REPLACEMENT_ALREADY_USED` | A resettlement would revoke a replacement reward the player already used; nothing changed (409) |
| `SETTLEMENT_UNAVAILABLE` | The locked reward has no stake/currency/cap or ticket snapshot (legacy data), or its stored data is rejected by the settlement calculator, so it cannot be settled (422) |
| `PROFILE_NOT_FOUND` | Profile ID doesn't exist |
| `PROFILE_INACTIVE` | Profile is not active |
| `INVALID_CONFIGURATION` | Reward profile configuration is invalid |
| `VALIDATION_ERROR` | Request validation failed (also malformed JSON 400, oversized body 413) |
| `ROUTE_NOT_FOUND` | Unknown API route (404) |
| `INTERNAL_ERROR` | Unexpected server error |
