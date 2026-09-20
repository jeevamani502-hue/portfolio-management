/**
 * Portfolio mathematics: valuation, XIRR, allocation, concentration and risk.
 *
 * Every function returns both the number and a `method` string describing how
 * it was computed, because the brief is explicit that the platform must
 * "explain the calculation behind every metric". The UI renders that string
 * verbatim in the metric's tooltip.
 */

export interface HoldingInput {
  instrumentId: number;
  symbol: string;
  name: string | null;
  sector: string | null;
  marketCapClass: string | null;
  quantity: number;
  avgPrice: number;
  /** Last traded price. Null when the quote could not be sourced. */
  ltp: number | null;
  prevClose: number | null;
  realizedPnl: number;
}

export interface HoldingValuation extends HoldingInput {
  invested: number;
  currentValue: number | null;
  unrealizedPnl: number | null;
  unrealizedPnlPct: number | null;
  dayPnl: number | null;
  dayPnlPct: number | null;
  /** Share of total portfolio value. Null when the position cannot be valued. */
  weightPct: number | null;
  /** True when this position's price could not be sourced. */
  priceUnavailable: boolean;
}

export interface PortfolioValuation {
  holdings: HoldingValuation[];
  totalInvested: number;
  /** Sum of valued positions only. */
  currentValue: number;
  unrealizedPnl: number;
  realizedPnl: number;
  dayPnl: number | null;
  totalReturnPct: number | null;
  dayReturnPct: number | null;
  /** Positions whose price could not be obtained — excluded from totals. */
  unvaluedSymbols: string[];
  /** Fraction of the book (by cost) that could be valued. */
  valuationCoveragePct: number;
  method: string;
}

export function valuePortfolio(holdings: HoldingInput[]): PortfolioValuation {
  const valued: HoldingValuation[] = holdings.map((h) => {
    const invested = h.quantity * h.avgPrice;
    const priceUnavailable = h.ltp === null;
    const currentValue = h.ltp !== null ? h.quantity * h.ltp : null;
    const unrealizedPnl = currentValue !== null ? currentValue - invested : null;
    const dayPnl =
      h.ltp !== null && h.prevClose !== null ? h.quantity * (h.ltp - h.prevClose) : null;

    return {
      ...h,
      invested,
      currentValue,
      unrealizedPnl,
      unrealizedPnlPct:
        unrealizedPnl !== null && invested > 0 ? (unrealizedPnl / invested) * 100 : null,
      dayPnl,
      dayPnlPct:
        dayPnl !== null && h.prevClose !== null && h.prevClose > 0
          ? ((h.ltp! - h.prevClose) / h.prevClose) * 100
          : null,
      weightPct: null, // filled in below, once the total is known
      priceUnavailable,
    };
  });

  const totalInvested = valued.reduce((s, h) => s + h.invested, 0);
  const currentValue = valued.reduce((s, h) => s + (h.currentValue ?? 0), 0);
  const unrealizedPnl = valued.reduce((s, h) => s + (h.unrealizedPnl ?? 0), 0);
  const realizedPnl = valued.reduce((s, h) => s + h.realizedPnl, 0);

  const dayPnlParts = valued.filter((h) => h.dayPnl !== null);
  const dayPnl = dayPnlParts.length > 0 ? dayPnlParts.reduce((s, h) => s + h.dayPnl!, 0) : null;

  for (const h of valued) {
    h.weightPct = h.currentValue !== null && currentValue > 0
      ? (h.currentValue / currentValue) * 100
      : null;
  }

  const unvalued = valued.filter((h) => h.priceUnavailable);
  const investedValued = valued
    .filter((h) => !h.priceUnavailable)
    .reduce((s, h) => s + h.invested, 0);

  // Previous close value of the valued book, for the day-return denominator.
  const prevValue = valued.reduce(
    (s, h) => s + (h.prevClose !== null ? h.quantity * h.prevClose : 0),
    0,
  );

  return {
    holdings: valued,
    totalInvested,
    currentValue,
    unrealizedPnl,
    realizedPnl,
    dayPnl,
    totalReturnPct: investedValued > 0 ? (unrealizedPnl / investedValued) * 100 : null,
    dayReturnPct: dayPnl !== null && prevValue > 0 ? (dayPnl / prevValue) * 100 : null,
    unvaluedSymbols: unvalued.map((h) => h.symbol),
    valuationCoveragePct:
      totalInvested > 0 ? (investedValued / totalInvested) * 100 : 100,
    method:
      'Invested = Σ(quantity × average price). Current value = Σ(quantity × last traded price). ' +
      "Unrealized P&L = current value − invested. Day P&L = Σ(quantity × (LTP − previous close)). " +
      'Positions whose live price could not be sourced are excluded from totals and listed separately rather than being valued at cost.',
  };
}

