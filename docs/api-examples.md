# Combo Boost Rollercoaster API - Example Payloads

This document provides example JSON payloads for every API endpoint.

## Authentication

All endpoints require authentication via one of:
- `X-API-Key` header with your API key
- `X-Signature` + `X-Timestamp` headers for HMAC authentication

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

Note: Ride behavior (checkpoint count, volatility, crash timing) is generated internally per reward.
Operators configure only eligibility and boost caps; the ride pattern remains unpredictable to bettors.
Ride duration is short by design (randomized between 2–15 seconds).
Reason: We keep ride timing internal to preserve unpredictability and avoid letting bettors time the optimal lock window.
Operators can optionally set the thresholds at which max boost becomes reachable:
`max_boost_min_selections` and `max_boost_min_combined_odds`. If omitted, max boost is always reachable (old behavior).

Optional risk controls:
- Set `max_boost_min_selections` and/or `max_boost_min_combined_odds` to make max boost reachable only for stronger tickets.
- Leave both unset to allow max boost at any eligible ticket strength.

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

### Grant Reward

**POST** `/api/rewards`

```json
// Request
{
  "user_id": "user-12345",
  "profile_version_id": "550e8400-e29b-41d4-a716-446655440000",
  "duration_seconds": 7200  // Optional; internal logic may override for short rides
}

// Response (201 Created)
{
  "id": "660e8400-e29b-41d4-a716-446655440001",
  "user_id": "user-12345",
  "profile_version_id": "550e8400-e29b-41d4-a716-446655440000",
  "status": "GRANTED",
  "start_time": "2024-01-15T12:00:00.000Z",
  "end_time": "2024-01-15T14:00:00.000Z",
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
      { "id": "sel-002", "odds": 2.10 },
      { "id": "sel-003", "odds": 1.65 }
    ]
  }
}

// Response (200 OK) - Eligible
{
  "eligible": true,
  "reason_code": "ELIGIBLE",
  "qualifying_selection_count": 3,
  "total_selection_count": 3,
  "combined_odds": 6.42,
  "ticket_strength": 0.42
}

// Response (200 OK) - Not Eligible
{
  "eligible": false,
  "reason_code": "MIN_SELECTIONS_NOT_MET",
  "qualifying_selection_count": 2,
  "total_selection_count": 3,
  "combined_odds": 3.88,
  "ticket_strength": null
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
  "start_time": "2024-01-15T12:00:00.000Z",
  "end_time": "2024-01-15T14:00:00.000Z",
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

Note: The bet is already placed. This call starts the ride for that bet.

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
  "end_time": "2024-01-15T14:00:00.000Z"
}
```

---

## Boost

Note: Ride volatility is derived from ticket strength (more selections/odds = bigger swings).
Crash timing is deterministic per reward but can occur before the end time.
Ride duration is randomized between 2–15 seconds; crash time is drawn from a scaled Beta distribution.
`theoretical_max_boost_pct` represents the peak boost the user could have locked if they stopped at the best moment on that ride.
When the ride is no longer active, the response distinguishes:
`RIDE_CRASHED` (crash happened) vs `RIDE_ENDED` (ride ended without a crash event).
Crash timing is clamped by a hard minimum (RIDE_MIN_CRASH_SECONDS) so crashes cannot occur too early.
`ride_path` values are the effective boost percentages (after ticket strength and caps), i.e. what the bettor would actually see.

### Get Quote

**POST** `/api/boost/quote`

```json
// Request
{
  "user_id": "user-12345",
  "reward_id": "660e8400-e29b-41d4-a716-446655440001",
  "bet_id": "bet-789"
}

// Response (200 OK) - Eligible
{
  "eligible": true,
  "reason_code": "ELIGIBLE",
  "qualifying_selection_count": 3,
  "total_selection_count": 3,
  "combined_odds": 6.42,
  "current_boost_pct": 0.35,
  "theoretical_max_boost_pct": 0.62,
  "ticket_strength": 0.42
}

// Response (200 OK) - Not Eligible
{
  "eligible": false,
  "reason_code": "MIN_SELECTIONS_NOT_MET",
  "qualifying_selection_count": 2,
  "total_selection_count": 3,
  "combined_odds": 3.88,
  "current_boost_pct": null,
  "theoretical_max_boost_pct": null,
  "ticket_strength": null,
  "ride_end_at_offset_seconds": null,
  "ride_crash_at_offset_seconds": null
}

// Response (200 OK) - Ride Crashed
{
  "eligible": false,
  "reason_code": "RIDE_CRASHED",
  "qualifying_selection_count": 3,
  "total_selection_count": 3,
  "combined_odds": 6.42,
  "current_boost_pct": 0,
  "theoretical_max_boost_pct": 0.62,
  "ticket_strength": 0.42,
  "ride_end_at_offset_seconds": 9.4,
  "ride_crash_at_offset_seconds": 5.8
}

// Response (200 OK) - Ride Ended (no crash)
{
  "eligible": false,
  "reason_code": "RIDE_ENDED",
  "qualifying_selection_count": 3,
  "total_selection_count": 3,
  "combined_odds": 6.42,
  "current_boost_pct": 0,
  "theoretical_max_boost_pct": 0.62,
  "ticket_strength": 0.42,
  "ride_end_at_offset_seconds": 9.4,
  "ride_crash_at_offset_seconds": 5.8
}
```

