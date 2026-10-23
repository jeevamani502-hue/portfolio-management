import { describe, it, expect } from 'vitest';
import { decideDirectionExit, type DirectionRead, type GuardedPosition } from '../options/directionGuard.js';

const read = (o: Partial<DirectionRead> = {}): DirectionRead => ({
  biasScore: 65, biasTimeframe: '1h', timingScore: 60, supertrend: 1, aboveVwap: true, emaUp: true, asOf: null, ...o,
});
const call = (o: Partial<GuardedPosition> = {}): GuardedPosition => ({
  action: 'BUY_CALL', horizon: 'intraday', entryPremium: 100, premium: 98, stopPremium: 80, target1Premium: 120,
  maxFavourablePremium: null, ...o,
});

describe('direction guard', () => {
  it('holds while every reading still agrees', () => {
    const d = decideDirectionExit(call(), read());
    expect(d.kind).toBe('HOLD');
    expect(d.against).toEqual([]);
  });

  it('exits the moment the bias chart crosses against the position', () => {
    const d = decideDirectionExit(call({ premium: 110 }), read({ biasScore: 48 }));
    expect(d.kind).toBe('EXIT');
    expect(d.kind === 'EXIT' && d.code).toBe('DIRECTION');
  });

  it('intraday: exits when two timing readings turn, even in profit', () => {
    const d = decideDirectionExit(call({ premium: 108 }), read({ supertrend: -1, aboveVwap: false }));
    expect(d.kind).toBe('EXIT');
    expect(d.kind === 'EXIT' && d.reason).toMatch(/2 of 4 timing readings/);
  });

  it('intraday: one reading turning is not enough', () => {
    expect(decideDirectionExit(call(), read({ supertrend: -1 })).kind).toBe('HOLD');
  });

  it('swing: needs three readings and a losing trade', () => {
    const swing = call({ horizon: 'swing', premium: 95 });
    expect(decideDirectionExit(swing, read({ supertrend: -1, aboveVwap: false })).kind).toBe('HOLD');
    expect(decideDirectionExit(swing, read({ supertrend: -1, aboveVwap: false, emaUp: false })).kind).toBe('EXIT');
    expect(decideDirectionExit({ ...swing, premium: 105 }, read({ supertrend: -1, aboveVwap: false, emaUp: false })).kind).toBe('HOLD');
  });

  it('exits when support has faded, one reading has turned and the trade is losing', () => {
    const d = decideDirectionExit(call({ premium: 97 }), read({ biasScore: 52, supertrend: -1 }));
    expect(d.kind).toBe('EXIT');
    expect(d.kind === 'EXIT' && d.code).toBe('SCORE');
    // Same chart but the trade is winning: hold. Same chart, no reading turned: hold.
    expect(decideDirectionExit(call({ premium: 103 }), read({ biasScore: 52, supertrend: -1 })).kind).toBe('HOLD');
    expect(decideDirectionExit(call({ premium: 97 }), read({ biasScore: 52 })).kind).toBe('HOLD');
  });

  it('intraday: cuts a trade down half a risk unit as soon as one reading turns', () => {
    // Risk unit is 20 (entry 100, stop 80); premium 89 is 11 below entry.
    const d = decideDirectionExit(call({ premium: 89 }), read({ supertrend: -1 }));
    expect(d.kind).toBe('EXIT');
    expect(d.kind === 'EXIT' && d.reason).toMatch(/Losing with the chart turning/);
    // Same loss with nothing turned: still the plan's trade.
    expect(decideDirectionExit(call({ premium: 89 }), read()).kind).toBe('HOLD');
    // Smaller loss with one reading turned: hold, one reading alone is noise.
    expect(decideDirectionExit(call({ premium: 95 }), read({ supertrend: -1 })).kind).toBe('HOLD');
  });

  it('closes a winner that has given most of its gain back', () => {
    const d = decideDirectionExit(call({ premium: 103, maxFavourablePremium: 125 }), read());
    expect(d.kind).toBe('EXIT');
    expect(d.kind === 'EXIT' && d.code).toBe('GIVEBACK');
  });

  it('moves the stop to breakeven halfway to the first target', () => {
    const d = decideDirectionExit(call({ premium: 111, maxFavourablePremium: 111 }), read());
    expect(d.kind).toBe('RAISE_STOP');
    expect(d.kind === 'RAISE_STOP' && d.newStop).toBe(100);
    // Already at breakeven: nothing more to raise.
    expect(decideDirectionExit(call({ premium: 111, maxFavourablePremium: 111, stopPremium: 100 }), read()).kind).toBe('HOLD');
  });

  it('reads puts the other way round', () => {
    const put = call({ action: 'BUY_PUT' });
    expect(decideDirectionExit(put, read({ biasScore: 30, timingScore: 40, supertrend: -1, aboveVwap: false, emaUp: false })).kind).toBe('HOLD');
    expect(decideDirectionExit(put, read({ biasScore: 30, supertrend: 1, aboveVwap: true, emaUp: false, timingScore: 40 })).kind).toBe('EXIT');
  });
});