// ── XIRR ────────────────────────────────────────────────────────────────────

export interface CashFlow {
  /** Negative for money leaving the investor (buys), positive for inflows. */
  amount: number;
  date: Date;
}

export interface XirrResult {
  xirr: number | null;
  xirrPct: number | null;
  converged: boolean;
  iterations: number;
  reason?: string;
  method: string;
}

/**
 * XIRR — the annualised internal rate of return over irregularly timed flows.
 *
 * Solves Σ CF_i / (1+r)^(d_i/365) = 0 by Newton-Raphson, falling back to
 * bisection over [-0.9999, 10]. Returns null rather than a nonsense figure
 * when the flows have no sign change (there is no IRR to find) or the solver
 * cannot converge.
 */
export function calculateXirr(
  flows: readonly CashFlow[],
  opts: { guess?: number; tolerance?: number; maxIterations?: number } = {},
): XirrResult {
  const { guess = 0.1, tolerance = 1e-7, maxIterations = 100 } = opts;
  const method =
    'XIRR solves Σ CFᵢ ÷ (1+r)^(dᵢ/365) = 0, where dᵢ is days from the first cash flow. ' +
    'Buys and deposits are negative flows, sells and dividends positive, and the current ' +
    'market value of open positions is included as a final positive flow dated today.';

  if (flows.length < 2) {
    return { xirr: null, xirrPct: null, converged: false, iterations: 0,
      reason: 'need_at_least_two_flows', method };
  }

  const sorted = [...flows].sort((a, b) => a.date.getTime() - b.date.getTime());
  const hasPositive = sorted.some((f) => f.amount > 0);
  const hasNegative = sorted.some((f) => f.amount < 0);
  if (!hasPositive || !hasNegative) {
    return { xirr: null, xirrPct: null, converged: false, iterations: 0,
      reason: 'no_sign_change', method };
  }

  const t0 = sorted[0]!.date.getTime();
  const years = sorted.map((f) => (f.date.getTime() - t0) / (365 * 24 * 3600 * 1000));

  const npv = (rate: number): number => {
    let sum = 0;
    for (let i = 0; i < sorted.length; i += 1) {
      sum += sorted[i]!.amount / (1 + rate) ** years[i]!;
    }
    return sum;
  };

  const dNpv = (rate: number): number => {
    let sum = 0;
    for (let i = 0; i < sorted.length; i += 1) {
      const t = years[i]!;
      if (t === 0) continue;
      sum -= (t * sorted[i]!.amount) / (1 + rate) ** (t + 1);
    }
    return sum;
  };

  let rate = guess;
  let iterations = 0;
  for (; iterations < maxIterations; iterations += 1) {
    const value = npv(rate);
    if (Math.abs(value) < tolerance) {
      return { xirr: rate, xirrPct: rate * 100, converged: true, iterations, method };
    }
    const derivative = dNpv(rate);
    if (Math.abs(derivative) < 1e-12) break;
    const next = rate - value / derivative;
    if (!Number.isFinite(next) || next <= -1) break;
    rate = next;
  }

  // Bisection fallback.
  let lo = -0.9999;
  let hi = 10;
  let fLo = npv(lo);
  const fHi = npv(hi);
  if (fLo * fHi > 0) {
    return { xirr: null, xirrPct: null, converged: false, iterations,
      reason: 'no_root_in_bracket', method };
  }
  for (let i = 0; i < 300; i += 1, iterations += 1) {
    const mid = (lo + hi) / 2;
    const fMid = npv(mid);
    if (Math.abs(fMid) < tolerance) {
      return { xirr: mid, xirrPct: mid * 100, converged: true, iterations, method };
    }
    if (fLo * fMid < 0) hi = mid;
    else { lo = mid; fLo = fMid; }
  }

  return { xirr: null, xirrPct: null, converged: false, iterations,
    reason: 'did_not_converge', method };
}

// ── allocation & concentration ──────────────────────────────────────────────

export interface AllocationSlice {
  key: string;
  value: number;
  weightPct: number;
  count: number;
}

