/**
 * Fundamentals service: fetch, persist, and summarise.
 *
 * The summary (brief section 7) is rule-based and shows its working: each
 * category verdict lists the metrics behind it and the thresholds applied.
 * Thresholds are stated explicitly rather than hidden, because reasonable
 * people disagree about what counts as "high" debt.
 */
import { query, queryOne, queryRows } from '../../db/pool.js';
import { getJson, setJson } from '../../cache/redis.js';
import { K, TTL } from '../../cache/keys.js';
import { sourced, unavailable, type Sourced } from '../../utils/sourced.js';
import { logger } from '../../utils/logger.js';
import { env } from '../../config/env.js';
import { EodhdProvider } from '../../providers/fundamentals/eodhd.js';
import type { NormalizedFundamentals } from '../../providers/types.js';
import type { InstrumentRow } from '../../db/repositories/instruments.js';

export interface FundamentalMetric {
  key: string;
  label: string;
  value: number | null;
  unit: '₹' | '₹ Cr' | '%' | 'x' | 'ratio' | null;
  /** How this number was obtained or derived. */
  derivation: string;
}

export type Verdict = 'strong' | 'adequate' | 'weak' | 'unavailable';

export interface CategoryAssessment {
  category: string;
  verdict: Verdict;
  headline: string;
  metrics: FundamentalMetric[];
  /** The exact thresholds applied, so the verdict can be audited. */
  criteria: string[];
}

export interface FundamentalsView {
  symbol: string;
  metrics: Record<string, number | null>;
  summary: CategoryAssessment[];
  fiscalPeriod: string | null;
  coverage: {
    available: number;
    total: number;
    missing: string[];
  };
  methodology: string;
}

interface FundamentalsRow {
  instrument_id: number;
  market_cap: number | null;
  revenue_ttm: number | null;
  revenue_growth_yoy: number | null;
  ebitda_ttm: number | null;
  ebitda_margin: number | null;
  net_profit_ttm: number | null;
  profit_growth_yoy: number | null;
  eps_ttm: number | null;
  eps_growth_yoy: number | null;
  pe: number | null;
  pb: number | null;
  roe: number | null;
  roce: number | null;
  debt_to_equity: number | null;
  free_cash_flow: number | null;
  operating_cf: number | null;
  dividend_yield: number | null;
  book_value: number | null;
  promoter_holding: number | null;
  fii_holding: number | null;
  dii_holding: number | null;
  pledged_pct: number | null;
  fiscal_period: string | null;
  source: string;
  as_of: Date;
}

let provider: EodhdProvider | null = null;
function fundamentalsProvider(): EodhdProvider {
  return (provider ??= new EodhdProvider());
}

export async function getFundamentals(
  instrument: InstrumentRow,
): Promise<Sourced<FundamentalsView>> {
  const cacheKey = K.fundamentals(instrument.id);
  const cached = await getJson<{ view: FundamentalsView; source: string; asOf: string }>(cacheKey);
  if (cached) {
    return sourced(cached.view, {
      source: cached.source,
      asOf: cached.asOf,
      freshness: 'fundamentals',
      kind: 'market_data',
    });
  }

  // Stored snapshot first — fundamentals change quarterly, not by the second.
  const stored = await queryOne<FundamentalsRow>(
    `SELECT * FROM fundamentals WHERE instrument_id = $1`,
    [instrument.id],
  );

  const ageMs = stored ? Date.now() - stored.as_of.getTime() : Infinity;
  if (stored && ageMs < 7 * 24 * 3600_000) {
    const view = buildView(instrument.tradingsymbol, stored);
    await setJson(cacheKey, { view, source: stored.source, asOf: stored.as_of.toISOString() }, TTL.fundamentals);
    return sourced(view, {
      source: stored.source,
      asOf: stored.as_of.toISOString(),
      freshness: 'fundamentals',
      kind: 'market_data',
    });
  }

  // Refresh from the provider.
  const p = fundamentalsProvider();
  if (!p.isConfigured()) {
    if (stored) {
      const view = buildView(instrument.tradingsymbol, stored);
      return sourced(view, {
        source: `${stored.source} (stored)`,
        asOf: stored.as_of.toISOString(),
        freshness: 'fundamentals',
        kind: 'market_data',
      });
    }
    return unavailable(
      'no_fundamentals_provider',
      'No fundamental-data provider is configured. Add an EODHD API token in Settings → Market Data Provider to enable this section.',
    );
  }

  try {
    const data = await p.getFundamentals(instrument.tradingsymbol);
    await persistFundamentals(instrument.id, data, 'eodhd');
    const fresh = await queryOne<FundamentalsRow>(
      `SELECT * FROM fundamentals WHERE instrument_id = $1`,
      [instrument.id],
    );
    if (!fresh) throw new Error('Persist succeeded but row not found');

    const view = buildView(instrument.tradingsymbol, fresh);
    await setJson(cacheKey, { view, source: 'eodhd', asOf: data.asOf }, TTL.fundamentals);
    return sourced(view, {
      source: 'eodhd',
      asOf: data.asOf,
      freshness: 'fundamentals',
      kind: 'market_data',
    });
  } catch (err) {
    logger.warn({ err, symbol: instrument.tradingsymbol }, 'Fundamentals fetch failed');
    if (stored) {
      const view = buildView(instrument.tradingsymbol, stored);
      return sourced(view, {
        source: `${stored.source} (stored)`,
        asOf: stored.as_of.toISOString(),
        freshness: 'fundamentals',
        kind: 'market_data',
      });
    }
    return unavailable(
      'fundamentals_fetch_failed',
      `Fundamental data could not be retrieved for ${instrument.tradingsymbol}.`,
      [{ provider: 'eodhd', error: err instanceof Error ? err.message : 'unknown' }],
    );
  }
}

