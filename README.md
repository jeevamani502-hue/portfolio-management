# Bharat Terminal

An Indian market research, analytics and portfolio-intelligence platform — NSE/BSE cash, indices,
F&O, portfolio analytics, a rule-based signal engine, and an evidence-grounded AI analyst.

> **The principle this codebase is built around**
>
> `REAL DATA → CALCULATIONS → EVIDENCE → ANALYSIS`
>
> Never `FAKE DATA → AI GUESS → TRADE CALL`
>
> Every market value carries `{ source, timestamp, status }`. When a value cannot be sourced the
> platform renders **“Live market data unavailable”** and says why. Nothing is estimated,
> interpolated, or substituted — and the AI analyst is *mechanically prevented* from stating a
> number that is not in its retrieved evidence.

---

## Current state

| Area | Status |
|---|---|
| Architecture, DB schema, API design | Complete — see [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) |
| Backend (auth, market, stocks, F&O, portfolio, watchlist, scanner, news, risk, AI, alerts, backtest, settings) | Implemented, typechecks clean, builds |
| Analysis engine (indicators, structure, signals, greeks, portfolio maths, backtester) | Implemented, **152 unit tests passing** |
| Frontend (13 pages, live WS, charts, provenance UI) | Implemented, typechecks clean, builds |
| Background workers (instruments, breadth, scanner, option chain, news, alerts, valuation) | Implemented |
| Tick streaming over broker websockets | **Not implemented** — see [Known gaps](#known-gaps) |
| Broker adapters verified against live credentials | **Not done** — see [Known gaps](#known-gaps) |

---

## Quick start

### Prerequisites

- Node.js 20+
- Docker (for PostgreSQL + Redis), or your own instances

### 1. Install

```bash
npm install
```

### 2. Configure

```bash
cp .env.example .env
```

Generate the three required secrets:

```bash
node -e "console.log('JWT_ACCESS_SECRET=' + require('crypto').randomBytes(32).toString('base64'))"
node -e "console.log('JWT_REFRESH_SECRET=' + require('crypto').randomBytes(32).toString('base64'))"
node -e "console.log('CREDENTIAL_ENC_KEY=' + require('crypto').randomBytes(32).toString('base64'))"
```

The server **refuses to start** if these are missing, too short, or left at a placeholder —
`CREDENTIAL_ENC_KEY` must decode to exactly 32 bytes, because it encrypts your broker credentials.

### 3. Start infrastructure

```bash
npm run infra:up      # PostgreSQL 16 + TimescaleDB, Redis 7
```

No Docker? Point `DATABASE_URL` and `REDIS_URL` at your own instances. TimescaleDB is optional —
the migrations detect it and fall back to plain PostgreSQL.

### 4. Migrate

```bash
npm run migrate
npm run migrate:status    # shows applied / pending
```

### 5. Run

```bash
npm run dev               # API on :4000, web on :5173
npm run dev:worker -w backend   # background jobs (separate terminal)
```

Open http://localhost:5173 and create an account.

### 6. Connect a market-data provider

Until you do, every market endpoint honestly reports that data is unavailable — that is the
designed behaviour, not a failure.

**Configure providers in the app: Settings → Market data providers → Configure.** Credentials are
AES-256-GCM encrypted before storage and never returned by any endpoint.

The `*_API_KEY` / `*_ACCESS_TOKEN` entries in `.env` are a fallback for headless deployments and
background workers that have no user context. **Anything saved in the app replaces the environment
value outright** rather than merging with it — otherwise a forgotten env token could silently win
over the key you just typed into the UI, and changing it in Settings would appear to do nothing.
For normal use, leave those env entries blank.

Then run the instruments sync (start the worker — it syncs on boot) and seed reference data:

```bash
npm run seed -w backend   # index membership, sector tags, NSE holidays
```

---

## Choosing a data provider

Full analysis in [`docs/ARCHITECTURE.md` § B](docs/ARCHITECTURE.md). Short version:

| Provider | Cost | Auth | Why you'd pick it |
|---|---|---|---|
| **Dhan HQ v2** | Free for individuals | Long-lived static token | Best default. No daily login, native option-chain endpoint. |
| **Angel One SmartAPI** | Free | TOTP | Good failover — the server can refresh sessions unattended. |
| **Zerodha Kite Connect** | Paid monthly | Daily OAuth | Best tick quality. No option-chain endpoint (assembled locally). |
| EODHD | Paid | API key | Fundamentals. |
| RSS feeds | Free | None | News. Set `RSS_FEEDS` to feeds you are entitled to read. |

> **Data licensing.** Using *your own* broker API to power *your own* dashboard is normal.
> Serving those ticks to other users is redistribution and needs an exchange vendor licence.
> The platform is single-tenant-credential by default; `SHARED_FEED_LICENSED=false` gates the
> shared-feed mode off.

> **On `NsePublicProvider`.** The undocumented `nseindia.com` JSON endpoints are shipped as an
> adapter but **disabled by default**, hard-throttled, and registered at the lowest priority
> behind every licensed feed. They are unsupported and not licensed for redistribution. Enabling
> them (`NSE_PUBLIC_ENABLED=true`) is an operator decision, not a default.

---

## Hosting it

[`docs/DEPLOY-ORACLE.md`](docs/DEPLOY-ORACLE.md) — the whole stack on one VM,
free and always on.

Most free tiers sleep after a few minutes idle, and when the process sleeps
the background worker stops: no scanner sweeps, no news polling, no alert
evaluation, no paper-trade exits. That is most of what this platform does, so
a host that keeps a process running matters more here than raw resources.
Oracle Cloud Always Free is the option that does.

[`render.yaml`](render.yaml) deploys the same stack to Render if you would
rather not run a VM — with the caveat above, and a free PostgreSQL instance
that expires after 30 days.

---

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | API + web, both with hot reload |
| `npm run dev:worker -w backend` | Background job runner |
| `npm run build` | Production build of both |
| `npm test` | Backend unit tests (286) + frontend (14) |
| `npm run migrate` / `migrate:status` | Database migrations |
| `npm run seed -w backend` | Reference data (indices, sectors, holidays) |
| `npm run lint:safety` | **Financial-safety linter** — fails on guarantee-style language |
| `npm run infra:up` / `infra:down` | Docker PostgreSQL + Redis |

---

## How the honesty guarantees actually work

These are structural, not aspirational. Each one is enforced by code you can point at.

**1. Provenance is a type, not a convention.**
`Sourced<T>` ([`utils/sourced.ts`](backend/src/utils/sourced.ts)) is a discriminated union —
`Available<T> | Unavailable`. TypeScript will not let a caller forget the unavailable branch, on
either side of the wire. Status (`live` / `delayed` / `closed`) is *derived* from age and market
state; a caller cannot simply assert that something is live.

**2. Stale data is never relabelled as fresh.**
When a provider fails, `marketData.service.ts` falls back to the stored quote — and marks it
`closed`, never `live`, even during market hours. Every such read writes a row to
`data_quality_events`, visible in **Settings → Data quality**.

**3. Bad ticks are rejected, not displayed.**
`isSaneQuote()` drops prints outside circuit bands, with high < low, or timestamped in the future.
Rejections are logged, never forwarded.

**4. The AI cannot invent a number.**
The system prompt forbids it; [`ai/validator.ts`](backend/src/ai/validator.ts) *proves* it. Every
numeric token in an answer must match a fact in the evidence bundle, or be derivable from two
facts by difference / ratio / percentage. Unmatched numbers → the answer is regenerated once, then
replaced by a deterministic template. There is a [test suite](backend/src/ai/__tests__/validator.test.ts)
for exactly this, including the case where one hallucinated figure hides among four correct ones.

**5. Missing evidence means no answer.**
If a fact the question requires is unavailable, the analyst says so **without calling the model at
all**. An answer assembled from absent data is worse than no answer.

**6. A trade idea cannot exist without its risk.**
`invalidation`, `riskFactors[]`, `dataAsOf` and `confidence` are non-optional on the `TradeIdea`
type *and* enforced by a `CHECK (cardinality(risk_factors) > 0)` constraint in the schema.

**7. Guarantee language fails the build.**
`npm run lint:safety` greps every source file for guarantee-style copy — promised profits,
returns described as certain, no-risk framing, claims of certainty about direction, perfect-accuracy
claims — and fails the build on a match. The pattern list lives in
[`scripts/banned-phrases.mjs`](scripts/banned-phrases.mjs).
The only exempt files are the validator and prompt that exist to *detect* such phrasing; this
README is itself linted, which is why it describes the patterns rather than spelling them out.

**8. Scores are labelled as what they are.**
Every score is "how many rule-based conditions currently agree, weighted" — never a probability.
The UI expands any score into the exact rules behind it, each with the observed value that made it
pass or fail.

**9. The F&O track record is measured, not claimed.**
Every ENTER-grade option signal is written to a journal with its plan at issue, and a tracker
resolves it against real quotes — stop, invalidation, targets, expiry, time stop. The hit rate and
average R shown per grade are computed from those rows and nothing else, and carry a sample-size
caveat until at least thirty have resolved.

---

## The F&O decision engine

Buying an index call or put is decided the way a discretionary trader decides it — as a checklist
across five groups, not a single score — and the whole checklist is shown with the number that
decided each line ([`decisionEngine.ts`](backend/src/analysis/options/decisionEngine.ts)):

| Group | What has to be true |
|---|---|
| **Direction** | The daily rule score has a side (≥ 60 bullish, ≤ 40 bearish — a gate); swing structure and a named setup agree; momentum is not already stretched; the broad-market regime is not fighting it |
| **Timing** | The 15-minute score has turned the same way; price is on the right side of session VWAP; the intraday Supertrend agrees; the session is moving that way; the entry is inside 09:30–15:00 IST |
| **Chain flow** | PCR reads with the bias; max pain sits on the trade's side; today's OI additions favour it; there is room to the nearest OI wall |
| **Volatility** | IV percentile is not at the rich end; India VIX is not elevated; at least two calendar days to expiry (a gate — the engine rolls to the next expiry itself) |
| **Risk** | A contract can be priced, stopped and sized from the capital entered (a gate); it survives to its own stop; the outlay is a sane share of capital; the strike is liquid |

A failed gate means no trade whatever the rest says. Otherwise the score is the weighted share of
*readable* factors that agree — an unavailable input lowers coverage rather than counting either
way — and maps to a grade: **A** (≥ 75, structure and timing clean) or **B** (≥ 60) is *Enter*,
**C** (≥ 45) is *Wait*, anything else is *No trade*. Coverage under 60% caps the grade at C.

An Enter decision carries a full plan: entry zone inside the quoted spread, a nominal premium stop
and the real invalidation level on the underlying, two targets (1.5R and 2.5R), lots sized from
the capital entered, a time stop, and the exits in the order to apply them. The panel also lists
what would change the read.

The same engine drives three things:

- **F&O page → Trade decision** — run the checklist for NIFTY / BANKNIFTY / FINNIFTY / MIDCPNIFTY.
- **`FNO_SETUP` alerts** — re-run every 30 s in market hours; fire once per new Enter-grade
  contract at or above the chosen grade. "Alert me on … setups" on the F&O page creates one.
- **Paper trading** — opens a simulated position only on an Enter decision inside the entry window.

**When to sell** is the signal tracker ([`signalTracker.ts`](backend/src/workers/jobs/signalTracker.ts)):
every minute it prices each journaled signal and notifies on target 1 (book half, stop to entry),
target 2, stop, invalidation, expiry and the time stop — plus one warning when the premium is 70%
of the way to the stop and one when expiry is a day away.

**Notifications** are persisted before they are pushed
([`notifications.service.ts`](backend/src/modules/notifications/notifications.service.ts)), so an
alert that fires while the browser is closed is waiting under the bell on the next visit. Desktop
notifications are opt-in from the bell; a "send test" button confirms they work.

---

## Architecture at a glance

```
Broker API ──► Provider registry ──► Market data service ──► Redis ──► WS gateway ──► React
                (capability routing,     (Sourced<T>,          (hot     (250ms
                 failover, breaker)       sanity checks)       cache)   coalescing)
                                               │
                                               ▼
                                     Analysis engine (pure, tested)
                                     indicators · structure · signals
                                     greeks · portfolio · backtester
                                               │
                                               ▼
                                     Evidence bundle ──► Claude ──► numeric validator
```

The registry routes **per capability**, not per provider — which is why Kite (no option-chain
endpoint) still produces an option chain: the `optionChain` capability falls through to local
assembly from the instrument master plus one batched quote call.

---

## Project layout

```
backend/src/
  analysis/     indicators, structure, signals, options (Black-Scholes), portfolio, risk, backtest
  providers/    MarketDataProvider contract + dhan, kite, angelone, nsepublic, eodhd, rss
  modules/      one folder per API area (routes + service)
  ai/           intent → retrieval → evidence → prompts → validator → analyst
  workers/      scheduled jobs
  websocket/    tick fan-out gateway
frontend/src/
  pages/        13 routes
  components/   DataValue (the honesty component), market, analysis, portfolio
  charts/       lightweight-charts candles, Recharts equity curve
database/migrations/   4 SQL files, 25 tables
docs/ARCHITECTURE.md   full design: providers, data flow, ER diagram, roadmap
```

---

## Known gaps

Stated plainly, because a README that implies more than exists is its own kind of fabrication.

**1. Tick streaming is not implemented.**
The websocket gateway, Redis pub/sub fan-out, 250 ms coalescing, leader election and client
reconnect are all built and working. What is missing is the *upstream* half: decoding each
broker's binary/protobuf tick socket. No shipped adapter declares `streamTicks`.

Consequence: the feed indicator reads "Not streaming", and quotes are fetched over REST with
their real freshness status. Nothing is faked — the UI tells you exactly what you are getting.
Adding it means implementing `openTickStream()` on one provider; the rest of the pipeline is done.

**2. Provider adapters are unverified against live credentials.**
They are written to each broker's published API shape, but no request has been made to a real
endpoint. Broker JSON field names drift between versions. Expect to fix field mappings on first
connection — `healthCheck()` on each provider and **Settings → Test connection** are there to make
that a short loop rather than a mystery.

**3. Some data needs history before it means anything.**
IV percentile needs ~20 stored option-chain snapshots. Portfolio volatility, drawdown, beta and
Sharpe need ~20 daily valuation snapshots. Both report *why* they are unavailable rather than
showing a number computed from three data points.

**4. 52-week high/low are provider-dependent.**
Dhan's market-feed payload does not include them; Angel One's does. Where absent, the field shows
as unavailable until an EOD reconciliation job populates it from bhavcopy. That job is specified
in the architecture doc but not yet written.

**5. Not yet built:** broker holdings import (OAuth flows exist in the Kite adapter but are not
wired to a UI), Telegram/email alert delivery (browser push works), multi-leg option strategy
payoffs, and the EOD bhavcopy reconciliation job.

**6. Backtest cost rates need verification.**
STT, exchange, SEBI and stamp-duty rates in [`costs.ts`](backend/src/analysis/backtest/costs.ts)
reflect the published structure at the time of writing. They change. They are configuration, not
constants — verify against current SEBI/exchange circulars before drawing economic conclusions.

---

## Testing

```bash
npm test
```

152 tests covering the parts where a silent error would be most damaging:

- **Indicators** (37) — RSI bounds, EMA seeding, MACD histogram identity, ATR gap handling,
  Bollinger symmetry, ADX on trending vs choppy series, VWAP session resets.
- **Options** (37) — Black-Scholes against textbook values (ATM call = 10.4506), put-call parity,
  IV round-trip recovery, max pain, PCR, buildup classification. IV solving returns `null` rather
  than a garbage number when the price is outside no-arbitrage bounds.
- **Risk & portfolio** (46) — position sizing never exceeds the risk budget at any stop distance,
  XIRR against hand-computed cases, unpriced holdings excluded rather than valued at cost,
  Indian cost model leg-by-leg.
- **AI safety** (32) — the validator catches a fabricated price, a fabricated volume, and an
  invented P/E; accepts derived differences and percentages; rejects guarantee language and direct
  advice.

---

## Security

JWT access tokens (15 min) with rotating refresh tokens (7 d, hashed at rest, family-revoked on
reuse). Argon-grade bcrypt hashing. Redis token-bucket rate limiting, tighter on AI and scans.
Zod validation on every input. RBAC. Audit logging. AES-256-GCM for broker credentials.

A response scrubber walks every outgoing JSON body and redacts anything credential-shaped, as
defence in depth against a controller bug. The one exemption — the auth endpoints returning your
own JWT — is opt-in per route (`allowTokensInResponse`) so it stays greppable.

---

## Licence and disclaimer

This is a research and analytics tool. It is **not investment advice**, it does not make
recommendations, and it makes no claim about future prices. Rule-based scores measure how many
technical conditions currently agree — nothing more. Backtest results are historical simulation on
past data and differ from live trading through execution, liquidity, gaps, and selection bias.

Market data is subject to exchange licensing. You are responsible for holding the rights to the
data you consume and for any redistribution.
