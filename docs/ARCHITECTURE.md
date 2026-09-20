# Bharat Terminal — System Architecture

**An Indian market research, analytics and portfolio-intelligence platform.**

> **Core principle of this system:**
> `REAL DATA -> CALCULATIONS -> EVIDENCE -> ANALYSIS`
> Never `FAKE DATA -> AI GUESS -> TRADE CALL`
>
> Every number rendered in the UI carries a **provenance triple**: `{ source, timestamp, status }`.
> When a value cannot be sourced, the system renders `Live market data unavailable` — it never
> substitutes, interpolates, or invents a price, volume, OI, or fundamental figure.

---

## A. Complete System Architecture

### A.1 Logical view

```
┌───────────────────────────────────────────────────────────────────────────────┐
│                                   CLIENTS                                     │
│   React 18 + TS + Vite SPA (desktop / tablet / mobile)   ·   Service Worker   │
└───────────────┬──────────────────────────────────────┬────────────────────────┘
                │ HTTPS REST (JSON)                    │ WSS (tick + event push)
                ▼                                      ▼
┌───────────────────────────────────────────────────────────────────────────────┐
│                          EDGE / API GATEWAY (Express)                         │
│  helmet · CORS · rate-limit (Redis token bucket) · zod validation · JWT auth  │
│  request-id · structured logging (pino) · audit log · RBAC                    │
└───────────────┬───────────────────────────────────────────────────────────────┘
                │
   ┌────────────┴─────────────────────────────────────────────────────────────┐
   │                        APPLICATION SERVICES (Node/TS)                    │
   │                                                                          │
   │  auth ·  users ·  settings ·  watchlist ·  portfolio ·  alerts           │
   │  market ·  stocks ·  options ·  scanner ·  news ·  backtest ·  ai        │
   └────────────┬───────────────────────────┬──────────────────┬──────────────┘
                │                           │                  │
                ▼                           ▼                  ▼
   ┌────────────────────────┐   ┌──────────────────────┐  ┌───────────────────┐
   │   ANALYSIS ENGINE      │   │  MARKET DATA LAYER   │  │   AI LAYER        │
   │  (pure, deterministic) │   │                      │  │                   │
   │  · indicators          │   │  MarketDataProvider  │  │ intent detection  │
   │  · signal rules        │   │  ├ KiteProvider      │  │ retrieval planner │
   │  · scoring             │   │  ├ UpstoxProvider    │  │ evidence bundle   │
   │  · regime detection    │   │  ├ DhanProvider      │  │ Claude (tools)    │
   │  · greeks / max pain   │   │  ├ FyersProvider     │  │ citation enforce  │
   │  · risk + sizing       │   │  ├ AngelOneProvider  │  │ refusal on gaps   │
   │  · backtester          │   │  ├ NsePublicProvider │  └───────────────────┘
   │  · portfolio metrics   │   │  └ AmfiProvider      │
   └────────────────────────┘   │        │             │
                                │  ProviderRegistry    │
                                │  (failover + health) │
                                └──────────┬───────────┘
                                           │
   ┌───────────────────────────────────────┴───────────────────────────────────┐
   │                        BACKGROUND WORKERS (BullMQ)                        │
   │  tick-ingest · candle-aggregator · indicator-recompute · scanner-sweep    │
   │  option-chain-poller · news-poller · alert-evaluator · fundamentals-sync  │
   │  eod-snapshot · portfolio-valuation · token-refresh · data-quality-audit  │
   └───────────────┬───────────────────────────────────┬───────────────────────┘
                   ▼                                   ▼
   ┌──────────────────────────────┐      ┌──────────────────────────────────────┐
   │  Redis 7                     │      │  PostgreSQL 16 + TimescaleDB         │
   │  · hot quote cache (TTL)     │      │  · users, portfolios, transactions   │
   │  · pub/sub fan-out to WS     │      │  · hypertable: ticks, candles        │
   │  · BullMQ queues             │      │  · option_chain_snapshots            │
   │  · rate-limit buckets        │      │  · fundamentals, news, alerts        │
   │  · idempotency + locks       │      │  · continuous aggregates (1m→1d)     │
   └──────────────────────────────┘      └──────────────────────────────────────┘
```

