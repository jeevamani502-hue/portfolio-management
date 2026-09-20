-- ════════════════════════════════════════════════════════════════════════════
-- 002 — Instrument master, quotes, candles, indicators, fundamentals, F&O.
--       Every market-data table carries `source` + `as_of` so provenance
--       survives into storage (Architecture doc, section D).
-- ════════════════════════════════════════════════════════════════════════════

-- ── instrument master (NSE/BSE cash, F&O, indices, ETFs) ────────────────────
CREATE TABLE IF NOT EXISTS instruments (
  id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  exchange         TEXT NOT NULL CHECK (exchange IN ('NSE','BSE','NFO','BFO','MCX','CDS','INDICES')),
  tradingsymbol    TEXT NOT NULL,
  name             TEXT,
  isin             TEXT,
  segment          TEXT,                               -- NSE-EQ, NFO-OPT, INDICES ...
  instrument_type  TEXT NOT NULL DEFAULT 'EQ'
                     CHECK (instrument_type IN ('EQ','INDEX','FUT','CE','PE','ETF','MF')),
  -- derivatives
  underlying       TEXT,
  expiry           DATE,
  strike           NUMERIC(18,4),
  option_type      TEXT CHECK (option_type IN ('CE','PE')),
  lot_size         INTEGER NOT NULL DEFAULT 1 CHECK (lot_size > 0),
  tick_size        NUMERIC(10,4) NOT NULL DEFAULT 0.05,
  -- classification
  sector           TEXT,
  industry         TEXT,
  market_cap_class TEXT CHECK (market_cap_class IN ('LARGE','MID','SMALL','MICRO')),
  index_membership TEXT[] NOT NULL DEFAULT '{}',        -- {NIFTY50, BANKNIFTY, ...}
  -- per-provider instrument identifiers: {"dhan":"1333","kite":"738561"}
  provider_tokens  JSONB NOT NULL DEFAULT '{}',
  is_active        BOOLEAN NOT NULL DEFAULT TRUE,
  source           TEXT NOT NULL,
  as_of            TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (exchange, tradingsymbol)
);
CREATE INDEX IF NOT EXISTS idx_instruments_symbol   ON instruments(tradingsymbol);
CREATE INDEX IF NOT EXISTS idx_instruments_type     ON instruments(instrument_type, is_active);
CREATE INDEX IF NOT EXISTS idx_instruments_under    ON instruments(underlying, expiry, strike)
  WHERE instrument_type IN ('FUT','CE','PE');
CREATE INDEX IF NOT EXISTS idx_instruments_sector   ON instruments(sector) WHERE sector IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_instruments_tokens   ON instruments USING GIN (provider_tokens);
CREATE INDEX IF NOT EXISTS idx_instruments_index    ON instruments USING GIN (index_membership);
CREATE INDEX IF NOT EXISTS idx_instruments_search   ON instruments
  USING GIN (to_tsvector('simple', coalesce(tradingsymbol,'') || ' ' || coalesce(name,'')));

DROP TRIGGER IF EXISTS trg_instruments_updated ON instruments;
CREATE TRIGGER trg_instruments_updated BEFORE UPDATE ON instruments
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── latest quote per instrument (hot row, mirrored in Redis) ────────────────
CREATE TABLE IF NOT EXISTS market_prices (
  instrument_id   BIGINT PRIMARY KEY REFERENCES instruments(id) ON DELETE CASCADE,
  ltp             NUMERIC(18,4),
  prev_close      NUMERIC(18,4),
  open            NUMERIC(18,4),
  high            NUMERIC(18,4),
  low             NUMERIC(18,4),
  close           NUMERIC(18,4),
  volume          BIGINT,
  avg_price       NUMERIC(18,4),            -- VWAP as reported by the exchange/broker
  oi              BIGINT,
  oi_change       BIGINT,
  bid             NUMERIC(18,4),
  ask             NUMERIC(18,4),
  bid_qty         BIGINT,
  ask_qty         BIGINT,
  upper_circuit   NUMERIC(18,4),
  lower_circuit   NUMERIC(18,4),
  week52_high     NUMERIC(18,4),
  week52_low      NUMERIC(18,4),
  delivery_pct    NUMERIC(7,3),
  source          TEXT NOT NULL,
  as_of           TIMESTAMPTZ NOT NULL,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_market_prices_asof ON market_prices(as_of DESC);

-- ── candles (time-series; hypertable when TimescaleDB is present) ───────────
CREATE TABLE IF NOT EXISTS candles (
  instrument_id  BIGINT NOT NULL REFERENCES instruments(id) ON DELETE CASCADE,
  timeframe      TEXT   NOT NULL CHECK (timeframe IN ('1m','5m','15m','30m','1h','4h','1d','1w','1M')),
  ts             TIMESTAMPTZ NOT NULL,
  open           NUMERIC(18,4) NOT NULL,
  high           NUMERIC(18,4) NOT NULL,
  low            NUMERIC(18,4) NOT NULL,
  close          NUMERIC(18,4) NOT NULL,
  volume         BIGINT NOT NULL DEFAULT 0,
  oi             BIGINT,
  source         TEXT   NOT NULL,
  PRIMARY KEY (instrument_id, timeframe, ts)
);
CREATE INDEX IF NOT EXISTS idx_candles_lookup ON candles(instrument_id, timeframe, ts DESC);

DO $tsc$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'timescaledb') THEN
    PERFORM create_hypertable('candles', 'ts',
                              chunk_time_interval => INTERVAL '7 days',
                              if_not_exists => TRUE, migrate_data => TRUE);
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'candles hypertable skipped: %', SQLERRM;
END
$tsc$;

