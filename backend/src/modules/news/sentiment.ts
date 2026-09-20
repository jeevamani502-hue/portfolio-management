/**
 * Transparent lexicon sentiment classifier.
 *
 * Deliberately NOT a neural model. The brief requires that sentiment be
 * shown with a confidence and acknowledged as fallible; a lexicon classifier
 * can additionally show *which words drove the score*, which makes the
 * "automated sentiment can be wrong" disclaimer actionable rather than
 * decorative — the user can look at the matched terms and judge for themselves.
 *
 * Tuned for Indian financial-press vocabulary.
 */

export type SentimentLabel = 'POSITIVE' | 'NEUTRAL' | 'NEGATIVE';

export interface SentimentResult {
  label: SentimentLabel;
  /** −1 (very negative) to +1 (very positive). */
  score: number;
  /** 0–1. Low when few terms matched or the text is short. */
  confidence: number;
  method: string;
  matched: Array<{ term: string; weight: number }>;
  caveat: string;
}

/** term → weight. Negative numbers are bearish. */
const LEXICON: Record<string, number> = {
  // Earnings / performance — positive
  surge: 2, surged: 2, soar: 2.5, soared: 2.5, jump: 1.5, jumped: 1.5,
  rally: 2, rallied: 2, rise: 1, rises: 1, rose: 1, gain: 1.5, gains: 1.5,
  gained: 1.5, climb: 1.5, climbed: 1.5, advance: 1, advanced: 1,
  outperform: 2, outperformed: 2, beat: 1.5, beats: 1.5, exceeded: 1.5,
  record: 1.5, 'all-time high': 2.5, upgrade: 2.5, upgraded: 2.5,
  bullish: 2, strong: 1.5, robust: 1.5, healthy: 1, improved: 1.5,
  profit: 1.5, profitable: 1.5, growth: 1.5, expansion: 1.5, expanding: 1.5,
  dividend: 1, bonus: 1, buyback: 1.5, 'stake buy': 1.5, acquisition: 0.5,
  approval: 1.5, approved: 1.5, wins: 1.5, won: 1.5, awarded: 1.5,
  'order win': 2, contract: 1, partnership: 1, breakthrough: 2,
  recovery: 1.5, rebound: 1.5, turnaround: 2, optimistic: 1.5,
  'higher guidance': 2, 'raises guidance': 2.5, expands: 1, launch: 0.5,

  // Earnings / performance — negative
  plunge: -2.5, plunged: -2.5, crash: -3, crashed: -3, slump: -2, slumped: -2,
  tumble: -2, tumbled: -2, fall: -1, falls: -1, fell: -1, drop: -1.5,
  dropped: -1.5, decline: -1.5, declined: -1.5, slide: -1.5, slid: -1.5,
  sink: -2, sank: -2, plummet: -2.5, plummeted: -2.5,
  underperform: -2, underperformed: -2, miss: -1.5, missed: -1.5,
  downgrade: -2.5, downgraded: -2.5, bearish: -2, weak: -1.5, weakness: -1.5,
  poor: -1.5, disappointing: -2, disappointed: -2, loss: -2, losses: -2,
  'net loss': -2.5, deficit: -1.5, decline_in_profit: -2,
  'profit warning': -3, warning: -1.5, concern: -1, concerns: -1,
  probe: -2, investigation: -2, investigating: -2, raid: -2.5,
  fraud: -3, scam: -3, default: -3, defaulted: -3, insolvency: -3,
  bankruptcy: -3, 'debt burden': -2, downturn: -2, recession: -2.5,
  layoff: -2, layoffs: -2, 'job cuts': -2, resign: -1.5, resigned: -1.5,
  'steps down': -1.5, penalty: -2, fine: -1.5, fined: -1.5, lawsuit: -2,
  'show cause': -2, 'regulatory action': -2.5, ban: -2.5, banned: -2.5,
  suspended: -2, halt: -1.5, halted: -1.5, recall: -2, delay: -1,
  delayed: -1, 'cuts guidance': -2.5, 'lowers guidance': -2.5,
  pledge: -1, pledged: -1, 'stake sale': -1, 'block deal': -0.5,
  selloff: -2, 'sell-off': -2, correction: -1, volatility: -0.5,

  // Indian market specifics
  'fii selling': -1.5, 'fii buying': 1.5, 'dii buying': 1.5, 'dii selling': -1.5,
  'circuit breaker': -2, 'upper circuit': 2, 'lower circuit': -2.5,
  'rate cut': 1.5, 'rate hike': -1, 'repo rate': 0, gst: 0,
  'sebi': 0, 'rbi': 0,
};