### A.2 Key architectural decisions

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | **Single upstream subscription, fan-out via Redis pub/sub** | A broker feed allows ~1–3 sockets and a few thousand instruments. One `tick-ingest` worker holds the upstream socket; N API pods fan out to thousands of browsers. Users never multiply upstream load. |
| 2 | **Provider abstraction with a capability manifest** | Providers differ wildly (Dhan has an option-chain REST endpoint; Kite does not and must be derived from instruments + quotes). Each provider declares `capabilities` and the registry routes per-capability, not per-provider. |
| 3 | **Deterministic analysis is never done by the LLM** | All indicators, greeks, scores, sizing and P&L are computed in pure TypeScript with unit tests. The LLM only *narrates* a pre-computed evidence bundle. |
| 4 | **Provenance is a type, not a convention** | `Sourced<T> = { value, source, asOf, status, staleMs }`. The serializer refuses to emit a bare number for a market value. Frontend `<DataValue>` renders status chips. |
| 5 | **Credentials never leave the server** | Broker keys are encrypted at rest (AES-256-GCM, key from `CREDENTIAL_ENC_KEY`), decrypted only inside the provider process, never serialized into any API response (a response-scrubber middleware asserts this). |
| 6 | **TimescaleDB hypertables + continuous aggregates** | 1-minute candles for ~2000 instruments ≈ 750k rows/day. Hypertable partitioning + compression after 7 days keeps this cheap; higher timeframes are continuous aggregates, not recomputed on read. |
| 7 | **Read-your-own-writes via Redis, durability via Postgres** | The dashboard reads Redis (sub-ms). Workers persist to Postgres asynchronously. A Redis miss falls back to Postgres and is marked `Delayed`, never `Live`. |
| 8 | **Market-hours state machine** | `PRE_OPEN / OPEN / CLOSED / POST / HOLIDAY`. Drives poll intervals, websocket behaviour, and the status chip. Nothing is labelled `Live` outside market hours. |

### A.3 Runtime processes

| Process | Scale | Responsibility |
|---|---|---|
| `api` | N (stateless) | REST + WS termination, auth, serving evidence bundles |
| `worker-realtime` | **1 (leader-elected)** | Holds broker websocket, normalizes ticks, writes Redis, publishes pub/sub |
| `worker-scheduled` | 1–2 | Cron-style jobs: EOD, fundamentals, news, scanner sweeps, token refresh |
| `worker-compute` | N | CPU-bound: indicator recompute, backtests, scanner scoring |
| `postgres` | 1 primary (+replica) | System of record |
| `redis` | 1 (+sentinel) | Cache, queues, pub/sub |

Leader election for `worker-realtime` uses a Redis lock (`SET key val NX PX 15000` + heartbeat
renew) so a restart cannot open two upstream sockets and trip broker rate limits.

---

## B. Recommended legitimate market-data providers for India

> Pricing and limits below reflect what was published at the time of writing and **must be
> re-verified** against each provider's current documentation before you commit. The code does not
> depend on any of these numbers — they live in `backend/src/providers/*/manifest.ts` as config.

### B.1 Tier 1 — Broker APIs (real-time, authenticated, licensed)

These are the correct primary source. They are licensed redistribution of exchange data to *you,
the account holder*. All require an account with that broker.

| Provider | Auth model | Realtime | Historical | Option chain | Notes |
|---|---|---|---|---|---|
| **Zerodha Kite Connect** | `api_key` + `api_secret` → daily `request_token` → `access_token` (expires ~07:30 IST next day) | WebSocket, binary ticks, ~3 sockets × 3000 instruments | Yes (separate paid add-on) | Derive from instrument dump + quote batch | Most mature docs, best tick quality. Paid monthly. |
| **Upstox API v2** | OAuth 2.0 authorization-code; token expires ~03:30 IST | WebSocket (protobuf) market feed | Yes, free | Yes (`/option/chain`) | Free API access. Protobuf decoding required. |
| **Angel One SmartAPI** | `api_key` + client code + MPIN + **TOTP** | WebSocket v2 (binary) | Yes, free | Yes | Free. TOTP lets the server refresh sessions unattended (store the TOTP secret encrypted). |
| **Dhan HQ v2** | Static `access_token` (long-lived) | Live market feed WS (20-level depth on some plans) | Yes | Yes, first-class endpoint | Free for individuals. Long-lived token = simplest unattended operation. Strict per-endpoint throttles (option chain ~1 req / 3 s). |
| **Fyers API v3** | OAuth → daily `access_token` | WebSocket | Yes | Yes | Free. Good symbol master. |
| **ICICI Breeze / 5paisa / Kotak Neo** | Varies | Yes | Yes | Partial | Implement on demand behind the same interface. |

**Recommendation:** ship **Dhan** (unattended, long-lived token, native option chain) +
**Angel One** (free, TOTP auto-refresh) as the default pair, with **Kite** for users who already
pay for it. Run one as `primary`, the others as `failover`.

### B.2 Tier 2 — Exchange / official sources

