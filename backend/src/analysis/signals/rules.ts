/**
 * The rule library.
 *
 * Each rule is a small, named, independently testable predicate over a
 * TechnicalSnapshot. A rule returns not just pass/fail but the *observation*
 * that justified it — "RSI 28.4 is below 30" — so the UI and the AI can quote
 * the evidence rather than assert a conclusion.
 *
 * No single rule produces a setup. Setups (see engine.ts) require multiple
 * independent confirmations, which is the whole point of section 6 of the
 * brief: one indicator is noise.
 */
import type { TechnicalSnapshot } from '../snapshot.js';

export type RuleCategory = 'trend' | 'momentum' | 'volume' | 'volatility' | 'structure';

export interface RuleResult {
  id: string;
  label: string;
  category: RuleCategory;
  passed: boolean;
  /** Human-readable statement of what was actually observed. */
  detail: string;
  /** Contribution weight when this rule fires. */
  weight: number;
  /** Null when the inputs were unavailable — distinct from a failed rule. */
  evaluable: boolean;
}

export interface Rule {
  id: string;
  label: string;
  category: RuleCategory;
  weight: number;
  evaluate: (s: TechnicalSnapshot) => { passed: boolean; detail: string } | null;
}

const fmt = (v: number | null | undefined, dp = 2): string =>
  v === null || v === undefined ? 'n/a' : v.toFixed(dp);

/** Run one rule, turning a null (uncomputable) result into `evaluable: false`. */
export function runRule(rule: Rule, s: TechnicalSnapshot): RuleResult {
  const outcome = rule.evaluate(s);
  if (outcome === null) {
    return {
      id: rule.id,
      label: rule.label,
      category: rule.category,
      passed: false,
      detail: 'Not evaluable — required indicator unavailable for this history length',
      weight: rule.weight,
      evaluable: false,
    };
  }
  return {
    id: rule.id,
    label: rule.label,
    category: rule.category,
    passed: outcome.passed,
    detail: outcome.detail,
    weight: rule.weight,
    evaluable: true,
  };
}

// ── trend rules ─────────────────────────────────────────────────────────────