export async function persistFundamentals(
  instrumentId: number,
  d: NormalizedFundamentals,
  source: string,
): Promise<void> {
  await query(
    `INSERT INTO fundamentals (
       instrument_id, market_cap, revenue_ttm, revenue_growth_yoy, ebitda_ttm, ebitda_margin,
       net_profit_ttm, profit_growth_yoy, eps_ttm, eps_growth_yoy, pe, pb, roe, roce,
       debt_to_equity, free_cash_flow, operating_cf, dividend_yield, book_value, face_value,
       promoter_holding, fii_holding, dii_holding, public_holding, pledged_pct,
       fiscal_period, raw, source, as_of, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,
             $21,$22,$23,$24,$25,$26,$27,$28,$29, now())
     ON CONFLICT (instrument_id) DO UPDATE SET
       market_cap = EXCLUDED.market_cap, revenue_ttm = EXCLUDED.revenue_ttm,
       revenue_growth_yoy = EXCLUDED.revenue_growth_yoy, ebitda_ttm = EXCLUDED.ebitda_ttm,
       ebitda_margin = EXCLUDED.ebitda_margin, net_profit_ttm = EXCLUDED.net_profit_ttm,
       profit_growth_yoy = EXCLUDED.profit_growth_yoy, eps_ttm = EXCLUDED.eps_ttm,
       eps_growth_yoy = EXCLUDED.eps_growth_yoy, pe = EXCLUDED.pe, pb = EXCLUDED.pb,
       roe = EXCLUDED.roe, roce = EXCLUDED.roce, debt_to_equity = EXCLUDED.debt_to_equity,
       free_cash_flow = EXCLUDED.free_cash_flow, operating_cf = EXCLUDED.operating_cf,
       dividend_yield = EXCLUDED.dividend_yield, book_value = EXCLUDED.book_value,
       promoter_holding = EXCLUDED.promoter_holding, fii_holding = EXCLUDED.fii_holding,
       dii_holding = EXCLUDED.dii_holding, pledged_pct = EXCLUDED.pledged_pct,
       fiscal_period = EXCLUDED.fiscal_period, raw = EXCLUDED.raw,
       source = EXCLUDED.source, as_of = EXCLUDED.as_of, updated_at = now()`,
    [
      instrumentId, d.marketCap, d.revenueTtm, d.revenueGrowthYoy, d.ebitdaTtm, d.ebitdaMargin,
      d.netProfitTtm, d.profitGrowthYoy, d.epsTtm, d.epsGrowthYoy, d.pe, d.pb, d.roe, d.roce,
      d.debtToEquity, d.freeCashFlow, d.operatingCashFlow, d.dividendYield, d.bookValue,
      d.faceValue, d.promoterHolding, d.fiiHolding, d.diiHolding, d.publicHolding,
      d.pledgedPct, d.fiscalPeriod, JSON.stringify(d.raw), source, d.asOf,
    ],
  );
}

// ── rule-based summary ──────────────────────────────────────────────────────

