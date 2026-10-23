# AdviSha database — every table and what it is for

PostgreSQL, schema `public`. The tables are created by the SQL files in
[database/migrations/](../database/migrations/), applied in order by
`npm run migrate`. The three tables most people ask about are marked
**★ users**, **★ profit** and **★ history** below.

Connect from the project root:

```bash
psql "$(grep ^DATABASE_URL .env | cut -d= -f2-)"
```

Money is stored in rupees as `NUMERIC`; timestamps are `TIMESTAMPTZ` (UTC) and
should be read in IST with `AT TIME ZONE 'Asia/Kolkata'`.

---

## 0. Server details

The database is **PostgreSQL** (plain, without the TimescaleDB extension). SQL is
the language; PostgreSQL is the server that runs it. The app talks to it through
the `pg` driver using `DATABASE_URL` in `.env`.

| Item | Value |
|---|---|
| Engine | PostgreSQL 17.6, 64-bit Windows build |
| Host and port | `127.0.0.1:5433` (local only; not reachable from the network) |
| Database name | `market_ai` |
| Database user | `market` (password in `.env`, never in this document) |
| Data directory | `C:\Jeevamani\bt-pgdata` |
| Binaries | `C:\Program Files\PostgreSQL\17\bin` (`psql.exe`, `pg_ctl.exe`, `pg_dump.exe`) |
| Size on disk | about 377 MB, most of it the instrument master and option-chain snapshots |
| Encoding and time zone | UTF-8; server time zone Asia/Calcutta (the app reads and writes UTC) |
| Schema version | 18 migrations applied, tracked in `schema_migrations` |
| Started by | `npm run restart` (`scripts/restart.mjs`), which starts the cluster with `pg_ctl` if it is not already running, then the API, worker and web server |
| Cache | in-memory substitute for Redis (`USE_IN_MEMORY_REDIS=true`); nothing cached survives a restart |

The application processes that use it, all on this machine:

| Process | Address | Purpose |
|---|---|---|
| API | `http://localhost:4000` (`/health` for status) | REST API and WebSocket tick feed; also serves the built frontend in production |
| Worker | no port | Scheduled jobs: paper and live sweeps, alerts, news, signal tracker, briefings |
| Web | `http://localhost:5173` | Vite dev server for the React frontend |
| Node.js | v22.12.0 | Runtime for all three |
| Logs | `logs/api.log`, `logs/worker.log`, `logs/web.log` | One file per process, JSON lines |

Connect and inspect:

```bash
# from the project root
psql "$(grep ^DATABASE_URL .env | cut -d= -f2-)"

# or directly
"C:\Program Files\PostgreSQL\17\bin\psql.exe" -h 127.0.0.1 -p 5433 -U market -d market_ai
```

### Connecting with pgAdmin (the "Let's connect to the server" dialog)

Fill the dialog exactly like this; leave every field not listed empty.

| Field in pgAdmin | What to enter |
|---|---|
| Existing Server (Optional) | leave empty the first time |
| Server Name | any label you like, for example `AdviSha local` |
| Host name/address | `127.0.0.1` |
| Port | `5433` |
| Database | `market_ai` |
| User | `market` |
| Password | the text between `market:` and `@` in the `DATABASE_URL` line of the project's `.env` file |
| Role | leave empty |
| Service | leave empty |
| Connection Parameters | nothing to add; SSL is not used on a local connection |

Then press **Connect & Open Query Tool**. The port is 5433, not PostgreSQL's usual
5432, because the cluster was created on a separate port; if the connection is
refused, the database is not running yet: run `npm run restart` from the project
root and try again. Any query from section 6 below can be pasted straight into
the Query Tool; replace `:'uid'` with your user id in quotes.

In production ([docs/DEPLOY-ORACLE.md](DEPLOY-ORACLE.md)) the same schema runs in the
official `postgres:17-alpine` container, reachable only from the other containers,
with a real Redis beside it.

---

## 1. Users and their settings

