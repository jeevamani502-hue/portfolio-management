/**
 * Tests for the F&O setup engine.
 *
 * The engine decides whether real money goes into an option, so the cases
 * that matter most are the refusals. Several of these come from defects found
 * against a live chain: a closed market quoting 0/0 scored as perfect
 * liquidity, and a stop the option could never survive to reach was printed
 * as a ₹0.05 stop price.
 */
import { describe, it, expect } from 'vitest';
import { buildOptionSetup, type OptionSetupInput } from '../options/setupEngine.js';
import type { NormalizedOptionChain, OptionStrike } from '../../providers/types.js';
import type { SignalReport } from '../signals/engine.js';

const leg = (over: Partial<{ ltp: number; bid: number; ask: number; oi: number }> = {}) => ({
  oi: over.oi ?? 100_000,
  oiChange: null,
  volume: 5_000,
  ltp: over.ltp ?? 100,
  iv: null,
  bid: over.bid ?? 99,
  ask: over.ask ?? 101,
  bidQty: 500,
  askQty: 500,
  prevClose: over.ltp ?? 100,
});

/** A symmetric chain around 20000 with 100-point spacing. */
function chainAround(spot: number, opts: { lotSize?: number; legOver?: Parameters<typeof leg>[0] } = {}): NormalizedOptionChain {
  const strikes: OptionStrike[] = [];
  for (let k = spot - 500; k <= spot + 500; k += 100) {
    const rounded = Math.round(k / 100) * 100;
    strikes.push({ strike: rounded, call: leg(opts.legOver), put: leg(opts.legOver) });
  }
  const expiry = new Date(Date.now() + 7 * 864e5).toISOString().slice(0, 10);
  return {
    underlying: 'NIFTY', expiry, spot, futuresPrice: null,
    strikes, timestamp: new Date().toISOString(), lotSize: opts.lotSize ?? 50,
  };
}

const signal = (overallScore: number | null): SignalReport => ({
  symbol: 'NIFTY', timeframe: '1d', asOf: new Date().toISOString(),
  allRules: [], scores: {} as SignalReport['scores'], overallScore,
  setups: [], interpretation: '',
});

const input = (over: Partial<OptionSetupInput> = {}): OptionSetupInput => ({
  underlying: 'NIFTY',
  chain: chainAround(20000),
  signal: signal(75),
  atr: 200,
  capital: 500_000,
  riskPercent: 2,
  ...over,
});

