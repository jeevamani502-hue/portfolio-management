/**
 * Option-chain analytics: PCR, max pain, OI-derived support/resistance,
 * buildup classification and IV skew.
 *
 * Interpretation discipline (brief section 10): price-and-OI combinations are
 * *interpretations of observed data*, not predictions. Every classification
 * returned here carries the raw numbers it was derived from, and the copy
 * says "consistent with", never "means" or "will".
 */
import type { NormalizedOptionChain, OptionStrike } from '../../providers/types.js';
import {
  blackScholes,
  impliedVolatility,
  yearsToExpiry,
  DEFAULT_RISK_FREE_RATE,
  type Greeks,
} from './blackScholes.js';

export interface PcrResult {
  pcrOi: number | null;
  pcrVolume: number | null;
  totalCallOi: number;
  totalPutOi: number;
  totalCallVolume: number;
  totalPutVolume: number;
  /** Neutral descriptive band, not a directional call. */
  band: 'very_low' | 'low' | 'neutral' | 'high' | 'very_high' | 'unavailable';
  note: string;
}

export function calculatePcr(chain: NormalizedOptionChain): PcrResult {
  let totalCallOi = 0;
  let totalPutOi = 0;
  let totalCallVolume = 0;
  let totalPutVolume = 0;
  let sawOi = false;
  let sawVolume = false;

  for (const s of chain.strikes) {
    if (s.call?.oi != null) { totalCallOi += s.call.oi; sawOi = true; }
    if (s.put?.oi != null) { totalPutOi += s.put.oi; sawOi = true; }
    if (s.call?.volume != null) { totalCallVolume += s.call.volume; sawVolume = true; }
    if (s.put?.volume != null) { totalPutVolume += s.put.volume; sawVolume = true; }
  }

  const pcrOi = sawOi && totalCallOi > 0 ? totalPutOi / totalCallOi : null;
  const pcrVolume = sawVolume && totalCallVolume > 0 ? totalPutVolume / totalCallVolume : null;

  let band: PcrResult['band'] = 'unavailable';
  if (pcrOi !== null) {
    if (pcrOi < 0.5) band = 'very_low';
    else if (pcrOi < 0.8) band = 'low';
    else if (pcrOi <= 1.2) band = 'neutral';
    else if (pcrOi <= 1.5) band = 'high';
    else band = 'very_high';
  }

  return {
    pcrOi,
    pcrVolume,
    totalCallOi,
    totalPutOi,
    totalCallVolume,
    totalPutVolume,
    band,
    note:
      pcrOi === null
        ? 'Open interest was not available for this chain, so PCR could not be computed.'
        : `Put/Call OI ratio is ${pcrOi.toFixed(2)} (${totalPutOi.toLocaleString('en-IN')} put OI vs ${totalCallOi.toLocaleString('en-IN')} call OI). PCR is a positioning statistic; readings at either extreme are commonly read as crowding, but it is not directional evidence on its own.`,
  };
}

export interface MaxPainResult {
  maxPain: number | null;
  /** Total writer payout at each strike, used to plot the curve. */
  payoutByStrike: Array<{ strike: number; totalPayout: number }>;
  note: string;
}

/**
 * Max pain: the strike at which the total intrinsic value payable to option
 * buyers at expiry is lowest, given current open interest.
 *
 * For each candidate settlement price S, the payout is
 *   Σ_calls OI_k × max(0, S − k)  +  Σ_puts OI_k × max(0, k − S)
 * evaluated over every listed strike as a candidate S.
 */
export function calculateMaxPain(chain: NormalizedOptionChain): MaxPainResult {
  const strikes = chain.strikes.filter(
    (s) => (s.call?.oi ?? 0) > 0 || (s.put?.oi ?? 0) > 0,
  );

  if (strikes.length === 0) {
    return {
      maxPain: null,
      payoutByStrike: [],
      note: 'No open interest in this chain, so max pain is undefined.',
    };
  }

  const payoutByStrike = strikes.map((candidate) => {
    let totalPayout = 0;
    for (const s of strikes) {
      const callOi = s.call?.oi ?? 0;
      const putOi = s.put?.oi ?? 0;
      if (candidate.strike > s.strike) totalPayout += callOi * (candidate.strike - s.strike);
      if (candidate.strike < s.strike) totalPayout += putOi * (s.strike - candidate.strike);
    }
    return { strike: candidate.strike, totalPayout };
  });

  const min = payoutByStrike.reduce((best, cur) =>
    cur.totalPayout < best.totalPayout ? cur : best,
  );

  return {
    maxPain: min.strike,
    payoutByStrike,
    note: `Max pain is ${min.strike}: the listed strike at which total intrinsic payout to option buyers would be smallest (₹${min.totalPayout.toLocaleString('en-IN', { maximumFractionDigits: 0 })} in index points × OI) given open interest at this instant. It describes current positioning, and it moves as open interest changes.`,
  };
}