| Source | What it gives | Legal posture |
|---|---|---|
| **NSE `nseindia.com` JSON endpoints** | Option chain, pre-open, gainers/losers, corporate announcements | **Undocumented, not licensed for redistribution, actively rate-limited and cookie-gated.** Shipped as `NsePublicProvider`, **disabled by default**, hard-throttled, with a kill-switch. Never powers a value labelled `Live` unless the operator explicitly opts in. |
| **NSE / BSE Bhavcopy & delivery files** | Official EOD OHLCV + delivery %, security-wise data | Published files intended for download. Safe for EOD. |
| **NSE Data Services (DotEx) / BSE paid feeds** | Licensed, redistributable real-time | The correct answer if you redistribute data commercially to third parties. |
| **AMFI `NAVAll.txt`** | Official daily NAV for every Indian mutual-fund scheme | Public, free, intended for consumption. Used by `AmfiProvider`. |
| **RBI / MoSPI / data.gov.in** | Rates, CPI/WPI, macro | Open data. |

> **Compliance note.** Real-time exchange data carries redistribution restrictions. Using *your
> own* broker API to power *your own* dashboard is normal. Serving that same tick to other paying
> users is redistribution and requires an exchange data-vendor licence. The platform is therefore
> built **single-tenant-credential first**: each user connects *their own* broker account and the
> system fans out only to that user's sessions. The `SHARED_FEED_LICENSED` flag gates the
> shared-feed mode off by default.

### B.3 Tier 3 — Fundamentals

| Source | Coverage | Notes |
|---|---|---|
| **EOD Historical Data (EODHD)** | NSE/BSE (`.NSE`/`.BSE`), long financial history, ratios | Paid, reliable, well documented. Recommended default. |
| **Financial Modeling Prep** | NSE/BSE via `.NS`/`.BO` | Paid tiers; verify per-symbol completeness for India. |
| **Twelve Data / Intrinio** | Partial India | Alternatives. |
| **NSE/BSE XBRL filings + corporate announcements** | Authoritative quarterly/annual | Free but requires XBRL parsing; highest fidelity. Roadmap item. |

`FundamentalsProvider` is a separate interface from `MarketDataProvider` because the best source
differs.

### B.4 Tier 4 — News & sentiment

| Source | Notes |
|---|---|
| **Marketaux** | Entity-tagged financial news with ticker mapping incl. Indian exchanges, plus sentiment. Good primary. |
| **NewsAPI.org / GNews** | Broad, cheap, weak entity tagging — we map entities ourselves. |
| **Official RSS** (Economic Times Markets, Moneycontrol, Livemint, Business Standard, NSE/BSE announcements) | Free, legitimate, publisher-sanctioned. `RssNewsProvider` is the zero-cost default. |
| **Exchange corporate announcements** | Highest signal, lowest noise. Treated as its own category. |

Sentiment is computed by a **transparent lexicon + rules classifier first** (explainable and
reproducible), optionally refined by the LLM. Every sentiment carries `confidence`, and the UI
states plainly that automated sentiment can be wrong.

### B.5 Provider capability matrix (drives routing)

```ts
type Capability =
  | 'quote' | 'quoteBatch' | 'depth' | 'streamTicks'
  | 'historicalCandles' | 'intradayCandles'
  | 'instruments' | 'optionChain' | 'futuresChain' | 'openInterest'
  | 'marketBreadth' | 'indices' | 'gainersLosers'
  | 'fundamentals' | 'news' | 'mfNav' | 'holdings' | 'positions';
```

The registry resolves `capability -> ordered provider list` from user config, tries in order,
records health, and **fails closed**: if no provider can serve a capability, the API returns
`status: 'unavailable'` with the list of providers tried and why each failed. It never falls back
to a fabricated value.

---

## C. Data flow

### C.1 Real-time tick flow

```
 Broker WS (binary/protobuf)
        │  ~1–50 msg/s/instrument
        ▼
 ┌────────────────────┐   decode → normalize → validate (sanity bands, monotonic ts)
 │  worker-realtime   │   drop + log ticks failing sanity checks (never forward junk)
 └─────────┬──────────┘
           ├──► Redis  SET quote:{exch}:{token}  {ltp,ohlc,vol,oi,ts,src}  EX 300
           ├──► Redis  PUBLISH ticks:{token}  (compact JSON)
           ├──► ring buffer → 1-minute candle builder → batch INSERT (Timescale)
           └──► alert-evaluator queue (only for tokens with active alerts)
                     │
 ┌───────────────────▼──────────┐
 │  api pod: WS gateway         │  per-connection subscription set,
 │  SUBSCRIBE ticks:*           │  coalesced at 250 ms, backpressure-aware
 └───────────────┬──────────────┘
                 ▼
          Browser (Zustand store → React)
```

