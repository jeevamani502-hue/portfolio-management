-- Alerts to the user's phone: Telegram, WhatsApp and SMS.
--
-- Telegram is linked by a one-time code the user sends to the bot, so no
-- chat id has to be typed. WhatsApp and SMS go through Twilio when the
-- server has credentials; the phone number is the user's own, stored in
-- E.164 form. notify_kinds and notify_min_severity decide which of the
-- in-app notifications are also sent out.

ALTER TABLE user_settings
  ADD COLUMN IF NOT EXISTS phone_e164               TEXT,
  ADD COLUMN IF NOT EXISTS notify_sms               BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS notify_whatsapp          BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS notify_kinds             TEXT[] NOT NULL
    DEFAULT ARRAY['paper','live','fno_entry','fno_exit','alert','paper_advice']::TEXT[],
  ADD COLUMN IF NOT EXISTS notify_min_severity      TEXT NOT NULL DEFAULT 'action'
    CHECK (notify_min_severity IN ('info','action','warning')),
  ADD COLUMN IF NOT EXISTS telegram_link_code       TEXT,
  ADD COLUMN IF NOT EXISTS telegram_link_expires_at TIMESTAMPTZ;

-- Paper entries and exits become notifications of their own kind.
ALTER TABLE user_notifications DROP CONSTRAINT IF EXISTS user_notifications_kind_check;
ALTER TABLE user_notifications ADD CONSTRAINT user_notifications_kind_check
  CHECK (kind IN ('alert','fno_entry','fno_exit','paper','paper_advice','live','system'));
