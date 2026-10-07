-- News-triggered F&O alerts.
--
-- NEWS_FNO watches for fresh, relevant news on an F&O underlying and then
-- asks the rule engine whether there is a trade. The news is the trigger;
-- the direction still comes from price and the option chain. That split is
-- deliberate and is explained where the alert is evaluated.

ALTER TABLE alerts DROP CONSTRAINT IF EXISTS alerts_kind_check;

ALTER TABLE alerts ADD CONSTRAINT alerts_kind_check CHECK (
  kind = ANY (ARRAY[
    'PRICE_ABOVE',
    'PRICE_BELOW',
    'PCT_CHANGE',
    'RSI_ABOVE',
    'RSI_BELOW',
    'VOLUME_MULTIPLE',
    'BREAKOUT',
    'SUPPORT_BROKEN',
    'OI_CHANGE_PCT',
    'NEWS',
    'SIGNAL',
    'SWING_SCAN',
    'FNO_SETUP',
    -- Fresh news on an F&O underlying, paired with whatever the rule engine
    -- makes of it — including "nothing", which is the common answer.
    'NEWS_FNO'
  ])
);

ALTER TABLE alerts DROP CONSTRAINT IF EXISTS alerts_instrument_required_check;

ALTER TABLE alerts ADD CONSTRAINT alerts_instrument_required_check CHECK (
  instrument_id IS NOT NULL
  OR kind = ANY (ARRAY['NEWS', 'SWING_SCAN', 'FNO_SETUP', 'NEWS_FNO'])
);
