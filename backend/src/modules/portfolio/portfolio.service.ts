/**
 * Portfolio service: valuation, analysis, health.
 *
 * Holdings can be entered manually or derived from the transaction ledger.
 * When transactions exist they are authoritative — average price and realized
 * P&L are recomputed from them using FIFO, so a user who records their trades
 * gets accurate figures rather than a manually maintained average that drifts.
 */
import { query, queryRows, queryOne, withTransaction } from '../../db/pool.js';
import { notFound, badRequest } from '../../utils/errors.js';
import { sourced, unavailable, isAvailable, type Sourced } from '../../utils/sourced.js';
import type { ProviderRegistry } from '../../providers/registry.js';
import * as instrumentsRepo from '../../db/repositories/instruments.js';
import { getQuotes, marketStatus } from '../market/marketData.service.js';
import {
  valuePortfolio, calculateXirr, allocationBy, calculateConcentration,
  calculateRiskMetrics, correlationMatrix,
  type HoldingInput, type PortfolioValuation, type AllocationSlice,
  type ConcentrationResult, type RiskMetrics, type XirrResult, type CashFlow,
} from '../../analysis/portfolio/metrics.js';

export interface PortfolioRow {
  id: string;
  user_id: string;
  name: string;
  currency: string;
  broker: string | null;
  is_default: boolean;
  created_at: Date;
}

export async function listPortfolios(userId: string): Promise<PortfolioRow[]> {
  return queryRows<PortfolioRow>(
    `SELECT * FROM portfolios WHERE user_id = $1 ORDER BY is_default DESC, name`,
    [userId],
  );
}

export async function getPortfolio(userId: string, portfolioId: string): Promise<PortfolioRow> {
  const row = await queryOne<PortfolioRow>(
    `SELECT * FROM portfolios WHERE id = $1 AND user_id = $2`,
    [portfolioId, userId],
  );
  if (!row) throw notFound('Portfolio not found');
  return row;
}

/** The default portfolio, creating one if the user somehow has none. */
export async function getDefaultPortfolio(userId: string): Promise<PortfolioRow> {
  const existing = await queryOne<PortfolioRow>(
    `SELECT * FROM portfolios WHERE user_id = $1 ORDER BY is_default DESC, created_at LIMIT 1`,
    [userId],
  );
  if (existing) return existing;

  const created = await queryOne<PortfolioRow>(
    `INSERT INTO portfolios (user_id, name, is_default) VALUES ($1, 'My Portfolio', TRUE) RETURNING *`,
    [userId],
  );
  if (!created) throw new Error('Failed to create default portfolio');
  return created;
}

// ── holdings ────────────────────────────────────────────────────────────────

interface HoldingRow {
  id: string;
  instrument_id: number;
  quantity: number;
  avg_price: number;
  realized_pnl: number;
  total_charges: number;
  notes: string | null;
  tradingsymbol: string;
  exchange: string;
  name: string | null;
  sector: string | null;
  market_cap_class: string | null;
  lot_size: number;
}

export async function loadHoldings(portfolioId: string): Promise<HoldingRow[]> {
  return queryRows<HoldingRow>(
    `SELECT h.id, h.instrument_id, h.quantity, h.avg_price, h.realized_pnl,
            h.total_charges, h.notes,
            i.tradingsymbol, i.exchange, i.name, i.sector, i.market_cap_class, i.lot_size
       FROM portfolio_holdings h
       JOIN instruments i ON i.id = h.instrument_id
      WHERE h.portfolio_id = $1 AND h.quantity > 0
      ORDER BY i.tradingsymbol`,
    [portfolioId],
  );
}

export interface AddHoldingInput {
  symbol: string;
  quantity: number;
  avgPrice: number;
  notes?: string;
}

