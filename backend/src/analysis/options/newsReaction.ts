/**
 * How an open position reacts to fresh news.
 *
 * The division of labour is the same as everywhere else in this codebase:
 * news decides WHEN to look again, price decides WHAT to do. Headline
 * sentiment comes from a keyword lexicon that is wrong often enough that
 * acting on it alone would be a coin flip — markets fall on good news that
 * was priced in and rally on bad news that was less bad than feared. So:
 *
 *   · the chart turning against the position is an exit, whatever the tone;
 *   · one chart factor against plus hostile news tightens the stop — the
 *     risk is cut, the thesis is given a shorter leash;
 *   · everything else is a hold, reported with the headline and the read.
 *
 * Pure, so every branch is tested.
 */

export type SentimentLabel = 'POSITIVE' | 'NEUTRAL' | 'NEGATIVE';

export interface NewsItemLite {
  headline: string;
  sentiment: SentimentLabel | null;
  /** −1 … +1 from the lexicon; null when not scored. */
  score: number | null;
  /** 0 … 1, how confidently the article was matched to the underlying. */
  relevance: number;
  publishedAt: string;
}

export interface PositionContext {
  action: 'BUY_CALL' | 'BUY_PUT';
  entryPremium: number;
  currentPremium: number | null;
  stopPremium: number;
}

export interface ChartRead {
  /** Lower-timeframe rule score, 0–100. */
  intradayScore: number | null;
  intradaySupertrend: 1 | -1 | null;
  aboveVwap: boolean | null;
  /** Higher-timeframe rule score, 0–100. */
  dailyScore: number | null;
}

export type NewsTone = 'FOR' | 'AGAINST' | 'MIXED' | 'NEUTRAL';

export interface NewsReaction {
  kind: 'EXIT' | 'TIGHTEN' | 'HOLD';
  tone: NewsTone;
  /** Only for TIGHTEN: the new stop on the premium. */
  newStop?: number;
  /** Chart factors read against the position, out of those readable. */
  chartAgainst: number;
  chartReadable: number;
  reason: string;
  /** The headlines that triggered the look, most relevant first. */
  headlines: string[];
}

const TONE_THRESHOLD = 0.15;

/** Net sentiment, signed in the position's favour, weighted by relevance. */
export function newsTone(news: readonly NewsItemLite[], action: PositionContext['action']): { tone: NewsTone; net: number } {
  let forSum = 0;
  let againstSum = 0;
  for (const n of news) {
    const s = n.score ?? (n.sentiment === 'POSITIVE' ? 0.5 : n.sentiment === 'NEGATIVE' ? -0.5 : 0);
    // A bullish headline favours a call and works against a put.
    const signed = action === 'BUY_CALL' ? s : -s;
    const w = Math.abs(signed) * n.relevance;
    if (signed > 0) forSum += w; else if (signed < 0) againstSum += w;
  }
  const net = forSum - againstSum;
  if (forSum >= TONE_THRESHOLD && againstSum >= TONE_THRESHOLD && Math.abs(net) < TONE_THRESHOLD) {
    return { tone: 'MIXED', net };
  }
  if (net >= TONE_THRESHOLD) return { tone: 'FOR', net };
  if (net <= -TONE_THRESHOLD) return { tone: 'AGAINST', net };
  return { tone: 'NEUTRAL', net };
}

export function decideNewsReaction(
  news: readonly NewsItemLite[],
  pos: PositionContext,
  chart: ChartRead,
): NewsReaction {
  const bull = pos.action === 'BUY_CALL';
  const { tone } = newsTone(news, pos.action);
  const headlines = [...news]
    .sort((a, b) => b.relevance - a.relevance || b.publishedAt.localeCompare(a.publishedAt))
    .map((n) => n.headline)
    .slice(0, 3);

  // Each chart factor votes only if it could be read.
  const votes: Array<{ against: boolean; label: string }> = [];
  if (chart.intradayScore !== null) {
    const against = bull ? chart.intradayScore <= 45 : chart.intradayScore >= 55;
    votes.push({ against, label: `15m score ${chart.intradayScore.toFixed(0)}` });
  }
  if (chart.intradaySupertrend !== null) {
    const against = bull ? chart.intradaySupertrend === -1 : chart.intradaySupertrend === 1;
    votes.push({ against, label: `15m Supertrend ${chart.intradaySupertrend === 1 ? 'bullish' : 'bearish'}` });
  }
  if (chart.aboveVwap !== null) {
    const against = bull ? !chart.aboveVwap : chart.aboveVwap;
    votes.push({ against, label: `price ${chart.aboveVwap ? 'above' : 'below'} VWAP` });
  }
  if (chart.dailyScore !== null) {
    const against = bull ? chart.dailyScore < 50 : chart.dailyScore > 50;
    votes.push({ against, label: `daily score ${chart.dailyScore.toFixed(0)}` });
  }
  const chartAgainst = votes.filter((v) => v.against).length;
  const chartReadable = votes.length;
  const againstLabels = votes.filter((v) => v.against).map((v) => v.label).join(', ');
  const forLabels = votes.filter((v) => !v.against).map((v) => v.label).join(', ');
  const toneText =
    tone === 'FOR' ? 'News reads in favour' : tone === 'AGAINST' ? 'News reads against' : tone === 'MIXED' ? 'News is mixed' : 'News is neutral';

  const base = { tone, chartAgainst, chartReadable, headlines };

  if (chartReadable >= 2 && chartAgainst >= 2) {
    return {
      ...base, kind: 'EXIT',
      reason: `${toneText}; on the re-check the chart has turned against the position (${againstLabels}). The thesis is gone — exit.`,
    };
  }

  if (chartAgainst === 1 && tone === 'AGAINST') {
    const cur = pos.currentPremium;
    let newStop = pos.stopPremium;
    if (cur !== null) {
      newStop = cur > pos.entryPremium
        ? Math.max(pos.stopPremium, pos.entryPremium)          // in profit: give nothing back
        : Math.max(pos.stopPremium, pos.stopPremium + (cur - pos.stopPremium) * 0.5); // cut remaining risk in half
      newStop = Math.round(newStop * 20) / 20;
    }
    return {
      ...base, kind: 'TIGHTEN', newStop,
      reason: `${toneText} and one chart factor has turned (${againstLabels}) while ${forLabels || 'the rest'} still support${forLabels ? '' : 's'} the position. Stop tightened to ₹${newStop.toFixed(2)} — the thesis keeps a shorter leash.`,
    };
  }

  return {
    ...base, kind: 'HOLD',
    reason: `${toneText}; the chart still supports the position (${forLabels || 'no factor against'}${againstLabels ? `; against: ${againstLabels}` : ''}). Holding — the plan's stop and targets stand.`,
  };
}
