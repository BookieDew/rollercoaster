# Combo Boost Rollercoaster API - Example Payloads

This document provides example JSON payloads for every API endpoint.

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
- Requests outside the allowed time window (default: ±5 minutes) are rejected.
- Replays of the exact same signed request within the window are rejected.

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
  "ride_duration_seconds": 3600
}

// Response (201 Created)
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
  "user_id": "user-12345",
  "profile_version_id": "550e8400-e29b-41d4-a716-446655440000",
  "status": "GRANTED",
  "start_time": "2024-01-15T12:00:00.000Z",
  "end_time": "2024-01-15T12:00:09.563Z",
  "opted_in_at": null,
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
  "user_id": "user-12345",
  "profile_version_id": "550e8400-e29b-41d4-a716-446655440000",
  "status": "ENTERED",
  "start_time": "2024-01-15T12:05:00.000Z",
  "end_time": "2024-01-15T12:05:09.563Z",
  "opted_in_at": "2024-01-15T12:05:00.000Z",
  "created_at": "2024-01-15T12:00:00.000Z",
  "updated_at": "2024-01-15T12:05:00.000Z"
}
```

### Get User Rewards

**GET** `/api/rewards/user/:userId`

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

**GET** `/api/rewards/user/:userId/active`

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
resolved profile/mode, derived ride timing/math, phase model/diagnostics, and
exact checkpoints in `ticketSnapshot.rideMath` (version 3). V3 checkpoint JSON and
its interpolation metadata are authoritative. Version 1/2 snapshots preserve their
original models; pre-snapshot rides retain their explicit legacy fallback. The
snapshot is internal, not a new opt-in response field. Existing `end_time` is retained for compatibility; the demo
does not use it to show a countdown or future curve.

```json
// Request
{
  "user_id": "user-12345",
  "bet_id": "bet-789",
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
  "status": "ENTERED",
  "ride_started": true,
  "end_time": "2024-01-15T12:05:09.563Z"
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
| `theoretical_max_boost_pct` | Model-dependent ride maximum/reference, not a guaranteed lockable payout |
| `maximum_model` | `WAVES_PRE_CRASH_SUPREMUM_V2` for new rides; `LEGACY_CHECKPOINT_MAX_V1` for legacy rides |
| `ride_elapsed_seconds` | Authoritative sampled offset from start, with millisecond precision; eligible/terminal quotes and terminal lock error details |
| `ride_stop_at_offset_seconds` | Successful lock's exact evaluation offset; pair it with `locked_boost_pct`, not interpolation of the sampled path |
| `ride_end_at_offset_seconds` / `ride_crash_at_offset_seconds` | Completed/locked schedule offsets; active quotes return null |
| `ride_path` | 60 full-ride samples, returned only after lock or terminal quote/lock error; never present in active quotes |

The v2 maximum model includes the baseline WAVES curve's left-hand limit at crash,
then applies the final payout transform. V3 preserves that maximum and keeps
LINEAR's v2 behavior. Eligible new WAVES suffixes change their stopping opportunities,
while old versions and locks retain their saved behavior. The
exact crash/end is zero, and finite server sampling may never attain the limit.
The legacy checkpoint-only reference can be lower than a live WAVES value between
checkpoints. Old locks without saved model metadata omit `maximum_model`.

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

Crash timing still uses the existing weighted buckets and rounded minimum-time
logic (including the known exact-minimum precision edge). The local v3 WAVES phase
model targets UP/PEAK/DOWN at 50/20/30 only on feasible rides: a bounded suffix of
at most 800ms starts no earlier than two seconds and needs at least 600ms of room.
Its last 400ms shapes actual effective boost direction/near-top position. Timing-
constrained, flat/rounding-degenerate, and no-crash rides stay unchanged with explicit
exception status. Legacy labels still describe checkpoint shaping. These are
conditional targets, not exact finite-sample proportions or a guarantee of client
observations through network gaps. This is local implementation behavior, not
release approval, an RTP promise, or a claim of unchanged WAVES payouts.

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
seeds are assigned by the server. At 1.390 seconds, the response is:

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
  "theoretical_max_boost_pct": 0.290494,
  "maximum_model": "WAVES_PRE_CRASH_SUPREMUM_V2",
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
the same floor, cap, strength, and maximum. This shape difference is intentional.

Terminal response excerpts below omit ticket/model details and the full
`ride_path` array. No-crash end for the fixture above, sampled at 2.781 seconds:

```json
{
  "eligible": false,
  "reason_code": "RIDE_ENDED",
  "current_boost_pct": 0,
  "theoretical_max_boost_pct": 0.290494,
  "maximum_model": "WAVES_PRE_CRASH_SUPREMUM_V2",
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
  "maximum_model": "WAVES_PRE_CRASH_SUPREMUM_V2",
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
  "maximum_model": "WAVES_PRE_CRASH_SUPREMUM_V2",
  "ride_stop_at_offset_seconds": 1.39,
  "ride_end_at_offset_seconds": 2.78,
  "ride_crash_at_offset_seconds": 2.78
}
```

Repeat lock returns the saved result. A lock attempted at/after crash or end fails
with `RIDE_CRASHED` or `RIDE_ENDED`; its error `details` include zero current boost,
`ride_elapsed_seconds`, schedule offsets, model metadata, and the full sampled path.

### Get Lock

**GET** `/api/boost/lock/:betId`

HTTP 200 returns the saved lock fields shown above, including the stored
`maximum_model` when available, `boost_model`, exact stop offset, and `ride_path`.
It does not recalculate against the current profile. Historical locks without model
metadata omit `maximum_model` on both read and repeated lock responses.

---

## Settlement

### Settle Bet

**POST** `/api/settlement`

```json
// Request - Win
{
  "bet_id": "bet-789",
  "outcome": "WIN",
  "winnings": 642.00
}

// Response (201 Created)
{
  "settlement_id": "880e8400-e29b-41d4-a716-446655440003",
  "bet_id": "bet-789",
  "outcome": "WIN",
  "winnings": 642.00,
  "bonus_amount": 224.70,
  "locked_boost_pct": 0.35,
  "settled_at": "2024-01-15T15:00:00.000Z"
}

// Request - Loss
{
  "bet_id": "bet-789",
  "outcome": "LOSS",
  "winnings": 0
}

// Response (201 Created)
{
  "settlement_id": "880e8400-e29b-41d4-a716-446655440003",
  "bet_id": "bet-789",
  "outcome": "LOSS",
  "winnings": 0,
  "bonus_amount": 0,
  "locked_boost_pct": 0.35,
  "settled_at": "2024-01-15T15:00:00.000Z"
}
```

### Get Settlement

**GET** `/api/settlement/:betId`

```json
// Response (200 OK)
{
  "settlement_id": "880e8400-e29b-41d4-a716-446655440003",
  "bet_id": "bet-789",
  "outcome": "WIN",
  "winnings": 642.00,
  "bonus_amount": 224.70,
  "locked_boost_pct": 0.35,
  "settled_at": "2024-01-15T15:00:00.000Z"
}
```

---

## Simulation (Admin)

### Simulate Ride Curve

**POST** `/api/simulation`

Optional `profile_id` supplies eligibility, mode, and boost settings; explicit
`min_boost_pct`/`max_boost_pct` overrides take precedence. The resolved min must be
<= max, including when only one override is supplied. The endpoint uses the current
v3 phase model and v2 maximum model, not the model of any historical reward/lock.
It adds `math_snapshot_version: 3` and `phase_diagnostics`; the latter uses model
`FEASIBLE_WAVES_PHASE_V3` and one of `REPAIRED`, `TIMING_CONSTRAINED`,
`FLAT_OR_ROUNDING_DEGENERATE`, `NO_CRASH_UNCHANGED`, or `NOT_APPLICABLE_LINEAR`.
A repaired diagnostic includes phase and suffix/window timing; exception cases
must not be counted as successful phase repairs. These operator-only details are
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

Response excerpt (config, checkpoints, curve, and phase diagnostic detail omitted):

```json
{
  "seed": "audit-seed-42",
  "evaluation_mode": "TICKET",
  "eligible": true,
  "reason_code": "ELIGIBLE",
  "serialization_decimals": 4,
  "maximum_model": "WAVES_PRE_CRASH_SUPREMUM_V2",
  "math_snapshot_version": 3,
  "ticket_analysis": {
    "qualifying_selections": 3,
    "combined_odds": 3.375,
    "ticket_strength": 0.042009
  }
}
```

The curve has `sample_points + 1` entries, including endpoints. Curve fields are
`time_pct`, `base_ride_value`, and `final_boost_pct`, serialized to four decimals.
In the controlled default-duration fixture above, the midpoint (`time_pct: 0.5`)
has `final_boost_pct: 0.2511`; the equivalent LINEAR profile gives `0.1702`.
Live quote/lock values are respectively `0.251138` and `0.170247`. Compare at the
unrounded sampling fraction before accounting for serialization, particularly near
terminal boundaries. Raw checkpoints are not guaranteed effective payouts.
`config.checkpoint_count` is the original generation parameter; v3 insertion/removal
can change the returned array length. Preserve checkpoint ordering, duplicate
boundary timestamps, full numeric precision, and optional `incoming_segment_end`
(`time_offset_pct`, `base_boost_value`) when replaying the curve. That metadata
retains the original incoming interpolation at inserted boundaries, including
rounding; discarding or deduplicating it can alter values. Prefer the supplied
`curve` for operator visualization and the shared server evaluator for exact replay.

With only two qualifying selections, the response excerpt becomes:

```json
{
  "evaluation_mode": "TICKET",
  "eligible": false,
  "reason_code": "MIN_SELECTIONS_NOT_MET",
  "serialization_decimals": 4,
  "maximum_model": "WAVES_PRE_CRASH_SUPREMUM_V2"
}
```

Every curve entry then has `final_boost_pct: null`. To explore without a ticket,
omit `ticket` entirely; `evaluation_mode` is `EXPLORATORY`, `eligible` and
`reason_code` are null, and `ticket_analysis` is omitted. Simulation exposes full
seed/checkpoint/curve information for administrators; do not use it to populate an
active player chart.

---

## Error Responses

All error responses follow this format:

```json
{
  "error": "Unprocessable Entity",
  "code": "MIN_SELECTIONS_NOT_MET",
  "message": "Minimum 3 qualifying selections required, got 2"
}
```

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
| `RIDE_CRASHED` | Ride reached its pre-end crash boundary |
| `RIDE_ENDED` | Ride reached end time without an earlier crash event |
| `BET_ALREADY_LOCKED` | Bet ID already has a lock |
| `LOCK_NOT_FOUND` | No lock exists for bet |
| `BET_ALREADY_SETTLED` | Bet already settled |
| `INVALID_OUTCOME` | Settlement outcome is invalid |
| `PROFILE_NOT_FOUND` | Profile ID doesn't exist |
| `PROFILE_INACTIVE` | Profile is not active |
| `INVALID_CONFIGURATION` | Reward profile configuration is invalid |
| `VALIDATION_ERROR` | Request validation failed |
| `INTERNAL_ERROR` | Unexpected server error |