-- ── raw ticks (optional deep storage; heavy, retained short) ────────────────
CREATE TABLE IF NOT EXISTS ticks (
  instrument_id BIGINT NOT NULL REFERENCES instruments(id) ON DELETE CASCADE,
  ts            TIMESTAMPTZ NOT NULL,
  ltp           NUMERIC(18,4) NOT NULL,
  qty           BIGINT,
  volume        BIGINT,
  oi            BIGINT,
  source        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ticks_lookup ON ticks(instrument_id, ts DESC);

DO $tst$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'timescaledb') THEN
    PERFORM create_hypertable('ticks', 'ts',
                              chunk_time_interval => INTERVAL '1 day',
                              if_not_exists => TRUE, migrate_data => TRUE);
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'ticks hypertable skipped: %', SQLERRM;
END
$tst$;

-- ── computed indicator cache ────────────────────────────────────────────────
-- Stored so the scanner can sweep the universe without recomputing per request.
-- `inputs_hash` lets us invalidate when the candle series changes.
CREATE TABLE IF NOT EXISTS technical_indicators (
  instrument_id BIGINT NOT NULL REFERENCES instruments(id) ON DELETE CASCADE,
  timeframe     TEXT   NOT NULL,
  ts            TIMESTAMPTZ NOT NULL,          -- timestamp of the last candle used
  values        JSONB  NOT NULL,               -- { sma20, ema9, rsi14, macd:{...}, ... }
  inputs_hash   TEXT   NOT NULL,
  source        TEXT   NOT NULL DEFAULT 'computed',
  computed_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (instrument_id, timeframe)
);
CREATE INDEX IF NOT EXISTS idx_indicators_ts ON technical_indicators(timeframe, ts DESC);

-- ── fundamentals (latest snapshot per instrument) ───────────────────────────
CREATE TABLE IF NOT EXISTS fundamentals (
  instrument_id     BIGINT PRIMARY KEY REFERENCES instruments(id) ON DELETE CASCADE,
  market_cap        NUMERIC(20,2),
  revenue_ttm       NUMERIC(20,2),
  revenue_growth_yoy NUMERIC(10,4),
  ebitda_ttm        NUMERIC(20,2),
  ebitda_margin     NUMERIC(10,4),
  net_profit_ttm    NUMERIC(20,2),
  profit_growth_yoy NUMERIC(10,4),
  eps_ttm           NUMERIC(14,4),
  eps_growth_yoy    NUMERIC(10,4),
  pe                NUMERIC(12,4),
  pb                NUMERIC(12,4),
  roe               NUMERIC(10,4),
  roce              NUMERIC(10,4),
  debt_to_equity    NUMERIC(12,4),
  free_cash_flow    NUMERIC(20,2),
  operating_cf      NUMERIC(20,2),
  dividend_yield    NUMERIC(10,4),
  book_value        NUMERIC(14,4),
  face_value        NUMERIC(10,2),
  promoter_holding  NUMERIC(8,4),
  fii_holding       NUMERIC(8,4),
  dii_holding       NUMERIC(8,4),
  public_holding    NUMERIC(8,4),
  pledged_pct       NUMERIC(8,4),
  fiscal_period     TEXT,
  raw               JSONB NOT NULL DEFAULT '{}',   -- untouched provider payload
  source            TEXT NOT NULL,
  as_of             TIMESTAMPTZ NOT NULL,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── reported results (quarterly + annual) ───────────────────────────────────
CREATE TABLE IF NOT EXISTS financial_results (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  instrument_id  BIGINT NOT NULL REFERENCES instruments(id) ON DELETE CASCADE,
  period_type    TEXT NOT NULL CHECK (period_type IN ('Q','A')),
  period_end     DATE NOT NULL,
  revenue        NUMERIC(20,2),
  expenses       NUMERIC(20,2),
  ebitda         NUMERIC(20,2),
  depreciation   NUMERIC(20,2),
  interest       NUMERIC(20,2),
  pbt            NUMERIC(20,2),
  tax            NUMERIC(20,2),
  net_profit     NUMERIC(20,2),
  eps            NUMERIC(14,4),
  raw            JSONB NOT NULL DEFAULT '{}',
  source         TEXT NOT NULL,
  as_of          TIMESTAMPTZ NOT NULL,
  UNIQUE (instrument_id, period_type, period_end)
);
CREATE INDEX IF NOT EXISTS idx_results_lookup ON financial_results(instrument_id, period_type, period_end DESC);

-- ── option chain snapshots ──────────────────────────────────────────────────
-- `strikes` holds the full normalized chain for the capture instant so that
-- analytics (PCR, max pain, OI shifts) are reproducible from stored evidence.
CREATE TABLE IF NOT EXISTS option_chain_snapshots (
  id             BIGINT GENERATED ALWAYS AS IDENTITY,
  underlying_id  BIGINT NOT NULL REFERENCES instruments(id) ON DELETE CASCADE,
  expiry         DATE NOT NULL,
  captured_at    TIMESTAMPTZ NOT NULL,
  spot           NUMERIC(18,4),
  atm_strike     NUMERIC(18,4),
  total_ce_oi    BIGINT,
  total_pe_oi    BIGINT,
  pcr_oi         NUMERIC(12,4),
  pcr_volume     NUMERIC(12,4),
  max_pain       NUMERIC(18,4),
  strikes        JSONB NOT NULL,
  source         TEXT NOT NULL,
  PRIMARY KEY (id, captured_at)
);
CREATE INDEX IF NOT EXISTS idx_chain_lookup ON option_chain_snapshots(underlying_id, expiry, captured_at DESC);

DO $tso$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'timescaledb') THEN
    PERFORM create_hypertable('option_chain_snapshots', 'captured_at',
                              chunk_time_interval => INTERVAL '7 days',
                              if_not_exists => TRUE, migrate_data => TRUE);
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'option_chain hypertable skipped: %', SQLERRM;
END
$tso$;

