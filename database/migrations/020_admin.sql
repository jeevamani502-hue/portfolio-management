-- Admin: runtime settings an administrator can change without editing .env,
-- and a first administrator so the screen is reachable.

CREATE TABLE IF NOT EXISTS app_settings (
  key        TEXT PRIMARY KEY,
  value      JSONB NOT NULL,
  updated_by UUID REFERENCES users(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE app_settings IS
  'Server-wide switches an administrator sets from the Admin screen (for example whether sign-up is open). Overrides the matching .env value.';

-- The oldest active account becomes the first administrator, once, only if no
-- administrator exists. Later promotions are done from the Admin screen.
UPDATE users SET role = 'admin'
 WHERE id = (SELECT id FROM users WHERE is_active ORDER BY created_at LIMIT 1)
   AND NOT EXISTS (SELECT 1 FROM users WHERE role = 'admin');
