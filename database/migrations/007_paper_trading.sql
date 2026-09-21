-- Paper trading: a simulated ledger for testing strategies with no money.
--
-- Nothing here can reach a brokerage account. There is no order id from a
-- venue, no broker column, and no code path out of this schema to an
-- exchange. It exists to answer one question honestly — does the rule engine
-- make money — before that question is asked with real capital.

CREATE TABLE IF NOT EXISTS paper_trade_config (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,

  -- Off by default: a simulation still costs provider quota to run.
  is_enabled BOOLEAN NOT NULL DEFAULT FALSE,

  -- Notional capital the simulation is allowed to deploy. Stated, never
  -- inferred from a real account balance.
  capital NUMERIC(18,2) NOT NULL CHECK (capital > 0),
  risk_per_trade_pct NUMERIC(5,2) NOT NULL DEFAULT 1
    CHECK (risk_per_trade_pct > 0 AND risk_per_trade_pct <= 10),

  -- The same limits a live system would need. Simulating without them would
  -- produce results that say nothing about how the strategy behaves when it
  -- is actually constrained.
  max_open_positions INT NOT NULL DEFAULT 3 CHECK (max_open_positions BETWEEN 1 AND 20),
  max_trades_per_day INT NOT NULL DEFAULT 5 CHECK (max_trades_per_day BETWEEN 1 AND 50),
  max_daily_loss_pct NUMERIC(5,2) NOT NULL DEFAULT 3
    CHECK (max_daily_loss_pct > 0 AND max_daily_loss_pct <= 25),
  min_confirmation INT NOT NULL DEFAULT 60 CHECK (min_confirmation BETWEEN 0 AND 100),

  -- What the simulation may trade.
  underlyings TEXT[] NOT NULL DEFAULT ARRAY['NIFTY']::TEXT[],
  trade_options BOOLEAN NOT NULL DEFAULT TRUE,
  trade_equity BOOLEAN NOT NULL DEFAULT TRUE,

  -- Set when a limit trips. Non-null blocks new entries; exits always run,
  -- because an open position must remain closable.
  halted_reason TEXT,
  halted_at TIMESTAMPTZ,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS paper_trades (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  instrument_id BIGINT REFERENCES instruments(id),
  tradingsymbol TEXT NOT NULL,
  exchange TEXT NOT NULL,
  underlying TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('EQUITY', 'OPTION')),
  side TEXT NOT NULL CHECK (side IN ('BUY', 'SELL')),
  quantity INT NOT NULL CHECK (quantity > 0),
  lot_size INT,

  -- Entry. `entry_reference` is the untouched market price the fill was
  -- derived from, kept beside the filled price so the simulation's own
  -- slippage assumption stays auditable rather than baked in invisibly.
  entry_price NUMERIC(18,4) NOT NULL,
  entry_reference NUMERIC(18,4),
  entry_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- The plan, recorded at entry so it cannot be rewritten afterwards.
  stop_price NUMERIC(18,4),
  target_price NUMERIC(18,4),
  underlying_stop NUMERIC(18,4),
  confirmation INT,
  rationale TEXT,
  evidence JSONB,

  status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'CLOSED')),
  exit_price NUMERIC(18,4),
  exit_reference NUMERIC(18,4),
  exit_at TIMESTAMPTZ,
  exit_reason TEXT CHECK (
    exit_reason IS NULL OR exit_reason IN ('TARGET', 'STOP', 'EXPIRY', 'MANUAL', 'EOD')
  ),

  -- Gross of costs, and separately net, so the Indian cost stack is never
  -- silently omitted from a result that looks profitable without it.
  gross_pnl NUMERIC(18,2),
  costs NUMERIC(18,2),
  net_pnl NUMERIC(18,2),

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS paper_trades_open_idx
  ON paper_trades (user_id, status) WHERE status = 'OPEN';

CREATE INDEX IF NOT EXISTS paper_trades_user_time_idx
  ON paper_trades (user_id, entry_at DESC);
