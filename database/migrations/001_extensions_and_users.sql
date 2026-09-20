-- ════════════════════════════════════════════════════════════════════════════
-- 001 — Extensions, users, auth, settings, provider credentials, audit.
-- ════════════════════════════════════════════════════════════════════════════

CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "citext";
-- TimescaleDB is optional. If the extension is unavailable (plain Postgres),
-- we continue without it and migration 002 falls back to native partitioning.
DO $ts$
BEGIN
  CREATE EXTENSION IF NOT EXISTS "timescaledb" CASCADE;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'TimescaleDB unavailable (%), continuing with plain PostgreSQL.', SQLERRM;
END
$ts$;

-- ── users ───────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email           CITEXT NOT NULL UNIQUE,
  password_hash   TEXT NOT NULL,
  full_name       TEXT,
  role            TEXT NOT NULL DEFAULT 'user'
                    CHECK (role IN ('user', 'analyst', 'admin')),
  is_active       BOOLEAN NOT NULL DEFAULT TRUE,
  email_verified  BOOLEAN NOT NULL DEFAULT FALSE,
  last_login_at   TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── refresh tokens (rotating, hashed at rest) ───────────────────────────────
CREATE TABLE IF NOT EXISTS refresh_tokens (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash    TEXT NOT NULL UNIQUE,
  family_id     UUID NOT NULL,
  user_agent    TEXT,
  ip            INET,
  expires_at    TIMESTAMPTZ NOT NULL,
  revoked_at    TIMESTAMPTZ,
  replaced_by   UUID REFERENCES refresh_tokens(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_refresh_user   ON refresh_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_refresh_family ON refresh_tokens(family_id);
CREATE INDEX IF NOT EXISTS idx_refresh_expiry ON refresh_tokens(expires_at);

-- ── user settings (risk config, appearance, notification prefs) ─────────────
CREATE TABLE IF NOT EXISTS user_settings (
  user_id                 UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  -- Risk management (section 18). Capital in INR.
  capital                 NUMERIC(18,2)  NOT NULL DEFAULT 500000
                            CHECK (capital >= 0),
  max_risk_per_trade_pct  NUMERIC(6,3)   NOT NULL DEFAULT 1.0
                            CHECK (max_risk_per_trade_pct > 0 AND max_risk_per_trade_pct <= 100),
  max_daily_loss_pct      NUMERIC(6,3)   NOT NULL DEFAULT 3.0
                            CHECK (max_daily_loss_pct > 0 AND max_daily_loss_pct <= 100),
  max_open_positions      INTEGER        NOT NULL DEFAULT 10 CHECK (max_open_positions > 0),
  default_timeframe       TEXT           NOT NULL DEFAULT '1d',
  theme                   TEXT           NOT NULL DEFAULT 'dark'
                            CHECK (theme IN ('dark','light','system')),
  -- Notification channels
  notify_browser          BOOLEAN NOT NULL DEFAULT TRUE,
  notify_email            BOOLEAN NOT NULL DEFAULT FALSE,
  notify_telegram         BOOLEAN NOT NULL DEFAULT FALSE,
  telegram_chat_id        TEXT,
  push_subscription       JSONB,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── broker / data-provider credentials ──────────────────────────────────────
-- Secrets are stored ONLY as AES-256-GCM ciphertext in `credentials_enc`.
-- The plaintext never leaves the provider process and is never serialized
-- into an API response (enforced by the scrubSecrets middleware).
CREATE TABLE IF NOT EXISTS api_providers (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider         TEXT NOT NULL
                     CHECK (provider IN ('dhan','angelone','kite','upstox','fyers',
                                         'nsepublic','amfi','eodhd','fmp',
                                         'marketaux','newsapi','rss')),
  label            TEXT,
  credentials_enc  TEXT,                       -- base64(iv | authTag | ciphertext)
  is_enabled       BOOLEAN NOT NULL DEFAULT TRUE,
  priority         INTEGER NOT NULL DEFAULT 100,   -- lower = tried first
  capabilities     TEXT[] NOT NULL DEFAULT '{}',
  -- health, updated by the registry's circuit breaker
  health_status    TEXT NOT NULL DEFAULT 'unknown'
                     CHECK (health_status IN ('unknown','healthy','degraded','down')),
  last_ok_at       TIMESTAMPTZ,
  last_error       TEXT,
  last_error_at    TIMESTAMPTZ,
  token_expires_at TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, provider)
);
CREATE INDEX IF NOT EXISTS idx_api_providers_user ON api_providers(user_id, is_enabled, priority);

-- ── audit log ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS audit_logs (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id     UUID REFERENCES users(id) ON DELETE SET NULL,
  action      TEXT NOT NULL,
  resource    TEXT,
  resource_id TEXT,
  ip          INET,
  user_agent  TEXT,
  metadata    JSONB NOT NULL DEFAULT '{}',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_logs(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_logs(action, created_at DESC);

-- ── updated_at trigger helper ───────────────────────────────────────────────
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_users_updated ON users;
CREATE TRIGGER trg_users_updated BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_settings_updated ON user_settings;
CREATE TRIGGER trg_settings_updated BEFORE UPDATE ON user_settings
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_providers_updated ON api_providers;
CREATE TRIGGER trg_providers_updated BEFORE UPDATE ON api_providers
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
