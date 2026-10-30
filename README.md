# Combo Boost Rollercoaster API

A REST service for a post-bet loyalty reward. After placing a qualifying combo
(parlay) bet, a bettor starts a short "ride" where a bonus boost moves in real
time and can crash at any moment. Stopping in time locks the current boost; on a
winning bet the bonus is `total return × locked boost`, capped. Stake and sportsbook odds
never change. The service decides eligibility, runs the ride, quotes and locks
boosts, and settles the bonus. A local demo UI is included for exploration.

## Brands, money and validity

One back end serves several brands. A profile belongs to one brand (`brand_id`,
immutable), rewards inherit it, a player is `(brand_id, user_id)` and a bet is
`(brand_id, bet_id)`. The player, lock and settlement reads
(`GET /api/rewards/user/:userId[/active]`, `GET /api/boost/lock/:betId`,
`GET /api/settlement/:betId`) require `?brand_id=`. Money is an integer number of minor units plus a currency code
(`stake_minor` 1000 + `EUR` = 10.00 EUR); no floats, and rounding is half-up.
Opt-in takes `stake_minor` and `currency` (the decimal `ticket.stake` is
deprecated and ignored). A profile carries a per-currency bonus cap
(`max_bonus_minor`) and a token validity (`reward_validity_seconds`, 60 to
31,536,000); both are frozen onto a reward when it is granted or opted in, so
profile edits only affect future ones. The intended bonus is
`total return x locked boost`, capped; for example 10.00 EUR at 5.40 odds returns
54.00 EUR, and a 25% locked boost pays 13.50 EUR. A pushed leg keeps its original
odds for the minimums, while a cancelled leg is removed and the minimums are
re-checked. See [docs/api-examples.md](docs/api-examples.md).

An existing database upgrades in place with `npm run migrate`: legacy rows become
brand `default`, and historical duplicate bet bindings are renamed
(`<bet_id>~legacy-<id prefix>`) with one audit row each; nothing is deleted.
Migration 015 replaces the legacy `settlement_records` table with
`bet_settlements` and refuses to run (changing nothing) while the legacy table
still has rows; archive and delete them first.

## Settlement