/** Terms that flip the polarity of what follows. */
const NEGATORS = new Set(['not', 'no', 'never', 'без', 'without', 'fails', 'failed', 'unlikely', "isn't", "wasn't", "doesn't", "didn't"]);

/** Terms that weaken a claim. */
const HEDGES = new Set(['may', 'might', 'could', 'reportedly', 'rumoured', 'rumored', 'speculation', 'likely', 'expected', 'plans', 'considering']);

const MULTIWORD = Object.keys(LEXICON).filter((k) => k.includes(' '));

export function analyzeSentiment(text: string): SentimentResult {
  const caveat =
    'Sentiment is assigned by a keyword-and-rules classifier, not by reading the article. ' +
    'It can be wrong — headlines are often ironic, conditional, or about a different company than the one tagged. ' +
    'Treat it as a filter, never as a fact about the news.';

  const method = 'lexicon-v1: weighted financial keyword matching with negation and hedge handling';

  if (!text || text.trim().length === 0) {
    return { label: 'NEUTRAL', score: 0, confidence: 0, method, matched: [], caveat };
  }

  const lower = text.toLowerCase();
  const matched: Array<{ term: string; weight: number }> = [];
  let total = 0;

  // Multi-word phrases first, so "profit warning" is not scored as "profit".
  const consumed = new Set<number>();
  for (const phrase of MULTIWORD) {
    let idx = lower.indexOf(phrase);
    while (idx !== -1) {
      const weight = LEXICON[phrase]!;
      matched.push({ term: phrase, weight });
      total += weight;
      for (let i = idx; i < idx + phrase.length; i += 1) consumed.add(i);
      idx = lower.indexOf(phrase, idx + phrase.length);
    }
  }

  const tokens = [...lower.matchAll(/[a-z'-]+/g)];
  let hedgeCount = 0;

  for (let t = 0; t < tokens.length; t += 1) {
    const m = tokens[t]!;
    const word = m[0];
    const start = m.index ?? 0;
    if (consumed.has(start)) continue;

    if (HEDGES.has(word)) { hedgeCount += 1; continue; }

    const base = LEXICON[word];
    if (base === undefined) continue;

    // Negation within the preceding three tokens flips polarity and damps it.
    let weight = base;
    for (let back = 1; back <= 3 && t - back >= 0; back += 1) {
      if (NEGATORS.has(tokens[t - back]![0])) {
        weight = -weight * 0.8;
        break;
      }
    }

    matched.push({ term: word, weight });
    total += weight;
  }

  if (matched.length === 0) {
    return {
      label: 'NEUTRAL',
      score: 0,
      confidence: 0.15,
      method,
      matched: [],
      caveat: `${caveat} No scoring terms were found in this text, so it defaults to neutral.`,
    };
  }

  // Normalise by a soft saturation so one dramatic word cannot peg the scale.
  const score = Math.tanh(total / 4);

  // Confidence rises with the number of agreeing matches and falls with hedging
  // and with disagreement between matched terms.
  const positives = matched.filter((m) => m.weight > 0).length;
  const negatives = matched.filter((m) => m.weight < 0).length;
  const agreement = matched.length > 0
    ? Math.abs(positives - negatives) / matched.length
    : 0;
  const volume = Math.min(1, matched.length / 4);
  const hedgePenalty = Math.max(0, 1 - hedgeCount * 0.2);
  const lengthFactor = Math.min(1, text.length / 60);
  const confidence = Math.max(0.05, Math.min(0.9, agreement * volume * hedgePenalty * lengthFactor));

  const label: SentimentLabel = score > 0.15 ? 'POSITIVE' : score < -0.15 ? 'NEGATIVE' : 'NEUTRAL';

  return {
    label,
    score: Number(score.toFixed(3)),
    confidence: Number(confidence.toFixed(3)),
    method,
    matched: matched.slice(0, 12),
    caveat,
  };
}
