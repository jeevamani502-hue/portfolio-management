import { describe, it, expect } from 'vitest';
import {
  calculatePositionSize, calculateRiskReward, checkDailyLoss, atrStop,
  InvalidRiskInput, type RiskConfig,
} from '../risk/positionSizing.js';
import {
  valuePortfolio, calculateXirr, allocationBy, calculateConcentration,
  calculateRiskMetrics, correlation, type HoldingInput,
} from '../portfolio/metrics.js';
import { calculateLegCosts, calculateRoundTripCosts, applySlippage } from '../backtest/costs.js';

const config: RiskConfig = {
  capital: 500000,
  maxRiskPerTradePct: 1,
  maxDailyLossPct: 3,
  maxOpenPositions: 10,
};

describe('calculatePositionSize', () => {
  it('sizes from the risk budget, matching the brief’s worked example', () => {
    // ₹5,00,000 capital, 1% risk → ₹5,000 at risk.
    // Entry 100, stop 95 → ₹5 risk/share → 1000 shares by risk budget,
    // but 1000 × 100 = ₹1,00,000 which is 20% of capital, under the 25% cap.
    const r = calculatePositionSize({ entry: 100, stop: 95, config });
    expect(r.maxCapitalAtRisk).toBe(5000);
    expect(r.riskPerUnit).toBe(5);
    expect(r.quantity).toBe(1000);
    expect(r.actualCapitalAtRisk).toBe(5000);
    expect(r.actualRiskPct).toBeCloseTo(1, 10);
    expect(r.limitedBy).toBe('risk_budget');
  });

  it('applies the concentration cap when the stop is tight', () => {
    // Entry 100, stop 99.5 → ₹0.50 risk → 10,000 shares = ₹10,00,000,
    // which is 200% of capital. The 25% cap must bind.
    const r = calculatePositionSize({ entry: 100, stop: 99.5, config });
    expect(r.limitedBy).toBe('position_cap');
    expect(r.positionValue).toBeLessThanOrEqual(config.capital * 0.25 + 100);
    expect(r.warnings.some((w) => /cap/i.test(w))).toBe(true);
  });

  it('rounds down to whole lots for F&O', () => {
    const r = calculatePositionSize({ entry: 100, stop: 95, config, lotSize: 75 });
    expect(r.quantity % 75).toBe(0);
    expect(r.lots).toBe(Math.floor(r.quantity / 75));
    // Rounding down must never increase risk above the budget.
    expect(r.actualCapitalAtRisk).toBeLessThanOrEqual(r.maxCapitalAtRisk);
  });

  it('reports insufficient capital rather than a fractional lot', () => {
    // One lot of 1000 units at ₹5 risk = ₹5,000 risk; budget is ₹100.
    const tiny: RiskConfig = { ...config, capital: 10000, maxRiskPerTradePct: 1 };
    const r = calculatePositionSize({ entry: 100, stop: 95, config: tiny, lotSize: 1000 });
    expect(r.quantity).toBe(0);
    expect(r.limitedBy).toBe('insufficient_capital');
    expect(r.warnings.length).toBeGreaterThan(0);
  });

  it('detects direction from the stop position', () => {
    expect(calculatePositionSize({ entry: 100, stop: 95, config }).direction).toBe('LONG');
    expect(calculatePositionSize({ entry: 100, stop: 105, config }).direction).toBe('SHORT');
  });

  it('shows its working', () => {
    const r = calculatePositionSize({ entry: 100, stop: 95, config });
    expect(r.explain.length).toBeGreaterThanOrEqual(3);
    expect(r.explain.join(' ')).toMatch(/Risk budget/);
    expect(r.explain.join(' ')).toMatch(/Risk per unit/);
  });

  it('rejects a stop equal to entry', () => {
    expect(() => calculatePositionSize({ entry: 100, stop: 100, config })).toThrow(InvalidRiskInput);
  });

  it('rejects non-positive inputs', () => {
    expect(() => calculatePositionSize({ entry: 0, stop: 95, config })).toThrow(InvalidRiskInput);
    expect(() => calculatePositionSize({ entry: 100, stop: -5, config })).toThrow(InvalidRiskInput);
    expect(() =>
      calculatePositionSize({ entry: 100, stop: 95, config: { ...config, capital: 0 } }),
    ).toThrow(InvalidRiskInput);
  });

  it('never risks more than the configured budget', () => {
    for (const stop of [99, 95, 90, 80, 50]) {
      const r = calculatePositionSize({ entry: 100, stop, config });
      expect(r.actualCapitalAtRisk).toBeLessThanOrEqual(r.maxCapitalAtRisk + 1e-6);
    }
  });
});