**Coalescing:** the WS gateway batches all ticks for a connection into one frame every 250 ms
(configurable). A user watching 50 symbols receives 4 frames/s, not 2000 messages/s.

### C.2 Analysis request flow (`GET /api/stocks/:symbol/analysis`)

```
request → resolve symbol (instruments table, exact then fuzzy)
        → fetch quote        (Redis hot → provider → mark status)
        → fetch candles      (Timescale continuous aggregate for the timeframe)
        → if candles stale   → enqueue backfill, serve what exists, status = Delayed
        → compute indicators (pure fns, memoized by (token, tf, lastCandleTs))
        → derive structure   (swing pivots, S/R clusters, pivot points)
        → run SignalEngine   (rule set → confirmations → score)
        → assemble Sourced<> envelope with per-field provenance
        → respond
```

Nothing in this path can produce a number without a candle or quote behind it. If candles are
missing, the indicator field is
`{ status: 'unavailable', reason: 'insufficient_history', required: 200, available: 34 }`.

### C.3 AI analyst flow

```
User question
   │
   ▼ intent classifier (rules + model): stock_analysis | portfolio | fno |
   │   market_why | compare | scanner | news | regime | unsupported
   ▼ retrieval planner → declares exactly which evidence bundles are needed
   ▼ parallel fetch: quote · candles+indicators · fundamentals · option chain ·
   │                 news · breadth · regime · (portfolio, if authorized)
   ▼ EvidenceBundle { facts[] }, each fact = value + source + asOf + status
   ▼ gap check: any REQUIRED fact unavailable → respond "cannot answer, missing X"
   │             WITHOUT calling the LLM
   ▼ Claude (claude-opus-5) — system prompt forbids introducing any number not
   │   present in the bundle; response schema requires fact_ids as citations
   ▼ post-validator: every numeric token in the answer must appear in the bundle
   │   (tolerance-matched); unmatched numbers → reject + regenerate once,
   │   then degrade to the deterministic template
   ▼ structured answer + sources + data timestamps
```

The **post-validator** is the teeth behind "never fabricate". It is a deterministic check, not a
prompt instruction.

### C.4 Historical / batch flow

```
scheduler (BullMQ repeatable)
   ├─ 08:45 IST  instruments-sync        provider → instruments table
   ├─ 09:07 IST  pre-open-snapshot
   ├─ every 3 m  option-chain-poller     (market hours only)
   ├─ every 5 m  scanner-sweep           → market_signals
   ├─ every 10 m news-poller             → news + entity mapping + sentiment
   ├─ 16:00 IST  eod-snapshot            bhavcopy reconcile, delivery %, 52w hi/lo
   ├─ 16:30 IST  indicator-recompute     daily-TF indicators for full universe
   ├─ 17:00 IST  portfolio-valuation     EOD marks, XIRR, drawdown, beta
   └─ weekly     fundamentals-sync
```

---

## D. Database ER diagram

```mermaid
erDiagram
    users ||--o{ user_settings : has
    users ||--o{ api_providers : configures
    users ||--o{ portfolios : owns
    users ||--o{ watchlists : owns
    users ||--o{ alerts : creates
    users ||--o{ refresh_tokens : holds
    users ||--o{ audit_logs : generates
    users ||--o{ backtests : runs
    users ||--o{ ai_conversations : has

    portfolios ||--o{ portfolio_holdings : contains
    portfolios ||--o{ transactions : records
    portfolios ||--o{ portfolio_snapshots : "valued daily"

    instruments ||--o{ portfolio_holdings : "referenced by"
    instruments ||--o{ transactions : "referenced by"
    instruments ||--o{ watchlist_items : "referenced by"
    instruments ||--o{ market_prices : "quoted as"
    instruments ||--o{ candles : "has history"
    instruments ||--o{ technical_indicators : "has computed"
    instruments ||--o{ fundamentals : "has reported"
    instruments ||--o{ quarterly_results : "has reported"
    instruments ||--o{ option_chain_snapshots : "underlies"
    instruments ||--o{ futures_snapshots : "underlies"
    instruments ||--o{ news_entities : "mentioned in"
    instruments ||--o{ market_signals : "signals on"
    instruments ||--o{ alerts : "watched by"

    watchlists ||--o{ watchlist_items : contains
    news_articles ||--o{ news_entities : tags
    market_signals ||--o{ trade_ideas : supports
    alerts ||--o{ alert_events : fires
    backtests ||--o{ backtest_trades : produces
    ai_conversations ||--o{ ai_messages : contains
    ai_messages ||--o{ analysis_logs : "evidenced by"

    users {
        uuid id PK
        citext email UK
        text password_hash
        text role
        bool is_active
        timestamptz created_at
    }
    instruments {
        bigint id PK
        text exchange
        text tradingsymbol
        text isin
        text segment
        text instrument_type
        text underlying
        date expiry
        numeric strike
        text option_type
        int lot_size
        jsonb provider_tokens
    }
    portfolio_holdings {
        uuid id PK
        uuid portfolio_id FK
        bigint instrument_id FK
        numeric quantity
        numeric avg_price
        numeric realized_pnl
    }
    transactions {
        uuid id PK
        uuid portfolio_id FK
        bigint instrument_id FK
        text side
        numeric quantity
        numeric price
        numeric charges
        timestamptz traded_at
    }
    candles {
        bigint instrument_id FK
        text timeframe
        timestamptz ts
        numeric open
        numeric high
        numeric low
        numeric close
        bigint volume
        bigint oi
        text source
    }
    option_chain_snapshots {
        bigint id PK
        bigint underlying_id FK
        date expiry
        timestamptz captured_at
        numeric spot
        jsonb strikes
        numeric pcr
        numeric max_pain
        text source
    }
```

