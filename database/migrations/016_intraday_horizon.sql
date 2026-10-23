-- The holding horizon, everywhere a decision is made or recorded.
--
-- live_trade_config.horizon: 'intraday' (hourly bias, 15-minute timing,
-- current week's expiry allowed, flat by the square-off) or 'swing' (daily
-- bias, two or more days to expiry). Intraday by default, matching paper.
--
-- fno_signals.horizon: how the journaled signal was meant to be held, so
-- the tracker times an intraday signal out at the close of its own day
-- rather than three days later, and the track record stays honest.

ALTER TABLE live_trade_config
  ADD COLUMN IF NOT EXISTS horizon TEXT NOT NULL DEFAULT 'intraday'
    CHECK (horizon IN ('intraday','swing'));

ALTER TABLE fno_signals
  ADD COLUMN IF NOT EXISTS horizon TEXT NOT NULL DEFAULT 'swing'
    CHECK (horizon IN ('intraday','swing'));