describe('calculateRiskReward', () => {
  it('computes the ratio and display string', () => {
    const rr = calculateRiskReward({ entry: 100, stop: 95, target1: 112 });
    expect(rr.riskPerUnit).toBe(5);
    expect(rr.reward1PerUnit).toBe(12);
    expect(rr.riskReward1).toBeCloseTo(2.4, 10);
    expect(rr.display1).toBe('1:2.40');
    expect(rr.valid).toBe(true);
  });

  it('computes break-even win rate from the payoff alone', () => {
    // R = 1 → break-even 50%. R = 3 → 25%.
    expect(calculateRiskReward({ entry: 100, stop: 90, target1: 110 }).breakEvenWinRatePct)
      .toBeCloseTo(50, 6);
    expect(calculateRiskReward({ entry: 100, stop: 90, target1: 130 }).breakEvenWinRatePct)
      .toBeCloseTo(25, 6);
  });

  it('handles short ideas', () => {
    const rr = calculateRiskReward({ entry: 100, stop: 105, target1: 90 });
    expect(rr.riskPerUnit).toBe(5);
    expect(rr.reward1PerUnit).toBe(10);
    expect(rr.riskReward1).toBe(2);
    expect(rr.valid).toBe(true);
  });

  it('flags a target on the wrong side of entry', () => {
    const rr = calculateRiskReward({ entry: 100, stop: 95, target1: 90 });
    expect(rr.valid).toBe(false);
    expect(rr.issues.join(' ')).toMatch(/not above entry/i);
  });

  it('flags target 2 that is not beyond target 1', () => {
    const rr = calculateRiskReward({ entry: 100, stop: 95, target1: 110, target2: 105 });
    expect(rr.valid).toBe(false);
  });
});

describe('checkDailyLoss', () => {
  it('reports the remaining budget', () => {
    const c = checkDailyLoss(config, 5000);
    expect(c.limit).toBe(15000); // 3% of 5,00,000
    expect(c.remaining).toBe(10000);
    expect(c.breached).toBe(false);
  });

  it('flags a breach at or beyond the limit', () => {
    expect(checkDailyLoss(config, 15000).breached).toBe(true);
    expect(checkDailyLoss(config, 20000).breached).toBe(true);
    expect(checkDailyLoss(config, 20000).remaining).toBe(0);
  });
});

describe('atrStop', () => {
  it('places the stop an ATR multiple away in the right direction', () => {
    expect(atrStop(100, 4, 'LONG', 1.5).stop).toBe(94);
    expect(atrStop(100, 4, 'SHORT', 1.5).stop).toBe(106);
  });
});

// ── portfolio ───────────────────────────────────────────────────────────────

const holding = (over: Partial<HoldingInput>): HoldingInput => ({
  instrumentId: 1, symbol: 'NSE:TEST', name: 'Test', sector: 'IT',
  marketCapClass: 'LARGE', quantity: 10, avgPrice: 100, ltp: 110,
  prevClose: 108, realizedPnl: 0, ...over,
});

describe('valuePortfolio', () => {
  it('matches the brief’s worked example', () => {
    // 20 @ ₹2,500 avg, LTP ₹2,650 → invested ₹50,000, value ₹53,000, P&L +₹3,000
    const v = valuePortfolio([
      holding({ symbol: 'NSE:RELIANCE', quantity: 20, avgPrice: 2500, ltp: 2650, prevClose: 2640 }),
    ]);
    expect(v.totalInvested).toBe(50000);
    expect(v.currentValue).toBe(53000);
    expect(v.unrealizedPnl).toBe(3000);
    expect(v.totalReturnPct).toBeCloseTo(6, 10);
    expect(v.dayPnl).toBe(200); // 20 × (2650 − 2640)
  });

  it('EXCLUDES unpriced holdings instead of valuing them at cost', () => {
    const v = valuePortfolio([
      holding({ symbol: 'NSE:A', quantity: 10, avgPrice: 100, ltp: 110, prevClose: 105 }),
      holding({ symbol: 'NSE:B', quantity: 10, avgPrice: 200, ltp: null, prevClose: null }),
    ]);
    expect(v.totalInvested).toBe(3000);       // both count as invested
    expect(v.currentValue).toBe(1100);        // only the priced one is valued
    expect(v.unvaluedSymbols).toEqual(['NSE:B']);
    // Return % is computed only over the valued portion, not silently diluted.
    expect(v.totalReturnPct).toBeCloseTo(10, 10);
    expect(v.valuationCoveragePct).toBeCloseTo((1000 / 3000) * 100, 8);
  });

  it('computes weights that sum to 100 across valued holdings', () => {
    const v = valuePortfolio([
      holding({ symbol: 'A', quantity: 10, avgPrice: 100, ltp: 100 }),
      holding({ symbol: 'B', quantity: 10, avgPrice: 100, ltp: 300 }),
    ]);
    const total = v.holdings.reduce((s, h) => s + (h.weightPct ?? 0), 0);
    expect(total).toBeCloseTo(100, 8);
    expect(v.holdings[1]!.weightPct).toBeCloseTo(75, 8);
  });

  it('includes a plain-language method string', () => {
    expect(valuePortfolio([holding({})]).method).toMatch(/quantity/i);
  });
});