export interface OiLevel {
  strike: number;
  oi: number;
  oiChange: number | null;
  /** Share of total OI on that side. */
  sharePct: number;
}

export interface OiLevels {
  /** Strikes with the largest put OI — commonly read as support. */
  supports: OiLevel[];
  /** Strikes with the largest call OI — commonly read as resistance. */
  resistances: OiLevel[];
  note: string;
}

export function deriveOiLevels(chain: NormalizedOptionChain, topN = 3): OiLevels {
  const totalPutOi = chain.strikes.reduce((s, x) => s + (x.put?.oi ?? 0), 0);
  const totalCallOi = chain.strikes.reduce((s, x) => s + (x.call?.oi ?? 0), 0);

  const putLevels = chain.strikes
    .filter((s) => (s.put?.oi ?? 0) > 0)
    .map((s) => ({
      strike: s.strike,
      oi: s.put!.oi!,
      oiChange: s.put!.oiChange ?? null,
      sharePct: totalPutOi > 0 ? (s.put!.oi! / totalPutOi) * 100 : 0,
    }))
    .sort((a, b) => b.oi - a.oi)
    .slice(0, topN);

  const callLevels = chain.strikes
    .filter((s) => (s.call?.oi ?? 0) > 0)
    .map((s) => ({
      strike: s.strike,
      oi: s.call!.oi!,
      oiChange: s.call!.oiChange ?? null,
      sharePct: totalCallOi > 0 ? (s.call!.oi! / totalCallOi) * 100 : 0,
    }))
    .sort((a, b) => b.oi - a.oi)
    .slice(0, topN);

  return {
    supports: putLevels,
    resistances: callLevels,
    note: 'Strikes carrying the largest open interest. Heavy put OI below spot and call OI above spot are conventionally read as support and resistance because writers at those strikes have an incentive to defend them — this is a convention about positioning, not a physical barrier.',
  };
}

export type BuildupType =
  | 'LONG_BUILDUP'
  | 'SHORT_BUILDUP'
  | 'SHORT_COVERING'
  | 'LONG_UNWINDING'
  | 'INDETERMINATE';

export interface BuildupResult {
  type: BuildupType;
  label: string;
  priceChange: number | null;
  priceChangePct: number | null;
  oiChange: number | null;
  oiChangePct: number | null;
  /** Explicitly framed as an interpretation of two observations. */
  interpretation: string;
}

/**
 * Classify price/OI behaviour.
 *
 *   price ↑ + OI ↑ → long buildup      (new money on the long side)
 *   price ↓ + OI ↑ → short buildup     (new money on the short side)
 *   price ↑ + OI ↓ → short covering    (shorts closing)
 *   price ↓ + OI ↓ → long unwinding    (longs closing)
 *
 * These are conventional readings of two measurable facts. They are not
 * forecasts, and the same pattern can arise from unrelated flows.
 */
export function classifyBuildup(
  priceChange: number | null,
  oiChange: number | null,
  opts: { priceBase?: number | null; oiBase?: number | null; deadbandPct?: number } = {},
): BuildupResult {
  const { priceBase = null, oiBase = null, deadbandPct = 0.1 } = opts;

  const priceChangePct =
    priceBase != null && priceBase !== 0 && priceChange != null
      ? (priceChange / priceBase) * 100
      : null;
  const oiChangePct =
    oiBase != null && oiBase !== 0 && oiChange != null ? (oiChange / oiBase) * 100 : null;

  if (priceChange === null || oiChange === null) {
    return {
      type: 'INDETERMINATE',
      label: 'Indeterminate',
      priceChange,
      priceChangePct,
      oiChange,
      oiChangePct,
      interpretation:
        'Price change or open-interest change was unavailable, so no buildup classification can be made.',
    };
  }

  // A deadband keeps noise from being labelled as a buildup.
  const priceFlat = priceChangePct !== null ? Math.abs(priceChangePct) < deadbandPct : priceChange === 0;
  const oiFlat = oiChangePct !== null ? Math.abs(oiChangePct) < deadbandPct : oiChange === 0;

  if (priceFlat || oiFlat) {
    return {
      type: 'INDETERMINATE',
      label: 'No clear buildup',
      priceChange,
      priceChangePct,
      oiChange,
      oiChangePct,
      interpretation: `Price moved ${fmtSigned(priceChangePct, '%')} and open interest ${fmtSigned(oiChangePct, '%')} — too little change on at least one axis to classify.`,
    };
  }

  const priceUp = priceChange > 0;
  const oiUp = oiChange > 0;

  let type: BuildupType;
  let label: string;
  let interpretation: string;

  if (priceUp && oiUp) {
    type = 'LONG_BUILDUP';
    label = 'Long buildup';
    interpretation = `Price rose ${fmtSigned(priceChangePct, '%')} while open interest rose ${fmtSigned(oiChangePct, '%')}. Rising price with rising OI is conventionally read as fresh long positions being added.`;
  } else if (!priceUp && oiUp) {
    type = 'SHORT_BUILDUP';
    label = 'Short buildup';
    interpretation = `Price fell ${fmtSigned(priceChangePct, '%')} while open interest rose ${fmtSigned(oiChangePct, '%')}. Falling price with rising OI is conventionally read as fresh short positions being added.`;
  } else if (priceUp && !oiUp) {
    type = 'SHORT_COVERING';
    label = 'Short covering';
    interpretation = `Price rose ${fmtSigned(priceChangePct, '%')} while open interest fell ${fmtSigned(oiChangePct, '%')}. Rising price with falling OI is conventionally read as existing shorts closing out.`;
  } else {
    type = 'LONG_UNWINDING';
    label = 'Long unwinding';
    interpretation = `Price fell ${fmtSigned(priceChangePct, '%')} while open interest fell ${fmtSigned(oiChangePct, '%')}. Falling price with falling OI is conventionally read as existing longs closing out.`;
  }

  return { type, label, priceChange, priceChangePct, oiChange, oiChangePct, interpretation };
}