export const RULES: Record<string, Rule> = {
  price_above_sma200: {
    id: 'price_above_sma200',
    label: 'Price above 200 SMA',
    category: 'trend',
    weight: 2,
    evaluate: (s) => {
      const ma = s.movingAverages.sma200;
      if (ma === null) return null;
      const passed = s.price.close > ma;
      return {
        passed,
        detail: `Close ${fmt(s.price.close)} is ${passed ? 'above' : 'below'} the 200 SMA ${fmt(ma)}`,
      };
    },
  },

  price_above_sma50: {
    id: 'price_above_sma50',
    label: 'Price above 50 SMA',
    category: 'trend',
    weight: 1.5,
    evaluate: (s) => {
      const ma = s.movingAverages.sma50;
      if (ma === null) return null;
      const passed = s.price.close > ma;
      return {
        passed,
        detail: `Close ${fmt(s.price.close)} is ${passed ? 'above' : 'below'} the 50 SMA ${fmt(ma)}`,
      };
    },
  },

  ma_stack_bullish: {
    id: 'ma_stack_bullish',
    label: 'Moving averages stacked bullishly',
    category: 'trend',
    weight: 2,
    evaluate: (s) => {
      const { ema20, sma50, sma200 } = s.movingAverages;
      if (ema20 === null || sma50 === null || sma200 === null) return null;
      const passed = ema20 > sma50 && sma50 > sma200;
      return {
        passed,
        detail: `EMA20 ${fmt(ema20)} ${ema20 > sma50 ? '>' : '<='} SMA50 ${fmt(sma50)} ${sma50 > sma200 ? '>' : '<='} SMA200 ${fmt(sma200)}`,
      };
    },
  },

  ma_stack_bearish: {
    id: 'ma_stack_bearish',
    label: 'Moving averages stacked bearishly',
    category: 'trend',
    weight: 2,
    evaluate: (s) => {
      const { ema20, sma50, sma200 } = s.movingAverages;
      if (ema20 === null || sma50 === null || sma200 === null) return null;
      const passed = ema20 < sma50 && sma50 < sma200;
      return {
        passed,
        detail: `EMA20 ${fmt(ema20)} ${ema20 < sma50 ? '<' : '>='} SMA50 ${fmt(sma50)} ${sma50 < sma200 ? '<' : '>='} SMA200 ${fmt(sma200)}`,
      };
    },
  },

  adx_trending: {
    id: 'adx_trending',
    label: 'ADX indicates a trending market',
    category: 'trend',
    weight: 1.5,
    evaluate: (s) => {
      const a = s.trend.adx14;
      if (a === null) return null;
      const passed = a >= 20;
      return {
        passed,
        detail: `ADX(14) is ${fmt(a, 1)} — ${passed ? 'above' : 'below'} the 20 threshold commonly used to separate trend from chop`,
      };
    },
  },

  adx_strong_trend: {
    id: 'adx_strong_trend',
    label: 'ADX indicates a strong trend',
    category: 'trend',
    weight: 1,
    evaluate: (s) => {
      const a = s.trend.adx14;
      if (a === null) return null;
      return { passed: a >= 25, detail: `ADX(14) is ${fmt(a, 1)} (strong-trend threshold 25)` };
    },
  },

  di_bullish: {
    id: 'di_bullish',
    label: '+DI above −DI',
    category: 'trend',
    weight: 1,
    evaluate: (s) => {
      const { plusDi, minusDi } = s.trend;
      if (plusDi === null || minusDi === null) return null;
      return {
        passed: plusDi > minusDi,
        detail: `+DI ${fmt(plusDi, 1)} vs −DI ${fmt(minusDi, 1)}`,
      };
    },
  },

  di_bearish: {
    id: 'di_bearish',
    label: '−DI above +DI',
    category: 'trend',
    weight: 1,
    evaluate: (s) => {
      const { plusDi, minusDi } = s.trend;
      if (plusDi === null || minusDi === null) return null;
      return {
        passed: minusDi > plusDi,
        detail: `−DI ${fmt(minusDi, 1)} vs +DI ${fmt(plusDi, 1)}`,
      };
    },
  },

  supertrend_bullish: {
    id: 'supertrend_bullish',
    label: 'Supertrend is bullish',
    category: 'trend',
    weight: 1.5,
    evaluate: (s) => {
      const dir = s.trend.supertrendDirection;
      if (dir === null) return null;
      return {
        passed: dir === 1,
        detail: `Supertrend(10, 3) is ${dir === 1 ? 'bullish' : 'bearish'}, line at ${fmt(s.trend.supertrend)}`,
      };
    },
  },

  supertrend_bearish: {
    id: 'supertrend_bearish',
    label: 'Supertrend is bearish',
    category: 'trend',
    weight: 1.5,
    evaluate: (s) => {
      const dir = s.trend.supertrendDirection;
      if (dir === null) return null;
      return {
        passed: dir === -1,
        detail: `Supertrend(10, 3) is ${dir === -1 ? 'bearish' : 'bullish'}, line at ${fmt(s.trend.supertrend)}`,
      };
    },
  },

  higher_highs_lows: {
    id: 'higher_highs_lows',
    label: 'Higher highs and higher lows',
    category: 'structure',
    weight: 2,
    evaluate: (s) => {
      const a = s.trend.assessment;
      if (a.label === 'UNDETERMINED') return null;
      return {
        passed: a.higherHighs && a.higherLows,
        detail: `Swing structure: ${a.higherHighs ? 'higher high' : 'no higher high'}, ${a.higherLows ? 'higher low' : 'no higher low'}`,
      };
    },
  },

  lower_highs_lows: {
    id: 'lower_highs_lows',
    label: 'Lower highs and lower lows',
    category: 'structure',
    weight: 2,
    evaluate: (s) => {
      const a = s.trend.assessment;
      if (a.label === 'UNDETERMINED') return null;
      return {
        passed: a.lowerHighs && a.lowerLows,
        detail: `Swing structure: ${a.lowerHighs ? 'lower high' : 'no lower high'}, ${a.lowerLows ? 'lower low' : 'no lower low'}`,
      };
    },
  },

  // ── momentum rules ────────────────────────────────────────────────────────

  rsi_oversold: {
    id: 'rsi_oversold',
    label: 'RSI below 30',
    category: 'momentum',
    weight: 2,
    evaluate: (s) => {
      const r = s.momentum.rsi14;
      if (r === null) return null;
      return { passed: r < 30, detail: `RSI(14) is ${fmt(r, 1)}` };
    },
  },

  rsi_overbought: {
    id: 'rsi_overbought',
    label: 'RSI above 70',
    category: 'momentum',
    weight: 2,
    evaluate: (s) => {
      const r = s.momentum.rsi14;
      if (r === null) return null;
      return { passed: r > 70, detail: `RSI(14) is ${fmt(r, 1)}` };
    },
  },

  rsi_bullish_zone: {
    id: 'rsi_bullish_zone',
    label: 'RSI in the bullish 50–70 zone',
    category: 'momentum',
    weight: 1.5,
    evaluate: (s) => {
      const r = s.momentum.rsi14;
      if (r === null) return null;
      return {
        passed: r >= 50 && r <= 70,
        detail: `RSI(14) is ${fmt(r, 1)} — ${r >= 50 && r <= 70 ? 'inside' : 'outside'} the 50–70 band`,
      };
    },
  },

  rsi_bearish_zone: {
    id: 'rsi_bearish_zone',
    label: 'RSI in the bearish 30–50 zone',
    category: 'momentum',
    weight: 1.5,
    evaluate: (s) => {
      const r = s.momentum.rsi14;
      if (r === null) return null;
      return {
        passed: r >= 30 && r <= 50,
        detail: `RSI(14) is ${fmt(r, 1)} — ${r >= 30 && r <= 50 ? 'inside' : 'outside'} the 30–50 band`,
      };
    },
  },

  rsi_rising: {
    id: 'rsi_rising',
    label: 'RSI is rising',
    category: 'momentum',
    weight: 1,
    evaluate: (s) => {
      const { rsi14, rsi14Prev } = s.momentum;
      if (rsi14 === null || rsi14Prev === null) return null;
      return {
        passed: rsi14 > rsi14Prev,
        detail: `RSI moved ${fmt(rsi14Prev, 1)} → ${fmt(rsi14, 1)}`,
      };
    },
  },

  rsi_falling: {
    id: 'rsi_falling',
    label: 'RSI is falling',
    category: 'momentum',
    weight: 1,
    evaluate: (s) => {
      const { rsi14, rsi14Prev } = s.momentum;
      if (rsi14 === null || rsi14Prev === null) return null;
      return {
        passed: rsi14 < rsi14Prev,
        detail: `RSI moved ${fmt(rsi14Prev, 1)} → ${fmt(rsi14, 1)}`,
      };
    },
  },

  macd_bullish_cross: {
    id: 'macd_bullish_cross',
    label: 'MACD crossed above its signal line',
    category: 'momentum',
    weight: 2,
    evaluate: (s) => {
      if (s.momentum.macd === null || s.momentum.macdSignal === null) return null;
      return {
        passed: s.momentum.macdBullishCross,
        detail: s.momentum.macdBullishCross
          ? `MACD ${fmt(s.momentum.macd, 3)} crossed above signal ${fmt(s.momentum.macdSignal, 3)} on the latest bar`
          : `No bullish crossover on the latest bar (MACD ${fmt(s.momentum.macd, 3)}, signal ${fmt(s.momentum.macdSignal, 3)})`,
      };
    },
  },

  macd_bearish_cross: {
    id: 'macd_bearish_cross',
    label: 'MACD crossed below its signal line',
    category: 'momentum',
    weight: 2,
    evaluate: (s) => {
      if (s.momentum.macd === null || s.momentum.macdSignal === null) return null;
      return {
        passed: s.momentum.macdBearishCross,
        detail: s.momentum.macdBearishCross
          ? `MACD ${fmt(s.momentum.macd, 3)} crossed below signal ${fmt(s.momentum.macdSignal, 3)} on the latest bar`
          : `No bearish crossover on the latest bar (MACD ${fmt(s.momentum.macd, 3)}, signal ${fmt(s.momentum.macdSignal, 3)})`,
      };
    },
  },

  macd_above_signal: {
    id: 'macd_above_signal',
    label: 'MACD above its signal line',
    category: 'momentum',
    weight: 1,
    evaluate: (s) => {
      const { macd: m, macdSignal: sig } = s.momentum;
      if (m === null || sig === null) return null;
      return { passed: m > sig, detail: `MACD ${fmt(m, 3)} vs signal ${fmt(sig, 3)}` };
    },
  },

  macd_below_signal: {
    id: 'macd_below_signal',
    label: 'MACD below its signal line',
    category: 'momentum',
    weight: 1,
    evaluate: (s) => {
      const { macd: m, macdSignal: sig } = s.momentum;
      if (m === null || sig === null) return null;
      return { passed: m < sig, detail: `MACD ${fmt(m, 3)} vs signal ${fmt(sig, 3)}` };
    },
  },

  bullish_divergence: {
    id: 'bullish_divergence',
    label: 'Bullish RSI divergence',
    category: 'momentum',
    weight: 2.5,
    evaluate: (s) => {
      const d = s.structure.divergence;
      if (d === null) return { passed: false, detail: 'No divergence detected in recent swings' };
      return { passed: d.type === 'BULLISH', detail: d.detail };
    },
  },

  bearish_divergence: {
    id: 'bearish_divergence',
    label: 'Bearish RSI divergence',
    category: 'momentum',
    weight: 2.5,
    evaluate: (s) => {
      const d = s.structure.divergence;
      if (d === null) return { passed: false, detail: 'No divergence detected in recent swings' };
      return { passed: d.type === 'BEARISH', detail: d.detail };
    },
  },

  // ── volume rules ──────────────────────────────────────────────────────────

  volume_above_average: {
    id: 'volume_above_average',
    label: 'Volume above its 20-period average',
    category: 'volume',
    weight: 1.5,
    evaluate: (s) => {
      const rv = s.volume.relativeVolume;
      if (rv === null) return null;
      return {
        passed: rv > 1,
        detail: `Volume is ${fmt(rv, 2)}× the 20-period average (${s.volume.volume?.toLocaleString('en-IN') ?? 'n/a'} vs ${s.volume.avgVolume20?.toLocaleString('en-IN') ?? 'n/a'})`,
      };
    },
  },

  volume_surge: {
    id: 'volume_surge',
    label: 'Volume at least 1.5× average',
    category: 'volume',
    weight: 2,
    evaluate: (s) => {
      const rv = s.volume.relativeVolume;
      if (rv === null) return null;
      return { passed: rv >= 1.5, detail: `Volume is ${fmt(rv, 2)}× the 20-period average` };
    },
  },

  obv_rising: {
    id: 'obv_rising',
    label: 'On-balance volume rising',
    category: 'volume',
    weight: 1,
    evaluate: (s) => {
      const slope = s.volume.obvSlope5;
      if (slope === null) return null;
      return {
        passed: slope > 0,
        detail: `OBV changed by ${slope.toLocaleString('en-IN', { maximumFractionDigits: 0 })} over the last 5 bars`,
      };
    },
  },

  obv_falling: {
    id: 'obv_falling',
    label: 'On-balance volume falling',
    category: 'volume',
    weight: 1,
    evaluate: (s) => {
      const slope = s.volume.obvSlope5;
      if (slope === null) return null;
      return {
        passed: slope < 0,
        detail: `OBV changed by ${slope.toLocaleString('en-IN', { maximumFractionDigits: 0 })} over the last 5 bars`,
      };
    },
  },

  // ── volatility rules ──────────────────────────────────────────────────────

  bb_squeeze: {
    id: 'bb_squeeze',
    label: 'Bollinger Band squeeze',
    category: 'volatility',
    weight: 1.5,
    evaluate: (s) => {
      const p = s.volatility.bbWidthPercentile;
      if (p === null) return null;
      return {
        passed: p <= 20,
        detail: `Band width is in the ${fmt(p, 0)}th percentile of its own history — ${p <= 20 ? 'a compression often preceding expansion' : 'not compressed'}`,
      };
    },
  },

  price_above_upper_band: {
    id: 'price_above_upper_band',
    label: 'Price at or above the upper Bollinger Band',
    category: 'volatility',
    weight: 1,
    evaluate: (s) => {
      const b = s.volatility.bbPercentB;
      if (b === null) return null;
      return { passed: b >= 100, detail: `%B is ${fmt(b, 1)} (100 = upper band)` };
    },
  },

  price_below_lower_band: {
    id: 'price_below_lower_band',
    label: 'Price at or below the lower Bollinger Band',
    category: 'volatility',
    weight: 1,
    evaluate: (s) => {
      const b = s.volatility.bbPercentB;
      if (b === null) return null;
      return { passed: b <= 0, detail: `%B is ${fmt(b, 1)} (0 = lower band)` };
    },
  },

  // ── structure rules ───────────────────────────────────────────────────────

  above_vwap: {
    id: 'above_vwap',
    label: 'Price above VWAP',
    category: 'structure',
    weight: 1.5,
    evaluate: (s) => {
      if (s.vwap === null) return null;
      const passed = s.price.close > s.vwap;
      return {
        passed,
        detail: `Close ${fmt(s.price.close)} is ${fmt(Math.abs(s.priceVsVwapPct ?? 0), 2)}% ${passed ? 'above' : 'below'} session VWAP ${fmt(s.vwap)}`,
      };
    },
  },

  below_vwap: {
    id: 'below_vwap',
    label: 'Price below VWAP',
    category: 'structure',
    weight: 1.5,
    evaluate: (s) => {
      if (s.vwap === null) return null;
      const passed = s.price.close < s.vwap;
      return {
        passed,
        detail: `Close ${fmt(s.price.close)} is ${fmt(Math.abs(s.priceVsVwapPct ?? 0), 2)}% ${passed ? 'below' : 'above'} session VWAP ${fmt(s.vwap)}`,
      };
    },
  },

  broke_resistance: {
    id: 'broke_resistance',
    label: 'Price broke above a mapped resistance level',
    category: 'structure',
    weight: 3,
    evaluate: (s) => {
      // A break means the previous close was under a level the current close cleared.
      const prevClose = s.price.prevClose;
      if (prevClose === null) return null;
      const broken = s.structure.resistances.find(
        (r) => prevClose <= r.price && s.price.close > r.price,
      );
      if (broken) {
        return {
          passed: true,
          detail: `Closed above resistance at ${fmt(broken.price)} (${broken.touches} prior touches, strength ${broken.strength}/100)`,
        };
      }
      const nearest = s.structure.nearestResistance;
      return {
        passed: false,
        detail: nearest
          ? `Nearest resistance at ${fmt(nearest.price)} is ${fmt(((nearest.price - s.price.close) / s.price.close) * 100, 2)}% above — not yet broken`
          : 'No mapped resistance level within the lookback window',
      };
    },
  },

  broke_support: {
    id: 'broke_support',
    label: 'Price broke below a mapped support level',
    category: 'structure',
    weight: 3,
    evaluate: (s) => {
      const prevClose = s.price.prevClose;
      if (prevClose === null) return null;
      const broken = s.structure.supports.find(
        (l) => prevClose >= l.price && s.price.close < l.price,
      );
      if (broken) {
        return {
          passed: true,
          detail: `Closed below support at ${fmt(broken.price)} (${broken.touches} prior touches, strength ${broken.strength}/100)`,
        };
      }
      const nearest = s.structure.nearestSupport;
      return {
        passed: false,
        detail: nearest
          ? `Nearest support at ${fmt(nearest.price)} is ${fmt(((s.price.close - nearest.price) / s.price.close) * 100, 2)}% below — not yet broken`
          : 'No mapped support level within the lookback window',
      };
    },
  },

  near_support: {
    id: 'near_support',
    label: 'Price near a mapped support level',
    category: 'structure',
    weight: 2,
    evaluate: (s) => {
      const sup = s.structure.nearestSupport;
      const atrPct = s.volatility.atrPct;
      if (!sup || atrPct === null) return null;
      const distancePct = ((s.price.close - sup.price) / s.price.close) * 100;
      // "Near" is scaled to the instrument's own volatility, not a fixed %.
      const passed = distancePct >= 0 && distancePct <= atrPct * 1.5;
      return {
        passed,
        detail: `Price is ${fmt(distancePct, 2)}% above support ${fmt(sup.price)} (ATR is ${fmt(atrPct, 2)}% of price)`,
      };
    },
  },

  near_resistance: {
    id: 'near_resistance',
    label: 'Price near a mapped resistance level',
    category: 'structure',
    weight: 2,
    evaluate: (s) => {
      const res = s.structure.nearestResistance;
      const atrPct = s.volatility.atrPct;
      if (!res || atrPct === null) return null;
      const distancePct = ((res.price - s.price.close) / s.price.close) * 100;
      const passed = distancePct >= 0 && distancePct <= atrPct * 1.5;
      return {
        passed,
        detail: `Price is ${fmt(distancePct, 2)}% below resistance ${fmt(res.price)} (ATR is ${fmt(atrPct, 2)}% of price)`,
      };
    },
  },

  pullback_to_ema: {
    id: 'pullback_to_ema',
    label: 'Pullback into the EMA20/SMA50 zone',
    category: 'structure',
    weight: 2.5,
    evaluate: (s) => {
      const { ema20, sma50 } = s.movingAverages;
      const atrVal = s.volatility.atr14;
      if (ema20 === null || sma50 === null || atrVal === null) return null;
      const lower = Math.min(ema20, sma50) - atrVal * 0.5;
      const upper = Math.max(ema20, sma50) + atrVal * 0.5;
      const passed = s.price.low <= upper && s.price.close >= lower;
      return {
        passed,
        detail: `Bar range touched the ${fmt(lower)}–${fmt(upper)} moving-average zone: ${passed ? 'yes' : 'no'} (low ${fmt(s.price.low)}, close ${fmt(s.price.close)})`,
      };
    },
  },

  near_52w_high: {
    id: 'near_52w_high',
    label: 'Within 5% of the 52-week high',
    category: 'structure',
    weight: 1.5,
    evaluate: (s) => {
      const r = s.structure.range52w;
      if (!r) return null;
      const distancePct = ((r.high - s.price.close) / r.high) * 100;
      return {
        passed: distancePct <= 5,
        detail: `Close is ${fmt(distancePct, 2)}% below the ${fmt(r.high)} range high`,
      };
    },
  },

  near_52w_low: {
    id: 'near_52w_low',
    label: 'Within 5% of the 52-week low',
    category: 'structure',
    weight: 1.5,
    evaluate: (s) => {
      const r = s.structure.range52w;
      if (!r) return null;
      const distancePct = ((s.price.close - r.low) / r.low) * 100;
      return {
        passed: distancePct <= 5,
        detail: `Close is ${fmt(distancePct, 2)}% above the ${fmt(r.low)} range low`,
      };
    },
  },
};

export const ruleById = (id: string): Rule | undefined => RULES[id];