| Table | Purpose |
|---|---|
| **★ `users`** | One row per login. `id` (UUID) is the key every other user-owned table references. Columns: `email`, `password_hash` (bcrypt, never the password), `full_name`, `role`, `is_active`, `email_verified`, `last_login_at`, `created_at`, `updated_at`. |
| `user_settings` | One row per user: notional `capital`, `max_risk_per_trade_pct`, `max_daily_loss_pct`, `max_open_positions`, `default_timeframe`, `theme`, and the phone-alert preferences: `notify_browser / notify_email / notify_telegram / notify_whatsapp / notify_sms`, `telegram_chat_id`, `phone_e164`, `notify_kinds`, `notify_min_severity`, `telegram_link_code`. |
| `refresh_tokens` | Login sessions. Hashed refresh tokens with `family_id` for rotation, `user_agent`, `ip`, `expires_at`, `revoked_at`. Deleting a user's rows here logs them out everywhere. |
| `api_providers` | Broker and data-provider credentials per user (Angel One, Groww, Dhan, Kite), AES-256-GCM encrypted in `credentials_enc`. Also `is_enabled`, `priority`, `health_status`, `last_error`, `token_expires_at`. |
| `audit_logs` | Who did what: every money-moving or credential-changing API call with `action`, `resource`, `resource_id`, `ip`, `user_agent`, `metadata`. Append-only. |

---

## 2. Trading accounts and their trades (profit lives here)

### Paper trading

| Table | Purpose |
|---|---|
| `paper_trade_config` | One row per user: `is_enabled`, `capital`, `risk_per_trade_pct`, `max_open_positions`, `max_trades_per_day`, `max_daily_loss_pct`, `min_confirmation`, `underlyings`, `intraday_only`, `entry_cutoff_min`, `square_off_min`, `direction_guard`, `halted_reason`. |
| **★ `paper_trades`** | **Profit and history for paper trading.** One row per simulated position: `tradingsymbol`, `underlying`, `kind`, `quantity`, `lot_size`, `entry_price`, `entry_at`, `stop_price`, `target_price`, `underlying_stop`, `confirmation` (checklist score at entry), `rationale`, `evidence` (the full checklist, frozen), `status` OPEN/CLOSED, `exit_price`, `exit_at`, `exit_reason` (TARGET, STOP, EOD, THESIS, GIVEBACK, NEWS, MANUAL, EXPIRY), **`gross_pnl`, `costs`, `net_pnl`**, `max_favourable_premium`. |

### Live trading (real money)

| Table | Purpose |
|---|---|
| `live_trade_config` | One row per user: `mode` OFF/CONFIRM/AUTO, `armed_until`, `capital` (read from the broker when arming), risk and position caps, entry window, `square_off_min`, `product`, `horizon`, `direction_guard`, the Hero Zero settings (`hero_zero_*`), `kill_switch`, `halted_reason`, `last_sweep_result`. |
| **★ `live_trades`** | **Profit and history for real trades.** One row per order sent to the broker: contract, `strategy` CHECKLIST/HERO_ZERO, `mode`, `lots`, `quantity`, `entry_order_id`, `entry_limit`, `entry_price`, `grade`, `score`, the frozen plan (`stop_premium`, `target1_premium`, `target2_premium`, `underlying_stop`, `plan`), `remaining_qty`, `t1_done`, exit order fields, `exits` (every sell leg), `exit_code`, **`gross_pnl`, `costs`, `net_pnl`**, `closed_at`, `status` PENDING/OPEN/EXITING/CLOSED/FAILED, `broker_log` (every request and reply, verbatim). |

### F&O signal journal (the track record)

| Table | Purpose |
|---|---|
| **★ `fno_signals`** | **History of every call the engine issued**, whether or not anyone traded it. `underlying`, `expiry`, `strike`, `option_type`, `action`, `grade`, `score`, `horizon`, `timeframe`, the plan at issue, `origin` alert/paper/manual/live, `status` ACTIVE/TARGET1_HIT/TARGET2_HIT/STOPPED/INVALIDATED/EXPIRED/TIMED_OUT, `last_premium`, `max_favourable_premium`, `max_adverse_premium`, **`r_multiple`** (result in units of risk), `notes`, `generated_at`, `resolved_at`. The Track Record page is computed from this table. |

### Long-term portfolio (holdings you own)

| Table | Purpose |
|---|---|
| `portfolios` | Named portfolios per user. |
| `portfolio_holdings` | Current positions in each portfolio with average cost. |
| `transactions` | Every buy and sell: `side`, `quantity`, `price`, `amount`, `charges`, `traded_at`, `source`, `notes`. Realised profit comes from these. |
| `portfolio_snapshots` | **Daily history of each portfolio**: `snapshot_date`, `invested`, `market_value`, `realized_pnl`, `unrealized_pnl`, `day_pnl`, `cash_flow`, `holdings_count`. Written once an hour by the worker. |

---

## 3. Alerts, notifications and the agent

