-- News guard: open positions re-checked against the chart when relevant news
-- lands on their underlying. Needs a timestamp per position so each article
-- triggers one look, and an exit reason that says a news-triggered re-check
-- closed the position (the chart decided; the news only prompted the look).

ALTER TABLE paper_trades ADD COLUMN IF NOT EXISTS news_checked_at TIMESTAMPTZ;
ALTER TABLE live_trades  ADD COLUMN IF NOT EXISTS news_checked_at TIMESTAMPTZ;
ALTER TABLE fno_signals  ADD COLUMN IF NOT EXISTS news_checked_at TIMESTAMPTZ;

ALTER TABLE paper_trades DROP CONSTRAINT IF EXISTS paper_trades_exit_reason_check;
ALTER TABLE paper_trades ADD CONSTRAINT paper_trades_exit_reason_check CHECK (
  exit_reason IS NULL OR exit_reason IN ('TARGET', 'STOP', 'EXPIRY', 'MANUAL', 'EOD', 'NEWS')
);