-- ── futures snapshots (for OI buildup interpretation) ───────────────────────
CREATE TABLE IF NOT EXISTS futures_snapshots (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  instrument_id  BIGINT NOT NULL REFERENCES instruments(id) ON DELETE CASCADE,
  captured_at    TIMESTAMPTZ NOT NULL,
  ltp            NUMERIC(18,4),
  price_change   NUMERIC(18,4),
  oi             BIGINT,
  oi_change      BIGINT,
  volume         BIGINT,
  basis          NUMERIC(18,4),                -- futures − spot
  rollover_pct   NUMERIC(10,4),
  buildup        TEXT CHECK (buildup IN ('LONG_BUILDUP','SHORT_BUILDUP',
                                         'SHORT_COVERING','LONG_UNWINDING','INDETERMINATE')),
  source         TEXT NOT NULL,
  UNIQUE (instrument_id, captured_at)
);
CREATE INDEX IF NOT EXISTS idx_futures_lookup ON futures_snapshots(instrument_id, captured_at DESC);

-- ── index / breadth snapshots ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS market_breadth (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  scope        TEXT NOT NULL DEFAULT 'NSE',      -- NSE | NIFTY50 | BANKNIFTY | sector
  captured_at  TIMESTAMPTZ NOT NULL,
  advances     INTEGER NOT NULL,
  declines     INTEGER NOT NULL,
  unchanged    INTEGER NOT NULL,
  new_52w_high INTEGER,
  new_52w_low  INTEGER,
  above_sma50  INTEGER,
  above_sma200 INTEGER,
  total_scanned INTEGER NOT NULL,
  source       TEXT NOT NULL,
  UNIQUE (scope, captured_at)
);
CREATE INDEX IF NOT EXISTS idx_breadth_lookup ON market_breadth(scope, captured_at DESC);

-- ── data-quality ledger (Architecture doc, section J.6) ─────────────────────
CREATE TABLE IF NOT EXISTS data_quality_events (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kind         TEXT NOT NULL CHECK (kind IN ('stale_read','provider_error','sanity_reject',
                                             'missing_capability','rate_limited','fallback_used')),
  provider     TEXT,
  capability   TEXT,
  symbol       TEXT,
  detail       JSONB NOT NULL DEFAULT '{}',
  occurred_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_dq_recent ON data_quality_events(occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_dq_kind   ON data_quality_events(kind, occurred_at DESC);

-- ── trading holidays (drives the market-hours state machine) ────────────────
CREATE TABLE IF NOT EXISTS trading_holidays (
  holiday_date DATE PRIMARY KEY,
  exchange     TEXT NOT NULL DEFAULT 'NSE',
  description  TEXT,
  source       TEXT NOT NULL
);