Full DDL lives in `database/migrations/*.sql`. Every market-data table carries
`source TEXT NOT NULL` and an `as_of TIMESTAMPTZ NOT NULL` so provenance survives into storage.

**Timescale hypertables:** `candles`, `ticks`, `option_chain_snapshots`, `portfolio_snapshots`.
Continuous aggregates roll `1m → 5m → 15m → 1h → 1d`.

---

## E. API architecture

### E.1 Conventions

- Base path `/api`, versioned by header `X-API-Version` (default `1`).
- Every response: `{ data, meta: { requestId, generatedAt, dataStatus, sources[] } }`.
- Every market value inside `data` is a `Sourced<T>`: `{ value, source, asOf, status, staleMs }`.
- Errors: `{ error: { code, message, details, requestId } }`.
- Auth: `Authorization: Bearer <access JWT, 15 min>`; rotation via httpOnly refresh cookie (7 d).
- Rate limits: global 300 req/min/user; AI 20 req/min; backtest 5 concurrent/user.

### E.2 Surface

```
POST   /api/auth/register            POST /api/auth/login        POST /api/auth/refresh
POST   /api/auth/logout              GET  /api/auth/me           POST /api/auth/password

GET    /api/market/status                     market-hours state machine
GET    /api/market/indices                    NIFTY/BANKNIFTY/SENSEX/VIX/sector indices
GET    /api/market/breadth                    advances/declines/unchanged + hi-lo
GET    /api/market/movers?type=gainers|losers|volume|delivery|gapup|gapdown|near52h|near52l
GET    /api/market/sectors
GET    /api/market/regime                     regime + underlying metrics
GET    /api/market/quote/:symbol
POST   /api/market/quotes                     batch
GET    /api/market/history/:symbol?tf=1d&from&to
GET    /api/market/search?q=                  instrument search

GET    /api/stocks/:symbol/analysis?tf=1d     price + technicals + structure + score + signals
GET    /api/stocks/:symbol/fundamentals
GET    /api/stocks/:symbol/peers
GET    /api/stocks/:symbol/news

GET    /api/options/:symbol/expiries
GET    /api/options/:symbol/chain?expiry=
GET    /api/options/:symbol/analytics?expiry=  PCR, max pain, OI S/R, IV skew
GET    /api/options/:symbol/greeks?expiry=&strike=&type=
GET    /api/futures/:symbol                    OI buildup interpretation

GET    /api/scanner/swing?setup=breakout|pullback|momentum|reversal
GET    /api/scanner/breakout
POST   /api/scanner/custom                    user-defined rule DSL
GET    /api/signals
GET    /api/ideas                             trade ideas w/ risk + invalidation

GET    /api/portfolio                         POST /api/portfolio
GET    /api/portfolio/:id/analysis            GET  /api/portfolio/:id/health
POST   /api/portfolio/:id/holding             PATCH/DELETE /api/portfolio/:id/holding/:hid
POST   /api/portfolio/:id/transaction         POST /api/portfolio/:id/import/:provider
GET    /api/portfolio/:id/xirr                GET  /api/portfolio/:id/risk

GET    /api/watchlists                        POST /api/watchlists
POST   /api/watchlists/:id/items              DELETE /api/watchlists/:id/items/:itemId
GET    /api/watchlists/:id/live

GET    /api/news?symbol=&sector=&sentiment=   GET /api/news/:id/impact

GET    /api/alerts    POST /api/alerts    PATCH /api/alerts/:id    DELETE /api/alerts/:id
GET    /api/alerts/:id/events

POST   /api/backtest/run   GET /api/backtest/:id   GET /api/backtest/:id/trades

POST   /api/risk/position-size                entry, stop, capital, risk% → size

POST   /api/ai/analyze                        question → evidence-grounded answer
GET    /api/ai/conversations/:id

GET    /api/settings    PATCH /api/settings
GET    /api/settings/providers   POST /api/settings/providers   (credentials, write-only)
POST   /api/settings/providers/:id/test       connectivity probe, returns no secrets

WS     /ws   { subscribe: ticks | alerts | signals | breadth }
```

