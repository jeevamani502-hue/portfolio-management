/**
 * Broker holdings import.
 *
 * Pulls holdings from a configured broker and reconciles them into a
 * portfolio. Two deliberate choices:
 *
 *  1. **Reconcile, don't append.** Re-importing is idempotent: quantities and
 *     average prices are set to what the broker reports, not added to what is
 *     already there. Importing twice must not double your position.
 *
 *  2. **Never invent an instrument.** A holding whose symbol cannot be
 *     resolved against the instrument master is skipped and reported, not
 *     inserted against a guessed id. The import result lists exactly what was
 *     left out and why.
 *
 * Note that holdings carry cost basis, not market value — the broker reports
 * quantity and average price. Current value still comes from the quote path,
 * so a portfolio imported without live-data access shows real cost and an
 * honest "unavailable" for P&L.
 */
import { query, queryOne } from '../../db/pool.js';
import { logger } from '../../utils/logger.js';
import { badRequest } from '../../utils/errors.js';
import type { ProviderRegistry } from '../../providers/registry.js';
import type { NormalizedHolding, ProviderId } from '../../providers/types.js';
import * as instrumentsRepo from '../../db/repositories/instruments.js';
import { getPortfolio } from './portfolio.service.js';

export interface ImportResult {
  provider: string;
  fetched: number;
  imported: number;
  updated: number;
  removed: number;
  skipped: Array<{ tradingsymbol: string; isin: string | null; reason: string }>;
  holdings: Array<{ symbol: string; quantity: number; averagePrice: number; invested: number }>;
  note: string;
}

/** Resolve a broker holding to an instrument, preferring ISIN. */
async function resolveHolding(
  h: NormalizedHolding,
): Promise<instrumentsRepo.InstrumentRow | null> {
  // ISIN is the stable identifier — symbols get renamed, ISINs do not.
  if (h.isin) {
    const byIsin = await queryOne<instrumentsRepo.InstrumentRow>(
      `SELECT id, exchange, tradingsymbol, name, isin, segment, instrument_type,
              underlying, to_char(expiry,'YYYY-MM-DD') AS expiry, strike, option_type,
              lot_size, tick_size, sector, industry, market_cap_class,
              index_membership, provider_tokens, is_active
         FROM instruments
        WHERE isin = $1 AND instrument_type = 'EQ' AND is_active = TRUE
        ORDER BY (CASE exchange WHEN 'NSE' THEN 0 WHEN 'BSE' THEN 1 ELSE 2 END)
        LIMIT 1`,
      [h.isin],
    );
    if (byIsin) return byIsin;
  }

  const prefix = h.exchange ? `${h.exchange}:` : '';
  return instrumentsRepo.resolveSymbol(`${prefix}${h.tradingsymbol}`);
}

export async function importHoldings(
  registry: ProviderRegistry,
  userId: string,
  portfolioId: string,
  providerId: ProviderId,
  opts: { removeMissing?: boolean } = {},
): Promise<ImportResult> {
  await getPortfolio(userId, portfolioId);

  const provider = registry.get(providerId);
  if (!provider) throw badRequest(`Provider "${providerId}" is not available`);
  if (!provider.getHoldings) {
    throw badRequest(`${provider.manifest.displayName} does not expose holdings`);
  }
  if (!provider.isConfigured()) {
    throw badRequest(
      `${provider.manifest.displayName} is not configured. Add credentials in Settings → Market Data Provider.`,
    );
  }

  const holdings = await provider.getHoldings();

  const skipped: ImportResult['skipped'] = [];
  const view: ImportResult['holdings'] = [];
  const seenInstrumentIds: number[] = [];
  let imported = 0;
  let updated = 0;

  for (const h of holdings) {
    const instrument = await resolveHolding(h);
    if (!instrument) {
      skipped.push({
        tradingsymbol: h.tradingsymbol,
        isin: h.isin,
        reason: 'not found in the instrument master — run the instruments sync',
      });
      continue;
    }

    seenInstrumentIds.push(instrument.id);

    // Reconcile to the broker's figures rather than accumulating, so a repeat
    // import is a no-op instead of doubling the position.
    const existing = await queryOne<{ id: string }>(
      `SELECT id FROM portfolio_holdings WHERE portfolio_id = $1 AND instrument_id = $2`,
      [portfolioId, instrument.id],
    );

    await query(
      `INSERT INTO portfolio_holdings
         (portfolio_id, instrument_id, quantity, avg_price, notes, first_bought_at)
       VALUES ($1,$2,$3,$4,$5, now())
       ON CONFLICT (portfolio_id, instrument_id) DO UPDATE SET
         quantity = EXCLUDED.quantity,
         avg_price = EXCLUDED.avg_price,
         notes = EXCLUDED.notes,
         updated_at = now()`,
      [
        portfolioId,
        instrument.id,
        h.quantity,
        h.averagePrice,
        `Imported from ${provider.manifest.displayName}`,
      ],
    );

    if (existing) updated += 1;
    else imported += 1;

    view.push({
      symbol: `${instrument.exchange}:${instrument.tradingsymbol}`,
      quantity: h.quantity,
      averagePrice: h.averagePrice,
      invested: h.quantity * h.averagePrice,
    });
  }

  /*
   * Optionally drop holdings the broker no longer reports.
   *
   * Off by default: a portfolio may deliberately contain manually tracked
   * positions held elsewhere, and silently deleting those on an import would
   * be destructive and surprising.
   */
  let removed = 0;
  if (opts.removeMissing && seenInstrumentIds.length > 0) {
    const res = await query(
      `DELETE FROM portfolio_holdings
        WHERE portfolio_id = $1 AND NOT (instrument_id = ANY($2::bigint[]))`,
      [portfolioId, seenInstrumentIds],
    );
    removed = res.rowCount ?? 0;
  }

  logger.info(
    { userId, portfolioId, provider: providerId, fetched: holdings.length, imported, updated, removed },
    'Broker holdings imported',
  );

  return {
    provider: provider.manifest.displayName,
    fetched: holdings.length,
    imported,
    updated,
    removed,
    skipped,
    holdings: view,
    note:
      'Quantities and average prices are set to what the broker reports, so re-importing is safe and will not duplicate positions. ' +
      'Brokers report cost basis only — current value and P&L still come from the live quote path, and show as unavailable if no provider can price the holding.',
  };
}
