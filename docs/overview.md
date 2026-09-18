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
7) On loss: bonus payout = 0. A crash or ride end before a successful lock also leaves no bonus; later ride movement cannot change an existing lock.

## Latest functionality in this version
- Precheck eligibility endpoint lets operators validate the ticket before ride start to avoid bad UX.
- Selection-level exclusion is supported (`eligible=false`, optional `ineligible_reason`) for cases like boosted odds or zero-margin markets.
- Same Game Parlay (SGP) support is explicit and safe:
  - send one priced `SGP_COMPOSITE` selection
  - optional `SGP_LEG` entries are accepted but never counted
  - all SGP entries must include `sgp_group_id`
- Two ride modes are available per profile:
  - `WAVES`: multi-peak dynamic ride.
  - `LINEAR`: straight climb from the effective minimum toward the same-seed WAVES ride maximum. It drops to zero at crash/end; the endpoint is a limit, not a guaranteed lockable boost.
- Max boost accessibility is tunable with optional thresholds:
  - `max_boost_min_selections`
  - `max_boost_min_combined_odds`
- Boost model tuning is profile-configurable:
  - `max_eligibility_selection_weight` (default 0.75)
  - `max_eligibility_odds_weight` (default 0.25)
  - `effective_min_floor_rate` (default 0.35)
- Profile maximum, ticket-adjusted cap, per-ride maximum, observed sample peak, and locked boost are distinct. Meeting max-boost thresholds opens cap access; it does not guarantee that a ride reaches the cap.
- New rides freeze their profile, mode, and timing settings at opt-in. Later profile edits do not change an already-started new ride or a locked payout.
- The maximum model keeps the true pre-crash WAVES maximum introduced in v2; LINEAR uses that same maximum. Unversioned/v1 rides retain their older checkpoint reference, which can understate values between checkpoints. Saved v2 rides, existing locks, and settlements also retain their original behavior.
- Active quotes provide current boost and authoritative elapsed sample time, without a future path or crash/end schedule. Completed/locked responses also provide sampled paths and timing offsets.
- The local demo progressively draws received authoritative boost samples while the ride runs, then freezes the exact stop/terminal result. It retains raw JSON and final outcomes; its chart does not forecast the unobserved path.

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

The current local implementation uses a v3 phase correction for feasible new WAVES
rides. It targets UP/PEAK/DOWN at 50/20/30 only when enough time and effective boost
range remain. The last part of the ride then rises, stays near its top, or falls in
the actual payable boost. Very early, flat/rounding-degenerate, and no-crash rides
remain unchanged and are classified separately. These targets are not a guarantee
of exact percentages in every finite sample or of what every client will observe.

The correction preserves each baseline ride's true maximum, floor/cap, duration,
and crash/no-crash choice, but changes when boosts are available in the final
bounded suffix. That changes WAVES stopping opportunities and potential payouts;
maximum preservation does not imply payout neutrality. LINEAR is unchanged from
its v2 behavior. Historical rides keep their saved model; historical phase labels
still describe checkpoint shaping rather than guaranteed effective crash direction.
This describes local code, not a production release or an RTP/payout guarantee.
Curve aesthetics and final acceptance remain separate review items.

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