### E.3 WebSocket protocol

```jsonc
// client → server
{ "op": "subscribe",   "channel": "ticks", "symbols": ["NSE:RELIANCE", "NSE:NIFTY 50"] }
{ "op": "unsubscribe", "channel": "ticks", "symbols": ["NSE:RELIANCE"] }
{ "op": "ping" }

// server → client (coalesced, every 250 ms)
{ "op": "ticks", "ts": 1726728131000, "status": "live",
  "data": [ { "s": "NSE:RELIANCE", "ltp": 2650.4, "ch": 12.3, "chp": 0.47,
              "v": 4821334, "oi": null, "src": "dhan", "t": 1726728130870 } ] }
{ "op": "status", "market": "OPEN", "feed": "degraded", "reason": "provider reconnecting" }
```

`feed: "degraded"` immediately turns every price chip in the UI from **Live** to **Delayed**.

---

## F. Frontend page structure

```
src/
├── app/            router, providers, theme, error boundary
├── pages/
│   ├── auth/            Login, Register
│   ├── Dashboard        index cards · breadth · sectors · movers · ideas · news
│   ├── Markets          indices grid, heatmap, sector rotation, breadth history
│   ├── StockAnalysis    /stocks/:symbol → Overview | Technicals | Fundamentals |
│   │                      Options | News | Peers
│   ├── Fno              option chain, analytics, futures OI, setups
│   ├── SwingScanner     setup tabs, filters, result table → idea drawer
│   ├── Portfolio        holdings, allocation, P&L, health, AI analysis
│   ├── Watchlist        live grid with RSI/trend/signal columns
│   ├── News             feed, entity filter, sentiment filter, impact panel
│   ├── Alerts           builder + history
│   ├── Backtesting      strategy builder, equity curve, stats, trade list
│   ├── AiAnalyst        chat with evidence panel + citations
│   └── Settings         profile, providers, risk config, notifications, appearance
├── components/
│   ├── ui/          shadcn primitives
│   ├── market/      DataValue, StatusChip, QuoteCard, IndexCard, BreadthBar,
│   │                SectorHeatmap, MoverTable, OptionChainTable, GreeksPanel
│   ├── analysis/    ScoreRadar, IndicatorGrid, SignalList, SetupCard, RiskBox
│   └── portfolio/   AllocationDonut, PnlBar, HealthPanel, XirrCard
├── charts/          CandleChart (lightweight-charts), EquityCurve, Sparkline,
│                    OiProfile, Heatmap
├── hooks/           useQuote, useTicks(ws), useAnalysis, usePortfolio, useScanner
├── services/        typed API client, WS client (reconnect + resubscribe)
├── store/           Zustand: auth, tickStore, uiStore, watchlistStore
└── lib/             formatters (₹ lakh/crore), dates (IST), constants
```

**Design language:** professional terminal — dense tables, tabular numerals, semantic red/green,
dark-first with a light theme, 12-column responsive grid collapsing to a single column below
768 px, virtualized tables for the option chain and scanner.

---

## G. Backend folder structure

