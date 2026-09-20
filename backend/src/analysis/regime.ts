/**
 * Market regime detection.
 *
 * Combines index trend, breadth, volatility and participation into one of six
 * labelled states. The point is not the label but the metric table behind it:
 * the UI shows every input and its contribution, so a user who disagrees with
 * the label can see exactly which component drove it.
 */
import type { TechnicalSnapshot } from './snapshot.js';

export type Regime =
  | 'STRONG_UPTREND'
  | 'UPTREND'
  | 'RANGE'
  | 'HIGH_VOLATILITY'
  | 'DOWNTREND'
  | 'STRONG_DOWNTREND'
  | 'UNDETERMINED';

export interface RegimeInputs {
  /** Technical snapshot of the benchmark index (usually NIFTY 50). */
  index: TechnicalSnapshot;
  /** India VIX level, if available. */
  vix: number | null;
  /** VIX percentile over stored history, if enough history exists. */
  vixPercentile: number | null;
  breadth: {
    advances: number;
    declines: number;
    unchanged: number;
    totalScanned: number;
  } | null;
  /** Share of the universe trading above its 50/200 SMA, 0–100. */
  pctAboveSma50: number | null;
  pctAboveSma200: number | null;
  /** New 52-week highs minus lows, as a share of the universe. */
  newHighs: number | null;
  newLows: number | null;
}

export interface RegimeComponent {
  name: string;
  /** −100 (maximally bearish) to +100 (maximally bullish). */
  score: number | null;
  weight: number;
  observed: string;
  available: boolean;
}

export interface RegimeResult {
  regime: Regime;
  /** Composite −100..+100. */
  compositeScore: number | null;
  /** How much of the intended evidence was actually available, 0–100. */
  confidence: number;
  components: RegimeComponent[];
  summary: string;
  caveats: string[];
  asOf: string;
}

/** VIX thresholds for the Indian market. India VIX typically sits 10–25. */
const VIX_ELEVATED = 20;
const VIX_HIGH = 25;