| Table | Purpose |
|---|---|
| `alerts` | Alert definitions per user: `kind` (PRICE_ABOVE, FNO_SETUP, NEWS_FNO, …), `params`, `timeframe`, `channels`, `is_active`, `cooldown_sec`. |
| `alert_events` | **History of every alert firing**: `triggered_at`, `observed` (the numbers that fired it), `source`, `data_as_of`, `delivered`. |
| `user_notifications` | The bell in the header, persisted: `kind` (alert, fno_entry, fno_exit, paper, paper_advice, live, system), `severity`, `title`, `message`, `payload`, `link`, `read_at`. Phone channels are sent from the same rows. |

---

## 4. Market data (shared, not per user)

| Table | Purpose |
|---|---|
| `instruments` | The instrument master: every stock, index, future and option contract with exchange, lot size, expiry, strike and per-provider tokens. About 350,000 rows; refreshed twice a day. |
| `candles` | OHLCV bars by instrument and timeframe, the store behind every chart and every indicator. |
| `ticks` | Last-traded ticks when stored. |
| `market_prices` | Latest quote per instrument. |
| `option_chain_snapshots` | Option chains as captured, for IV percentile and analytics. |
| `futures_snapshots` | Futures prices and open interest by expiry. |
| `market_breadth` | Advance/decline counts and sector aggregates over time. |
| `technical_indicators` | Cached indicator values. |
| `market_signals` | Rule-engine setups found by the scanner, with `rules_passed`, `scores`, `expires_at`. |
| `trade_ideas` | Scanner ideas derived from signals: entry zone, invalidation, targets, reasons. |
| `fundamentals`, `financial_results` | Company fundamentals and quarterly results where a provider supplies them. |
| `news_articles`, `news_entities` | Polled news and the instruments each article mentions, used by NEWS_FNO alerts and the news guard. |
| `trading_holidays` | NSE holiday calendar for the market clock. |
| `data_quality_events` | Every provider error, stale read or fallback, so a bad number can be traced to its source. |

---

## 5. Research and AI

| Table | Purpose |
|---|---|
| `backtests` | One row per backtest run with its parameters and summary statistics: `total_return_pct`, `max_drawdown_pct`, `win_rate`, `profit_factor`, `sharpe`, `equity_curve`. |
| `backtest_trades` | Every simulated trade of a backtest with `gross_pnl`, `charges`, `net_pnl`, `mae`, `mfe`. |
| `watchlists`, `watchlist_items` | User watchlists. |
| `ai_conversations`, `ai_messages` | The AI analyst chat, per user. |
| `analysis_logs` | What evidence each AI answer used and whether the validator passed it. |
| `schema_migrations` | Which migration files have been applied. Managed by `npm run migrate`. |

---

## 6. Useful queries

Profit and loss for one user, paper and live, by day (IST):

```sql
SELECT day, SUM(net) AS net_pnl, COUNT(*) AS trades
FROM (
  SELECT (exit_at AT TIME ZONE 'Asia/Kolkata')::date AS day, net_pnl AS net
    FROM paper_trades WHERE status = 'CLOSED' AND user_id = :'uid'
  UNION ALL
  SELECT (closed_at AT TIME ZONE 'Asia/Kolkata')::date, net_pnl
    FROM live_trades WHERE status = 'CLOSED' AND user_id = :'uid'
) t
GROUP BY day ORDER BY day DESC;
```

Trade history with the reason each one closed:

```sql
SELECT tradingsymbol, quantity, entry_price, exit_price, exit_reason, net_pnl,
       entry_at AT TIME ZONE 'Asia/Kolkata' AS entered,
       exit_at  AT TIME ZONE 'Asia/Kolkata' AS exited
FROM paper_trades
WHERE user_id = :'uid'
ORDER BY entry_at DESC;
```

Hit rate of the engine's calls by grade (what the Track Record page shows):

```sql
SELECT grade,
       COUNT(*) FILTER (WHERE status <> 'ACTIVE') AS resolved,
       COUNT(*) FILTER (WHERE r_multiple > 0) AS wins,
       ROUND(AVG(r_multiple) FILTER (WHERE status <> 'ACTIVE'), 2) AS avg_r
FROM fno_signals
WHERE user_id = :'uid'
GROUP BY grade ORDER BY grade;
```

Find your user id:

```sql
SELECT id, email, created_at FROM users;
```

---

## 7. Backup

The three tables that cannot be rebuilt from providers are `users`,
`api_providers` (encrypted broker credentials) and the trade tables
(`paper_trades`, `live_trades`, `fno_signals`, `transactions`). Back up the whole
database before any upgrade:

```bash
pg_dump "$(grep ^DATABASE_URL .env | cut -d= -f2-)" | gzip > backup-$(date +%F).sql.gz
```
