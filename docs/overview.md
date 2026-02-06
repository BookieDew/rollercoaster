# Combo Boost Rollercoaster - Business Overview

## What it is
Combo Boost Rollercoaster is a short-form loyalty mechanic for sportsbook combo/parlay bettors.
Eligible users receive a reward token, place a qualifying bet, and then start a short "rollercoaster"
ride that can crash at any moment. If they stop the ride in time, a dynamic boost is locked and paid
on winning tickets only. Stake and odds are never modified.

## Why it works
- Creates urgency: the boost changes in real time and can crash without warning.
- Rewards strong tickets: more qualifying selections and higher combined odds yield better boosts.
- Ticket strength prioritizes margin multiplication: 75% weight on selection count, 25% on combined odds.
- Stronger tickets are more likely to open on an upswing.
- Ride generation avoids instant "best-at-start" outcomes by keeping the first theoretical peak at least 2 seconds in.
- Low operational risk: boosts are capped and apply only to winnings.

## Business value
- Increases parlay adoption by making the combo bet more exciting and rewarding.
- Drives higher stake and higher odds combos without changing base odds.
- Creates a repeatable daily/weekly engagement moment without long promo cycles.
- Adds a "post-bet moment" that keeps users engaged after bet placement.
- Generates shareable moments (ride path can be used in UI animation and social).

## Who it is for
- Operators who want a simple loyalty mechanic that does not touch sportsbook pricing.
- Bettors who like quick, high-tension moments and optional upside on winnings.

## How money is made
- More and better combo bets (higher odds, more legs) can increase handle.
- The boost is paid only on wins, so payouts are bounded and predictable.
- Caps and eligibility rules keep the offer profitable and controllable.

## Core customer experience
1) User receives a reward token
2) User places a qualifying combo bet
3) User opts in to start the ride
4) Boost changes in real time (no countdown shown)
5) User locks the boost by stopping the ride
6) Bonus payout = winnings × locked boost
7) If the ride crashes or ends, no bonus is paid

## Operator controls
Operators configure:
- Minimum selections
- Minimum combined odds
- Minimum odds per selection
- Min/max boost limits
- Optional thresholds for when max boost becomes reachable (by selections and combined odds)
- Eligibility and access rules

Ride timing, volatility, and crash behavior are internal to preserve unpredictability.

## Key safeguards
- Boost only applies to winnings (no downside risk for bettors).
- Strict min/max caps enforce budget control.
- Optional max-boost thresholds let operators decide how hard it is to reach the top boost.
- Deterministic ride logic supports audits and dispute resolution.
- Single-use token behavior prevents repeat claims on the same reward.

## Suggested KPIs
- Opt-in rate (token -> ride start)
- Lock rate (ride start -> lock)
- Average locked boost by segment
- Incremental combo handle vs control group
- Payout rate (bonus paid / bonus locked)

## Trust and auditability
Every boost decision is deterministic and auditable. The system stores:
- Qualifying selections and odds
- Ticket strength
- Ride curve checkpoints and crash point
- Locked boost value and timestamp
- Full decision snapshot for audits and support

## Example outcome
Stake $20 at 5.00 odds = $100 winnings  
Locked boost 17.5% → payout becomes $117.50  
If the bet loses → bonus is $0