### Lock Boost

**POST** `/api/boost/lock`

Note: Locking consumes the reward (single-use). After a successful lock, the reward becomes `USED`.
Ride path is only returned after lock to avoid revealing the full ride in advance.

```json
// Request
{
  "user_id": "user-12345",
  "reward_id": "660e8400-e29b-41d4-a716-446655440001",
  "bet_id": "bet-789"
}

// Response (201 Created)
{
  "lock_id": "770e8400-e29b-41d4-a716-446655440002",
  "bet_id": "bet-789",
  "reward_id": "660e8400-e29b-41d4-a716-446655440001",
  "locked_boost_pct": 0.35,
  "qualifying_selections": 3,
  "qualifying_odds": 6.42,
  "ticket_strength": 0.42,
  "locked_at": "2024-01-15T12:30:00.000Z",
  "theoretical_max_boost_pct": 0.62,
  "ride_end_at_offset_seconds": 9.4,
  "ride_crash_at_offset_seconds": 5.8,
  "ride_path": [
    { "time_pct": 0, "base_boost_value": 0.45 },
    { "time_pct": 0.02, "base_boost_value": 0.47 },
    // ... 60 points total
    { "time_pct": 1, "base_boost_value": 0 }
  ]
}
```

### Get Lock

**GET** `/api/boost/lock/:betId`

```json
// Response (200 OK)
{
  "lock_id": "770e8400-e29b-41d4-a716-446655440002",
  "bet_id": "bet-789",
  "reward_id": "660e8400-e29b-41d4-a716-446655440001",
  "locked_boost_pct": 0.35,
  "qualifying_selections": 3,
  "qualifying_odds": 6.42,
  "ticket_strength": 0.42,
  "locked_at": "2024-01-15T12:30:00.000Z",
  "theoretical_max_boost_pct": 0.62,
  "ride_end_at_offset_seconds": 9.4,
  "ride_crash_at_offset_seconds": 5.8,
  "ride_path": [
    { "time_pct": 0, "base_boost_value": 0.45 },
    { "time_pct": 0.02, "base_boost_value": 0.47 },
    // ... 60 points total
    { "time_pct": 1, "base_boost_value": 0 }
  ]
}
```

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

```json
// Request - Using profile
{
  "profile_id": "550e8400-e29b-41d4-a716-446655440000",
  "sample_points": 50,
  "ticket": {
    "selections": [
      { "id": "s1", "odds": 1.8 },
      { "id": "s2", "odds": 2.0 },
      { "id": "s3", "odds": 1.5 }
    ]
  }
}

// Request - Custom parameters
{
  "seed": "custom-seed-123",
  "min_boost_pct": 0.1,
  "max_boost_pct": 0.8,
  "sample_points": 100
}

// Response (200 OK)
{
  "seed": "abc123...",
  "config": {
    "checkpoint_count": 12,
    "volatility": 0.55,
    "crash_pct": 0.37,
    "min_boost_pct": 0.1,
    "max_boost_pct": 0.8
  },
  "ticket_analysis": {
    "qualifying_selections": 3,
    "combined_odds": 5.4,
    "ticket_strength": 0.38
  },
  "checkpoints": [
    { "index": 0, "time_offset_pct": 0, "base_boost_value": 0.45 },
    { "index": 1, "time_offset_pct": 0.0714, "base_boost_value": 0.52 },
    // ... more checkpoints
    { "index": 14, "time_offset_pct": 1, "base_boost_value": 0 }
  ],
  "curve": [
    { "time_pct": 0, "base_ride_value": 0.45, "final_boost_pct": 0.31 },
    { "time_pct": 0.01, "base_ride_value": 0.46, "final_boost_pct": 0.32 },
    // ... 100 sample points
    { "time_pct": 1, "base_ride_value": 0, "final_boost_pct": 0 }
  ]
}
```

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
| `RIDE_ENDED` | Ride has ended or crashed early |
| `BET_ALREADY_LOCKED` | Bet ID already has a lock |
| `LOCK_NOT_FOUND` | No lock exists for bet |
| `BET_ALREADY_SETTLED` | Bet already settled |
| `INVALID_OUTCOME` | Settlement outcome is invalid |
| `PROFILE_NOT_FOUND` | Profile ID doesn't exist |
| `PROFILE_INACTIVE` | Profile is not active |
| `INVALID_CONFIGURATION` | Reward profile configuration is invalid |
| `VALIDATION_ERROR` | Request validation failed |
| `INTERNAL_ERROR` | Unexpected server error |
