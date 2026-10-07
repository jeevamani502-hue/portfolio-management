/**
 * Tests for signal outcome resolution and the track-record summary.
 *
 * The priority order is the point: a stop and a target in the same
 * observation must resolve as the stop, and an invalidated thesis must
 * count as a loss even when the premium is still above its nominal stop.
 */
import { describe, it, expect } from 'vitest';
import {
  resolveSignalOutcome, summariseByGrade, isWin, TIME_STOP_DAYS,
  type TrackedSignal,
} from '../options/signalOutcome.js';
import { fromIst } from '../../utils/time.js';

const ISSUED = fromIst('2026-09-23', 11, 0);

const call = (over: Partial<TrackedSignal> = {}): TrackedSignal => ({
  action: 'BUY_CALL',
  expiry: '2026-09-30',
  generatedAt: ISSUED.toISOString(),
  entryPremium: 100,
  stopPremium: 60,
  target1Premium: 160,
  target2Premium: 200,
  underlyingStop: 24_700,
  maxFavourablePremium: null,
  maxAdversePremium: null,
  ...over,
});

const at = (hour: number, minute = 0, day = '2026-09-23') => fromIst(day, hour, minute);

describe('resolveSignalOutcome', () => {
  it('stays active inside the plan', () => {
    const o = resolveSignalOutcome(call(), { premium: 110, spot: 25_050, now: at(12) });
    expect(o.status).toBe('ACTIVE');
    expect(o.rMultiple).toBeNull();
    expect(o.maxFavourablePremium).toBe(110);
  });

  it('resolves a stop with a negative R from the observed premium, not the level', () => {
    const o = resolveSignalOutcome(call(), { premium: 55, spot: 24_900, now: at(12) });
    expect(o.status).toBe('STOPPED');
    // (55 − 100) / (100 − 60) = −1.125: a gap through the stop costs more than 1R.
    expect(o.rMultiple).toBeCloseTo(-1.125, 3);
  });

  it('resolves target 1 and target 2 with positive R', () => {
    expect(resolveSignalOutcome(call(), { premium: 162, spot: 25_300, now: at(12) }).status).toBe('TARGET1_HIT');
    const t2 = resolveSignalOutcome(call(), { premium: 210, spot: 25_500, now: at(12) });
    expect(t2.status).toBe('TARGET2_HIT');
    expect(t2.rMultiple).toBeCloseTo(2.75, 3);
  });

  it('prefers the stop when the observation satisfies both stop and target', () => {
    // A premium at the stop can only happen with the target hit if the
    // levels are degenerate; construct that to pin the priority.
    const o = resolveSignalOutcome(call({ target1Premium: 50 }), { premium: 55, spot: 25_000, now: at(12) });
    expect(o.status).toBe('STOPPED');
  });

  it('invalidates when the underlying trades through its stop even if the premium has not', () => {
    const o = resolveSignalOutcome(call(), { premium: 80, spot: 24_650, now: at(12) });
    expect(o.status).toBe('INVALIDATED');
    expect(o.rMultiple).toBeCloseTo(-0.5, 3);
  });

  it('handles the put side of the underlying stop', () => {
    const put = call({ action: 'BUY_PUT', underlyingStop: 25_300 });
    expect(resolveSignalOutcome(put, { premium: 90, spot: 25_350, now: at(12) }).status).toBe('INVALIDATED');
    expect(resolveSignalOutcome(put, { premium: 90, spot: 25_100, now: at(12) }).status).toBe('ACTIVE');
  });

  it('does not invalidate on an unknown spot', () => {
    expect(resolveSignalOutcome(call(), { premium: 90, spot: null, now: at(12) }).status).toBe('ACTIVE');
  });

  it('expires at 15:30 IST on the expiry date', () => {
    // Issued on the expiry morning, so the time stop cannot fire first.
    const sameDay = call({ generatedAt: at(9, 45, '2026-09-30').toISOString() });
    const before = resolveSignalOutcome(sameDay, { premium: 90, spot: 25_000, now: at(15, 0, '2026-09-30') });
    expect(before.status).toBe('ACTIVE');
    const after = resolveSignalOutcome(sameDay, { premium: 90, spot: 25_000, now: at(15, 31, '2026-09-30') });
    expect(after.status).toBe('EXPIRED');
    expect(after.rMultiple).toBeCloseTo(-0.25, 3);
  });

  it('times out after the plan\'s time stop', () => {
    const o = resolveSignalOutcome(call(), {
      premium: 104, spot: 25_020, now: new Date(ISSUED.getTime() + TIME_STOP_DAYS * 864e5 + 1),
    });
    expect(o.status).toBe('TIMED_OUT');
    expect(o.rMultiple).toBeCloseTo(0.1, 3);
  });

  it('carries the best and worst excursion between observations', () => {
    const first = resolveSignalOutcome(call(), { premium: 130, spot: 25_100, now: at(12) });
    const second = resolveSignalOutcome(
      call({ maxFavourablePremium: first.maxFavourablePremium, maxAdversePremium: first.maxAdversePremium }),
      { premium: 85, spot: 24_950, now: at(13) },
    );
    expect(second.maxFavourablePremium).toBe(130);
    expect(second.maxAdversePremium).toBe(85);
    expect(second.stopProximity).toBeCloseTo(0.375, 3);
  });
});

describe('summariseByGrade', () => {
  const rec = (grade: string, status: Parameters<typeof isWin>[0], r: number | null, mfe = 120) => ({
    grade, status, rMultiple: r, entryPremium: 100, stopPremium: 60, maxFavourablePremium: mfe,
  });

  it('reports hit rate, average R and profit factor per grade and overall', () => {
    const rows = [
      rec('A', 'TARGET1_HIT', 1.5, 170),
      rec('A', 'STOPPED', -1, 105),
      rec('A', 'ACTIVE', null, 110),
      rec('B', 'TARGET2_HIT', 2.5, 210),
      rec('B', 'TIMED_OUT', -0.2, 115),
      rec('B', 'INVALIDATED', -0.6, 108),
    ];
    const stats = summariseByGrade(rows);
    const a = stats.find((s) => s.grade === 'A')!;
    expect(a.issued).toBe(3);
    expect(a.resolved).toBe(2);
    expect(a.active).toBe(1);
    expect(a.hitRatePct).toBe(50);
    expect(a.avgR).toBeCloseTo(0.25, 3);
    expect(a.profitFactor).toBeCloseTo(1.5, 3);

    const b = stats.find((s) => s.grade === 'B')!;
    expect(b.wins).toBe(1);
    expect(b.losses).toBe(2);
    expect(b.profitFactor).toBeCloseTo(2.5 / 0.8, 3);

    const all = stats.find((s) => s.grade === 'ALL')!;
    expect(all.issued).toBe(6);
    expect(all.resolved).toBe(5);
  });

  it('returns null rather than a number when nothing has resolved', () => {
    const stats = summariseByGrade([rec('A', 'ACTIVE', null)]);
    const a = stats.find((s) => s.grade === 'A')!;
    expect(a.hitRatePct).toBeNull();
    expect(a.avgR).toBeNull();
    expect(a.profitFactor).toBeNull();
  });

  it('counts a timed-out signal that closed above entry as a win', () => {
    expect(isWin('TIMED_OUT', 0.3)).toBe(true);
    expect(isWin('TIMED_OUT', -0.3)).toBe(false);
    expect(isWin('EXPIRED', null)).toBe(false);
  });
});
