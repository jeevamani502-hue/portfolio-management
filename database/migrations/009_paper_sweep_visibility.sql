-- Record what each paper-trading sweep decided.
--
-- Without this the engine is a black box: it is "running", nothing trades,
-- and there is no way to tell whether it looked and declined, never looked,
-- or failed. The sweep already produces a list of reasons it skipped each
-- underlying — this keeps the latest one so the UI can show it.
--
-- Stored on the config row rather than in Redis because the worker and the
-- API are separate processes, and the in-memory Redis substitute used in
-- development does not share state between them.

ALTER TABLE paper_trade_config
  ADD COLUMN IF NOT EXISTS last_sweep_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_sweep_result JSONB;

COMMENT ON COLUMN paper_trade_config.last_sweep_at IS
  'When the engine last evaluated this account. Null means it has never run.';
COMMENT ON COLUMN paper_trade_config.last_sweep_result IS
  'Outcome of that evaluation: how many underlyings were considered, how many positions opened, and the reason each one was skipped.';
