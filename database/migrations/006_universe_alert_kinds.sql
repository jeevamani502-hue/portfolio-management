-- Universe-wide alert kinds.
--
-- SWING_SCAN and FNO_SETUP watch a whole universe rather than one instrument,
-- so they carry no instrument_id. The existing CHECK on alerts.kind lists the
-- permitted kinds explicitly, which is the behaviour we want — an unknown kind
-- should be rejected at the database, not silently stored and then skipped by
-- the evaluator. That means adding new kinds needs a migration, and this is it.

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
    -- Fires when the scanner persists a new setup anywhere in the universe.
    'SWING_SCAN',
    -- Fires when the F&O engine produces an actionable option trade.
    'FNO_SETUP'
  ])
);

-- An instrument is required for every kind except the universe-wide ones.
-- Previously only NEWS was symbol-less and nothing enforced it; the API
-- checked and the schema did not. Stating it here means a bad row cannot be
-- written by any path, including a manual INSERT.
ALTER TABLE alerts DROP CONSTRAINT IF EXISTS alerts_instrument_required_check;

ALTER TABLE alerts ADD CONSTRAINT alerts_instrument_required_check CHECK (
  instrument_id IS NOT NULL
  OR kind = ANY (ARRAY['NEWS', 'SWING_SCAN', 'FNO_SETUP'])
);
