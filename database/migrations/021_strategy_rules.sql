-- Every entry and exit rule added on 19–22 Oct 2026 becomes a per-account
-- setting, for paper and live alike. Defaults are the values that were
-- hard-coded until now.

ALTER TABLE paper_trade_config
  ADD COLUMN IF NOT EXISTS entry_start_min          INT NOT NULL DEFAULT 585 CHECK (entry_start_min BETWEEN 555 AND 925),
  ADD COLUMN IF NOT EXISTS min_grade                TEXT NOT NULL DEFAULT 'B' CHECK (min_grade IN ('A','B','C')),
  ADD COLUMN IF NOT EXISTS require_timing_agreement BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS require_named_setup      BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS reentry_cooldown_min     INT NOT NULL DEFAULT 30 CHECK (reentry_cooldown_min BETWEEN 0 AND 240),
  ADD COLUMN IF NOT EXISTS cut_loser_at_r           NUMERIC(4,2) NOT NULL DEFAULT 0.5 CHECK (cut_loser_at_r >= 0 AND cut_loser_at_r <= 2),
  ADD COLUMN IF NOT EXISTS stop_atr_multiple        NUMERIC(4,2) NOT NULL DEFAULT 1.0 CHECK (stop_atr_multiple >= 0.5 AND stop_atr_multiple <= 3),
  ADD COLUMN IF NOT EXISTS target1_r                NUMERIC(4,2) NOT NULL DEFAULT 1.0 CHECK (target1_r >= 0.5 AND target1_r <= 5),
  ADD COLUMN IF NOT EXISTS target2_r                NUMERIC(4,2) NOT NULL DEFAULT 1.5 CHECK (target2_r >= 0.75 AND target2_r <= 10);

ALTER TABLE live_trade_config
  ADD COLUMN IF NOT EXISTS require_timing_agreement BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS require_named_setup      BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS reentry_cooldown_min     INT NOT NULL DEFAULT 30 CHECK (reentry_cooldown_min BETWEEN 0 AND 240),
  ADD COLUMN IF NOT EXISTS cut_loser_at_r           NUMERIC(4,2) NOT NULL DEFAULT 0.5 CHECK (cut_loser_at_r >= 0 AND cut_loser_at_r <= 2),
  ADD COLUMN IF NOT EXISTS stop_atr_multiple        NUMERIC(4,2) NOT NULL DEFAULT 1.0 CHECK (stop_atr_multiple >= 0.5 AND stop_atr_multiple <= 3),
  ADD COLUMN IF NOT EXISTS target1_r                NUMERIC(4,2) NOT NULL DEFAULT 1.0 CHECK (target1_r >= 0.5 AND target1_r <= 5),
  ADD COLUMN IF NOT EXISTS target2_r                NUMERIC(4,2) NOT NULL DEFAULT 1.5 CHECK (target2_r >= 0.75 AND target2_r <= 10);