export interface StrikeGreeks {
  strike: number;
  call: (Greeks & { iv: number | null; ivSource: 'provider' | 'derived' | 'unavailable' }) | null;
  put: (Greeks & { iv: number | null; ivSource: 'provider' | 'derived' | 'unavailable' }) | null;
}

/**
 * Compute greeks for every strike.
 *
 * IV preference order: the provider's own IV (an exchange/broker number) over
 * our solved IV (a model output). The `ivSource` field keeps that distinction
 * visible all the way to the UI.
 */
export function computeChainGreeks(
  chain: NormalizedOptionChain,
  opts: { rate?: number; now?: Date } = {},
): { strikes: StrikeGreeks[]; spotUsed: number | null; timeToExpiry: number } {
  const rate = opts.rate ?? DEFAULT_RISK_FREE_RATE;
  const now = opts.now ?? new Date();
  const T = yearsToExpiry(chain.expiry, now);
  // Futures price is the better forward when available.
  const spot = chain.futuresPrice ?? chain.spot;

  if (spot === null || spot <= 0) {
    return { strikes: [], spotUsed: null, timeToExpiry: T };
  }

  const strikes = chain.strikes.map<StrikeGreeks>((s) => ({
    strike: s.strike,
    call: legGreeks(s, 'CE', spot, T, rate),
    put: legGreeks(s, 'PE', spot, T, rate),
  }));

  return { strikes, spotUsed: spot, timeToExpiry: T };
}

function legGreeks(
  s: OptionStrike,
  type: 'CE' | 'PE',
  spot: number,
  T: number,
  rate: number,
): StrikeGreeks['call'] {
  const leg = type === 'CE' ? s.call : s.put;
  if (!leg) return null;

  let iv: number | null = null;
  let ivSource: 'provider' | 'derived' | 'unavailable' = 'unavailable';

  if (leg.iv != null && leg.iv > 0 && leg.iv < 500) {
    iv = leg.iv / 100;
    ivSource = 'provider';
  } else if (leg.ltp != null && leg.ltp > 0) {
    const solved = impliedVolatility(leg.ltp, {
      spot,
      strike: s.strike,
      timeToExpiry: T,
      rate,
      type,
    });
    if (solved.iv !== null) {
      iv = solved.iv;
      ivSource = 'derived';
    }
  }

  if (iv === null) return null;

  const greeks = blackScholes({
    spot,
    strike: s.strike,
    timeToExpiry: T,
    rate,
    volatility: iv,
    type,
  });

  return { ...greeks, iv: iv * 100, ivSource };
}

export interface IvSkew {
  atmStrike: number | null;
  atmIv: number | null;
  /** IV at roughly 10% OTM on each side. */
  otmCallIv: number | null;
  otmPutIv: number | null;
  /** Put IV minus call IV at comparable moneyness. */
  skew: number | null;
  note: string;
}

