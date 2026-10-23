import { describe, it, expect } from 'vitest';
import { resolveSignalOutcome, type TrackedSignal } from '../options/signalOutcome.js';

// IST = UTC + 5:30. 04:30Z is 10:00 IST; 09:46Z is 15:16 IST.
const signal = (horizon: 'intraday' | 'swing'): TrackedSignal => ({
  action: 'BUY_CALL', horizon, expiry: '2026-10-22',
  generatedAt: '2026-10-14T04:30:00.000Z',
  entryPremium: 100, stopPremium: 80, target1Premium: 120, target2Premium: 140,
  underlyingStop: 25000, maxFavourablePremium: null, maxAdversePremium: null,
});
const obs = (iso: string) => ({ premium: 101, spot: 25100, now: new Date(iso) });

describe('intraday signal time stop', () => {
  it('stays active during its own session', () => {
    expect(resolveSignalOutcome(signal('intraday'), obs('2026-10-14T08:30:00.000Z')).status).toBe('ACTIVE'); // 14:00 IST
  });
  it('times out at the 15:15 IST square-off of the same day', () => {
    const o = resolveSignalOutcome(signal('intraday'), obs('2026-10-14T09:46:00.000Z')); // 15:16 IST
    expect(o.status).toBe('TIMED_OUT');
    expect(o.rMultiple).toBeCloseTo(0.05, 2);
    expect(o.note).toMatch(/square-off/);
  });
  it('times out on the next morning if it was somehow still open', () => {
    expect(resolveSignalOutcome(signal('intraday'), obs('2026-10-15T04:00:00.000Z')).status).toBe('TIMED_OUT');
  });
  it('leaves swing signals on the three-day rule', () => {
    expect(resolveSignalOutcome(signal('swing'), obs('2026-10-15T04:00:00.000Z')).status).toBe('ACTIVE');
    expect(resolveSignalOutcome(signal('swing'), obs('2026-10-17T05:00:00.000Z')).status).toBe('TIMED_OUT');
  });
});