export function detectRegime(inputs: RegimeInputs): RegimeResult {
  const { index, vix, vixPercentile, breadth, pctAboveSma50, pctAboveSma200 } = inputs;
  const components: RegimeComponent[] = [];

  // 1. Index trend structure.
  const trend = index.trend.assessment;
  const trendScore =
    trend.label === 'STRONG_UPTREND' ? 100
    : trend.label === 'UPTREND' ? 55
    : trend.label === 'RANGE' ? 0
    : trend.label === 'DOWNTREND' ? -55
    : trend.label === 'STRONG_DOWNTREND' ? -100
    : null;

  components.push({
    name: 'Index trend structure',
    score: trendScore,
    weight: 0.3,
    observed: `${trend.label.replace(/_/g, ' ').toLowerCase()} — ${trend.reasons.slice(0, 2).join('; ') || 'no swing evidence'}`,
    available: trendScore !== null,
  });

  // 2. Moving-average position.
  const { sma50, sma200 } = index.movingAverages;
  const close = index.price.close;
  let maScore: number | null = null;
  let maObserved = 'Insufficient history for 50/200 SMA';
  if (sma50 !== null && sma200 !== null) {
    const aboveBoth = close > sma50 && close > sma200;
    const belowBoth = close < sma50 && close < sma200;
    const goldenCross = sma50 > sma200;
    maScore = aboveBoth ? (goldenCross ? 90 : 50) : belowBoth ? (goldenCross ? -50 : -90) : 0;
    maObserved = `Index ${close.toFixed(2)} vs SMA50 ${sma50.toFixed(2)} and SMA200 ${sma200.toFixed(2)}; 50 SMA is ${goldenCross ? 'above' : 'below'} 200 SMA`;
  }
  components.push({
    name: 'Moving-average position',
    score: maScore,
    weight: 0.2,
    observed: maObserved,
    available: maScore !== null,
  });

  // 3. Breadth.
  let breadthScore: number | null = null;
  let breadthObserved = 'Breadth data unavailable';
  if (breadth && breadth.advances + breadth.declines > 0) {
    const ratio = breadth.advances / (breadth.advances + breadth.declines);
    // Map 0..1 onto −100..+100, so a 50/50 split is neutral.
    breadthScore = (ratio - 0.5) * 200;
    breadthObserved = `${breadth.advances} advancing vs ${breadth.declines} declining (${(ratio * 100).toFixed(1)}% advancing) across ${breadth.totalScanned} stocks`;
  }
  components.push({
    name: 'Market breadth',
    score: breadthScore,
    weight: 0.2,
    observed: breadthObserved,
    available: breadthScore !== null,
  });

  // 4. Participation.
  let participationScore: number | null = null;
  let participationObserved = 'Participation data unavailable';
  if (pctAboveSma50 !== null || pctAboveSma200 !== null) {
    const parts = [pctAboveSma50, pctAboveSma200].filter((v): v is number => v !== null);
    const avg = parts.reduce((s, v) => s + v, 0) / parts.length;
    participationScore = (avg - 50) * 2;
    participationObserved =
      `${pctAboveSma50 !== null ? `${pctAboveSma50.toFixed(0)}% of stocks above their 50 SMA` : ''}` +
      `${pctAboveSma50 !== null && pctAboveSma200 !== null ? ', ' : ''}` +
      `${pctAboveSma200 !== null ? `${pctAboveSma200.toFixed(0)}% above their 200 SMA` : ''}`;
  }
  components.push({
    name: 'Participation',
    score: participationScore,
    weight: 0.15,
    observed: participationObserved,
    available: participationScore !== null,
  });

  // 5. Momentum.
  const rsiVal = index.momentum.rsi14;
  const momentumScore = rsiVal !== null ? Math.max(-100, Math.min(100, (rsiVal - 50) * 3)) : null;
  components.push({
    name: 'Index momentum',
    score: momentumScore,
    weight: 0.15,
    observed: rsiVal !== null ? `Index RSI(14) is ${rsiVal.toFixed(1)}` : 'RSI unavailable',
    available: momentumScore !== null,
  });

  // Composite over available components only.
  let weighted = 0;
  let weightUsed = 0;
  let weightTotal = 0;
  for (const c of components) {
    weightTotal += c.weight;
    if (c.score === null) continue;
    weighted += c.score * c.weight;
    weightUsed += c.weight;
  }
  const compositeScore = weightUsed > 0 ? weighted / weightUsed : null;
  const confidence = weightTotal > 0 ? (weightUsed / weightTotal) * 100 : 0;

  // Volatility is a *state override*, not a directional score: when volatility
  // is extreme, the honest label is HIGH_VOLATILITY regardless of direction.
  const atrPct = index.volatility.atrPct;
  const vixElevated = vix !== null && vix >= VIX_HIGH;
  const vixPercentileHigh = vixPercentile !== null && vixPercentile >= 85;
  const atrElevated = atrPct !== null && atrPct >= 1.8;
  const volatilityOverride = vixElevated || vixPercentileHigh || (vix === null && atrElevated);

  components.push({
    name: 'Volatility',
    score: null, // non-directional by design
    weight: 0,
    observed:
      vix !== null
        ? `India VIX at ${vix.toFixed(2)}${vixPercentile !== null ? ` (${vixPercentile.toFixed(0)}th percentile of stored history)` : ''}`
        : atrPct !== null
          ? `India VIX unavailable; index ATR is ${atrPct.toFixed(2)}% of price`
          : 'Volatility data unavailable',
    available: vix !== null || atrPct !== null,
  });

  let regime: Regime;
  if (compositeScore === null) regime = 'UNDETERMINED';
  else if (volatilityOverride) regime = 'HIGH_VOLATILITY';
  else if (compositeScore >= 60) regime = 'STRONG_UPTREND';
  else if (compositeScore >= 20) regime = 'UPTREND';
  else if (compositeScore <= -60) regime = 'STRONG_DOWNTREND';
  else if (compositeScore <= -20) regime = 'DOWNTREND';
  else regime = 'RANGE';

  const caveats: string[] = [];
  if (confidence < 60) {
    caveats.push(
      `Only ${confidence.toFixed(0)}% of the intended evidence was available; the label is weakly supported.`,
    );
  }
  const missing = components.filter((c) => !c.available && c.weight > 0).map((c) => c.name);
  if (missing.length) caveats.push(`Unavailable inputs: ${missing.join(', ')}.`);
  if (volatilityOverride) {
    caveats.push(
      'Volatility is elevated, which overrides the directional label — in this state, direction tends to be less persistent.',
    );
  }
  caveats.push(
    'Regime describes conditions that have already been observed. It is a summary of the present, not a forecast.',
  );

  const summary = buildSummary(regime, compositeScore, components, vix);

  return { regime, compositeScore, confidence, components, summary, caveats, asOf: index.asOf };
}

function buildSummary(
  regime: Regime,
  composite: number | null,
  components: RegimeComponent[],
  vix: number | null,
): string {
  const label = regime.replace(/_/g, ' ').toLowerCase();
  if (regime === 'UNDETERMINED') {
    return 'Not enough market data was available to classify the current regime.';
  }
  const available = components.filter((c) => c.available && c.weight > 0);
  const detail = available
    .slice(0, 3)
    .map((c) => c.observed)
    .join('. ');
  const volNote =
    vix !== null
      ? vix >= VIX_HIGH
        ? ` India VIX at ${vix.toFixed(2)} is in the elevated zone.`
        : vix >= VIX_ELEVATED
          ? ` India VIX at ${vix.toFixed(2)} is moderately elevated.`
          : ` India VIX at ${vix.toFixed(2)} is subdued.`
      : '';
  return `Current regime reads as ${label}${composite !== null ? ` (composite ${composite.toFixed(0)} on a −100 to +100 scale)` : ''}. ${detail}.${volNote}`;
}
