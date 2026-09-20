-- ════════════════════════════════════════════════════════════════════════════
-- 004 — Signals, trade ideas, news, alerts, backtests, AI logs.
--       Note the NOT NULL constraints on trade_ideas: an idea is structurally
--       incapable of existing without an invalidation level, risk factors and
--       a data timestamp (Architecture doc, section J.3).
-- ════════════════════════════════════════════════════════════════════════════

-- ── rule-based signals emitted by the scanner sweep ────────────────────────
CREATE TABLE IF NOT EXISTS market_signals (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  instrument_id  BIGINT NOT NULL REFERENCES instruments(id) ON DELETE CASCADE,
  timeframe      TEXT NOT NULL,
  setup          TEXT NOT NULL CHECK (setup IN ('BREAKOUT','PULLBACK','MOMENTUM','REVERSAL',
                                                'BREAKDOWN','RANGE','FNO_LONG_BUILDUP',
                                                'FNO_SHORT_BUILDUP','FNO_SHORT_COVERING',
                                                'FNO_LONG_UNWINDING')),
  direction      TEXT NOT NULL CHECK (direction IN ('BULLISH','BEARISH','NEUTRAL')),
  -- confirmation strength: how many of the setup's rules fired, weighted
  strength       NUMERIC(6,2) NOT NULL CHECK (strength >= 0 AND strength <= 100),
  rules_passed   JSONB NOT NULL,            -- [{id,label,passed,detail,weight}]
  scores         JSONB NOT NULL DEFAULT '{}', -- {trend,momentum,volume,volatility,structure}
  reference_price NUMERIC(18,4) NOT NULL,
  source         TEXT NOT NULL,
  data_as_of     TIMESTAMPTZ NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at     TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_signals_recent ON market_signals(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_signals_setup  ON market_signals(setup, direction, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_signals_instr  ON market_signals(instrument_id, created_at DESC);

-- ── trade ideas (research output, never a "call") ──────────────────────────
CREATE TABLE IF NOT EXISTS trade_ideas (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  signal_id         BIGINT REFERENCES market_signals(id) ON DELETE SET NULL,
  instrument_id     BIGINT NOT NULL REFERENCES instruments(id) ON DELETE CASCADE,
  direction         TEXT NOT NULL CHECK (direction IN ('BULLISH','BEARISH')),
  setup             TEXT NOT NULL,
  timeframe         TEXT NOT NULL,
  entry_low         NUMERIC(18,4) NOT NULL,
  entry_high        NUMERIC(18,4) NOT NULL,
  invalidation      NUMERIC(18,4) NOT NULL,            -- MANDATORY
  target1           NUMERIC(18,4) NOT NULL,
  target2           NUMERIC(18,4),
  risk_reward       NUMERIC(10,3) NOT NULL,
  confidence        NUMERIC(6,2) NOT NULL              -- MANDATORY, = rule strength
                      CHECK (confidence >= 0 AND confidence <= 100),
  technical_reasons TEXT[] NOT NULL DEFAULT '{}',
  fno_reasons       TEXT[] NOT NULL DEFAULT '{}',
  market_context    TEXT,
  news_context      TEXT,
  risk_factors      TEXT[] NOT NULL,                   -- MANDATORY, non-empty enforced in code
  data_sources      JSONB NOT NULL DEFAULT '[]',
  data_as_of        TIMESTAMPTZ NOT NULL,              -- MANDATORY
  generated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  status            TEXT NOT NULL DEFAULT 'ACTIVE'
                      CHECK (status IN ('ACTIVE','INVALIDATED','TARGET_HIT','EXPIRED')),
  CHECK (entry_high >= entry_low),
  CHECK (cardinality(risk_factors) > 0)
);
CREATE INDEX IF NOT EXISTS idx_ideas_active ON trade_ideas(status, generated_at DESC);
CREATE INDEX IF NOT EXISTS idx_ideas_instr  ON trade_ideas(instrument_id, generated_at DESC);

-- ── news ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS news_articles (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  headline       TEXT NOT NULL,
  summary        TEXT,
  url            TEXT NOT NULL,
  url_hash       TEXT NOT NULL UNIQUE,        -- dedupe across providers
  publisher      TEXT NOT NULL,
  author         TEXT,
  category       TEXT,                        -- markets | corporate | macro | announcement
  published_at   TIMESTAMPTZ NOT NULL,
  -- transparent lexicon classifier output; the LLM may refine but never replaces
  sentiment      TEXT CHECK (sentiment IN ('POSITIVE','NEUTRAL','NEGATIVE')),
  sentiment_score NUMERIC(6,3),               -- -1 .. +1
  sentiment_confidence NUMERIC(5,3),          -- 0 .. 1
  sentiment_method TEXT,                      -- 'lexicon-v1' | 'provider' | 'llm-refined'
  source         TEXT NOT NULL,
  ingested_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_news_time ON news_articles(published_at DESC);
CREATE INDEX IF NOT EXISTS idx_news_sent ON news_articles(sentiment, published_at DESC);

CREATE TABLE IF NOT EXISTS news_entities (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  article_id     UUID NOT NULL REFERENCES news_articles(id) ON DELETE CASCADE,
  instrument_id  BIGINT REFERENCES instruments(id) ON DELETE CASCADE,
  sector         TEXT,
  -- how confident the entity mapper is that the article concerns this instrument
  relevance      NUMERIC(5,3) NOT NULL CHECK (relevance >= 0 AND relevance <= 1),
  match_reason   TEXT NOT NULL,               -- 'exact_symbol' | 'company_name' | 'alias' | 'sector'
  UNIQUE (article_id, instrument_id)
);
CREATE INDEX IF NOT EXISTS idx_news_ent_instr ON news_entities(instrument_id);

-- ── alerts ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS alerts (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  instrument_id  BIGINT REFERENCES instruments(id) ON DELETE CASCADE,
  name           TEXT,
  kind           TEXT NOT NULL CHECK (kind IN ('PRICE_ABOVE','PRICE_BELOW','PCT_CHANGE',
                                               'RSI_ABOVE','RSI_BELOW','VOLUME_MULTIPLE',
                                               'BREAKOUT','SUPPORT_BROKEN','OI_CHANGE_PCT',
                                               'NEWS','SIGNAL')),
  params         JSONB NOT NULL DEFAULT '{}',   -- {threshold, timeframe, lookback, ...}
  timeframe      TEXT NOT NULL DEFAULT '1d',
  channels       TEXT[] NOT NULL DEFAULT '{browser}',
  is_active      BOOLEAN NOT NULL DEFAULT TRUE,
  repeat_mode    TEXT NOT NULL DEFAULT 'ONCE' CHECK (repeat_mode IN ('ONCE','DAILY','ALWAYS')),
  cooldown_sec   INTEGER NOT NULL DEFAULT 300,
  last_fired_at  TIMESTAMPTZ,
  fire_count     INTEGER NOT NULL DEFAULT 0,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_alerts_active ON alerts(is_active, instrument_id);
CREATE INDEX IF NOT EXISTS idx_alerts_user   ON alerts(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS alert_events (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  alert_id      UUID NOT NULL REFERENCES alerts(id) ON DELETE CASCADE,
  triggered_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  observed      JSONB NOT NULL,               -- the exact values that satisfied the rule
  source        TEXT NOT NULL,
  data_as_of    TIMESTAMPTZ NOT NULL,
  delivered     JSONB NOT NULL DEFAULT '{}'   -- {browser:true, email:false, ...}
);
CREATE INDEX IF NOT EXISTS idx_alert_events ON alert_events(alert_id, triggered_at DESC);

-- ── backtests ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS backtests (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  strategy        TEXT NOT NULL,
  universe        TEXT[] NOT NULL DEFAULT '{}',
  timeframe       TEXT NOT NULL,
  from_date       DATE NOT NULL,
  to_date         DATE NOT NULL,
  params          JSONB NOT NULL DEFAULT '{}',
  costs           JSONB NOT NULL DEFAULT '{}',  -- brokerage, STT, exchange, GST, stamp, slippage
  status          TEXT NOT NULL DEFAULT 'QUEUED'
                    CHECK (status IN ('QUEUED','RUNNING','DONE','FAILED')),
  error           TEXT,
  -- results
  initial_capital NUMERIC(20,2) NOT NULL,
  final_capital   NUMERIC(20,2),
  total_return_pct NUMERIC(12,4),
  cagr            NUMERIC(12,4),
  max_drawdown_pct NUMERIC(12,4),
  win_rate        NUMERIC(8,4),
  avg_win         NUMERIC(20,2),
  avg_loss        NUMERIC(20,2),
  profit_factor   NUMERIC(12,4),
  sharpe          NUMERIC(12,4),
  trade_count     INTEGER,
  equity_curve    JSONB,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at    TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_backtests_user ON backtests(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS backtest_trades (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  backtest_id    UUID NOT NULL REFERENCES backtests(id) ON DELETE CASCADE,
  instrument_id  BIGINT REFERENCES instruments(id) ON DELETE SET NULL,
  symbol         TEXT NOT NULL,
  direction      TEXT NOT NULL CHECK (direction IN ('LONG','SHORT')),
  entry_at       TIMESTAMPTZ NOT NULL,
  entry_price    NUMERIC(18,4) NOT NULL,
  exit_at        TIMESTAMPTZ,
  exit_price     NUMERIC(18,4),
  quantity       NUMERIC(20,4) NOT NULL,
  gross_pnl      NUMERIC(20,2),
  charges        NUMERIC(20,2) NOT NULL DEFAULT 0,
  net_pnl        NUMERIC(20,2),
  exit_reason    TEXT,
  mae            NUMERIC(20,2),               -- max adverse excursion
  mfe            NUMERIC(20,2)                -- max favourable excursion
);
CREATE INDEX IF NOT EXISTS idx_bt_trades ON backtest_trades(backtest_id, entry_at);

-- ── AI conversations + evidence audit ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS ai_conversations (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title       TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ai_messages (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES ai_conversations(id) ON DELETE CASCADE,
  role            TEXT NOT NULL CHECK (role IN ('user','assistant','system')),
  content         TEXT NOT NULL,
  intent          TEXT,
  model           TEXT,
  tokens_in       INTEGER,
  tokens_out      INTEGER,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ai_msgs ON ai_messages(conversation_id, created_at);

-- Every AI answer stores the exact evidence bundle it was given and the result
-- of the numeric-citation validator, so any answer can be audited after the fact.
CREATE TABLE IF NOT EXISTS analysis_logs (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id        UUID REFERENCES ai_messages(id) ON DELETE CASCADE,
  user_id           UUID REFERENCES users(id) ON DELETE SET NULL,
  question          TEXT NOT NULL,
  intent            TEXT NOT NULL,
  evidence          JSONB NOT NULL,          -- the facts[] handed to the model
  missing_facts     TEXT[] NOT NULL DEFAULT '{}',
  validator_passed  BOOLEAN NOT NULL,
  validator_detail  JSONB NOT NULL DEFAULT '{}',
  regenerated       BOOLEAN NOT NULL DEFAULT FALSE,
  degraded_to_template BOOLEAN NOT NULL DEFAULT FALSE,
  latency_ms        INTEGER,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_analysis_logs ON analysis_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_analysis_failed ON analysis_logs(validator_passed, created_at DESC);

DROP TRIGGER IF EXISTS trg_alerts_updated ON alerts;
CREATE TRIGGER trg_alerts_updated BEFORE UPDATE ON alerts
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_ai_conv_updated ON ai_conversations;
CREATE TRIGGER trg_ai_conv_updated BEFORE UPDATE ON ai_conversations
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
