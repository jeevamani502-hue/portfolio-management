-- ════════════════════════════════════════════════════════════════════════════
-- 003 — Portfolios, holdings, transactions, snapshots, watchlists.
-- ════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS portfolios (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  currency      TEXT NOT NULL DEFAULT 'INR',
  broker        TEXT,                                -- set when imported
  is_default    BOOLEAN NOT NULL DEFAULT FALSE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, name)
);
CREATE INDEX IF NOT EXISTS idx_portfolios_user ON portfolios(user_id);

-- ── holdings: the current position, derived from transactions when present ──
CREATE TABLE IF NOT EXISTS portfolio_holdings (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  portfolio_id   UUID NOT NULL REFERENCES portfolios(id) ON DELETE CASCADE,
  instrument_id  BIGINT NOT NULL REFERENCES instruments(id) ON DELETE RESTRICT,
  quantity       NUMERIC(20,4) NOT NULL CHECK (quantity >= 0),
  avg_price      NUMERIC(18,4) NOT NULL CHECK (avg_price >= 0),
  realized_pnl   NUMERIC(20,2) NOT NULL DEFAULT 0,
  total_charges  NUMERIC(20,2) NOT NULL DEFAULT 0,
  first_bought_at TIMESTAMPTZ,
  notes          TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (portfolio_id, instrument_id)
);
CREATE INDEX IF NOT EXISTS idx_holdings_portfolio ON portfolio_holdings(portfolio_id);

-- ── transaction ledger (source of truth for XIRR + realized P&L) ───────────
CREATE TABLE IF NOT EXISTS transactions (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  portfolio_id   UUID NOT NULL REFERENCES portfolios(id) ON DELETE CASCADE,
  instrument_id  BIGINT REFERENCES instruments(id) ON DELETE RESTRICT,
  side           TEXT NOT NULL CHECK (side IN ('BUY','SELL','DIVIDEND','BONUS','SPLIT',
                                               'DEPOSIT','WITHDRAWAL','CHARGE')),
  quantity       NUMERIC(20,4) NOT NULL DEFAULT 0,
  price          NUMERIC(18,4) NOT NULL DEFAULT 0,
  amount         NUMERIC(20,2),          -- explicit for cash flows (dividend/deposit)
  charges        NUMERIC(20,2) NOT NULL DEFAULT 0,
  traded_at      TIMESTAMPTZ NOT NULL,
  external_id    TEXT,                   -- broker order/trade id, for idempotent import
  source         TEXT NOT NULL DEFAULT 'manual',
  notes          TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (portfolio_id, external_id)
);
CREATE INDEX IF NOT EXISTS idx_tx_portfolio ON transactions(portfolio_id, traded_at DESC);
CREATE INDEX IF NOT EXISTS idx_tx_instrument ON transactions(instrument_id, traded_at DESC);

-- ── daily valuation snapshots (drawdown, equity curve, XIRR checkpoints) ───
CREATE TABLE IF NOT EXISTS portfolio_snapshots (
  portfolio_id   UUID NOT NULL REFERENCES portfolios(id) ON DELETE CASCADE,
  snapshot_date  DATE NOT NULL,
  invested       NUMERIC(20,2) NOT NULL,
  market_value   NUMERIC(20,2) NOT NULL,
  realized_pnl   NUMERIC(20,2) NOT NULL DEFAULT 0,
  unrealized_pnl NUMERIC(20,2) NOT NULL DEFAULT 0,
  day_pnl        NUMERIC(20,2),
  cash_flow      NUMERIC(20,2) NOT NULL DEFAULT 0,
  holdings_count INTEGER NOT NULL DEFAULT 0,
  source         TEXT NOT NULL,
  as_of          TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (portfolio_id, snapshot_date)
);
CREATE INDEX IF NOT EXISTS idx_snapshots_date ON portfolio_snapshots(snapshot_date DESC);

-- ── watchlists ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS watchlists (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  is_default  BOOLEAN NOT NULL DEFAULT FALSE,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, name)
);

CREATE TABLE IF NOT EXISTS watchlist_items (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  watchlist_id   UUID NOT NULL REFERENCES watchlists(id) ON DELETE CASCADE,
  instrument_id  BIGINT NOT NULL REFERENCES instruments(id) ON DELETE CASCADE,
  sort_order     INTEGER NOT NULL DEFAULT 0,
  note           TEXT,
  added_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (watchlist_id, instrument_id)
);
CREATE INDEX IF NOT EXISTS idx_wl_items ON watchlist_items(watchlist_id, sort_order);

DROP TRIGGER IF EXISTS trg_portfolios_updated ON portfolios;
CREATE TRIGGER trg_portfolios_updated BEFORE UPDATE ON portfolios
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_holdings_updated ON portfolio_holdings;
CREATE TRIGGER trg_holdings_updated BEFORE UPDATE ON portfolio_holdings
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_watchlists_updated ON watchlists;
CREATE TRIGGER trg_watchlists_updated BEFORE UPDATE ON watchlists
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
