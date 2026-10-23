-- Paper trading as an intraday account: nothing is carried overnight.
--
-- Default ON. Everything still open at square_off_min is closed at the
-- market with exit_reason EOD, no new position is opened after
-- entry_cutoff_min, and a position found open from an earlier day is closed
-- on the first sweep that sees it. Minutes of day, IST.

ALTER TABLE paper_trade_config
  ADD COLUMN IF NOT EXISTS intraday_only    BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS entry_cutoff_min INT NOT NULL DEFAULT 870
    CHECK (entry_cutoff_min BETWEEN 555 AND 925),
  ADD COLUMN IF NOT EXISTS square_off_min   INT NOT NULL DEFAULT 915
    CHECK (square_off_min BETWEEN 600 AND 928);

COMMENT ON COLUMN paper_trade_config.intraday_only IS
  'TRUE: positions are squared off at square_off_min and never carried to the next session.';
