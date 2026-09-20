/**
 * The signal engine.
 *
 * A setup definition lists:
 *   · `required`  — every one must pass, or there is no setup at all
 *   · `confirming` — additional evidence; each raises the confirmation strength
 *   · `disqualifying` — any one of these kills the setup outright
 *
 * Strength is the weighted fraction of confirming rules that fired. It is
 * explicitly a measure of *how much rule evidence agrees*, not a probability of
 * profit, and the API labels it that way. Every setup carries the full rule
 * list so the UI can show exactly why it appeared.
 */
import type { TechnicalSnapshot } from '../snapshot.js';
import { RULES, runRule, type RuleResult, type RuleCategory } from './rules.js';

export type SetupKind =
  | 'BREAKOUT'
  | 'PULLBACK'
  | 'MOMENTUM'
  | 'REVERSAL'
  | 'BREAKDOWN'
  | 'RANGE';

export type Direction = 'BULLISH' | 'BEARISH' | 'NEUTRAL';

export interface SetupDefinition {
  kind: SetupKind;
  direction: Direction;
  label: string;
  description: string;
  required: string[];
  confirming: string[];
  disqualifying: string[];
  /** Minimum strength (0–100) before the setup is reported at all. */
  minStrength: number;
}

export const SETUPS: SetupDefinition[] = [
  {
    kind: 'BREAKOUT',
    direction: 'BULLISH',
    label: 'Resistance breakout',
    description:
      'Price has closed above a mapped resistance level. Confirmation comes from volume expansion, momentum agreement and trend alignment.',
    required: ['broke_resistance'],
    confirming: [
      'volume_surge',
      'volume_above_average',
      'rsi_bullish_zone',
      'rsi_rising',
      'macd_above_signal',
      'price_above_sma50',
      'price_above_sma200',
      'adx_trending',
      'supertrend_bullish',
      'obv_rising',
    ],
    disqualifying: ['bearish_divergence'],
    minStrength: 45,
  },
  {
    kind: 'BREAKDOWN',
    direction: 'BEARISH',
    label: 'Support breakdown',
    description:
      'Price has closed below a mapped support level, with volume and momentum confirming the loss of the level.',
    required: ['broke_support'],
    confirming: [
      'volume_surge',
      'volume_above_average',
      'rsi_bearish_zone',
      'rsi_falling',
      'macd_below_signal',
      'ma_stack_bearish',
      'adx_trending',
      'supertrend_bearish',
      'obv_falling',
    ],
    disqualifying: ['bullish_divergence'],
    minStrength: 45,
  },
  {
    kind: 'PULLBACK',
    direction: 'BULLISH',
    label: 'Trend pullback',
    description:
      'An established uptrend has retraced into its moving-average zone. The setup looks for the pullback to hold rather than for fresh strength.',
    required: ['price_above_sma200', 'pullback_to_ema'],
    confirming: [
      'higher_highs_lows',
      'ma_stack_bullish',
      'rsi_bullish_zone',
      'near_support',
      'adx_trending',
      'supertrend_bullish',
      'volume_above_average',
      'di_bullish',
    ],
    disqualifying: ['broke_support', 'bearish_divergence'],
    minStrength: 50,
  },
  {
    kind: 'MOMENTUM',
    direction: 'BULLISH',
    label: 'Momentum continuation',
    description:
      'Trend, momentum and participation are aligned to the upside without price being stretched into an obvious exhaustion zone.',
    required: ['price_above_sma50', 'macd_above_signal'],
    confirming: [
      'ma_stack_bullish',
      'adx_strong_trend',
      'di_bullish',
      'rsi_bullish_zone',
      'rsi_rising',
      'volume_above_average',
      'obv_rising',
      'supertrend_bullish',
      'near_52w_high',
    ],
    disqualifying: ['rsi_overbought', 'bearish_divergence'],
    minStrength: 55,
  },
  {
    kind: 'REVERSAL',
    direction: 'BULLISH',
    label: 'Oversold reversal candidate',
    description:
      'Price is stretched to the downside at a mapped support level with momentum starting to turn. Counter-trend by nature, so it demands more confirmation.',
    required: ['rsi_oversold'],
    confirming: [
      'near_support',
      'bullish_divergence',
      'price_below_lower_band',
      'rsi_rising',
      'macd_bullish_cross',
      'volume_surge',
      'price_above_sma200',
    ],
    disqualifying: ['broke_support'],
    minStrength: 50,
  },
  {
    kind: 'REVERSAL',
    direction: 'BEARISH',
    label: 'Overbought rejection candidate',
    description:
      'Price is stretched to the upside into a mapped resistance level with momentum rolling over.',
    required: ['rsi_overbought'],
    confirming: [
      'near_resistance',
      'bearish_divergence',
      'price_above_upper_band',
      'rsi_falling',
      'macd_bearish_cross',
      'volume_surge',
    ],
    disqualifying: ['broke_resistance'],
    minStrength: 50,
  },
  {
    kind: 'RANGE',
    direction: 'NEUTRAL',
    label: 'Volatility compression',
    description:
      'Bollinger Band width is in the lowest part of its own history. Compression says nothing about direction — only that the range is unusually tight.',
    required: ['bb_squeeze'],
    confirming: ['adx_trending'],
    disqualifying: [],
    minStrength: 30,
  },
];

