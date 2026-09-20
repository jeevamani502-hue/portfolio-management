/**
 * These are the tests that matter most in this codebase.
 *
 * The platform's central promise is that the AI cannot state a number it was
 * not given. The system prompt asks for that; this validator enforces it. If
 * these tests pass, a hallucinated price is caught before it reaches a user.
 */
import { describe, it, expect } from 'vitest';
import { validateAnswer, validateSafety, extractNumbers } from '../validator.js';
import { EvidenceBuilder, renderBundle } from '../evidence.js';

const asOf = '2024-03-15T09:45:00.000Z';

function bundle() {
  return new EvidenceBuilder('stock_analysis', 'RELIANCE', 'OPEN')
    .addNumber('price.ltp', 'RELIANCE last traded price', 2650.4, {
      unit: 'INR', source: 'dhan', asOf,
    })
    .addNumber('price.prevClose', 'RELIANCE previous close', 2638.1, {
      unit: 'INR', source: 'dhan', asOf,
    })
    .addNumber('tech.rsi14', 'RELIANCE RSI(14)', 58.3, {
      source: 'computed', asOf, kind: 'calculated',
    })
    .addNumber('tech.support', 'Nearest support', 2590, {
      unit: 'INR', source: 'computed', asOf, kind: 'calculated',
    })
    .addText('tech.trend', 'Trend', 'UPTREND', { source: 'rule-engine-v1', asOf, kind: 'rule_signal' })
    .addContext('rules', 'Rule detail', 'PASS — Price above 200 SMA: Close 2650.40 is above the 200 SMA 2410.55')
    .build();
}

describe('extractNumbers', () => {
  it('finds plain, decimal and Indian-grouped numbers', () => {
    const found = extractNumbers('Price 2650.40, volume 48,21,334 and 12%');
    const values = found.map((f) => f.value);
    expect(values).toContain(2650.4);
    expect(values).toContain(4821334);
    expect(values).toContain(12);
  });

  it('handles negatives', () => {
    expect(extractNumbers('down -12.5 points').map((f) => f.value)).toContain(-12.5);
  });
});

describe('validateAnswer — the anti-fabrication guard', () => {
  it('accepts an answer quoting only supplied facts', () => {
    const answer =
      'RELIANCE last traded at 2650.40, against a previous close of 2638.10. RSI(14) reads 58.3 and the nearest mapped support sits at 2590.';
    const r = validateAnswer(answer, bundle());
    expect(r.passed).toBe(true);
    expect(r.issues).toHaveLength(0);
  });

  it('REJECTS a fabricated price', () => {
    const answer = 'RELIANCE last traded at 2650.40 and the target is 2890.75.';
    const r = validateAnswer(answer, bundle());
    expect(r.passed).toBe(false);
    expect(r.issues.some((i) => i.value === 2890.75)).toBe(true);
  });

  it('REJECTS a fabricated volume figure', () => {
    const answer = 'Volume today was 8,54,21,900 shares.';
    const r = validateAnswer(answer, bundle());
    expect(r.passed).toBe(false);
    expect(r.issues.some((i) => i.value === 85421900)).toBe(true);
  });

  it('REJECTS an invented fundamental the bundle never contained', () => {
    const answer = 'The stock trades at a P/E of 27.4.';
    const r = validateAnswer(answer, bundle());
    expect(r.passed).toBe(false);
  });

  it('accepts a difference derived from two facts', () => {
    // 2650.40 − 2638.10 = 12.30
    const answer = 'The stock is up 12.30 points on the day.';
    const r = validateAnswer(answer, bundle());
    expect(r.passed).toBe(true);
    expect(r.derived).toBeGreaterThan(0);
  });

  it('accepts a percentage change derived from two facts', () => {
    // (2650.40 − 2638.10) / 2638.10 × 100 = 0.4662%
    const answer = 'That is a gain of 0.47% from the previous close.';
    const r = validateAnswer(answer, bundle());
    expect(r.passed).toBe(true);
  });

  it('accepts numbers quoted from the context block', () => {
    // 2410.55 appears only inside the rule-detail context, not as a fact.
    const answer = 'Price remains above the 200 SMA at 2410.55.';
    const r = validateAnswer(answer, bundle());
    expect(r.passed).toBe(true);
  });

  it('tolerates reasonable rounding of a supplied value', () => {
    const answer = 'RELIANCE is around 2650 with RSI near 58.';
    const r = validateAnswer(answer, bundle());
    expect(r.passed).toBe(true);
  });

  it('does NOT tolerate a number outside the rounding tolerance', () => {
    // 2750 is >0.5% away from 2650.40 — a different price, not a rounding.
    const answer = 'RELIANCE is trading at 2750.';
    const r = validateAnswer(answer, bundle());
    expect(r.passed).toBe(false);
  });

  it('allows common indicator periods named while describing a method', () => {
    const answer = 'RSI(14) is 58.3 and the 50 and 200 period averages are referenced.';
    const r = validateAnswer(answer, bundle());
    expect(r.passed).toBe(true);
  });

  it('allows small counting numbers in prose', () => {
    const answer = '3 of the 5 rule groups currently agree, with RSI at 58.3.';
    const r = validateAnswer(answer, bundle());
    expect(r.passed).toBe(true);
  });

  it('allows date and clock components from the data timestamp', () => {
    const answer = 'Data as of 2024-03-15, 15:15 IST.';
    const r = validateAnswer(answer, bundle());
    expect(r.passed).toBe(true);
  });

  it('counts how many numbers it checked', () => {
    const r = validateAnswer('Price 2650.40 and RSI 58.3.', bundle());
    expect(r.checked).toBeGreaterThanOrEqual(2);
  });

  it('catches a hallucination even among many valid numbers', () => {
    const answer =
      'Price 2650.40, previous close 2638.10, RSI 58.3, support 2590, and analyst target 3100.';
    const r = validateAnswer(answer, bundle());
    expect(r.passed).toBe(false);
    expect(r.issues).toHaveLength(1);
    expect(r.issues[0]!.value).toBe(3100);
  });

  it('includes surrounding context so the issue can be inspected', () => {
    const r = validateAnswer('The target is 2890.75 by year end.', bundle());
    expect(r.issues[0]!.context).toContain('2890.75');
  });

  it('passes an answer with no numbers at all', () => {
    const r = validateAnswer('The trend is classified as an uptrend by the rule engine.', bundle());
    expect(r.passed).toBe(true);
    expect(r.checked).toBe(0);
  });
});