```
backend/src/
├── index.ts                    api entrypoint
├── app.ts                      express wiring
├── config/          env.ts (zod-validated), constants.ts, market-hours.ts
├── db/              pool.ts, migrate.ts, repositories/*.ts
├── cache/           redis.ts, keys.ts, quoteCache.ts
├── middleware/      auth, rbac, validate, rateLimit, errorHandler, requestId,
│                    auditLog, scrubSecrets
├── modules/                    (controller + service + routes + schema per module)
│   ├── auth/  users/  settings/  market/  stocks/  options/  scanner/
│   ├── portfolio/  watchlist/  news/  alerts/  backtest/  ai/  risk/
├── providers/
│   ├── types.ts                MarketDataProvider, Capability, Sourced
│   ├── registry.ts             routing, failover, health, circuit breaker
│   ├── base/HttpProvider.ts    retry, throttle, timeout, error mapping
│   ├── dhan/  angelone/  kite/  upstox/  fyers/  nsepublic/  amfi/
│   ├── fundamentals/  eodhd/  fmp/
│   └── news/  marketaux/  rss/
├── analysis/
│   ├── indicators/   sma, ema, rsi, macd, adx, atr, bollinger, vwap,
│   │                 supertrend, stochrsi, obv, pivots, supportResistance
│   ├── structure.ts  swing highs/lows, trend classification, S/R clustering
│   ├── signals/      rules.ts, engine.ts, scoring.ts
│   ├── regime.ts     market regime state machine
│   ├── options/      blackScholes.ts, greeks.ts, maxPain.ts, pcr.ts, buildup.ts, iv.ts
│   ├── portfolio/    valuation.ts, xirr.ts, risk.ts (beta, vol, drawdown, corr)
│   ├── risk/         positionSizing.ts
│   └── backtest/     engine.ts, strategies/*.ts, costs.ts (STT, brokerage, slippage)
├── workers/         index.ts, queues.ts, tickIngest, candleAggregator, scannerSweep,
│                    optionChainPoller, newsPoller, alertEvaluator, eodSnapshot,
│                    fundamentalsSync, portfolioValuation, tokenRefresh
├── websocket/       server.ts, subscriptions.ts, publisher.ts
├── ai/              intent.ts, retrieval.ts, evidence.ts, prompts.ts, client.ts,
│                    validator.ts (numeric-citation enforcement), analyst.ts
├── notify/          email, telegram, webpush
└── utils/           logger, errors, crypto (AES-256-GCM), money, time (IST), sourced.ts
```

---

## H. Required environment variables

```ini
# ── Core ────────────────────────────────────────────────────────────────────
NODE_ENV=development
PORT=4000
API_BASE_URL=http://localhost:4000
FRONTEND_ORIGIN=http://localhost:5173
LOG_LEVEL=info

# ── Database ────────────────────────────────────────────────────────────────
DATABASE_URL=postgres://market:market@localhost:5432/market_ai
DATABASE_POOL_MAX=20
TIMESCALE_ENABLED=true

# ── Redis ───────────────────────────────────────────────────────────────────
REDIS_URL=redis://localhost:6379
REDIS_QUOTE_TTL_SECONDS=300

# ── Auth / crypto ───────────────────────────────────────────────────────────
JWT_ACCESS_SECRET=            # 32+ random bytes, base64
JWT_REFRESH_SECRET=           # 32+ random bytes, base64
JWT_ACCESS_TTL=15m
JWT_REFRESH_TTL=7d
BCRYPT_ROUNDS=12
CREDENTIAL_ENC_KEY=           # EXACTLY 32 bytes, base64 — AES-256-GCM key for broker secrets

# ── Market data providers (server-side only, never sent to the browser) ─────
PRIMARY_PROVIDER=dhan         # dhan | angelone | kite | upstox | fyers
FAILOVER_PROVIDERS=angelone
SHARED_FEED_LICENSED=false    # true only if you hold an exchange vendor licence

DHAN_CLIENT_ID=
DHAN_ACCESS_TOKEN=

ANGELONE_API_KEY=
ANGELONE_CLIENT_CODE=
ANGELONE_MPIN=
ANGELONE_TOTP_SECRET=

KITE_API_KEY=
KITE_API_SECRET=
KITE_ACCESS_TOKEN=            # refreshed daily via login flow

UPSTOX_API_KEY=
UPSTOX_API_SECRET=
UPSTOX_REDIRECT_URI=
UPSTOX_ACCESS_TOKEN=

FYERS_APP_ID=
FYERS_SECRET_ID=
FYERS_ACCESS_TOKEN=

NSE_PUBLIC_ENABLED=false      # undocumented endpoints; operator must opt in
NSE_PUBLIC_MIN_INTERVAL_MS=3000

# ── Fundamentals / news ─────────────────────────────────────────────────────
EODHD_API_KEY=
FMP_API_KEY=
MARKETAUX_API_KEY=
NEWSAPI_KEY=
RSS_FEEDS=

# ── AI ──────────────────────────────────────────────────────────────────────
ANTHROPIC_API_KEY=
AI_MODEL=claude-opus-5
AI_MAX_TOKENS=4096
AI_ENABLED=true

# ── Notifications ───────────────────────────────────────────────────────────
SMTP_URL=
ALERT_FROM_EMAIL=
TELEGRAM_BOT_TOKEN=
VAPID_PUBLIC_KEY=
VAPID_PRIVATE_KEY=

# ── Frontend (VITE_ vars are PUBLIC — never put a secret here) ──────────────
VITE_API_BASE_URL=http://localhost:4000
VITE_WS_URL=ws://localhost:4000/ws
```