function buildView(symbol: string, r: FundamentalsRow): FundamentalsView {
  const metrics: Record<string, number | null> = {
    marketCap: r.market_cap,
    revenueTtm: r.revenue_ttm,
    revenueGrowthYoy: r.revenue_growth_yoy,
    ebitdaTtm: r.ebitda_ttm,
    ebitdaMargin: r.ebitda_margin,
    netProfitTtm: r.net_profit_ttm,
    profitGrowthYoy: r.profit_growth_yoy,
    epsTtm: r.eps_ttm,
    epsGrowthYoy: r.eps_growth_yoy,
    pe: r.pe,
    pb: r.pb,
    roe: r.roe,
    roce: r.roce,
    debtToEquity: r.debt_to_equity,
    freeCashFlow: r.free_cash_flow,
    operatingCashFlow: r.operating_cf,
    dividendYield: r.dividend_yield,
    bookValue: r.book_value,
    promoterHolding: r.promoter_holding,
    fiiHolding: r.fii_holding,
    diiHolding: r.dii_holding,
    pledgedPct: r.pledged_pct,
  };

  const total = Object.keys(metrics).length;
  const missing = Object.entries(metrics).filter(([, v]) => v === null).map(([k]) => k);

  return {
    symbol,
    metrics,
    fiscalPeriod: r.fiscal_period,
    summary: [
      assessGrowth(r),
      assessProfitability(r),
      assessValuation(r),
      assessDebt(r),
      assessCashFlow(r),
      assessOwnership(r),
    ],
    coverage: { available: total - missing.length, total, missing },
    methodology:
      'Verdicts are produced by fixed numeric thresholds applied to the reported figures shown alongside them. ' +
      'Thresholds are general-purpose and are not adjusted per sector — a debt ratio normal for a bank or an NBFC ' +
      'will read as elevated here. Where a figure is unavailable the category is marked unavailable rather than ' +
      'being scored on partial data.',
  };
}

function verdictFrom(
  checks: Array<{ ok: boolean | null; weight?: number }>,
): Verdict {
  const evaluable = checks.filter((c) => c.ok !== null);
  if (evaluable.length === 0) return 'unavailable';
  const weightTotal = evaluable.reduce((s, c) => s + (c.weight ?? 1), 0);
  const passed = evaluable.filter((c) => c.ok === true).reduce((s, c) => s + (c.weight ?? 1), 0);
  const ratio = passed / weightTotal;
  return ratio >= 0.7 ? 'strong' : ratio >= 0.4 ? 'adequate' : 'weak';
}

const f = (v: number | null, dp = 2): string => (v === null ? 'not reported' : v.toFixed(dp));
const crores = (v: number | null): string =>
  v === null ? 'not reported' : `₹${(v / 1e7).toLocaleString('en-IN', { maximumFractionDigits: 0 })} Cr`;

function assessGrowth(r: FundamentalsRow): CategoryAssessment {
  const checks = [
    { ok: r.revenue_growth_yoy === null ? null : r.revenue_growth_yoy > 10 },
    { ok: r.profit_growth_yoy === null ? null : r.profit_growth_yoy > 10 },
    { ok: r.eps_growth_yoy === null ? null : r.eps_growth_yoy > 10 },
  ];
  const verdict = verdictFrom(checks);
  return {
    category: 'Business Growth',
    verdict,
    headline:
      verdict === 'unavailable'
        ? 'Growth figures were not reported by the data provider.'
        : `Revenue growth ${f(r.revenue_growth_yoy)}%, profit growth ${f(r.profit_growth_yoy)}% year on year.`,
    metrics: [
      { key: 'revenueTtm', label: 'Revenue (TTM)', value: r.revenue_ttm, unit: '₹ Cr',
        derivation: `Trailing twelve months revenue as reported: ${crores(r.revenue_ttm)}` },
      { key: 'revenueGrowthYoy', label: 'Revenue growth YoY', value: r.revenue_growth_yoy, unit: '%',
        derivation: 'Most recent quarter revenue against the same quarter a year earlier' },
      { key: 'profitGrowthYoy', label: 'Profit growth YoY', value: r.profit_growth_yoy, unit: '%',
        derivation: 'Most recent quarter earnings against the same quarter a year earlier' },
      { key: 'epsGrowthYoy', label: 'EPS growth YoY', value: r.eps_growth_yoy, unit: '%',
        derivation: 'Earnings per share growth year on year' },
    ],
    criteria: ['Growth above 10% YoY counts as a pass for each of revenue, profit and EPS.'],
  };
}