describe('buildOptionSetup', () => {
  describe('refusals', () => {
    it('refuses when the rules have no directional agreement', () => {
      const s = buildOptionSetup(input({ signal: signal(50) }));
      expect(s.action).toBe('NO_TRADE');
      expect(s.bias).toBe('NEUTRAL');
      expect(s.rejectedBecause.join(' ')).toMatch(/do not agree on a direction/);
    });

    it('refuses without capital rather than assuming an amount', () => {
      const s = buildOptionSetup(input({ capital: 0 }));
      expect(s.action).toBe('NO_TRADE');
      expect(s.rejectedBecause.join(' ')).toMatch(/capital must be entered/i);
    });

    it('refuses when the underlying has no score', () => {
      expect(buildOptionSetup(input({ signal: signal(null) })).action).toBe('NO_TRADE');
    });

    it('refuses when there is no ATR to place a stop against', () => {
      const s = buildOptionSetup(input({ atr: null }));
      expect(s.action).toBe('NO_TRADE');
      expect(s.rejectedBecause.join(' ')).toMatch(/invalidation/i);
    });

    it('refuses when one lot exceeds the risk budget, and says the numbers', () => {
      // A real case: ₹1L at 1% is ₹1,000, far under one lot's stop risk.
      const s = buildOptionSetup(input({ capital: 20_000, riskPercent: 1 }));
      expect(s.action).toBe('NO_TRADE');
      expect(s.rejectedBecause.join(' ')).toMatch(/does not cover one lot/);
    });

    it('refuses when the spot is unknown', () => {
      const chain = { ...chainAround(20000), spot: null };
      expect(buildOptionSetup(input({ chain })).action).toBe('NO_TRADE');
    });
  });

  describe('direction', () => {
    it('buys a call on a bullish score, one strike out of the money', () => {
      const s = buildOptionSetup(input({ signal: signal(75) }));
      expect(s.action).toBe('BUY_CALL');
      expect(s.optionType).toBe('CE');
      expect(s.bias).toBe('BULLISH');
      expect(s.strike).toBe(20100); // ATM 20000 + one 100-point step
    });

    it('buys a put on a bearish score, one strike out of the money', () => {
      const s = buildOptionSetup(input({ signal: signal(25) }));
      expect(s.action).toBe('BUY_PUT');
      expect(s.optionType).toBe('PE');
      expect(s.strike).toBe(19900);
    });

    it('infers strike spacing from the chain rather than assuming it', () => {
      // A genuine 200-point ladder, not a 100-point one with gaps.
      const chain = chainAround(20000);
      chain.strikes = [];
      for (let k = 19000; k <= 21000; k += 200) {
        chain.strikes.push({ strike: k, call: leg(), put: leg() });
      }
      expect(buildOptionSetup(input({ chain, signal: signal(75) })).strike).toBe(20200);
    });
  });

  describe('sizing from the capital the user typed', () => {
    it('never risks more than the stated percentage', () => {
      const s = buildOptionSetup(input({ capital: 1_000_000, riskPercent: 2 }));
      expect(s.action).not.toBe('NO_TRADE');
      expect(s.sizing!.actualCapitalAtRisk).toBeLessThanOrEqual(1_000_000 * 0.02 + 0.01);
    });

    it('deals in whole lots only', () => {
      const s = buildOptionSetup(input({ capital: 1_000_000, chain: chainAround(20000, { lotSize: 50 }) }));
      expect(s.sizing!.quantity % 50).toBe(0);
      expect(s.sizing!.lots).toBe(s.sizing!.quantity / 50);
    });

    it('reports the whole premium as the outlay, not just the stop distance', () => {
      const s = buildOptionSetup(input({ capital: 1_000_000 }));
      expect(s.totalPremiumAtRisk).toBeCloseTo(s.entryPremium! * s.sizing!.quantity, 2);
      // Buying an option can lose the whole premium, which is the larger number.
      expect(s.totalPremiumAtRisk!).toBeGreaterThanOrEqual(s.sizing!.actualCapitalAtRisk - 0.01);
    });

    it('scales lots with capital', () => {
      const small = buildOptionSetup(input({ capital: 500_000 }));
      const large = buildOptionSetup(input({ capital: 2_000_000 }));
      expect(large.sizing!.lots!).toBeGreaterThan(small.sizing!.lots!);
    });
  });

  describe('honesty about liquidity and stops', () => {
    it('does not score an unquoted strike as tight — a 0/0 book is not a 0% spread', () => {
      const s = buildOptionSetup(input({
        capital: 1_000_000,
        chain: chainAround(20000, { legOver: { bid: 0, ask: 0, ltp: 100 } }),
      }));
      expect(s.warnings.join(' ')).toMatch(/No two-sided quote/);
      // The unquoted version must not score above the properly quoted one.
      const quoted = buildOptionSetup(input({ capital: 1_000_000 }));
      expect(s.confirmation).toBeLessThan(quoted.confirmation);
    });

    it('warns when the option dies before the underlying stop is reached', () => {
      // Cheap premium, wide ATR: the adverse move costs more than the option.
      const s = buildOptionSetup(input({
        capital: 2_000_000,
        atr: 800,
        chain: chainAround(20000, { legOver: { ltp: 2, bid: 1.9, ask: 2.1 } }),
      }));
      expect(s.warnings.join(' ')).toMatch(/worthless before the underlying stop/);
      expect(s.warnings.join(' ')).toMatch(/entire premium as the risk/);
    });

    it('flags an illiquid strike with no open interest', () => {
      const s = buildOptionSetup(input({
        capital: 1_000_000,
        chain: chainAround(20000, { legOver: { oi: 0 } }),
      }));
      expect(s.warnings.join(' ')).toMatch(/no open interest/);
    });
  });

  describe('evidence and framing', () => {
    it('attributes every evidence item to a source', () => {
      const s = buildOptionSetup(input({ capital: 1_000_000 }));
      expect(s.evidence.length).toBeGreaterThan(5);
      for (const e of s.evidence) {
        expect(['chain', 'signal_engine', 'calculated', 'user_input']).toContain(e.source);
      }
    });

    it('records the user-supplied capital as user_input, never as market data', () => {
      const s = buildOptionSetup(input({ capital: 750_000 }));
      const cap = s.evidence.find((e) => e.label === 'Capital');
      expect(cap?.source).toBe('user_input');
      expect(cap?.value).toContain('750000');
    });

    it('states that confirmation is not a probability', () => {
      const s = buildOptionSetup(input({ capital: 1_000_000 }));
      expect(s.interpretation).toMatch(/not a probability/i);
    });

    it('names the invalidation level on the underlying', () => {
      const s = buildOptionSetup(input({ capital: 1_000_000, signal: signal(75), atr: 200 }));
      expect(s.underlyingStop).toBeLessThan(s.spot!);   // long call -> stop below
      expect(s.underlyingTarget).toBeGreaterThan(s.spot!);
      expect(s.interpretation).toMatch(/exit if/i);
    });
  });

  it('is deterministic — same inputs, same output', () => {
    // `now` must be pinned: greeks depend on time to expiry, so two calls a
    // millisecond apart legitimately differ in the far decimals.
    const chain = chainAround(20000);
    const now = new Date('2026-09-20T10:00:00Z');
    const args = { capital: 1_000_000, chain, now };
    expect(buildOptionSetup(input(args))).toEqual(buildOptionSetup(input(args)));
  });
});
