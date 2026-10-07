-- F&O signal journal and a persisted notification feed.
--
-- fno_signals records every graded option trade the decision engine issues,
-- and what happened to it afterwards. It exists because "how often does this
-- work" is a question that has to be answered from records, not asserted:
-- the hit rate by grade shown in the UI is computed from these rows and
-- nothing else.
--
-- user_notifications is the feed behind the bell in the header. Alerts used
-- to be pushed over the websocket only, which meant an alert that fired while
-- the browser was closed was never seen at all. Every alert, signal exit and
-- position advice now lands here first and is pushed second.

CREATE TABLE IF NOT EXISTS fno_signals (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  underlying      TEXT NOT NULL,
  expiry          DATE NOT NULL,
  strike          NUMERIC(18,4) NOT NULL,
  option_type     TEXT NOT NULL CHECK (option_type IN ('CE','PE')),
  instrument_id   BIGINT REFERENCES instruments(id),
  tradingsymbol   TEXT,

  action          TEXT NOT NULL CHECK (action IN ('BUY_CALL','BUY_PUT')),
  grade           TEXT NOT NULL CHECK (grade IN ('A','B','C')),
  -- Weighted share of readable checklist conditions that agreed, 0-100.
  -- A count of agreeing conditions, never a probability.
  score           INT NOT NULL CHECK (score BETWEEN 0 AND 100),
  timeframe       TEXT NOT NULL DEFAULT '1d',

  -- The plan, recorded at issue so it cannot be rewritten afterwards.
  spot                NUMERIC(18,4) NOT NULL,
  entry_premium       NUMERIC(18,4) NOT NULL,
  stop_premium        NUMERIC(18,4) NOT NULL,
  target1_premium     NUMERIC(18,4) NOT NULL,
  target2_premium     NUMERIC(18,4),
  underlying_stop     NUMERIC(18,4) NOT NULL,
  underlying_target1  NUMERIC(18,4) NOT NULL,
  underlying_target2  NUMERIC(18,4),
  factors         JSONB NOT NULL,
  plan            JSONB NOT NULL,

  source          TEXT NOT NULL,
  data_as_of      TIMESTAMPTZ NOT NULL,
  generated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  origin          TEXT NOT NULL DEFAULT 'alert'
                    CHECK (origin IN ('alert','paper','manual')),

  status          TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN (
                    'ACTIVE','TARGET1_HIT','TARGET2_HIT','STOPPED',
                    'INVALIDATED','EXPIRED','TIMED_OUT')),
  -- Excursions, so a resolved signal also shows how far it went either way.
  max_favourable_premium NUMERIC(18,4),
  max_adverse_premium    NUMERIC(18,4),
  last_premium    NUMERIC(18,4),
  last_checked_at TIMESTAMPTZ,
  resolved_at     TIMESTAMPTZ,
  resolved_premium NUMERIC(18,4),
  -- Result in multiples of the premium risked to the stop.
  r_multiple      NUMERIC(10,3),
  notes           TEXT,

  -- One-shot warnings, so "approaching the stop" is said once, not every minute.
  stop_warned     BOOLEAN NOT NULL DEFAULT FALSE,
  expiry_warned   BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE INDEX IF NOT EXISTS idx_fno_signals_user ON fno_signals(user_id, generated_at DESC);
CREATE INDEX IF NOT EXISTS idx_fno_signals_active ON fno_signals(status) WHERE status = 'ACTIVE';

-- The engine re-proposes the same contract every cycle while the setup holds.
-- One active journal row per contract per user keeps the track record from
-- counting one idea ten times.
CREATE UNIQUE INDEX IF NOT EXISTS uq_fno_signals_active_contract
  ON fno_signals(user_id, underlying, expiry, strike, option_type)
  WHERE status = 'ACTIVE';

COMMENT ON TABLE fno_signals IS
  'Every graded F&O signal the decision engine issued, with its plan at issue and the outcome the tracker resolved. The track record is computed from here.';

CREATE TABLE IF NOT EXISTS user_notifications (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL CHECK (kind IN ('alert','fno_entry','fno_exit','paper_advice','system')),
  severity    TEXT NOT NULL DEFAULT 'info' CHECK (severity IN ('info','action','warning')),
  title       TEXT NOT NULL,
  message     TEXT NOT NULL,
  payload     JSONB NOT NULL DEFAULT '{}',
  link        TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  read_at     TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_user_notifications ON user_notifications(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_user_notifications_unread
  ON user_notifications(user_id) WHERE read_at IS NULL;

COMMENT ON TABLE user_notifications IS
  'Persisted notification feed. Written before the websocket push, so a notification fired while no browser was open is still there on the next visit.';
