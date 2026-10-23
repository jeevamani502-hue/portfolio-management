import { describe, it, expect } from 'vitest';
import { intradayEntryBlock, squareOffDue } from '../paper/intradayRules.js';

// 09:00 UTC is 14:30 IST; 09:45 UTC is 15:15 IST.
const ist = (hhmm: string, day = '2026-10-14') => {
  const [h, m] = hhmm.split(':').map(Number);
  return new Date(Date.UTC(2026, 9, Number(day.slice(-2)), (h ?? 0) - 5, (m ?? 0) - 30));
};

const cfg = { intradayOnly: true, entryCutoffMin: 14 * 60 + 30, squareOffMin: 15 * 60 + 15 };

describe('intraday paper rules', () => {
  it('allows entries before the cutoff and refuses them after', () => {
    expect(intradayEntryBlock(cfg, ist('11:00'))).toBeNull();
    expect(intradayEntryBlock(cfg, ist('14:29'))).toBeNull();
    expect(intradayEntryBlock(cfg, ist('14:30'))).toMatch(/cutoff \(14:30 IST\)/);
  });

  it('does nothing when the account is allowed to carry forward', () => {
    const swing = { ...cfg, intradayOnly: false };
    expect(intradayEntryBlock(swing, ist('15:10'))).toBeNull();
    expect(squareOffDue(swing, ist('10:00', '2026-10-13'), ist('10:00'))).toEqual({ due: false });
  });

  it('holds a same-day position until the square-off time', () => {
    const entry = ist('10:15');
    expect(squareOffDue(cfg, entry, ist('15:14'))).toEqual({ due: false });
    const d = squareOffDue(cfg, entry, ist('15:15'));
    expect(d.due).toBe(true);
    expect(d.due && d.reason).toMatch(/square-off at 15:15 IST/);
  });

  it('closes a position left over from an earlier day as soon as it is seen', () => {
    const d = squareOffDue(cfg, ist('14:00', '2026-10-13'), ist('09:31'));
    expect(d.due).toBe(true);
    expect(d.due && d.reason).toMatch(/opened on 2026-10-13/);
  });
});