describe('calculateXirr', () => {
  it('computes a simple one-year doubling as ~100%', () => {
    const r = calculateXirr([
      { amount: -100000, date: new Date('2023-01-01') },
      { amount: 200000, date: new Date('2024-01-01') },
    ]);
    expect(r.converged).toBe(true);
    expect(r.xirrPct!).toBeCloseTo(100, 0);
  });

  it('computes a known multi-flow case', () => {
    // ₹1,00,000 in, ₹1,10,000 out after exactly one year → 10%.
    const r = calculateXirr([
      { amount: -100000, date: new Date('2023-01-01') },
      { amount: 110000, date: new Date('2024-01-01') },
    ]);
    expect(r.xirrPct!).toBeCloseTo(10, 1);
  });

  it('handles irregular contributions', () => {
    const r = calculateXirr([
      { amount: -50000, date: new Date('2023-01-01') },
      { amount: -50000, date: new Date('2023-07-01') },
      { amount: 115000, date: new Date('2024-01-01') },
    ]);
    expect(r.converged).toBe(true);
    expect(r.xirrPct!).toBeGreaterThan(0);
  });

  it('returns null with no sign change rather than a bogus rate', () => {
    const r = calculateXirr([
      { amount: -1000, date: new Date('2023-01-01') },
      { amount: -1000, date: new Date('2024-01-01') },
    ]);
    expect(r.xirr).toBeNull();
    expect(r.reason).toBe('no_sign_change');
  });

  it('returns null with fewer than two flows', () => {
    expect(calculateXirr([{ amount: -1000, date: new Date() }]).reason)
      .toBe('need_at_least_two_flows');
  });

  it('reports a negative rate for a loss', () => {
    const r = calculateXirr([
      { amount: -100000, date: new Date('2023-01-01') },
      { amount: 80000, date: new Date('2024-01-01') },
    ]);
    expect(r.xirrPct!).toBeLessThan(0);
    expect(r.xirrPct!).toBeCloseTo(-20, 0);
  });

  it('always explains its method', () => {
    expect(calculateXirr([]).method).toMatch(/XIRR solves/);
  });
});

describe('allocation and concentration', () => {
  it('groups by sector with correct weights', () => {
    const v = valuePortfolio([
      holding({ symbol: 'A', sector: 'IT', quantity: 10, avgPrice: 100, ltp: 100 }),
      holding({ symbol: 'B', sector: 'IT', quantity: 10, avgPrice: 100, ltp: 100 }),
      holding({ symbol: 'C', sector: 'Banking', quantity: 10, avgPrice: 100, ltp: 200 }),
    ]);
    const alloc = allocationBy(v.holdings, (h) => h.sector);
    expect(alloc[0]!.key).toBe('IT');
    expect(alloc[0]!.weightPct).toBeCloseTo(50, 8);
    expect(alloc[0]!.count).toBe(2);
  });

  it('labels missing classification rather than dropping it', () => {
    const v = valuePortfolio([holding({ sector: null, ltp: 100 })]);
    expect(allocationBy(v.holdings, (h) => h.sector)[0]!.key).toBe('Unclassified');
  });

  it('computes HHI and effective positions', () => {
    // Four equal positions → HHI = 4 × 25² = 2500 → 10000/2500 = 4 effective.
    const v = valuePortfolio(
      ['A', 'B', 'C', 'D'].map((s) => holding({ symbol: s, quantity: 10, avgPrice: 100, ltp: 100 })),
    );
    const c = calculateConcentration(v.holdings, allocationBy(v.holdings, (h) => h.sector));
    expect(c.hhi).toBeCloseTo(2500, 6);
    expect(c.effectivePositions).toBeCloseTo(4, 6);
    expect(c.topHoldingPct).toBeCloseTo(25, 6);
  });

  it('reports a single position as maximally concentrated', () => {
    const v = valuePortfolio([holding({ ltp: 100 })]);
    const c = calculateConcentration(v.holdings, []);
    expect(c.hhi).toBeCloseTo(10000, 6);
    expect(c.effectivePositions).toBeCloseTo(1, 6);
  });
});

