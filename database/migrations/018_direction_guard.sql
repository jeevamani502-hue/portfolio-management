-- Direction guard: positions are closed by the engine when the chart turns
-- against them, in paper, live and the F&O signal journal alike.
--
-- direction_guard: on by default; the user can switch it off per account.
-- paper_trades.max_favourable_premium: best premium seen, so the breakeven
-- and give-back rules can be applied to paper exactly as to live.

ALTER TABLE paper_trade_config ADD COLUMN IF NOT EXISTS direction_guard BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE live_trade_config  ADD COLUMN IF NOT EXISTS direction_guard BOOLEAN NOT NULL DEFAULT TRUE;

ALTER TABLE paper_trades ADD COLUMN IF NOT EXISTS max_favourable_premium NUMERIC(18,4);

ALTER TABLE paper_trades DROP CONSTRAINT IF EXISTS paper_trades_exit_reason_check;
ALTER TABLE paper_trades ADD CONSTRAINT paper_trades_exit_reason_check CHECK (
  exit_reason IS NULL OR exit_reason IN ('TARGET', 'STOP', 'EXPIRY', 'MANUAL', 'EOD', 'NEWS', 'THESIS', 'GIVEBACK')
);