export async function addHolding(
  userId: string,
  portfolioId: string,
  input: AddHoldingInput,
): Promise<{ id: string; symbol: string }> {
  await getPortfolio(userId, portfolioId);

  const instrument = await instrumentsRepo.resolveSymbol(input.symbol);
  if (!instrument) throw badRequest(`No instrument matches "${input.symbol}"`);
  if (input.quantity <= 0) throw badRequest('Quantity must be greater than zero');
  if (input.avgPrice < 0) throw badRequest('Average price cannot be negative');

  // Merge with an existing position by weighted average rather than replacing.
  const row = await queryOne<{ id: string }>(
    `INSERT INTO portfolio_holdings (portfolio_id, instrument_id, quantity, avg_price, notes, first_bought_at)
     VALUES ($1,$2,$3,$4,$5, now())
     ON CONFLICT (portfolio_id, instrument_id) DO UPDATE SET
       avg_price = (portfolio_holdings.quantity * portfolio_holdings.avg_price
                    + EXCLUDED.quantity * EXCLUDED.avg_price)
                   / NULLIF(portfolio_holdings.quantity + EXCLUDED.quantity, 0),
       quantity = portfolio_holdings.quantity + EXCLUDED.quantity,
       notes = COALESCE(EXCLUDED.notes, portfolio_holdings.notes),
       updated_at = now()
     RETURNING id`,
    [portfolioId, instrument.id, input.quantity, input.avgPrice, input.notes ?? null],
  );
  if (!row) throw new Error('Failed to save holding');

  return { id: row.id, symbol: `${instrument.exchange}:${instrument.tradingsymbol}` };
}

export async function updateHolding(
  userId: string,
  portfolioId: string,
  holdingId: string,
  patch: { quantity?: number; avgPrice?: number; notes?: string },
): Promise<void> {
  await getPortfolio(userId, portfolioId);
  if (patch.quantity !== undefined && patch.quantity < 0) {
    throw badRequest('Quantity cannot be negative');
  }
  const res = await query(
    `UPDATE portfolio_holdings
        SET quantity  = COALESCE($3, quantity),
            avg_price = COALESCE($4, avg_price),
            notes     = COALESCE($5, notes),
            updated_at = now()
      WHERE id = $1 AND portfolio_id = $2`,
    [holdingId, portfolioId, patch.quantity ?? null, patch.avgPrice ?? null, patch.notes ?? null],
  );
  if (res.rowCount === 0) throw notFound('Holding not found in this portfolio');
}

export async function deleteHolding(
  userId: string,
  portfolioId: string,
  holdingId: string,
): Promise<void> {
  await getPortfolio(userId, portfolioId);
  const res = await query(
    `DELETE FROM portfolio_holdings WHERE id = $1 AND portfolio_id = $2`,
    [holdingId, portfolioId],
  );
  if (res.rowCount === 0) throw notFound('Holding not found in this portfolio');
}

// ── transactions ────────────────────────────────────────────────────────────

export interface AddTransactionInput {
  symbol?: string;
  side: 'BUY' | 'SELL' | 'DIVIDEND' | 'BONUS' | 'SPLIT' | 'DEPOSIT' | 'WITHDRAWAL' | 'CHARGE';
  quantity?: number;
  price?: number;
  amount?: number;
  charges?: number;
  tradedAt: Date;
  notes?: string;
  externalId?: string;
}

/**
 * Record a transaction and roll the holding forward.
 *
 * Realized P&L on a sale uses the current weighted-average cost, which is the
 * convention Indian brokers report and what users will reconcile against.
 */