describe('validateSafety — no certainty, no advice', () => {
  it('accepts hedged, descriptive language', () => {
    const answer =
      'The data shows price above the 200 SMA. One reading of this is continued momentum; the setup fails below 2590.';
    expect(validateSafety(answer).passed).toBe(true);
  });

  it('rejects a guarantee', () => {
    const r = validateSafety('This trade is guaranteed to work.');
    expect(r.passed).toBe(false);
    expect(r.violations[0]!.label).toBe('guarantee');
  });

  it('rejects a certainty claim about direction', () => {
    expect(validateSafety('The stock will definitely rise from here.').passed).toBe(false);
  });

  it('rejects direct investment advice', () => {
    const r = validateSafety('You should buy this stock now.');
    expect(r.passed).toBe(false);
    expect(r.violations[0]!.label).toBe('direct investment advice');
  });

  it('rejects assured-return language', () => {
    expect(validateSafety('Assured returns of 20%.').passed).toBe(false);
  });

  it('rejects risk-free framing', () => {
    expect(validateSafety('This is a risk-free trade.').passed).toBe(false);
  });

  it('rejects a buy recommendation framing', () => {
    expect(validateSafety('Our strong buy recommendation stands.').passed).toBe(false);
  });

  it('reports every violation it finds', () => {
    const r = validateSafety('Guaranteed profit — you should buy, it is risk-free.');
    expect(r.violations.length).toBeGreaterThanOrEqual(2);
  });
});

describe('EvidenceBuilder and renderBundle', () => {
  it('drops null values rather than emitting them as facts', () => {
    const b = new EvidenceBuilder('stock_analysis', 'TEST', 'OPEN')
      .addNumber('a', 'A', 1, { source: 's', asOf })
      .addNumber('b', 'B', null, { source: 's', asOf })
      .addNumber('c', 'C', Number.NaN, { source: 's', asOf })
      .build();
    expect(b.facts.map((f) => f.id)).toEqual(['a']);
  });

  it('records missing facts separately from present ones', () => {
    const b = new EvidenceBuilder('stock_analysis', 'TEST', 'OPEN')
      .addNumber('a', 'A', 1, { source: 's', asOf })
      .markMissing('b', 'B', 'provider returned nothing')
      .build();
    expect(b.facts).toHaveLength(1);
    expect(b.missing).toHaveLength(1);
    expect(b.missing[0]!.reason).toBe('provider returned nothing');
  });

  it('takes the oldest timestamp as the bundle as-of', () => {
    const b = new EvidenceBuilder('x', 'y', 'OPEN')
      .addNumber('new', 'N', 1, { source: 's', asOf: '2024-03-15T10:00:00.000Z' })
      .addNumber('old', 'O', 2, { source: 's', asOf: '2024-03-15T09:00:00.000Z' })
      .build();
    expect(b.asOf).toBe('2024-03-15T09:00:00.000Z');
  });

  it('collects distinct sources', () => {
    const b = new EvidenceBuilder('x', 'y', 'OPEN')
      .addNumber('a', 'A', 1, { source: 'dhan', asOf })
      .addNumber('b', 'B', 2, { source: 'dhan', asOf })
      .addNumber('c', 'C', 3, { source: 'computed', asOf })
      .build();
    expect(b.sources).toEqual(['computed', 'dhan']);
  });

  it('renders facts with ids, sources and timestamps the model can cite', () => {
    const text = renderBundle(bundle());
    expect(text).toContain('[price.ltp]');
    expect(text).toContain('2650.4');
    expect(text).toContain('source: dhan');
    expect(text).toContain('FACTS');
  });

  it('renders an explicit unavailable section', () => {
    const b = new EvidenceBuilder('x', 'y', 'OPEN')
      .addNumber('a', 'A', 1, { source: 's', asOf })
      .markMissing('fund.pe', 'P/E ratio', 'no fundamentals provider configured')
      .build();
    const text = renderBundle(b);
    expect(text).toContain('UNAVAILABLE');
    expect(text).toContain('no fundamentals provider configured');
  });
});