function assessProfitability(r: FundamentalsRow): CategoryAssessment {
  const checks = [
    { ok: r.roe === null ? null : r.roe > 15, weight: 2 },
    { ok: r.roce === null ? null : r.roce > 15, weight: 2 },
    { ok: r.ebitda_margin === null ? null : r.ebitda_margin > 15 },
  ];
  const verdict = verdictFrom(checks);
  return {
    category: 'Profitability',
    verdict,
    headline:
      verdict === 'unavailable'
        ? 'Profitability ratios were not reported by the data provider.'
        : `ROE ${f(r.roe)}%, ROCE ${f(r.roce)}%, EBITDA margin ${f(r.ebitda_margin)}%.`,
    metrics: [
      { key: 'roe', label: 'Return on equity', value: r.roe, unit: '%',
        derivation: 'Net income ÷ shareholders’ equity, trailing twelve months' },
      { key: 'roce', label: 'Return on capital employed', value: r.roce, unit: '%',
        derivation: 'EBIT ÷ (total assets − current liabilities), from the latest annual balance sheet' },
      { key: 'ebitdaMargin', label: 'EBITDA margin', value: r.ebitda_margin, unit: '%',
        derivation: 'EBITDA ÷ revenue (TTM)' },
      { key: 'netProfitTtm', label: 'Net profit (TTM)', value: r.net_profit_ttm, unit: '₹ Cr',
        derivation: `Latest reported annual net income: ${crores(r.net_profit_ttm)}` },
    ],
    criteria: [
      'ROE above 15% and ROCE above 15% each count double.',
      'EBITDA margin above 15% counts once.',
      'These thresholds suit manufacturing and services; financials and utilities differ materially.',
    ],
  };
}

function assessValuation(r: FundamentalsRow): CategoryAssessment {
  // Valuation is deliberately NOT scored as good/bad — a low P/E can mean
  // cheap or it can mean broken. We report the numbers and say so.
  const available = [r.pe, r.pb].some((v) => v !== null);
  return {
    category: 'Valuation',
    verdict: available ? 'adequate' : 'unavailable',
    headline: available
      ? `Trading at ${f(r.pe)}× earnings and ${f(r.pb)}× book value.`
      : 'Valuation ratios were not reported by the data provider.',
    metrics: [
      { key: 'pe', label: 'Price / Earnings', value: r.pe, unit: 'x',
        derivation: 'Market price ÷ trailing twelve-month earnings per share' },
      { key: 'pb', label: 'Price / Book', value: r.pb, unit: 'x',
        derivation: 'Market price ÷ book value per share (most recent quarter)' },
      { key: 'bookValue', label: 'Book value per share', value: r.book_value, unit: '₹',
        derivation: 'Shareholders’ equity ÷ shares outstanding' },
      { key: 'dividendYield', label: 'Dividend yield', value: r.dividend_yield, unit: '%',
        derivation: 'Trailing dividends per share ÷ market price' },
    ],
    criteria: [
      'Valuation is reported, not graded. A low multiple can indicate value or deteriorating fundamentals, and a high one can reflect growth or optimism.',
      'Compare against the sector peer table rather than against an absolute threshold.',
    ],
  };
}

function assessDebt(r: FundamentalsRow): CategoryAssessment {
  const checks = [
    { ok: r.debt_to_equity === null ? null : r.debt_to_equity < 1, weight: 2 },
    { ok: r.pledged_pct === null ? null : r.pledged_pct < 10 },
  ];
  const verdict = verdictFrom(checks);
  return {
    category: 'Debt',
    verdict,
    headline:
      r.debt_to_equity === null
        ? 'Debt figures were not reported by the data provider.'
        : `Debt to equity of ${f(r.debt_to_equity)}.`,
    metrics: [
      { key: 'debtToEquity', label: 'Debt / Equity', value: r.debt_to_equity, unit: 'ratio',
        derivation: 'Total debt (short + long term) ÷ shareholders’ equity, latest annual balance sheet' },
      { key: 'pledgedPct', label: 'Promoter pledge', value: r.pledged_pct, unit: '%',
        derivation: 'Share of promoter holding pledged, where the provider reports it' },
    ],
    criteria: [
      'Debt to equity below 1.0 counts double.',
      'Promoter pledge below 10% counts once.',
      'Banks, NBFCs and infrastructure companies operate at structurally higher leverage; this threshold will misread them.',
    ],
  };
}