Only locked bets are settled. `POST /api/settlement` takes `brand_id`, `bet_id`,
an `outcome` (`SETTLED`, `CASHOUT` or `CANCELLED`) and, for `SETTLED`, one result
per ticket leg (`WON`, `LOST`, `PUSH`, `CANCELLED`). The server computes the total
return and bonus from the stake, odds, locked boost and cap frozen earlier, in
exact integer arithmetic: 10.00 EUR at 2.10 x 1.90 x 2.50 returns
`total_return_minor` `"9975"` and, at a 20% locked boost, `bonus_minor` 1995.
`total_return_minor` is an exact decimal string because sportsbook returns can
exceed 2^53; any accepted ticket settles, and max payout is the sportsbook's
responsibility (the bonus never exceeds the brand's cap). A lost
leg, a cash-out or an all-push bet pays no bonus; a cancelled bet returns the
token as a new reward. Identical retries replay; different payloads are 409.
Corrections go through `POST /api/settlement/resettle` with a `reason`, which
keeps every revision and returns the bonus delta. `GET /api/settlement/:betId`
requires `?brand_id=`.

## Status

**Pre-production.** Not yet for real-money use. Ride math is V4 only; rides
started under older math were closed by migration 016. See [Known limitations](#known-limitations).

## Requirements

- Node.js 24.13 with its bundled npm (see `.nvmrc`; `engines` allows `>=24.13.0 <25`)
- SQLite (bundled through the `sqlite3` package; no separate install)

## Local setup

```sh
npm ci
cp .env.example .env     # development defaults work as-is
npm run migrate          # applies migrations/*.ts to DATABASE_URL (default ./dev.db)
npm run dev              # http://localhost:3000, restarts on change
```

- Health check: `GET http://localhost:3000/health`
- Demo UI: <http://localhost:3000/demo/> (enabled by default in development; the
  development API key `dev-secret-key` is pre-filled)
- Optional sample profiles: `npm run seed`. The seed **deletes existing data** and
  refuses to run with `NODE_ENV=production`.

## Tests

```sh
npm run test:coverage                      # unit + integration, 80% global coverage gate
npm test                                   # unit tests only (no coverage gate)
npm run typecheck                          # type-check src, tests, migrations, seeds
node --test tests/ui/ride-observer.test.cjs  # demo chart observer module
```

Tests use an in-memory SQLite database and never read `.env`. Browser workflow
checks for the demo UI are described in [tests/ui/README.md](tests/ui/README.md).

## Production build, migrate and start

```sh
npm ci
npm run build            # dist/ (server) and dist/migrations/*.js
npm prune --omit=dev     # optional: keep production dependencies only

export NODE_ENV=production
export DATABASE_URL=sqlite:///var/lib/rollercoaster/app.db
export API_KEY_SECRET=...  ADMIN_API_KEY_SECRET=...  HMAC_SECRET=...

npm run migrate:prod     # applies compiled migrations; no ts-node needed
npm start                # node dist/index.js
```

- The server validates its configuration at startup and exits with a list of
  every problem (secret values are never printed).
- In production the three secrets are required, at least 32 characters each, all
  different, and never the development key or an `.env.example` placeholder.
  Generate each one separately, e.g. `openssl rand -hex 32`.
- `/demo` is off in production unless `DEMO_UI_ENABLED=true`.
- `migrate:prod` uses the same configuration as the server, so set the same
  environment for both.
- For a clean artifact, run `npm run clean` before `npm run build`.

## Configuration

All settings are environment variables (a `.env` file is read outside tests).
`.env.example` documents each one.

| Variable | Default | Notes |
|---|---|---|
| `NODE_ENV` | `development` | `development`, `production` or `test` |
| `PORT` | `3000` | Integer 1–65535 |
| `DATABASE_URL` | `sqlite://./dev.db` | `sqlite://<path>` or `postgres(ql)://…` (PostgreSQL not yet verified). Required in production. Tests always use in-memory SQLite |
| `DATABASE_POOL_MIN` / `DATABASE_POOL_MAX` | `2` / `10` | PostgreSQL only |
| `DATABASE_SSL` | `false` | PostgreSQL only |
| `DATABASE_SSL_REJECT_UNAUTHORIZED` | `true` | PostgreSQL only |
| `API_KEY_SECRET` | `dev-secret-key` (dev/test only) | Service key sent as `X-API-Key` |
| `ADMIN_API_KEY_SECRET` | `API_KEY_SECRET` (dev/test only) | Admin key for `/api/profiles`, `/api/simulation` and `/api/admin` |
| `HMAC_SECRET` | `API_KEY_SECRET` (dev/test only) | Key for `X-Signature` request signing |
| `HMAC_MAX_SKEW_MS` | `300000` | Positive integer; allowed signature timestamp skew |
| `HMAC_REPLAY_CACHE_SIZE` | `10000` | Positive integer; signatures remembered for replay protection |
| `RIDE_MIN_DURATION_SECONDS` | `2` | Greater than 0 and ≤ `RIDE_MAX_DURATION_SECONDS` |
| `RIDE_MAX_DURATION_SECONDS` | `15` | |
| `RIDE_MIN_CRASH_SECONDS` | `2` | At least 0.4, at most `RIDE_MIN_DURATION_SECONDS`, and below `RIDE_MAX_DURATION_SECONDS` |
| `DEMO_UI_ENABLED` | `true`, but `false` in production | Serves the demo at `/demo` |
| `REWARD_EXPIRY_INTERVAL_SECONDS` | `300` | Integer ≥ 0 (at most 2147483); seconds between in-process reward expiry runs, `0` disables. Runs only while the server is listening, never in test. `POST /api/admin/rewards/expire` runs it on demand |
| `RIDE_EXPIRY_GRACE_SECONDS` | `900` | Integer 0 to 31536000; an unlocked ride must have been over (crashed or ended) this long before the expiry job marks its reward `EXPIRED`. Until then quote and lock report the ride's own `RIDE_CRASHED` / `RIDE_ENDED` |

Secrets may never be empty in any environment.

## Project layout

```
src/
  index.ts            Express app: /api routes, /health, optional /demo
  config/             environment validation and database settings
  routes/             HTTP routes
  controllers/        request/response handling
  services/           business logic (eligibility, opt-in, quote, lock, settlement)
  computations/       ride and boost math
  money/              minor-unit money helpers (integer amounts, currency)
  db/                 knex connection and repositories
  middleware/         API key / HMAC auth, error handling, request logging
  validation/         request schemas (zod)
  types/              shared types and reason codes
migrations/           knex migrations (TypeScript; compiled for production)
seeds/                development sample data
public/demo/          demo UI
scripts/              build and production migration helpers
tests/                unit, integration and demo UI checks
```

## Further documentation

- [docs/api-examples.md](docs/api-examples.md): endpoints, authentication and payloads
- [docs/overview.md](docs/overview.md): product behaviour for business readers
- [docs/dev-overview.md](docs/dev-overview.md): developer on-ramp and key behaviours

## Known limitations

- PostgreSQL is not yet verified: the `pg` driver is not a dependency, and a
  `postgres://` URL fails at startup with an "install pg" message.
- There is no rate limiting yet.
- Not ready for real-money use (see [Status](#status)).
