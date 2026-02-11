# Combo Boost Rollercoaster - Business Overview

## What this product does
Combo Boost Rollercoaster is a short, post-bet loyalty experience for combo/parlay bettors.
The bettor places a qualifying combo first, then starts a live boost ride. The boost moves in
real time and can crash at any moment. If the bettor stops in time, the boost is locked.

Important: stake and sportsbook odds never change. The reward only adds bonus payout on wins.

## Core customer flow
1) User receives a reward token.
2) User places a qualifying combo bet.
3) User starts the ride (opt-in).
4) Boost moves live with no countdown/ETA shown.
5) User chooses when to stop and lock the current boost.
6) On win: bonus payout = winnings x locked boost.
7) On loss, crash, or ride end: bonus payout = 0.

## Latest functionality in this version
- Precheck eligibility endpoint lets operators validate the ticket before ride start to avoid bad UX.
- Selection-level exclusion is supported (`eligible=false`, optional `ineligible_reason`) for cases like boosted odds or zero-margin markets.
- Two ride modes are available per profile:
  - `WAVES`: multi-peak dynamic ride.
  - `LINEAR`: straight climb from effective min boost to effective max boost.
- Max boost accessibility is tunable with optional thresholds:
  - `max_boost_min_selections`
  - `max_boost_min_combined_odds`
- Boost model tuning is profile-configurable:
  - `max_eligibility_selection_weight` (default 0.75)
  - `max_eligibility_odds_weight` (default 0.25)
  - `effective_min_floor_rate` (default 0.35)
- Ride outputs include data for UI and analytics:
  - current boost
  - theoretical max boost
  - ride crash/end offsets
  - effective ride path (for visual animation and post-bet storytelling)

## Why operators use it
- Adds a high-intensity moment after bet placement without changing core sportsbook pricing.
- Encourages stronger combos (more qualifying legs and higher qualifying odds).
- Keeps payout risk controllable through min/max boost caps and max-eligibility thresholds.
- Supports CRM-style token campaigns (daily/weekly) with clear single-use behavior.

## Why bettors engage
- Live movement creates urgency and FOMO.
- Outcome feels interactive (user chooses when to stop).
- No downside to stake or odds, only upside on a winning ticket.
- Ride path can be visualized in client UI for stronger game feel.

## Operator controls (business levers)
Operators can configure:
- Eligibility thresholds:
  - minimum qualifying selections
  - minimum qualifying combined odds
  - minimum odds per selection
- Boost economics:
  - min boost
  - max boost
  - optional max-boost thresholds by selections and odds
- Boost model behavior:
  - selection/odds weighting
  - effective minimum floor rate
- Ride mode:
  - WAVES or LINEAR

Internal ride generation remains deterministic and auditable, but not predictable to bettors.

## Risk controls and safeguards
- Bonus applies only to winnings; bettors never lose extra stake through this feature.
- Single-use token behavior prevents repeat claiming of the same reward.
- Lock and settlement are idempotent for safe sportsbook integration.
- Deterministic seeded ride generation supports full replay and dispute handling.
- HMAC authentication is supported for monetary endpoints.

## Measurement framework (recommended KPIs)
- Token -> precheck pass rate
- Token -> ride start rate (opt-in)
- Ride start -> lock rate
- Average locked boost by segment/profile
- Crash vs lock distribution
- Incremental combo handle vs control
- Bonus payout rate (bonus paid / bonus locked)

## Example payout
Stake $20 at 5.00 odds = $100 winnings
Locked boost 17.5% -> total payout on win = $117.50
If the bet loses -> bonus payout = $0
