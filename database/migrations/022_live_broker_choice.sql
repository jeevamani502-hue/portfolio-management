-- Which connected broker places live orders. 'auto' keeps the old behaviour:
-- the first connected broker that can place orders.
ALTER TABLE live_trade_config
  ADD COLUMN IF NOT EXISTS broker TEXT NOT NULL DEFAULT 'auto'
    CHECK (broker IN ('auto','angelone','groww','kite','dhan'));
