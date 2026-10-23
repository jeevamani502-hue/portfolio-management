-- Password reset by one-time link, and a free WhatsApp channel (CallMeBot).

CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- SHA-256 of the token in the link; the token itself is never stored.
  token_hash  TEXT NOT NULL UNIQUE,
  expires_at  TIMESTAMPTZ NOT NULL,
  used_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_password_reset_user ON password_reset_tokens(user_id, created_at DESC);

-- CallMeBot: free WhatsApp messages to the user's own number, personal use.
-- The user activates it once by messaging the CallMeBot number and pastes the
-- key it replies with. Nothing here needs a Twilio account.
ALTER TABLE user_settings
  ADD COLUMN IF NOT EXISTS callmebot_apikey TEXT,
  ADD COLUMN IF NOT EXISTS notify_callmebot BOOLEAN NOT NULL DEFAULT FALSE;