export function allocationBy(
  holdings: HoldingValuation[],
  keyFn: (h: HoldingValuation) => string | null,
  unknownLabel = 'Unclassified',
): AllocationSlice[] {
  const buckets = new Map<string, { value: number; count: number }>();
  let total = 0;

  for (const h of holdings) {
    if (h.currentValue === null) continue;
    const key = keyFn(h) ?? unknownLabel;
    const b = buckets.get(key) ?? { value: 0, count: 0 };
    b.value += h.currentValue;
    b.count += 1;
    buckets.set(key, b);
    total += h.currentValue;
  }

  return [...buckets.entries()]
    .map(([key, b]) => ({
      key,
      value: b.value,
      weightPct: total > 0 ? (b.value / total) * 100 : 0,
      count: b.count,
    }))
    .sort((a, b) => b.value - a.value);
}

export interface ConcentrationResult {
  /** Herfindahl-Hirschman Index over position weights, 0–10000. */
  hhi: number | null;
  /** Equivalent number of equally weighted positions. */
  effectivePositions: number | null;
  topHoldingPct: number | null;
  top3Pct: number | null;
  top5Pct: number | null;
  topSectorPct: number | null;
  topSector: string | null;
  positionCount: number;
  method: string;
}

export function calculateConcentration(
  holdings: HoldingValuation[],
  sectorAllocation: AllocationSlice[],
): ConcentrationResult {
  const weights = holdings
    .map((h) => h.weightPct)
    .filter((w): w is number => w !== null)
    .sort((a, b) => b - a);

  const method =
    'HHI = Σ(weightᵢ%)², ranging from ~0 (perfectly diversified) to 10,000 (a single position). ' +
    'Effective positions = 10,000 ÷ HHI, the number of equally weighted holdings that would ' +
    'produce the same concentration.';

  if (weights.length === 0) {
    return { hhi: null, effectivePositions: null, topHoldingPct: null, top3Pct: null,
      top5Pct: null, topSectorPct: null, topSector: null, positionCount: 0, method };
  }

  const hhi = weights.reduce((s, w) => s + w * w, 0);
  const sum = (n: number) => weights.slice(0, n).reduce((s, w) => s + w, 0);
  const topSector = sectorAllocation[0] ?? null;

  return {
    hhi,
    effectivePositions: hhi > 0 ? 10000 / hhi : null,
    topHoldingPct: weights[0] ?? null,
    top3Pct: sum(3),
    top5Pct: sum(5),
    topSectorPct: topSector?.weightPct ?? null,
    topSector: topSector?.key ?? null,
    positionCount: weights.length,
    method,
  };
}

// ── return-series risk ──────────────────────────────────────────────────────

export interface RiskMetrics {
  /** Annualised standard deviation of daily returns, in percent. */
  volatilityPct: number | null;
  maxDrawdownPct: number | null;
  maxDrawdownPeak: number | null;
  maxDrawdownTrough: number | null;
  currentDrawdownPct: number | null;
  sharpe: number | null;
  sortino: number | null;
  beta: number | null;
  alpha: number | null;
  correlation: number | null;
  observations: number;
  method: string;
}

const TRADING_DAYS = 252;

/**
 * Risk statistics from a daily value series.
 *
 * Beta/alpha/correlation require a benchmark series of the same length; when
 * one is not supplied they are null rather than silently omitted.
 */
