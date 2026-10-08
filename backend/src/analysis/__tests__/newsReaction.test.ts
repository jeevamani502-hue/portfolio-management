/**
 * News never acts alone: the chart has to turn before a position is exited,
 * and hostile news with one chart factor against only tightens the stop.
 */
import { describe, it, expect } from 'vitest';
import { decideNewsReaction, newsTone, type NewsItemLite, type ChartRead } from '../options/newsReaction.js';

const item = (score: number, relevance = 0.9, headline = 'h'): NewsItemLite => ({
  headline, sentiment: score > 0 ? 'POSITIVE' : score < 0 ? 'NEGATIVE' : 'NEUTRAL', score, relevance, publishedAt: '2026-10-07T05:00:00Z',
});
const call = { action: 'BUY_CALL' as const, entryPremium: 100, currentPremium: 110, stopPremium: 60 };
const put = { action: 'BUY_PUT' as const, entryPremium: 100, currentPremium: 90, stopPremium: 60 };
const chart = (over: Partial<ChartRead> = {}): ChartRead => ({
  intradayScore: 62, intradaySupertrend: 1, aboveVwap: true, dailyScore: 65, ...over,
});

describe('newsTone', () => {
  it('reads bullish headlines as for a call and against a put', () => {
    expect(newsTone([item(0.6)], 'BUY_CALL').tone).toBe('FOR');
    expect(newsTone([item(0.6)], 'BUY_PUT').tone).toBe('AGAINST');
  });
  it('is neutral on weak or irrelevant news, mixed on strong both ways', () => {
    expect(newsTone([item(0.1)], 'BUY_CALL').tone).toBe('NEUTRAL');
    expect(newsTone([item(0.8, 0.1)], 'BUY_CALL').tone).toBe('NEUTRAL');
    expect(newsTone([item(0.7), item(-0.7)], 'BUY_CALL').tone).toBe('MIXED');
  });
});

describe('decideNewsReaction', () => {
  it('holds when the chart still supports the position, even on hostile news', () => {
    const r = decideNewsReaction([item(-0.8)], call, chart());
    expect(r.kind).toBe('HOLD');
    expect(r.tone).toBe('AGAINST');
    expect(r.chartAgainst).toBe(0);
  });

  it('exits when two chart factors have turned, whatever the tone', () => {
    const r = decideNewsReaction([item(0.8)], call, chart({ intradayScore: 40, intradaySupertrend: -1 }));
    expect(r.kind).toBe('EXIT');
    expect(r.tone).toBe('FOR');
    const p = decideNewsReaction([item(-0.2)], put, chart({ intradayScore: 60, aboveVwap: true }));
    expect(p.kind).toBe('EXIT');
  });

  it('tightens to breakeven when one factor turns and news is against, in profit', () => {
    const r = decideNewsReaction([item(-0.8)], call, chart({ aboveVwap: false }));
    expect(r.kind).toBe('TIGHTEN');
    expect(r.newStop).toBe(100);
  });

  it('halves the remaining risk when tightening a losing position', () => {
    const r = decideNewsReaction([item(-0.8)], { ...call, currentPremium: 80 }, chart({ aboveVwap: false }));
    expect(r.kind).toBe('TIGHTEN');
    expect(r.newStop).toBe(70); // 60 + (80 − 60) / 2
  });

  it('does not tighten on one factor when the news is not against', () => {
    expect(decideNewsReaction([item(0.8)], call, chart({ aboveVwap: false })).kind).toBe('HOLD');
    expect(decideNewsReaction([item(0.05)], call, chart({ aboveVwap: false })).kind).toBe('HOLD');
  });

  it('needs at least two readable factors to call an exit', () => {
    const r = decideNewsReaction([item(-0.8)], call, { intradayScore: 30, intradaySupertrend: null, aboveVwap: null, dailyScore: null });
    expect(r.kind).toBe('TIGHTEN');
  });

  it('carries the most relevant headlines', () => {
    const r = decideNewsReaction([item(-0.5, 0.7, 'low'), item(-0.5, 0.95, 'high')], call, chart());
    expect(r.headlines[0]).toBe('high');
  });
});