export async function addTransaction(
  userId: string,
  portfolioId: string,
  input: AddTransactionInput,
): Promise<{ id: string }> {
  await getPortfolio(userId, portfolioId);

  let instrumentId: number | null = null;
  if (input.symbol) {
    const instrument = await instrumentsRepo.resolveSymbol(input.symbol);
    if (!instrument) throw badRequest(`No instrument matches "${input.symbol}"`);
    instrumentId = instrument.id;
  }

  const needsInstrument = ['BUY', 'SELL', 'DIVIDEND', 'BONUS', 'SPLIT'].includes(input.side);
  if (needsInstrument && instrumentId === null) {
    throw badRequest(`A symbol is required for a ${input.side} transaction`);
  }

  return withTransaction(async (client) => {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO transactions
         (portfolio_id, instrument_id, side, quantity, price, amount, charges, traded_at, external_id, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       RETURNING id`,
      [
        portfolioId, instrumentId, input.side, input.quantity ?? 0, input.price ?? 0,
        input.amount ?? null, input.charges ?? 0, input.tradedAt,
        input.externalId ?? null, input.notes ?? null,
      ],
    );
    const txId = rows[0]!.id;

    if (input.side === 'BUY' && instrumentId !== null) {
      await client.query(
        `INSERT INTO portfolio_holdings
           (portfolio_id, instrument_id, quantity, avg_price, total_charges, first_bought_at)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (portfolio_id, instrument_id) DO UPDATE SET
           avg_price = (portfolio_holdings.quantity * portfolio_holdings.avg_price
                        + EXCLUDED.quantity * EXCLUDED.avg_price)
                       / NULLIF(portfolio_holdings.quantity + EXCLUDED.quantity, 0),
           quantity = portfolio_holdings.quantity + EXCLUDED.quantity,
           total_charges = portfolio_holdings.total_charges + EXCLUDED.total_charges,
           updated_at = now()`,
        [portfolioId, instrumentId, input.quantity ?? 0, input.price ?? 0,
         input.charges ?? 0, input.tradedAt],
      );
    } else if (input.side === 'SELL' && instrumentId !== null) {
      const { rows: hRows } = await client.query<{ quantity: number; avg_price: number }>(
        `SELECT quantity, avg_price FROM portfolio_holdings
          WHERE portfolio_id = $1 AND instrument_id = $2 FOR UPDATE`,
        [portfolioId, instrumentId],
      );
      const holding = hRows[0];
      if (!holding) throw badRequest('Cannot record a sale: no existing holding for this instrument');

      const qty = input.quantity ?? 0;
      if (qty > holding.quantity) {
        throw badRequest(
          `Cannot sell ${qty} units; the portfolio holds ${holding.quantity}.`,
        );
      }

      const realized = qty * ((input.price ?? 0) - holding.avg_price) - (input.charges ?? 0);
      await client.query(
        `UPDATE portfolio_holdings
            SET quantity = quantity - $3,
                realized_pnl = realized_pnl + $4,
                total_charges = total_charges + $5,
                updated_at = now()
          WHERE portfolio_id = $1 AND instrument_id = $2`,
        [portfolioId, instrumentId, qty, realized, input.charges ?? 0],
      );
    }

    return { id: txId };
  });
}

export async function listTransactions(
  portfolioId: string,
  limit = 100,
  offset = 0,
): Promise<Array<Record<string, unknown>>> {
  return queryRows(
    `SELECT t.id, t.side, t.quantity, t.price, t.amount, t.charges, t.traded_at,
            t.notes, t.source, i.tradingsymbol, i.exchange, i.name
       FROM transactions t
       LEFT JOIN instruments i ON i.id = t.instrument_id
      WHERE t.portfolio_id = $1
      ORDER BY t.traded_at DESC
      LIMIT $2 OFFSET $3`,
    [portfolioId, limit, offset],
  );
}

// ── analysis ────────────────────────────────────────────────────────────────

export interface PortfolioAnalysis {
  portfolio: { id: string; name: string; currency: string };
  valuation: PortfolioValuation;
  allocation: {
    bySector: AllocationSlice[];
    byMarketCap: AllocationSlice[];
    byInstrument: AllocationSlice[];
  };
  concentration: ConcentrationResult;
  xirr: XirrResult;
  risk: RiskMetrics;
  correlations: Array<{ a: string; b: string; correlation: number }>;
  observations: Observation[];
  dataQuality: {
    holdingsValued: number;
    holdingsTotal: number;
    unvaluedSymbols: string[];
    snapshotDays: number;
  };
}

export interface Observation {
  severity: 'info' | 'attention' | 'high';
  category: string;
  title: string;
  detail: string;
  /** The numbers that produced this observation. */
  evidence: Record<string, number | string | null>;
}

export async function analyzePortfolio(
  registry: ProviderRegistry,
  userId: string,
  portfolioId: string,
): Promise<Sourced<PortfolioAnalysis>> {
  const portfolio = await getPortfolio(userId, portfolioId);
  const holdings = await loadHoldings(portfolioId);

  if (holdings.length === 0) {
    return unavailable(
      'empty_portfolio',
      'This portfolio has no holdings yet. Add a holding to see analysis.',
      undefined,
      'calculated',
    );
  }

  const instrumentRows = await instrumentsRepo.getByIds(holdings.map((h) => h.instrument_id));
  const quotes = await getQuotes(registry, instrumentRows);
  const status = await marketStatus();

  const sources = new Set<string>();
  let oldest: number | null = null;

  const inputs: HoldingInput[] = holdings.map((h) => {
    const q = quotes.get(h.instrument_id);
    let ltp: number | null = null;
    let prevClose: number | null = null;
    if (q && isAvailable(q)) {
      ltp = q.value.ltp;
      prevClose = q.value.prevClose;
      sources.add(q.source);
      const t = new Date(q.asOf).getTime();
      if (oldest === null || t < oldest) oldest = t;
    }
    return {
      instrumentId: h.instrument_id,
      symbol: `${h.exchange}:${h.tradingsymbol}`,
      name: h.name,
      sector: h.sector,
      marketCapClass: h.market_cap_class,
      quantity: h.quantity,
      avgPrice: h.avg_price,
      ltp,
      prevClose,
      realizedPnl: h.realized_pnl,
    };
  });

  const valuation = valuePortfolio(inputs);

  const bySector = allocationBy(valuation.holdings, (h) => h.sector, 'Unclassified');
  const byMarketCap = allocationBy(valuation.holdings, (h) => h.marketCapClass, 'Unclassified');
  const byInstrument = allocationBy(valuation.holdings, (h) => h.symbol);
  const concentration = calculateConcentration(valuation.holdings, bySector);

  const xirr = await computePortfolioXirr(portfolioId, valuation.currentValue);
  const { risk, snapshotDays } = await computePortfolioRisk(portfolioId);
  const correlations = await computeHoldingCorrelations(holdings.map((h) => ({
    id: h.instrument_id,
    symbol: h.tradingsymbol,
  })));

  const observations = deriveObservations(valuation, concentration, bySector, risk, correlations);

  const analysis: PortfolioAnalysis = {
    portfolio: { id: portfolio.id, name: portfolio.name, currency: portfolio.currency },
    valuation,
    allocation: { bySector, byMarketCap, byInstrument },
    concentration,
    xirr,
    risk,
    correlations: correlations.slice(0, 10),
    observations,
    dataQuality: {
      holdingsValued: valuation.holdings.filter((h) => !h.priceUnavailable).length,
      holdingsTotal: valuation.holdings.length,
      unvaluedSymbols: valuation.unvaluedSymbols,
      snapshotDays,
    },
  };

  return sourced(analysis, {
    source: [...sources].join('+') || 'computed',
    asOf: new Date(oldest ?? Date.now()).toISOString(),
    freshness: 'quote',
    kind: 'calculated',
    marketOpen: status.isSessionActive,
  });
}

async function computePortfolioXirr(
  portfolioId: string,
  currentValue: number,
): Promise<XirrResult> {
  const txs = await queryRows<{
    side: string; quantity: number; price: number; amount: number | null;
    charges: number; traded_at: Date;
  }>(
    `SELECT side, quantity, price, amount, charges, traded_at
       FROM transactions WHERE portfolio_id = $1 ORDER BY traded_at`,
    [portfolioId],
  );

  if (txs.length === 0) {
    return {
      xirr: null, xirrPct: null, converged: false, iterations: 0,
      reason: 'no_transactions',
      method:
        'XIRR requires a dated transaction history. This portfolio has holdings recorded ' +
        'without transactions, so there are no cash-flow dates to solve against. Add ' +
        'transactions (or import them from your broker) to enable XIRR.',
    };
  }

  const flows: CashFlow[] = txs.map((t) => {
    // Sign convention: money out of the investor's pocket is negative.
    let amount: number;
    switch (t.side) {
      case 'BUY':
        amount = -(t.quantity * t.price + t.charges);
        break;
      case 'SELL':
        amount = t.quantity * t.price - t.charges;
        break;
      case 'DIVIDEND':
        amount = t.amount ?? 0;
        break;
      case 'DEPOSIT':
        amount = -(t.amount ?? 0);
        break;
      case 'WITHDRAWAL':
        amount = t.amount ?? 0;
        break;
      case 'CHARGE':
        amount = -(t.amount ?? t.charges);
        break;
      default:
        amount = 0;
    }
    return { amount, date: t.traded_at };
  }).filter((f) => f.amount !== 0);

  // Current market value is the terminal inflow.
  if (currentValue > 0) flows.push({ amount: currentValue, date: new Date() });

  return calculateXirr(flows);
}

async function computePortfolioRisk(
  portfolioId: string,
): Promise<{ risk: RiskMetrics; snapshotDays: number }> {
  const snapshots = await queryRows<{ market_value: number; snapshot_date: Date }>(
    `SELECT market_value, snapshot_date FROM portfolio_snapshots
      WHERE portfolio_id = $1 ORDER BY snapshot_date`,
    [portfolioId],
  );

  const values = snapshots.map((s) => s.market_value);

  // Benchmark: NIFTY 50 closes over the same span.
  let benchmarkValues: number[] | undefined;
  if (values.length >= 20) {
    const nifty = await instrumentsRepo.resolveSymbol('NIFTY 50');
    if (nifty) {
      const closes = await queryRows<{ close: number }>(
        `SELECT close FROM candles
          WHERE instrument_id = $1 AND timeframe = '1d'
            AND ts::date >= $2::date AND ts::date <= $3::date
          ORDER BY ts`,
        [nifty.id, snapshots[0]!.snapshot_date, snapshots.at(-1)!.snapshot_date],
      );
      if (closes.length === values.length) benchmarkValues = closes.map((c) => c.close);
    }
  }

  return {
    risk: calculateRiskMetrics(values, benchmarkValues ? { benchmarkValues } : {}),
    snapshotDays: values.length,
  };
}

async function computeHoldingCorrelations(
  holdings: Array<{ id: number; symbol: string }>,
): Promise<Array<{ a: string; b: string; correlation: number }>> {
  if (holdings.length < 2) return [];

  const series = new Map<string, number[]>();
  for (const h of holdings) {
    const closes = await queryRows<{ close: number }>(
      `SELECT close FROM candles
        WHERE instrument_id = $1 AND timeframe = '1d' AND ts > now() - interval '120 days'
        ORDER BY ts`,
      [h.id],
    );
    if (closes.length < 30) continue;
    const returns: number[] = [];
    for (let i = 1; i < closes.length; i += 1) {
      const prev = closes[i - 1]!.close;
      if (prev > 0) returns.push(closes[i]!.close / prev - 1);
    }
    series.set(h.symbol, returns);
  }

  // Correlation requires equal-length series; trim to the shortest.
  const lengths = [...series.values()].map((s) => s.length);
  if (lengths.length < 2) return [];
  const minLen = Math.min(...lengths);
  const trimmed = new Map<string, number[]>();
  for (const [k, v] of series) trimmed.set(k, v.slice(-minLen));

  return correlationMatrix(trimmed);
}

/**
 * Turn the computed metrics into plain-language observations.
 *
 * These are descriptive, never prescriptive: "62% of this portfolio sits in
 * one sector" is a fact about the data. "You should diversify" would be
 * investment advice, which this system does not give.
 */
function deriveObservations(
  valuation: PortfolioValuation,
  concentration: ConcentrationResult,
  bySector: AllocationSlice[],
  risk: RiskMetrics,
  correlations: Array<{ a: string; b: string; correlation: number }>,
): Observation[] {
  const out: Observation[] = [];

  if (concentration.topSectorPct !== null && concentration.topSectorPct > 40) {
    out.push({
      severity: concentration.topSectorPct > 60 ? 'high' : 'attention',
      category: 'Concentration',
      title: `${concentration.topSectorPct.toFixed(1)}% of the portfolio is in ${concentration.topSector}`,
      detail:
        `The ${concentration.topSector} sector accounts for ${concentration.topSectorPct.toFixed(1)}% of current value across ` +
        `${bySector[0]?.count ?? 0} holdings. Sector-level moves will therefore drive a large share of portfolio movement.`,
      evidence: { sector: concentration.topSector, weightPct: concentration.topSectorPct },
    });
  }

  if (concentration.topHoldingPct !== null && concentration.topHoldingPct > 25) {
    const top = valuation.holdings
      .filter((h) => h.weightPct !== null)
      .sort((a, b) => b.weightPct! - a.weightPct!)[0];
    out.push({
      severity: concentration.topHoldingPct > 40 ? 'high' : 'attention',
      category: 'Concentration',
      title: `Largest position is ${concentration.topHoldingPct.toFixed(1)}% of the portfolio`,
      detail:
        `${top?.symbol ?? 'The largest holding'} represents ${concentration.topHoldingPct.toFixed(1)}% of current value. ` +
        `A 10% move in this single position would change portfolio value by roughly ${(concentration.topHoldingPct / 10).toFixed(1)}%.`,
      evidence: { symbol: top?.symbol ?? null, weightPct: concentration.topHoldingPct },
    });
  }

  if (concentration.effectivePositions !== null && concentration.positionCount > 0) {
    out.push({
      severity: 'info',
      category: 'Diversification',
      title: `${concentration.positionCount} holdings, behaving like ${concentration.effectivePositions.toFixed(1)} equally weighted ones`,
      detail:
        `The Herfindahl index is ${concentration.hhi?.toFixed(0)}, which corresponds to ` +
        `${concentration.effectivePositions.toFixed(1)} effective positions. The gap between that and the ` +
        `${concentration.positionCount} actual holdings is the effect of unequal position sizes.`,
      evidence: {
        hhi: concentration.hhi,
        effectivePositions: concentration.effectivePositions,
        positionCount: concentration.positionCount,
      },
    });
  }

  const highCorr = correlations.filter((c) => c.correlation > 0.8);
  if (highCorr.length > 0) {
    out.push({
      severity: 'attention',
      category: 'Correlation',
      title: `${highCorr.length} holding pair${highCorr.length > 1 ? 's move' : ' moves'} closely together`,
      detail:
        `Over the last 120 trading days, ${highCorr
          .slice(0, 3)
          .map((c) => `${c.a} and ${c.b} (${c.correlation.toFixed(2)})`)
          .join(', ')} showed daily-return correlation above 0.80. Positions this correlated provide less ` +
        `diversification than their separate line items suggest.`,
      evidence: { pairCount: highCorr.length, highest: highCorr[0]?.correlation ?? null },
    });
  }

  if (risk.maxDrawdownPct !== null && risk.maxDrawdownPct > 20) {
    out.push({
      severity: risk.maxDrawdownPct > 35 ? 'high' : 'attention',
      category: 'Risk',
      title: `Maximum drawdown of ${risk.maxDrawdownPct.toFixed(1)}% in the recorded history`,
      detail:
        `Across ${risk.observations} daily observations, portfolio value fell ${risk.maxDrawdownPct.toFixed(1)}% ` +
        `from a peak of ₹${risk.maxDrawdownPeak?.toLocaleString('en-IN', { maximumFractionDigits: 0 })} to ` +
        `₹${risk.maxDrawdownTrough?.toLocaleString('en-IN', { maximumFractionDigits: 0 })}.`,
      evidence: {
        maxDrawdownPct: risk.maxDrawdownPct,
        peak: risk.maxDrawdownPeak,
        trough: risk.maxDrawdownTrough,
      },
    });
  }

  if (risk.beta !== null) {
    out.push({
      severity: 'info',
      category: 'Market exposure',
      title: `Beta to NIFTY 50 is ${risk.beta.toFixed(2)}`,
      detail:
        `Over ${risk.observations} observations, the portfolio moved ${risk.beta.toFixed(2)}× the index on average ` +
        `(correlation ${risk.correlation?.toFixed(2) ?? 'n/a'}). ` +
        (risk.beta > 1.2
          ? 'That is more volatile than the index.'
          : risk.beta < 0.8
            ? 'That is less volatile than the index.'
            : 'That is broadly in line with the index.'),
      evidence: { beta: risk.beta, correlation: risk.correlation, observations: risk.observations },
    });
  }

  if (valuation.unvaluedSymbols.length > 0) {
    out.push({
      severity: 'attention',
      category: 'Data quality',
      title: `${valuation.unvaluedSymbols.length} holding${valuation.unvaluedSymbols.length > 1 ? 's' : ''} could not be valued`,
      detail:
        `Live prices were unavailable for ${valuation.unvaluedSymbols.join(', ')}. These positions are excluded ` +
        `from the totals above rather than valued at cost, so portfolio value is understated by their market worth. ` +
        `${valuation.valuationCoveragePct.toFixed(1)}% of invested capital could be priced.`,
      evidence: {
        unvalued: valuation.unvaluedSymbols.join(', '),
        coveragePct: valuation.valuationCoveragePct,
      },
    });
  }

  if (risk.observations === 0) {
    out.push({
      severity: 'info',
      category: 'Data quality',
      title: 'Risk metrics need daily snapshots',
      detail:
        'Volatility, drawdown, Sharpe and beta are computed from a daily portfolio-value series. ' +
        'The valuation worker records one snapshot per trading day; these metrics will populate once at least ' +
        '20 days of history exist.',
      evidence: { observations: 0 },
    });
  }

  return out;
}

/** The compact health summary shown on the dashboard card. */
export interface PortfolioHealth {
  portfolioValue: number;
  todayPnl: number | null;
  todayPnlPct: number | null;
  overallPnl: number;
  overallPnlPct: number | null;
  xirrPct: number | null;
  riskLevel: 'low' | 'moderate' | 'elevated' | 'unknown';
  riskBasis: string;
  diversificationScore: number | null;
  diversificationBasis: string;
  concentrationFlag: string | null;
  attentionCount: number;
}

export function summariseHealth(analysis: PortfolioAnalysis): PortfolioHealth {
  const { valuation, concentration, risk, xirr, observations } = analysis;

  let riskLevel: PortfolioHealth['riskLevel'] = 'unknown';
  let riskBasis = 'Not enough daily history to compute portfolio volatility.';
  if (risk.volatilityPct !== null) {
    riskLevel =
      risk.volatilityPct < 15 ? 'low' : risk.volatilityPct < 25 ? 'moderate' : 'elevated';
    riskBasis = `Annualised volatility of ${risk.volatilityPct.toFixed(1)}% computed from ${risk.observations} daily returns.`;
  }

  // Diversification: effective positions relative to a 15-holding reference.
  const diversificationScore =
    concentration.effectivePositions !== null
      ? Math.round(Math.min(100, (concentration.effectivePositions / 15) * 100))
      : null;

  return {
    portfolioValue: valuation.currentValue,
    todayPnl: valuation.dayPnl,
    todayPnlPct: valuation.dayReturnPct,
    overallPnl: valuation.unrealizedPnl + valuation.realizedPnl,
    overallPnlPct: valuation.totalReturnPct,
    xirrPct: xirr.xirrPct,
    riskLevel,
    riskBasis,
    diversificationScore,
    diversificationBasis:
      concentration.effectivePositions !== null
        ? `${concentration.effectivePositions.toFixed(1)} effective positions out of ${concentration.positionCount} holdings, scored against a 15-position reference.`
        : 'Position weights unavailable.',
    concentrationFlag:
      concentration.topSectorPct !== null && concentration.topSectorPct > 40
        ? `${concentration.topSectorPct.toFixed(0)}% in ${concentration.topSector}`
        : concentration.topHoldingPct !== null && concentration.topHoldingPct > 25
          ? `Largest position is ${concentration.topHoldingPct.toFixed(0)}%`
          : null,
    attentionCount: observations.filter((o) => o.severity !== 'info').length,
  };
}
