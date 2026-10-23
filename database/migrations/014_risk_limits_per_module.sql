-- Separate risk ceilings per module. Paper trading is simulated money and may
-- size up to the whole notional account; live trading is real money and is
-- bounded lower. These numbers mirror backend/src/config/riskLimits.ts.
--
-- The inline CHECKs from migrations 007 and 011 were auto-named by Postgres
-- as <table>_<column>_check; they are dropped and re-created here.

ALTER TABLE paper_trade_config DROP CONSTRAINT IF EXISTS paper_trade_config_risk_per_trade_pct_check;
ALTER TABLE paper_trade_config ADD CONSTRAINT paper_trade_config_risk_per_trade_pct_check
  CHECK (risk_per_trade_pct > 0 AND risk_per_trade_pct <= 100);

ALTER TABLE paper_trade_config DROP CONSTRAINT IF EXISTS paper_trade_config_max_daily_loss_pct_check;
ALTER TABLE paper_trade_config ADD CONSTRAINT paper_trade_config_max_daily_loss_pct_check
  CHECK (max_daily_loss_pct > 0 AND max_daily_loss_pct <= 100);

ALTER TABLE live_trade_config DROP CONSTRAINT IF EXISTS live_trade_config_risk_per_trade_pct_check;
ALTER TABLE live_trade_config ADD CONSTRAINT live_trade_config_risk_per_trade_pct_check
  CHECK (risk_per_trade_pct > 0 AND risk_per_trade_pct <= 50);

ALTER TABLE live_trade_config DROP CONSTRAINT IF EXISTS live_trade_config_max_daily_loss_pct_check;
ALTER TABLE live_trade_config ADD CONSTRAINT live_trade_config_max_daily_loss_pct_check
  CHECK (max_daily_loss_pct > 0 AND max_daily_loss_pct <= 50);