function assessCashFlow(r: FundamentalsRow): CategoryAssessment {
  const cashConversion =
    r.operating_cf !== null && r.net_profit_ttm !== null && r.net_profit_ttm !== 0
      ? r.operating_cf / r.net_profit_ttm
      : null;

  const checks = [
    { ok: r.operating_cf === null ? null : r.operating_cf > 0, weight: 2 },
    { ok: r.free_cash_flow === null ? null : r.free_cash_flow > 0, weight: 2 },
    { ok: cashConversion === null ? null : cashConversion > 0.8 },
  ];
  const verdict = verdictFrom(checks);

  return {
    category: 'Cash Flow',
    verdict,
    headline:
      r.operating_cf === null
        ? 'Cash-flow figures were not reported by the data provider.'
        : `Operating cash flow ${crores(r.operating_cf)}, free cash flow ${crores(r.free_cash_flow)}.`,
    metrics: [
      { key: 'operatingCashFlow', label: 'Operating cash flow', value: r.operating_cf, unit: '₹ Cr',
        derivation: `Cash generated from operations, latest annual: ${crores(r.operating_cf)}` },
      { key: 'freeCashFlow', label: 'Free cash flow', value: r.free_cash_flow, unit: '₹ Cr',
        derivation: `Operating cash flow − capital expenditure: ${crores(r.free_cash_flow)}` },
      { key: 'cashConversion', label: 'Cash conversion', value: cashConversion, unit: 'ratio',
        derivation: 'Operating cash flow ÷ net profit — how much reported profit arrives as cash' },
    ],
    criteria: [
      'Positive operating cash flow and positive free cash flow each count double.',
      'Cash conversion above 0.8 counts once.',
    ],
  };
}

function assessOwnership(r: FundamentalsRow): CategoryAssessment {
  const checks = [
    { ok: r.promoter_holding === null ? null : r.promoter_holding > 40 },
    { ok: r.pledged_pct === null ? null : r.pledged_pct < 10 },
  ];
  const verdict = verdictFrom(checks);
  return {
    category: 'Ownership',
    verdict,
    headline:
      r.promoter_holding === null
        ? 'Shareholding pattern was not reported by the data provider.'
        : `Promoter holding ${f(r.promoter_holding, 1)}%.`,
    metrics: [
      { key: 'promoterHolding', label: 'Promoter holding', value: r.promoter_holding, unit: '%',
        derivation: 'Share of equity held by promoters. Note: when sourced from EODHD this is the insider-holding field, which approximates but does not exactly equal the Indian promoter-holding definition.' },
      { key: 'fiiHolding', label: 'FII holding', value: r.fii_holding, unit: '%',
        derivation: 'Foreign institutional holding, where reported' },
      { key: 'diiHolding', label: 'DII holding', value: r.dii_holding, unit: '%',
        derivation: 'Domestic institutional holding, where reported' },
    ],
    criteria: [
      'Promoter holding above 40% and pledge below 10% each count once.',
      'A high promoter stake is not inherently positive; it is reported because Indian investors commonly track it.',
    ],
  };
}

/** Quarterly and annual results table. */
export async function getResults(
  instrumentId: number,
  periodType: 'Q' | 'A' = 'Q',
  limit = 8,
): Promise<Sourced<Array<Record<string, unknown>>>> {
  const rows = await queryRows<{
    period_end: Date; revenue: number | null; ebitda: number | null;
    net_profit: number | null; eps: number | null; source: string; as_of: Date;
  }>(
    `SELECT to_char(period_end, 'YYYY-MM-DD') AS period_end, revenue, ebitda, net_profit, eps, source, as_of
       FROM financial_results
      WHERE instrument_id = $1 AND period_type = $2
      ORDER BY period_end DESC LIMIT $3`,
    [instrumentId, periodType, limit],
  );

  if (rows.length === 0) {
    return unavailable(
      'no_results_stored',
      `No ${periodType === 'Q' ? 'quarterly' : 'annual'} results are stored for this instrument. They are populated by the fundamentals sync when a provider is configured.`,
    );
  }

  return sourced(rows as unknown as Array<Record<string, unknown>>, {
    source: rows[0]!.source,
    asOf: rows[0]!.as_of,
    freshness: 'fundamentals',
    kind: 'market_data',
  });
}

export const fundamentalsConfigured = (): boolean => Boolean(env.EODHD_API_KEY || env.FMP_API_KEY);