export function calculateRiskMetrics(
  values: readonly number[],
  opts: {
    benchmarkValues?: readonly number[];
    riskFreeRateAnnual?: number;
    minObservations?: number;
  } = {},
): RiskMetrics {
  const { benchmarkValues, riskFreeRateAnnual = 0.065, minObservations = 20 } = opts;

  const method =
    `Daily returns rᵢ = Vᵢ/Vᵢ₋₁ − 1. Volatility = stdev(r) × √${TRADING_DAYS}. ` +
    `Sharpe = (annualised return − risk-free ${(riskFreeRateAnnual * 100).toFixed(2)}%) ÷ volatility. ` +
    'Sortino uses downside deviation only. Max drawdown is the largest peak-to-trough fall in the value series. ' +
    'Beta = cov(portfolio, benchmark) ÷ var(benchmark); alpha is the annualised CAPM intercept.';

  const empty: RiskMetrics = {
    volatilityPct: null, maxDrawdownPct: null, maxDrawdownPeak: null, maxDrawdownTrough: null,
    currentDrawdownPct: null, sharpe: null, sortino: null, beta: null, alpha: null,
    correlation: null, observations: values.length, method,
  };

  if (values.length < minObservations) return empty;

  const returns: number[] = [];
  for (let i = 1; i < values.length; i += 1) {
    const prev = values[i - 1]!;
    if (prev <= 0) continue;
    returns.push(values[i]! / prev - 1);
  }
  if (returns.length < minObservations - 1) return empty;

  const mean = returns.reduce((s, r) => s + r, 0) / returns.length;
  const variance = returns.reduce((s, r) => s + (r - mean) ** 2, 0) / returns.length;
  const dailyVol = Math.sqrt(variance);
  const annualVol = dailyVol * Math.sqrt(TRADING_DAYS);
  const annualReturn = (1 + mean) ** TRADING_DAYS - 1;

  // Drawdown.
  let peak = values[0]!;
  let maxDd = 0;
  let ddPeak = peak;
  let ddTrough = peak;
  for (const v of values) {
    if (v > peak) peak = v;
    const dd = peak > 0 ? (peak - v) / peak : 0;
    if (dd > maxDd) { maxDd = dd; ddPeak = peak; ddTrough = v; }
  }
  const lastValue = values.at(-1)!;
  const currentDrawdown = peak > 0 ? (peak - lastValue) / peak : 0;

  const sharpe =
    annualVol > 0 ? (annualReturn - riskFreeRateAnnual) / annualVol : null;

  const downside = returns.filter((r) => r < 0);
  const downsideDev =
    downside.length > 0
      ? Math.sqrt(downside.reduce((s, r) => s + r * r, 0) / downside.length) *
        Math.sqrt(TRADING_DAYS)
      : 0;
  const sortino = downsideDev > 0 ? (annualReturn - riskFreeRateAnnual) / downsideDev : null;

  let beta: number | null = null;
  let alpha: number | null = null;
  let correlation: number | null = null;

  if (benchmarkValues && benchmarkValues.length === values.length) {
    const benchReturns: number[] = [];
    for (let i = 1; i < benchmarkValues.length; i += 1) {
      const prev = benchmarkValues[i - 1]!;
      if (prev <= 0) continue;
      benchReturns.push(benchmarkValues[i]! / prev - 1);
    }
    if (benchReturns.length === returns.length && benchReturns.length >= minObservations - 1) {
      const bMean = benchReturns.reduce((s, r) => s + r, 0) / benchReturns.length;
      let cov = 0;
      let bVar = 0;
      for (let i = 0; i < returns.length; i += 1) {
        cov += (returns[i]! - mean) * (benchReturns[i]! - bMean);
        bVar += (benchReturns[i]! - bMean) ** 2;
      }
      cov /= returns.length;
      bVar /= benchReturns.length;

      if (bVar > 0) {
        beta = cov / bVar;
        const benchAnnual = (1 + bMean) ** TRADING_DAYS - 1;
        alpha = annualReturn - (riskFreeRateAnnual + beta * (benchAnnual - riskFreeRateAnnual));
      }
      const bStd = Math.sqrt(bVar);
      if (dailyVol > 0 && bStd > 0) correlation = cov / (dailyVol * bStd);
    }
  }

  return {
    volatilityPct: annualVol * 100,
    maxDrawdownPct: maxDd * 100,
    maxDrawdownPeak: ddPeak,
    maxDrawdownTrough: ddTrough,
    currentDrawdownPct: currentDrawdown * 100,
    sharpe,
    sortino,
    beta,
    alpha: alpha !== null ? alpha * 100 : null,
    correlation,
    observations: returns.length,
    method,
  };
}

/** Pearson correlation between two equal-length return series. */
export function correlation(a: readonly number[], b: readonly number[]): number | null {
  if (a.length !== b.length || a.length < 2) return null;
  const meanA = a.reduce((s, v) => s + v, 0) / a.length;
  const meanB = b.reduce((s, v) => s + v, 0) / b.length;
  let cov = 0;
  let varA = 0;
  let varB = 0;
  for (let i = 0; i < a.length; i += 1) {
    const da = a[i]! - meanA;
    const db = b[i]! - meanB;
    cov += da * db;
    varA += da * da;
    varB += db * db;
  }
  if (varA === 0 || varB === 0) return null;
  return cov / Math.sqrt(varA * varB);
}

/** Pairwise correlation matrix across holdings' return series. */
export function correlationMatrix(
  series: Map<string, readonly number[]>,
): Array<{ a: string; b: string; correlation: number }> {
  const keys = [...series.keys()];
  const out: Array<{ a: string; b: string; correlation: number }> = [];
  for (let i = 0; i < keys.length; i += 1) {
    for (let j = i + 1; j < keys.length; j += 1) {
      const c = correlation(series.get(keys[i]!)!, series.get(keys[j]!)!);
      if (c !== null) out.push({ a: keys[i]!, b: keys[j]!, correlation: c });
    }
  }
  return out.sort((x, y) => y.correlation - x.correlation);
}
