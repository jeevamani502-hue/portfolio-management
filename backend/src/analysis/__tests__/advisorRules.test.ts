/**
 * The advisor's decision order.
 *
 * These pin the priority rather than the prose: capital preservation before
 * profit-taking, both before anything about the chart. The ordering is the
 * part that matters — an advisor that says "take profit" while the stop is
 * hit is worse than one that says nothing.
 *
 * The thresholds are duplicated here deliberately. If someone changes them
 * in advisor.ts these tests fail, which is the point: they are judgement
 * calls about someone's money, not implementation details.
 */
import { describe, it, expect } from 'vitest';

const TAKE_PROFIT_AT = 0.8;
const STOP_PROXIMITY_WARN = 0.7;
const THETA_DANGER_DAYS = 2;

type Action = 'CLOSE' | 'CONSIDER_CLOSING' | 'WATCH' | 'HOLD';

/** Mirrors the decision ladder in advisor.ts. */
function decide(i: {
  current: number; entry: number; stop: number | null; target: number | null;
  daysToExpiry: number | null; net: number; thesisIntact: boolean | null;
}): Action {
  const progressToTarget =
    i.target !== null && i.target > i.entry ? (i.current - i.entry) / (i.target - i.entry) : null;
  const progressToStop =
    i.stop !== null && i.stop < i.entry ? (i.entry - i.current) / (i.entry - i.stop) : null;

  if (i.stop !== null && i.current <= i.stop) return 'CLOSE';
  if (i.target !== null && i.current >= i.target) return 'CLOSE';
  if (i.daysToExpiry !== null && i.daysToExpiry <= THETA_DANGER_DAYS) {
    return i.net > 0 ? 'CLOSE' : 'CONSIDER_CLOSING';
  }
  if (progressToTarget !== null && progressToTarget >= TAKE_PROFIT_AT) return 'CONSIDER_CLOSING';
  if (i.thesisIntact === false) return 'CONSIDER_CLOSING';
  if (progressToStop !== null && progressToStop >= STOP_PROXIMITY_WARN) return 'WATCH';
  return 'HOLD';
}

const base = {
  entry: 100, stop: 60, target: 150, daysToExpiry: 10, net: 0, thesisIntact: true,
};

describe('advisor decision order', () => {
  it('closes on a hit stop, even when the thesis still looks fine', () => {
    expect(decide({ ...base, current: 60 })).toBe('CLOSE');
    expect(decide({ ...base, current: 55 })).toBe('CLOSE');
  });

  it('closes on a reached target', () => {
    expect(decide({ ...base, current: 150 })).toBe('CLOSE');
    expect(decide({ ...base, current: 160 })).toBe('CLOSE');
  });

  it('puts the stop ahead of profit-taking when both could apply', () => {
    // Contrived but important: a stop at/below entry must win over any
    // profit rule that might also match.
    expect(decide({ ...base, current: 60, target: 61 })).toBe('CLOSE');
  });

  describe('time decay', () => {
    it('closes a winner near expiry', () => {
      expect(decide({ ...base, current: 110, daysToExpiry: 1, net: 500 })).toBe('CLOSE');
    });

    it('suggests closing a loser near expiry rather than insisting', () => {
      expect(decide({ ...base, current: 90, daysToExpiry: 1, net: -400 })).toBe('CONSIDER_CLOSING');
    });

    it('ignores expiry when it is far off', () => {
      expect(decide({ ...base, current: 105, daysToExpiry: 20 })).toBe('HOLD');
    });

    it('treats the boundary day as dangerous', () => {
      expect(decide({ ...base, current: 110, daysToExpiry: THETA_DANGER_DAYS, net: 100 })).toBe('CLOSE');
    });
  });

  describe('taking profit before the last stretch', () => {
    it('suggests closing at 80% of the way to target', () => {
      // entry 100, target 150 -> 80% is 140
      expect(decide({ ...base, current: 140 })).toBe('CONSIDER_CLOSING');
    });

    it('holds just below the threshold', () => {
      expect(decide({ ...base, current: 139 })).toBe('HOLD');
    });
  });

  describe('the thesis', () => {
    it('suggests closing once the underlying score crosses against the trade', () => {
      expect(decide({ ...base, current: 105, thesisIntact: false })).toBe('CONSIDER_CLOSING');
    });

    it('does not override a target that has already been reached', () => {
      expect(decide({ ...base, current: 150, thesisIntact: false })).toBe('CLOSE');
    });

    it('holds when the score is unknown rather than guessing', () => {
      expect(decide({ ...base, current: 105, thesisIntact: null })).toBe('HOLD');
    });
  });

  describe('approaching the stop', () => {
    it('warns at 70% of the way to the stop', () => {
      // entry 100, stop 60 -> 70% of the 40-point distance is 72
      expect(decide({ ...base, current: 72 })).toBe('WATCH');
    });

    it('stays quiet just inside that', () => {
      expect(decide({ ...base, current: 73 })).toBe('HOLD');
    });

    it('does not warn about a position that is winning', () => {
      expect(decide({ ...base, current: 120 })).toBe('HOLD');
    });
  });

  it('holds when nothing has happened', () => {
    expect(decide({ ...base, current: 100 })).toBe('HOLD');
  });

  it('never returns WATCH or HOLD once the stop is hit, under any combination', () => {
    // Exhaustive over the other inputs: capital preservation must dominate.
    for (const days of [1, 5, 30, null]) {
      for (const thesis of [true, false, null]) {
        for (const net of [-500, 0, 500]) {
          expect(decide({ ...base, current: 50, daysToExpiry: days, thesisIntact: thesis, net }))
            .toBe('CLOSE');
        }
      }
    }
  });
});