export function calculateIvSkew(
  chain: NormalizedOptionChain,
  greeks: StrikeGreeks[],
): IvSkew {
  const spot = chain.futuresPrice ?? chain.spot;
  if (spot === null || greeks.length === 0) {
    return {
      atmStrike: null, atmIv: null, otmCallIv: null, otmPutIv: null, skew: null,
      note: 'Spot price or IV data unavailable for this chain.',
    };
  }

  const atm = greeks.reduce((best, g) =>
    Math.abs(g.strike - spot) < Math.abs(best.strike - spot) ? g : best,
  );
  const atmIv = atm.call?.iv ?? atm.put?.iv ?? null;

  const targetCall = spot * 1.1;
  const targetPut = spot * 0.9;
  const nearestCall = greeks.reduce((best, g) =>
    Math.abs(g.strike - targetCall) < Math.abs(best.strike - targetCall) ? g : best,
  );
  const nearestPut = greeks.reduce((best, g) =>
    Math.abs(g.strike - targetPut) < Math.abs(best.strike - targetPut) ? g : best,
  );

  const otmCallIv = nearestCall.call?.iv ?? null;
  const otmPutIv = nearestPut.put?.iv ?? null;
  const skew = otmPutIv !== null && otmCallIv !== null ? otmPutIv - otmCallIv : null;

  return {
    atmStrike: atm.strike,
    atmIv,
    otmCallIv,
    otmPutIv,
    skew,
    note:
      skew === null
        ? 'Not enough IV data on both wings to measure skew.'
        : `IV at the ~10% OTM put (${nearestPut.strike}) is ${otmPutIv!.toFixed(1)}% against ${otmCallIv!.toFixed(1)}% at the ~10% OTM call (${nearestCall.strike}), a skew of ${skew.toFixed(1)} points. A positive skew means downside protection is priced richer than upside.`,
  };
}

export interface IvPercentileResult {
  current: number | null;
  percentile: number | null;
  rank: number | null;
  sampleSize: number;
  note: string;
}

/**
 * IV percentile over stored history.
 *
 * Requires at least 20 historical observations; below that the number would be
 * noise dressed up as a statistic, so we return null and say why.
 */
export function calculateIvPercentile(
  currentIv: number | null,
  historicalIvs: readonly number[],
  minSample = 20,
): IvPercentileResult {
  if (currentIv === null) {
    return { current: null, percentile: null, rank: null, sampleSize: historicalIvs.length,
      note: 'Current IV unavailable.' };
  }
  if (historicalIvs.length < minSample) {
    return {
      current: currentIv, percentile: null, rank: null, sampleSize: historicalIvs.length,
      note: `IV percentile needs at least ${minSample} historical observations; only ${historicalIvs.length} are stored so far. It will become available as history accumulates.`,
    };
  }

  const below = historicalIvs.filter((v) => v <= currentIv).length;
  const percentile = (below / historicalIvs.length) * 100;
  const lo = Math.min(...historicalIvs);
  const hi = Math.max(...historicalIvs);
  const rank = hi > lo ? ((currentIv - lo) / (hi - lo)) * 100 : null;

  return {
    current: currentIv,
    percentile,
    rank,
    sampleSize: historicalIvs.length,
    note: `Current IV of ${currentIv.toFixed(1)}% sits at the ${percentile.toFixed(0)}th percentile of ${historicalIvs.length} stored observations (range ${lo.toFixed(1)}%–${hi.toFixed(1)}%).`,
  };
}

/** Aggregate OI change across the chain, split by side. */
export interface ChainOiShift {
  callOiChange: number;
  putOiChange: number;
  /** Strikes with the biggest OI additions, either side. */
  topCallAdditions: Array<{ strike: number; oiChange: number }>;
  topPutAdditions: Array<{ strike: number; oiChange: number }>;
  topCallUnwinds: Array<{ strike: number; oiChange: number }>;
  topPutUnwinds: Array<{ strike: number; oiChange: number }>;
}

export function analyzeOiShift(chain: NormalizedOptionChain, topN = 3): ChainOiShift {
  const calls = chain.strikes
    .filter((s) => s.call?.oiChange != null)
    .map((s) => ({ strike: s.strike, oiChange: s.call!.oiChange! }));
  const puts = chain.strikes
    .filter((s) => s.put?.oiChange != null)
    .map((s) => ({ strike: s.strike, oiChange: s.put!.oiChange! }));

  return {
    callOiChange: calls.reduce((sum, c) => sum + c.oiChange, 0),
    putOiChange: puts.reduce((sum, p) => sum + p.oiChange, 0),
    topCallAdditions: [...calls].sort((a, b) => b.oiChange - a.oiChange).slice(0, topN),
    topPutAdditions: [...puts].sort((a, b) => b.oiChange - a.oiChange).slice(0, topN),
    topCallUnwinds: [...calls].sort((a, b) => a.oiChange - b.oiChange).slice(0, topN),
    topPutUnwinds: [...puts].sort((a, b) => a.oiChange - b.oiChange).slice(0, topN),
  };
}

function fmtSigned(v: number | null, suffix = ''): string {
  if (v === null) return 'an unknown amount';
  return `${v >= 0 ? '+' : ''}${v.toFixed(2)}${suffix}`;
}
