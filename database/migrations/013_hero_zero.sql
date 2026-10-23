-- Hero Zero: the expiry-day lottery trade, kept as its own strategy with its
-- own budget, window and caps so it can never borrow the checklist engine's
-- sizing. The whole budget is expected to go to zero on most attempts; the
-- columns here exist so that amount is stated up front and capped per day.

ALTER TABLE live_trade_config
  ADD COLUMN IF NOT EXISTS hero_zero_enabled            BOOLEAN NOT NULL DEFAULT FALSE,
  -- Rupees of premium per attempt. Treated as fully at risk.
  ADD COLUMN IF NOT EXISTS hero_zero_budget             NUMERIC(18,2) NOT NULL DEFAULT 2000 CHECK (hero_zero_budget >= 500),
  ADD COLUMN IF NOT EXISTS hero_zero_min_premium        NUMERIC(10,2) NOT NULL DEFAULT 3 CHECK (hero_zero_min_premium >= 0.5),
  ADD COLUMN IF NOT EXISTS hero_zero_max_premium        NUMERIC(10,2) NOT NULL DEFAULT 25 CHECK (hero_zero_max_premium > 0),
  ADD COLUMN IF NOT EXISTS hero_zero_max_lots           INT NOT NULL DEFAULT 2 CHECK (hero_zero_max_lots BETWEEN 1 AND 20),
  ADD COLUMN IF NOT EXISTS hero_zero_max_trades_per_day INT NOT NULL DEFAULT 1 CHECK (hero_zero_max_trades_per_day BETWEEN 1 AND 5),
  -- IST minutes of day. Default 12:30 to 15:00, flat by 15:20.
  ADD COLUMN IF NOT EXISTS hero_zero_window_start_min   INT NOT NULL DEFAULT 750 CHECK (hero_zero_window_start_min BETWEEN 555 AND 925),
  ADD COLUMN IF NOT EXISTS hero_zero_window_end_min     INT NOT NULL DEFAULT 900 CHECK (hero_zero_window_end_min BETWEEN 555 AND 925),
  ADD COLUMN IF NOT EXISTS hero_zero_square_off_min     INT NOT NULL DEFAULT 920 CHECK (hero_zero_square_off_min BETWEEN 600 AND 928),
  -- 0 means ride it to zero; otherwise exit when the premium has fallen this much.
  ADD COLUMN IF NOT EXISTS hero_zero_stop_pct           NUMERIC(5,2) NOT NULL DEFAULT 50 CHECK (hero_zero_stop_pct >= 0 AND hero_zero_stop_pct <= 90),
  ADD COLUMN IF NOT EXISTS hero_zero_target_multiple    NUMERIC(5,2) NOT NULL DEFAULT 3 CHECK (hero_zero_target_multiple >= 1.5 AND hero_zero_target_multiple <= 10),
  -- How many of the momentum conditions must agree before an order goes out.
  ADD COLUMN IF NOT EXISTS hero_zero_min_agree          INT NOT NULL DEFAULT 5 CHECK (hero_zero_min_agree BETWEEN 3 AND 7);

ALTER TABLE live_trades
  ADD COLUMN IF NOT EXISTS strategy TEXT NOT NULL DEFAULT 'CHECKLIST'
    CHECK (strategy IN ('CHECKLIST','HERO_ZERO'));

CREATE INDEX IF NOT EXISTS idx_live_trades_strategy ON live_trades(user_id, strategy, created_at DESC);

COMMENT ON COLUMN live_trades.strategy IS
  'CHECKLIST: the 21-factor decision engine. HERO_ZERO: the expiry-day cheap-option momentum trade with its own budget and rules.';
