-- Live trading: real orders routed to the user's broker from the F&O decision
-- engine's plans.
--
-- Everything that governs whether money moves is a column here, set by the
-- user and read by the guards before every order. Arming expires at the end
-- of the session on purpose: live trading is a decision made each morning,
-- not a switch left on.

CREATE TABLE IF NOT EXISTS live_trade_config (
  user_id             UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  mode                TEXT NOT NULL DEFAULT 'OFF' CHECK (mode IN ('OFF','CONFIRM','AUTO')),
  armed_until         TIMESTAMPTZ,
  -- Stated when arming, never read from the broker.
  capital             NUMERIC(18,2) CHECK (capital IS NULL OR capital > 0),
  risk_per_trade_pct  NUMERIC(5,2) NOT NULL DEFAULT 1 CHECK (risk_per_trade_pct > 0 AND risk_per_trade_pct <= 10),
  max_open_positions  INT NOT NULL DEFAULT 1 CHECK (max_open_positions BETWEEN 1 AND 10),
  max_lots_per_trade  INT NOT NULL DEFAULT 1 CHECK (max_lots_per_trade BETWEEN 1 AND 50),
  max_trades_per_day  INT NOT NULL DEFAULT 3 CHECK (max_trades_per_day BETWEEN 1 AND 20),
  max_daily_loss_pct  NUMERIC(5,2) NOT NULL DEFAULT 2 CHECK (max_daily_loss_pct > 0 AND max_daily_loss_pct <= 25),
  underlyings         TEXT[] NOT NULL DEFAULT ARRAY['NIFTY']::TEXT[],
  min_grade           TEXT NOT NULL DEFAULT 'B' CHECK (min_grade IN ('A','B','C')),
  allow_expiry_day    BOOLEAN NOT NULL DEFAULT FALSE,
  -- IST minutes of day.
  window_start_min    INT NOT NULL DEFAULT 570 CHECK (window_start_min BETWEEN 555 AND 930),
  window_end_min      INT NOT NULL DEFAULT 900 CHECK (window_end_min BETWEEN 555 AND 930),
  square_off_min      INT NOT NULL DEFAULT 915 CHECK (square_off_min BETWEEN 600 AND 925),
  product             TEXT NOT NULL DEFAULT 'INTRADAY' CHECK (product IN ('INTRADAY','CARRYFORWARD')),
  scale_out           BOOLEAN NOT NULL DEFAULT TRUE,
  entry_timeout_sec   INT NOT NULL DEFAULT 90 CHECK (entry_timeout_sec BETWEEN 15 AND 600),
  kill_switch         BOOLEAN NOT NULL DEFAULT FALSE,
  halted_reason       TEXT,
  halted_at           TIMESTAMPTZ,
  last_sweep_at       TIMESTAMPTZ,
  last_sweep_result   JSONB,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS live_trades (
  id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id          UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  signal_id        BIGINT REFERENCES fno_signals(id) ON DELETE SET NULL,
  mode             TEXT NOT NULL CHECK (mode IN ('CONFIRM','AUTO')),
  broker           TEXT NOT NULL,

  instrument_id    BIGINT REFERENCES instruments(id),
  tradingsymbol    TEXT NOT NULL,
  exchange         TEXT NOT NULL,
  underlying       TEXT NOT NULL,
  expiry           DATE NOT NULL,
  strike           NUMERIC(18,4) NOT NULL,
  option_type      TEXT NOT NULL CHECK (option_type IN ('CE','PE')),
  action           TEXT NOT NULL CHECK (action IN ('BUY_CALL','BUY_PUT')),
  product          TEXT NOT NULL CHECK (product IN ('INTRADAY','CARRYFORWARD')),
  lot_size         INT NOT NULL,
  lots             INT NOT NULL,
  quantity         INT NOT NULL,

  -- Entry: the limit sent, what the broker filled, and when.
  entry_order_id       TEXT,
  entry_order_status   TEXT NOT NULL DEFAULT 'PENDING',
  entry_limit          NUMERIC(18,4),
  entry_price          NUMERIC(18,4),
  entry_filled_qty     INT NOT NULL DEFAULT 0,
  entry_placed_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  entry_at             TIMESTAMPTZ,

  -- The plan at issue, frozen.
  grade            TEXT NOT NULL,
  score            INT NOT NULL,
  stop_premium        NUMERIC(18,4) NOT NULL,
  target1_premium     NUMERIC(18,4) NOT NULL,
  target2_premium     NUMERIC(18,4) NOT NULL,
  underlying_stop     NUMERIC(18,4) NOT NULL,
  underlying_target1  NUMERIC(18,4) NOT NULL,
  underlying_target2  NUMERIC(18,4) NOT NULL,
  plan             JSONB NOT NULL,
  scale_out        BOOLEAN NOT NULL DEFAULT TRUE,

  -- Position state.
  remaining_qty    INT NOT NULL DEFAULT 0,
  t1_done          BOOLEAN NOT NULL DEFAULT FALSE,
  exit_order_id    TEXT,
  exit_order_status TEXT,
  exit_order_qty   INT,
  exit_kind        TEXT CHECK (exit_kind IS NULL OR exit_kind IN ('PARTIAL','FULL')),
  exit_code        TEXT,
  exit_placed_at   TIMESTAMPTZ,
  exits            JSONB NOT NULL DEFAULT '[]',   -- [{qty, price, at, code, reason}]
  last_premium     NUMERIC(18,4),
  max_favourable_premium NUMERIC(18,4),
  max_adverse_premium    NUMERIC(18,4),

  -- Result, net of the Indian cost stack, written when flat.
  gross_pnl        NUMERIC(18,2),
  costs            NUMERIC(18,2),
  net_pnl          NUMERIC(18,2),
  closed_at        TIMESTAMPTZ,

  status           TEXT NOT NULL DEFAULT 'PENDING'
                     CHECK (status IN ('PENDING','OPEN','EXITING','CLOSED','FAILED')),
  failure_reason   TEXT,
  -- Every request sent to the broker and every reply, verbatim.
  broker_log       JSONB NOT NULL DEFAULT '[]',
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_live_trades_user ON live_trades(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_live_trades_active ON live_trades(user_id, status)
  WHERE status IN ('PENDING','OPEN','EXITING');

COMMENT ON TABLE live_trades IS
  'Real option orders routed to the broker from the decision engine, with the plan frozen at entry and every broker exchange logged.';

-- Live orders are journaled like any other signal, and notified under their own kind.
ALTER TABLE fno_signals DROP CONSTRAINT IF EXISTS fno_signals_origin_check;
ALTER TABLE fno_signals ADD CONSTRAINT fno_signals_origin_check
  CHECK (origin IN ('alert','paper','manual','live'));

ALTER TABLE user_notifications DROP CONSTRAINT IF EXISTS user_notifications_kind_check;
ALTER TABLE user_notifications ADD CONSTRAINT user_notifications_kind_check
  CHECK (kind IN ('alert','fno_entry','fno_exit','paper_advice','live','system'));