export interface SetupMatch {
  kind: SetupKind;
  direction: Direction;
  label: string;
  description: string;
  /** 0–100 weighted confirmation strength. NOT a probability. */
  strength: number;
  requiredRules: RuleResult[];
  confirmingRules: RuleResult[];
  disqualifyingRules: RuleResult[];
  /** Short bullet reasons, drawn from the rules that actually passed. */
  reasons: string[];
}

export interface CategoryScores {
  trend: number | null;
  momentum: number | null;
  volume: number | null;
  volatility: number | null;
  structure: number | null;
}

export interface SignalReport {
  symbol: string;
  timeframe: string;
  asOf: string;
  /** Every rule evaluated, for full transparency. */
  allRules: RuleResult[];
  scores: CategoryScores;
  /** Composite of the category scores, weighted. Null if nothing is evaluable. */
  overallScore: number | null;
  setups: SetupMatch[];
  /** Plain-language statement of what the score does and does not mean. */
  interpretation: string;
}

/**
 * Directional rules used for scoring. Each category's score is the weighted
 * balance of its bullish vs bearish rules, mapped onto 0–100 where 50 is
 * neutral. Rules that could not be evaluated are excluded from both the
 * numerator and the denominator, so a short history lowers confidence rather
 * than silently biasing the score.
 */
const SCORING: Record<RuleCategory, { bullish: string[]; bearish: string[] }> = {
  trend: {
    bullish: ['price_above_sma200', 'price_above_sma50', 'ma_stack_bullish', 'di_bullish', 'supertrend_bullish'],
    bearish: ['ma_stack_bearish', 'di_bearish', 'supertrend_bearish'],
  },
  momentum: {
    bullish: ['rsi_bullish_zone', 'rsi_rising', 'macd_above_signal', 'macd_bullish_cross', 'bullish_divergence'],
    bearish: ['rsi_bearish_zone', 'rsi_falling', 'macd_below_signal', 'macd_bearish_cross', 'bearish_divergence'],
  },
  volume: {
    bullish: ['volume_above_average', 'volume_surge', 'obv_rising'],
    bearish: ['obv_falling'],
  },
  volatility: {
    // Volatility is not directional. Score expresses "expansion" vs "compression".
    bullish: ['price_above_upper_band'],
    bearish: ['bb_squeeze', 'price_below_lower_band'],
  },
  structure: {
    bullish: ['higher_highs_lows', 'above_vwap', 'near_52w_high', 'broke_resistance', 'near_support'],
    bearish: ['lower_highs_lows', 'below_vwap', 'near_52w_low', 'broke_support', 'near_resistance'],
  },
};

function scoreCategory(results: Map<string, RuleResult>, category: RuleCategory): number | null {
  const { bullish, bearish } = SCORING[category];
  let bullWeight = 0;
  let bearWeight = 0;
  let totalWeight = 0;

  for (const id of bullish) {
    const r = results.get(id);
    if (!r?.evaluable) continue;
    totalWeight += r.weight;
    if (r.passed) bullWeight += r.weight;
  }
  for (const id of bearish) {
    const r = results.get(id);
    if (!r?.evaluable) continue;
    totalWeight += r.weight;
    if (r.passed) bearWeight += r.weight;
  }

  if (totalWeight === 0) return null;
  // Map net bias from [−1, +1] onto [0, 100].
  const net = (bullWeight - bearWeight) / totalWeight;
  return Math.round(((net + 1) / 2) * 100);
}

