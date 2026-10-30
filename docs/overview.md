# Combo Boost Rollercoaster - Business Overview

## What this product does
Combo Boost Rollercoaster is a short, post-bet loyalty experience for combo/parlay bettors.
The bettor places a qualifying combo first, then starts a live boost ride. The boost moves in
real time and can crash at any moment. If the bettor stops in time, the boost is locked.

Important: stake and sportsbook odds never change. The reward only adds bonus payout on wins.

One shared back end serves several brands (B2C operators). Profiles, rewards, bets and
players are all scoped to a brand, so two brands never see or affect each other's data.

## Core customer flow
1) User receives a reward token.
2) User places a qualifying combo bet.
3) User starts the ride (opt-in).
4) Boost moves live with no countdown/ETA shown.
5) User chooses when to stop and lock the current boost.
6) On win: bonus payout = total return x locked boost, never more than the profile's bonus cap for the bet's currency. Total return is stake x the product of the leg odds (the stake is included).
   Example: 10.00 EUR at 5.40 odds returns 54.00 EUR; at a locked 25% boost the bonus is 13.50 EUR.
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
- The ride maximum is the exact highest value the ride reaches before it crashes or ends; LINEAR climbs toward that same maximum. Existing locks and settlements keep their stored values.
- Active quotes provide current boost and authoritative elapsed sample time, without a future path or crash/end schedule. Completed/locked responses also provide sampled paths and timing offsets.
- The local demo progressively draws received authoritative boost samples while the ride runs, then freezes the exact stop/terminal result. It retains raw JSON and final outcomes; its chart does not forecast the unobserved path.

## Brands, money, bonus caps and token validity
- Every profile belongs to one brand and never moves to another. A reward belongs to the brand of the profile it was granted from.
- Money is whole minor units (cents) plus a currency, for example 10.00 EUR is 1000 EUR-cents. Amounts that need rounding round half up to the nearest cent.
- The bettor's stake and currency are recorded when the ride starts. The operator sets a **maximum bonus per currency** on the profile; the cap that applies to a bet is copied when its ride starts, so later changes to the profile never alter a bet already in play. A currency the profile has no cap for cannot start a ride.
- Each profile sets how long a granted token stays usable (**validity**, from 1 minute to 365 days). A token that is not started in time expires; a ride that crashed or ended without a lock also expires, after a grace period (15 minutes by default) during which the player still sees the ride's own crash or end result. A scheduled job (every 5 minutes by default, plus an admin button/endpoint) keeps statuses current, and every change is audited.

## Settlement
- Only bets whose boost was locked are settled. The sportsbook reports the bet's result (each leg won, lost, pushed or cancelled; or a cash-out; or a cancelled bet). The service works out the payout itself from what was recorded earlier: the stake, the leg odds, the locked boost and the cap. The sportsbook never sends an amount.
- **Bonus = locked boost x total return**, rounded half up to the cent and limited by the cap. Example: 10.00 EUR on 2.10 x 1.90 x 2.50 returns 99.75 EUR; a 20% locked boost pays a 19.95 EUR bonus.
- Any lost leg, a cash-out, or all legs pushed: no bonus, the token is used.
- A **pushed** leg (stake returned on that leg) counts as 1.00 in the return. A push is a normal result, so it never re-opens the eligibility question: the leg keeps its original odds for the minimums. Example: pushing the 1.90 leg returns 52.50 EUR and pays 10.50 EUR.
- A **cancelled** leg also counts as 1.00, but it is removed, so the profile minimums are checked again on the remaining legs. If they still pass, the bonus is paid on the smaller return; if not, the bet wins **without a bonus** and the token is used. Example (minimum combined odds 5.0): cancelling the 1.90 leg leaves 2.10 x 2.50 = 5.25, so 52.50 EUR returns with a 10.50 EUR bonus; cancelling the 2.50 leg leaves 3.99, so the bet pays 39.90 EUR and no bonus.
- A fully **cancelled** bet pays no bonus and **returns the token** as a new one with the same expiry date. If that date has already passed, no new token is issued.
- **Corrections**: the sportsbook can resettle a bet with a reason. Every version is kept, the newest one counts, and the answer says how much the bonus changed (for example -9.45 EUR). If a correction un-cancels a bet, the returned token is withdrawn; if the player has already used it, the correction is refused so nothing is double-paid.

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
- Money and lifetime:
  - brand
  - maximum bonus per currency
  - token validity

The ride math is V4 only. Each ride is built from a secret seed through keyed
random streams, so it is reproducible for dispute handling but unpredictable to
players. A ride ends without crashing 8% of the time; otherwise it crashes in a
window after the minimum crash time (weighted early/mid/late). WAVES is a
multi-peak ride. LINEAR climbs at a MEDIUM pace (9 seconds to the top of the
band) toward this ride's maximum. These are random draws per ride, not guaranteed
proportions in every finite sample. Rides that were in flight under older math
were closed at the V4 upgrade. This describes local code, not a production
release or an RTP/payout guarantee.

## Risk controls and safeguards
- Bonus applies only to winning bets; bettors never lose extra stake through this feature.
- Single-use token behavior prevents repeat claiming of the same reward.
- Lock and settlement are idempotent for safe sportsbook integration: an identical retry returns the original result, while a conflicting one (another reward or user for the same bet, or a different settlement result) is rejected rather than silently accepted; real corrections go through an explicit, audited resettlement. One bet can start only one ride.
- While a ride is live, players see no countdown, ride length or ride maximum; those are revealed only after the ride ends or the boost is locked. Ride seeds are random and never exposed; audit records hold only a commitment (hash) of the seed.
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
Stake 20.00 EUR at 5.00 odds = 100.00 EUR total return
Locked boost 17.5% -> bonus = 17.50 EUR (total payout 117.50 EUR), provided it does not exceed the profile's cap for EUR
If the cap is 15.00 EUR -> bonus = 15.00 EUR
If the bet loses -> bonus payout = 0

Push versus cancel: with three legs at 2.00, 1.50 and 1.80 and a 10.00 EUR stake, a pushed third leg counts as 1.00 and the bet still earns a bonus on its 30.00 EUR return; a cancelled third leg is removed and, if only two legs remain below a profile minimum of three, the bet wins with no bonus.
