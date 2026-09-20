import { logger } from '../../utils/logger.js';
import { query, queryRows } from '../../db/pool.js';
import type { ProviderRegistry } from '../../providers/registry.js';
import { registryForUser } from '../../providers/registry.js';
import { isAvailable } from '../../utils/sourced.js';
import { analyzePortfolio } from '../../modules/portfolio/portfolio.service.js';
import { toIst } from '../../utils/time.js';

const log = logger.child({ job: 'portfolio-valuation' });

/**
 * Write one valuation snapshot per portfolio per trading day.
 *
 * These rows are what make the risk tab possible: volatility, drawdown,
 * Sharpe and beta all need a daily value series, and there is no way to
 * reconstruct one after the fact from holdings alone. A portfolio whose
 * positions could not all be priced is still snapshotted — with the coverage
 * recorded — rather than skipped, so the series has no silent gaps.
 */
export async function snapshotPortfolios(_registry: ProviderRegistry): Promise<void> {
  const portfolios = await queryRows<{ id: string; user_id: string; name: string }>(
    `SELECT p.id, p.user_id, p.name
       FROM portfolios p
      WHERE EXISTS (
        SELECT 1 FROM portfolio_holdings h WHERE h.portfolio_id = p.id AND h.quantity > 0
      )`,
  );

  if (portfolios.length === 0) return;

  const today = toIst().dateKey;
  let written = 0;
  let partial = 0;

  for (const p of portfolios) {
    try {
      const registry = await registryForUser(p.user_id);
      const analysis = await analyzePortfolio(registry, p.user_id, p.id);

      if (!isAvailable(analysis)) {
        log.warn({ portfolioId: p.id, reason: analysis.reason }, 'Portfolio could not be valued');
        continue;
      }

      const v = analysis.value.valuation;
      if (v.unvaluedSymbols.length > 0) partial += 1;

      // Net external cash flow for the day, so XIRR reconciles against the
      // snapshot series rather than drifting from it.
      const flows = await queryRows<{ net: number }>(
        `SELECT COALESCE(SUM(
                  CASE side
                    WHEN 'BUY'        THEN quantity * price + charges
                    WHEN 'DEPOSIT'    THEN COALESCE(amount, 0)
                    WHEN 'SELL'       THEN -(quantity * price - charges)
                    WHEN 'WITHDRAWAL' THEN -COALESCE(amount, 0)
                    WHEN 'DIVIDEND'   THEN -COALESCE(amount, 0)
                    ELSE 0
                  END), 0) AS net
           FROM transactions
          WHERE portfolio_id = $1 AND traded_at::date = $2::date`,
        [p.id, today],
      );

      await query(
        `INSERT INTO portfolio_snapshots
           (portfolio_id, snapshot_date, invested, market_value, realized_pnl,
            unrealized_pnl, day_pnl, cash_flow, holdings_count, source, as_of)
         VALUES ($1, $2::date, $3, $4, $5, $6, $7, $8, $9, $10, now())
         ON CONFLICT (portfolio_id, snapshot_date) DO UPDATE SET
           invested = EXCLUDED.invested,
           market_value = EXCLUDED.market_value,
           realized_pnl = EXCLUDED.realized_pnl,
           unrealized_pnl = EXCLUDED.unrealized_pnl,
           day_pnl = EXCLUDED.day_pnl,
           cash_flow = EXCLUDED.cash_flow,
           holdings_count = EXCLUDED.holdings_count,
           source = EXCLUDED.source,
           as_of = now()`,
        [
          p.id, today, v.totalInvested, v.currentValue, v.realizedPnl,
          v.unrealizedPnl, v.dayPnl, flows[0]?.net ?? 0, v.holdings.length,
          // Record the valuation coverage in the source string, so a later
          // reader can tell a full snapshot from a partial one.
          v.unvaluedSymbols.length > 0
            ? `${analysis.source} (partial: ${v.valuationCoveragePct.toFixed(0)}% priced)`
            : analysis.source,
        ],
      );
      written += 1;
    } catch (err) {
      log.warn({ err, portfolioId: p.id }, 'Snapshot failed for this portfolio');
    }
  }

  log.info({ portfolios: portfolios.length, written, partial }, 'Portfolio snapshots written');
}