describe('calculateRiskMetrics', () => {
  it('refuses to compute on too little history', () => {
    const r = calculateRiskMetrics([100, 101, 102]);
    expect(r.volatilityPct).toBeNull();
    expect(r.observations).toBe(3);
  });

  it('reports zero volatility for a flat series', () => {
    const r = calculateRiskMetrics(Array(60).fill(100));
    expect(r.volatilityPct).toBeCloseTo(0, 8);
    expect(r.maxDrawdownPct).toBeCloseTo(0, 8);
  });

  it('measures a known drawdown', () => {
    // Peak 200, trough 150 → 25% drawdown.
    const values = [...Array(30).fill(100), 200, ...Array(30).fill(150)];
    const r = calculateRiskMetrics(values);
    expect(r.maxDrawdownPct).toBeCloseTo(25, 6);
    expect(r.maxDrawdownPeak).toBe(200);
    expect(r.maxDrawdownTrough).toBe(150);
  });

  it('computes beta of ~1 against an identical benchmark', () => {
    const values = Array.from({ length: 80 }, (_, i) => 100 * 1.001 ** i);
    const r = calculateRiskMetrics(values, { benchmarkValues: values });
    expect(r.beta!).toBeCloseTo(1, 4);
    expect(r.correlation!).toBeCloseTo(1, 4);
  });

  it('leaves beta null without a benchmark', () => {
    const r = calculateRiskMetrics(Array.from({ length: 60 }, (_, i) => 100 + i));
    expect(r.beta).toBeNull();
  });
});

describe('correlation', () => {
  it('is 1 for identical series and -1 for mirrored', () => {
    const a = [1, 2, 3, 4, 5];
    expect(correlation(a, a)!).toBeCloseTo(1, 10);
    expect(correlation(a, [5, 4, 3, 2, 1])!).toBeCloseTo(-1, 10);
  });

  it('returns null for mismatched lengths or constant input', () => {
    expect(correlation([1, 2], [1, 2, 3])).toBeNull();
    expect(correlation([1, 1, 1], [1, 2, 3])).toBeNull();
  });
});

// ── Indian cost model ───────────────────────────────────────────────────────

describe('transaction costs', () => {
  it('charges STT on both legs for delivery', () => {
    const buy = calculateLegCosts({ side: 'BUY', price: 100, quantity: 100, segment: 'EQ_DELIVERY' });
    const sell = calculateLegCosts({ side: 'SELL', price: 100, quantity: 100, segment: 'EQ_DELIVERY' });
    expect(buy.stt).toBeGreaterThan(0);
    expect(sell.stt).toBeGreaterThan(0);
    expect(buy.stt).toBeCloseTo(10000 * 0.001, 8); // 0.1% of ₹10,000
  });

  it('charges STT only on the sell leg for intraday', () => {
    const buy = calculateLegCosts({ side: 'BUY', price: 100, quantity: 100, segment: 'EQ_INTRADAY' });
    const sell = calculateLegCosts({ side: 'SELL', price: 100, quantity: 100, segment: 'EQ_INTRADAY' });
    expect(buy.stt).toBe(0);
    expect(sell.stt).toBeGreaterThan(0);
  });

  it('charges stamp duty only on the buy leg', () => {
    const buy = calculateLegCosts({ side: 'BUY', price: 100, quantity: 100, segment: 'EQ_DELIVERY' });
    const sell = calculateLegCosts({ side: 'SELL', price: 100, quantity: 100, segment: 'EQ_DELIVERY' });
    expect(buy.stampDuty).toBeGreaterThan(0);
    expect(sell.stampDuty).toBe(0);
  });

  it('caps intraday brokerage at the configured flat fee', () => {
    const big = calculateLegCosts({ side: 'BUY', price: 10000, quantity: 1000, segment: 'EQ_INTRADAY' });
    expect(big.brokerage).toBeLessThanOrEqual(20);
  });

  it('itemises every charge in explain', () => {
    const c = calculateLegCosts({ side: 'BUY', price: 100, quantity: 100, segment: 'EQ_DELIVERY' });
    const text = c.explain.join(' ');
    for (const term of ['Brokerage', 'STT', 'Exchange', 'SEBI', 'GST', 'Stamp duty', 'Total']) {
      expect(text).toContain(term);
    }
  });

  it('sums a round trip from both legs', () => {
    const rt = calculateRoundTripCosts(100, 110, 100, 'EQ_DELIVERY', 'LONG');
    expect(rt.total).toBeCloseTo(rt.entry.total + rt.exit.total, 10);
    expect(rt.total).toBeGreaterThan(0);
  });

  it('applies slippage against the trader in both directions', () => {
    expect(applySlippage(100, 'BUY', 'EQ_DELIVERY')).toBeGreaterThan(100);
    expect(applySlippage(100, 'SELL', 'EQ_DELIVERY')).toBeLessThan(100);
  });
});
