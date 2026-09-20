-- ════════════════════════════════════════════════════════════════════════════
-- 005 — Allow 'groww' as a configurable provider.
--
-- `api_providers.provider` is constrained to a known set so a typo in a
-- credential payload cannot create a silently dead configuration row. Adding
-- a provider therefore means widening the constraint.
-- ════════════════════════════════════════════════════════════════════════════

ALTER TABLE api_providers DROP CONSTRAINT IF EXISTS api_providers_provider_check;

ALTER TABLE api_providers ADD CONSTRAINT api_providers_provider_check
  CHECK (provider IN ('groww','dhan','angelone','kite','upstox','fyers',
                      'nsepublic','amfi','eodhd','fmp',
                      'marketaux','newsapi','rss'));
