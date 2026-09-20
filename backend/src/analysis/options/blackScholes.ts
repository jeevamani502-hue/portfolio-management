/**
 * Black-Scholes pricing, greeks and implied volatility.
 *
 * Indian index options are European-style, which is exactly what Black-Scholes
 * models, so this is the right tool for NIFTY/BANKNIFTY/FINNIFTY. Stock options
 * on NSE are also European since 2011. We use the Black-76 variant when pricing
 * off the futures price, and spot Black-Scholes otherwise.
 *
 * Every greek here is the textbook analytic formula — no approximations, no
 * fitted constants. Where the market provides its own IV we prefer it and mark
 * ours as derived, because a model number and an exchange number are different
 * kinds of fact.
 */

export type OptionType = 'CE' | 'PE';

export interface BsInputs {
  /** Spot (or futures) price of the underlying. */
  spot: number;
  strike: number;
  /** Time to expiry in YEARS. */
  timeToExpiry: number;
  /** Risk-free rate as a decimal (0.065 for 6.5%). */
  rate: number;
  /** Volatility as a decimal (0.18 for 18%). */
  volatility: number;
  /** Continuous dividend yield as a decimal. Zero for index options. */
  dividendYield?: number;
  type: OptionType;
}

export interface Greeks {
  price: number;
  /** ∂V/∂S — change in option value per 1 unit move in the underlying. */
  delta: number;
  /** ∂²V/∂S² — change in delta per 1 unit move. */
  gamma: number;
  /** ∂V/∂t, expressed PER DAY (the convention traders use). */
  theta: number;
  /** ∂V/∂σ, expressed per 1 PERCENTAGE POINT of vol. */
  vega: number;
  /** ∂V/∂r, per 1 percentage point of rate. */
  rho: number;
  d1: number;
  d2: number;
}

const SQRT_2PI = Math.sqrt(2 * Math.PI);

/** Standard normal PDF. */
export const normPdf = (x: number): number => Math.exp(-0.5 * x * x) / SQRT_2PI;

/**
 * Standard normal CDF via Abramowitz & Stegun 7.1.26 applied to erf.
 * Absolute error < 1.5e-7, which is far tighter than any market bid-ask.
 */
export function normCdf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x) / Math.SQRT2;

  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;

  const t = 1 / (1 + p * ax);
  const y = 1 - ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-ax * ax);
  return 0.5 * (1 + sign * y);
}

/**
 * Full analytic greeks. Returns intrinsic value with degenerate greeks when
 * time or volatility has collapsed, rather than dividing by zero.
 */
export function blackScholes(inputs: BsInputs): Greeks {
  const { spot: S, strike: K, timeToExpiry: T, rate: r, volatility: sigma, type } = inputs;
  const q = inputs.dividendYield ?? 0;

  if (!(S > 0) || !(K > 0)) {
    throw new Error('Spot and strike must be positive');
  }

  // At (or past) expiry, or with no volatility, the option is worth intrinsic.
  if (T <= 0 || sigma <= 0) {
    const intrinsic = type === 'CE' ? Math.max(0, S - K) : Math.max(0, K - S);
    const itm = type === 'CE' ? S > K : S < K;
    return {
      price: intrinsic,
      delta: itm ? (type === 'CE' ? 1 : -1) : 0,
      gamma: 0,
      theta: 0,
      vega: 0,
      rho: 0,
      d1: Number.NaN,
      d2: Number.NaN,
    };
  }

  const sqrtT = Math.sqrt(T);
  const d1 = (Math.log(S / K) + (r - q + (sigma * sigma) / 2) * T) / (sigma * sqrtT);
  const d2 = d1 - sigma * sqrtT;

  const discount = Math.exp(-r * T);
  const carry = Math.exp(-q * T);
  const nd1 = normCdf(d1);
  const nd2 = normCdf(d2);
  const pdfD1 = normPdf(d1);

  let price: number;
  let delta: number;
  let theta: number;
  let rho: number;

  if (type === 'CE') {
    price = S * carry * nd1 - K * discount * nd2;
    delta = carry * nd1;
    theta =
      (-(S * carry * pdfD1 * sigma) / (2 * sqrtT) -
        r * K * discount * nd2 +
        q * S * carry * nd1) /
      365;
    rho = (K * T * discount * nd2) / 100;
  } else {
    const nMinusD1 = normCdf(-d1);
    const nMinusD2 = normCdf(-d2);
    price = K * discount * nMinusD2 - S * carry * nMinusD1;
    delta = -carry * nMinusD1;
    theta =
      (-(S * carry * pdfD1 * sigma) / (2 * sqrtT) +
        r * K * discount * nMinusD2 -
        q * S * carry * nMinusD1) /
      365;
    rho = (-K * T * discount * nMinusD2) / 100;
  }

  const gamma = (carry * pdfD1) / (S * sigma * sqrtT);
  const vega = (S * carry * pdfD1 * sqrtT) / 100;

  return { price, delta, gamma, theta, vega, rho, d1, d2 };
}

