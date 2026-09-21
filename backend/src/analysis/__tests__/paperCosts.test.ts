/**
 * The arithmetic paper trading reports on.
 *
 * These pin the two things most likely to make a simulation lie: charging
 * the real cost stack, and applying slippage against the trader rather than
 * for them. A paper run that quietly skips either will show an edge that
 * does not exist.
 */
import { describe, it, expect } from 'vitest';
import { calculateRoundTripCosts, calculateLegCosts } from '../backtest/costs.js';

/** Mirrors the fill model in paper.service.ts. */
const SLIPPAGE_BPS = 15;
const simulate = (reference: number, side: 'BUY' | 'SELL') => {
  const slip = reference * (SLIPPAGE_BPS / 10_000);
  return Number((side === 'BUY' ? reference + slip : reference - slip).toFixed(2));
};

describe('paper fill simulation', () => {
  it('pays up when buying and receives less when selling', () => {
    // Slippage must never favour the trader, on either side.
    expect(simulate(100, 'BUY')).toBeGreaterThan(100);
    expect(simulate(100, 'SELL')).toBeLessThan(100);
  });

  it('costs the round trip something even when the price does not move', () => {
    const inPrice = simulate(100, 'BUY');
    const outPrice = simulate(100, 'SELL');
    expect(outPrice - inPrice).toBeLessThan(0);
  });

  it('scales with price rather than being a flat rupee amount', () => {
    const cheap = simulate(2, 'BUY') - 2;
    const dear = simulate(200, 'BUY') - 200;
    expect(dear).toBeGreaterThan(cheap);
  });
});

describe('net P&L after the Indian cost stack', () => {
  it('is strictly below gross on a winning option trade', () => {
    const entry = 100;
    const exit = 120;
    const qty = 50;
    const gross = (exit - entry) * qty;

    const costs = calculateRoundTripCosts(entry, exit, qty, 'OPT', 'LONG');
    const net = gross - costs.total;

    expect(gross).toBe(1000);
    expect(costs.total).toBeGreaterThan(0);
    expect(net).toBeLessThan(gross);
  });

  it('makes a losing trade worse, not better', () => {
    const gross = (90 - 100) * 50; // -500
    const costs = calculateRoundTripCosts(100, 90, 50, 'OPT', 'LONG');
    const net = gross - costs.total;
    expect(net).toBeLessThan(gross);
  });

  it('can turn a small gross profit into a net loss', () => {
    // The case that matters: scalping a tick looks profitable until charged.
    const entry = 100;
    const exit = 100.2;
    const qty = 50;
    const gross = (exit - entry) * qty; // ₹10
    const costs = calculateRoundTripCosts(entry, exit, qty, 'OPT', 'LONG');
    expect(costs.total).toBeGreaterThan(gross);
    expect(gross - costs.total).toBeLessThan(0);
  });

  it('charges both legs, not just one', () => {
    const rt = calculateRoundTripCosts(100, 120, 50, 'OPT', 'LONG');
    expect(rt.entry.total).toBeGreaterThan(0);
    expect(rt.exit.total).toBeGreaterThan(0);
    expect(rt.total).toBeCloseTo(rt.entry.total + rt.exit.total, 6);
  });

  it('charges STT on the sell leg of an options trade', () => {
    const sell = calculateLegCosts({ side: 'SELL', price: 120, quantity: 50, segment: 'OPT' });
    expect(sell.stt).toBeGreaterThan(0);
  });

  it('itemises every charge so a result can be audited', () => {
    const leg = calculateLegCosts({ side: 'BUY', price: 100, quantity: 50, segment: 'OPT' });
    const sum = leg.brokerage + leg.stt + leg.exchangeTxn + leg.sebi + leg.gst + leg.stampDuty;
    expect(leg.total).toBeCloseTo(sum, 6);
    expect(leg.explain.length).toBeGreaterThan(0);
  });
});

describe('daily loss limit arithmetic', () => {
  // Mirrors entryBlockedBecause: breach is on <=, so hitting the cap exactly
  // halts rather than allowing one more trade.
  const breached = (pnlToday: number, capital: number, pct: number) =>
    pnlToday <= -(capital * (pct / 100));

  it('halts exactly at the limit, not only beyond it', () => {
    expect(breached(-3000, 100_000, 3)).toBe(true);
  });

  it('allows trading just inside the limit', () => {
    expect(breached(-2999, 100_000, 3)).toBe(false);
  });

  it('is not triggered by profit', () => {
    expect(breached(5000, 100_000, 3)).toBe(false);
  });

  it('scales with capital', () => {
    expect(breached(-3000, 1_000_000, 3)).toBe(false);
    expect(breached(-30_000, 1_000_000, 3)).toBe(true);
  });
});