A zod schema in `config/env.ts` validates these at boot and **refuses to start** if
`CREDENTIAL_ENC_KEY` is not exactly 32 bytes or a JWT secret is left at a default value.

---

## I. Development roadmap

| Phase | Scope | Exit criteria |
|---|---|---|
| **0 — Foundation** | Monorepo, TS configs, docker-compose, env validation, migrations, logger, error model, `Sourced<T>` | `docker compose up` healthy; `npm run migrate` green |
| **1 — Auth & shell** | JWT + refresh rotation, RBAC, audit log, React shell, sidebar, theme, protected routes | Register → login → dashboard |
| **2 — Provider layer** | `MarketDataProvider`, registry + failover + health, Dhan + AngelOne + NSE-public(off), instruments sync, quote cache | `/api/market/quote/RELIANCE` returns a real quote with provenance, or an honest `unavailable` |
| **3 — Realtime** | tick-ingest worker, Redis pub/sub, WS gateway, coalescing, market-hours machine, status chips | Dashboard ticks live in market hours; `Delayed`/`Closed` otherwise |
| **4 — Dashboard & market** | Indices, breadth, sectors, movers, 52w, gappers, delivery | Dashboard fully populated from real data |
| **5 — Stock analysis** | Candle store, timeframes, all indicators (unit-tested), structure, S/R, pivots, charts | `/stocks/RELIANCE` complete across 5m→1M |
| **6 — Signal engine** | Rule DSL, multi-confirmation, 5-axis score, transparency panel | Every score expands to the rules that produced it |
| **7 — Watchlist & portfolio** | Watchlists, holdings, transactions, valuation, XIRR, allocation, risk, health | Portfolio P&L matches a hand-computed fixture |
| **8 — F&O** | Option chain, greeks, PCR, max pain, OI S/R, buildup, IV percentile | Chain renders with real OI; analytics reproducible |
| **9 — Scanner & ideas** | Swing setups, entry/invalidation/targets, R:R, position sizing | Sweep produces ideas with a full risk block |
| **10 — News** | RSS + API ingestion, entity mapping, lexicon sentiment, impact panel | News tied to instruments with confidence |
| **11 — AI analyst** | Intent, retrieval, evidence bundle, Claude, numeric-citation validator | Validator rejects hallucinated numbers in tests |
| **12 — Alerts** | Builder, evaluator worker, browser/email/Telegram delivery | Alert fires within 2 s of condition in market hours |
| **13 — Backtesting** | Engine with Indian cost model (STT/brokerage/exchange/GST/stamp/slippage), metrics | Known-strategy fixture reproduces expected stats |
| **14 — Broker integration** | OAuth flows, holdings/positions import, token refresh | One-click holdings import |
| **15 — Hardening** | Load test, compression policy, observability, backups, CI | p95 < 200 ms on cached reads |

### MVP vs Advanced

**MVP (phases 0–11):** Auth · Dashboard · Search · Stock technical analysis · Watchlist ·
Portfolio · Option chain · Swing scanner · News · AI Market Analyst.

**Advanced (12–15):** Alerts · Backtesting · Broker holdings import · Advanced portfolio
analytics (factor/correlation/stress) · Advanced F&O (IV surface, strategy payoff builder,
multi-leg risk).

---

## J. Safety, honesty and compliance model

This is a **research and analytics tool, not investment advice.** That is enforced structurally,
not just in copy:

1. **Five-level provenance labelling.** Every surface distinguishes
   `Market Data` → `Calculated Indicator` → `Rule-Based Signal` → `AI Interpretation` →
   `Your Decision`. These are distinct visual treatments, not footnotes.
2. **Banned-phrase linter.** A CI check greps the codebase (prompts, copy, templates) for
   `guaranteed`, `will rise`, `sure shot`, `100% accurate`, `assured returns` and fails the build.
3. **Mandatory risk block.** The `TradeIdea` type makes `invalidation`, `riskFactors[]`,
   `dataTimestamp` and `confidence` non-optional — an idea cannot be constructed without them.
4. **Confidence, never certainty.** Scores are labelled *rule-confirmation strength*, with the
   contributing rules listed. No probability of profit is ever claimed.
5. **The LLM cannot introduce numbers.** Deterministic post-validation, described in C.3.
6. **Data-quality ledger.** `data_quality_events` records every stale read, provider failure and
   sanity-check rejection; the UI exposes a feed-health indicator.
7. **No redistribution by default.** `SHARED_FEED_LICENSED=false` keeps each user on their own
   broker credentials.