export interface ImpliedVolResult {
  iv: number | null;
  /** Percent, for display. */
  ivPct: number | null;
  iterations: number;
  converged: boolean;
  reason?: string;
}

/**
 * Implied volatility by Newton-Raphson with a bisection fallback.
 *
 * Newton is fast but unstable for deep ITM/OTM options where vega approaches
 * zero, so we bracket and bisect when it misbehaves. Returns null rather than
 * a garbage number when the market price is outside the no-arbitrage bounds —
 * a wide or stale quote should read as "unavailable", not as 300% vol.
 */
export function impliedVolatility(
  marketPrice: number,
  inputs: Omit<BsInputs, 'volatility'>,
  opts: { tolerance?: number; maxIterations?: number } = {},
): ImpliedVolResult {
  const { tolerance = 1e-6, maxIterations = 100 } = opts;
  const { spot: S, strike: K, timeToExpiry: T, rate: r, type } = inputs;
  const q = inputs.dividendYield ?? 0;

  if (!(marketPrice > 0)) {
    return { iv: null, ivPct: null, iterations: 0, converged: false, reason: 'non_positive_price' };
  }
  if (T <= 0) {
    return { iv: null, ivPct: null, iterations: 0, converged: false, reason: 'expired' };
  }

  // No-arbitrage bounds. Outside them no volatility can reproduce the price.
  const discount = Math.exp(-r * T);
  const carry = Math.exp(-q * T);
  const lowerBound =
    type === 'CE' ? Math.max(0, S * carry - K * discount) : Math.max(0, K * discount - S * carry);
  const upperBound = type === 'CE' ? S * carry : K * discount;

  if (marketPrice < lowerBound - 1e-8) {
    return { iv: null, ivPct: null, iterations: 0, converged: false, reason: 'below_intrinsic' };
  }
  if (marketPrice > upperBound + 1e-8) {
    return { iv: null, ivPct: null, iterations: 0, converged: false, reason: 'above_upper_bound' };
  }

  // Brenner-Subrahmanyam seed: reasonable for near-ATM options.
  let sigma = Math.max(
    0.05,
    Math.min(3, (marketPrice / S) * Math.sqrt((2 * Math.PI) / T)),
  );

  let iterations = 0;
  for (; iterations < maxIterations; iterations += 1) {
    const g = blackScholes({ ...inputs, volatility: sigma });
    const diff = g.price - marketPrice;
    if (Math.abs(diff) < tolerance) {
      return { iv: sigma, ivPct: sigma * 100, iterations, converged: true };
    }
    // vega is per percentage point; convert back to per-unit for Newton.
    const vegaPerUnit = g.vega * 100;
    if (vegaPerUnit < 1e-8) break;
    const next = sigma - diff / vegaPerUnit;
    if (!Number.isFinite(next) || next <= 0 || next > 10) break;
    sigma = next;
  }

  // Bisection fallback over a generous bracket.
  let lo = 1e-4;
  let hi = 10;
  let mid = sigma;
  for (let i = 0; i < 200; i += 1, iterations += 1) {
    mid = (lo + hi) / 2;
    const price = blackScholes({ ...inputs, volatility: mid }).price;
    const diff = price - marketPrice;
    if (Math.abs(diff) < tolerance) {
      return { iv: mid, ivPct: mid * 100, iterations, converged: true };
    }
    if (diff > 0) hi = mid;
    else lo = mid;
  }

  return {
    iv: null,
    ivPct: null,
    iterations,
    converged: false,
    reason: 'did_not_converge',
  };
}

/**
 * Years to expiry from now to the expiry date.
 *
 * Indian index options expire at 15:30 IST on the expiry day. Using calendar
 * time (rather than trading days) matches how exchanges and most platforms
 * quote IV, so our numbers stay comparable.
 */
export function yearsToExpiry(expiryDate: string, now: Date = new Date()): number {
  // 15:30 IST == 10:00 UTC on the expiry date.
  const expiryMs = new Date(`${expiryDate}T10:00:00.000Z`).getTime();
  const years = (expiryMs - now.getTime()) / (365 * 24 * 3600 * 1000);
  return Math.max(0, years);
}

/** Default Indian risk-free rate proxy. Configurable; used only for greeks. */
export const DEFAULT_RISK_FREE_RATE = 0.065;