/** Evaluate every rule once and reuse the results across all setups. */
export function evaluateAllRules(snapshot: TechnicalSnapshot): Map<string, RuleResult> {
  const out = new Map<string, RuleResult>();
  for (const rule of Object.values(RULES)) {
    out.set(rule.id, runRule(rule, snapshot));
  }
  return out;
}

function matchSetup(
  def: SetupDefinition,
  results: Map<string, RuleResult>,
): SetupMatch | null {
  const requiredRules = def.required.map((id) => results.get(id)).filter((r): r is RuleResult => !!r);
  const confirmingRules = def.confirming.map((id) => results.get(id)).filter((r): r is RuleResult => !!r);
  const disqualifyingRules = def.disqualifying
    .map((id) => results.get(id))
    .filter((r): r is RuleResult => !!r);

  // Every required rule must be both evaluable and passing.
  if (requiredRules.length !== def.required.length) return null;
  if (!requiredRules.every((r) => r.evaluable && r.passed)) return null;

  // Any disqualifier that fired kills the setup.
  if (disqualifyingRules.some((r) => r.evaluable && r.passed)) return null;

  const evaluableConfirming = confirmingRules.filter((r) => r.evaluable);
  const possible = evaluableConfirming.reduce((sum, r) => sum + r.weight, 0);
  const achieved = evaluableConfirming
    .filter((r) => r.passed)
    .reduce((sum, r) => sum + r.weight, 0);

  // The required rules contribute a floor; confirmations fill the rest.
  const REQUIRED_FLOOR = 30;
  const confirmationShare = possible > 0 ? achieved / possible : 0;
  const strength = Math.round(REQUIRED_FLOOR + confirmationShare * (100 - REQUIRED_FLOOR));

  if (strength < def.minStrength) return null;

  const reasons = [
    ...requiredRules.map((r) => r.detail),
    ...evaluableConfirming.filter((r) => r.passed).map((r) => r.detail),
  ];

  return {
    kind: def.kind,
    direction: def.direction,
    label: def.label,
    description: def.description,
    strength,
    requiredRules,
    confirmingRules,
    disqualifyingRules,
    reasons,
  };
}

export function runSignalEngine(snapshot: TechnicalSnapshot): SignalReport {
  const results = evaluateAllRules(snapshot);

  const scores: CategoryScores = {
    trend: scoreCategory(results, 'trend'),
    momentum: scoreCategory(results, 'momentum'),
    volume: scoreCategory(results, 'volume'),
    volatility: scoreCategory(results, 'volatility'),
    structure: scoreCategory(results, 'structure'),
  };

  // Weighted composite; trend and structure carry the most information about
  // direction, volatility the least.
  const WEIGHTS: Record<keyof CategoryScores, number> = {
    trend: 0.3,
    momentum: 0.25,
    structure: 0.25,
    volume: 0.15,
    volatility: 0.05,
  };

  let weighted = 0;
  let weightUsed = 0;
  for (const [key, weight] of Object.entries(WEIGHTS) as Array<[keyof CategoryScores, number]>) {
    const v = scores[key];
    if (v === null) continue;
    weighted += v * weight;
    weightUsed += weight;
  }
  const overallScore = weightUsed > 0 ? Math.round(weighted / weightUsed) : null;

  const setups = SETUPS.map((def) => matchSetup(def, results))
    .filter((m): m is SetupMatch => m !== null)
    .sort((a, b) => b.strength - a.strength);

  const evaluableCount = [...results.values()].filter((r) => r.evaluable).length;

  return {
    symbol: snapshot.symbol,
    timeframe: snapshot.timeframe,
    asOf: snapshot.asOf,
    allRules: [...results.values()],
    scores,
    overallScore,
    setups,
    interpretation:
      `Scores measure how many rule-based conditions currently agree, weighted by rule importance — ` +
      `${evaluableCount} of ${results.size} rules were evaluable on ${snapshot.candleCount} bars of ${snapshot.timeframe} history. ` +
      `A high score means the listed conditions align right now. It is not a forecast, a probability of profit, or a recommendation.`,
  };
}
