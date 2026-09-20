/**
 * Intent detection and retrieval planning.
 *
 * Rules first, model second. A keyword classifier resolves most questions
 * ("analyze reliance", "why is nifty moving") instantly and for free; only
 * genuinely ambiguous questions reach the model. That keeps the retrieval
 * planner deterministic and testable.
 */
import * as instrumentsRepo from '../db/repositories/instruments.js';

export type Intent =
  | 'stock_analysis'
  | 'market_overview'
  | 'market_why'
  | 'portfolio_analysis'
  | 'fno_analysis'
  | 'option_chain'
  | 'scanner'
  | 'news'
  | 'compare'
  | 'regime'
  | 'risk_sizing'
  | 'explain_concept'
  | 'unsupported';

export interface IntentResult {
  intent: Intent;
  /** Symbols mentioned, resolved against the instrument master. */
  symbols: string[];
  /** The raw candidate strings before resolution, for diagnostics. */
  candidates: string[];
  timeframe: string | null;
  confidence: number;
  reasoning: string;
}

interface Pattern {
  intent: Intent;
  re: RegExp;
  weight: number;
}

const PATTERNS: Pattern[] = [
  { intent: 'portfolio_analysis', re: /\b(my|our)\s+(portfolio|holdings|positions|investments)\b/i, weight: 10 },
  { intent: 'portfolio_analysis', re: /\banaly[sz]e\s+(my\s+)?portfolio\b/i, weight: 10 },
  { intent: 'portfolio_analysis', re: /\b(portfolio|holdings)\s+(health|risk|allocation|performance|diversification)\b/i, weight: 8 },

  { intent: 'option_chain', re: /\boption\s*chain\b/i, weight: 10 },
  { intent: 'option_chain', re: /\b(explain|read|interpret)\s+.{0,20}\b(chain|strikes)\b/i, weight: 8 },
  { intent: 'fno_analysis', re: /\b(open\s*interest|\boi\b|pcr|put[\s/-]?call|max\s*pain|futures|f&o|fno)\b/i, weight: 7 },
  { intent: 'fno_analysis', re: /\b(call|put)\s+(writing|buildup|unwinding)\b/i, weight: 8 },
  { intent: 'fno_analysis', re: /\b(iv|implied\s+volatility|greeks|delta|gamma|theta|vega)\b/i, weight: 7 },

  { intent: 'scanner', re: /\b(find|show|scan|screen|list)\b.{0,30}\b(setups?|breakouts?|stocks?|opportunit)/i, weight: 9 },
  { intent: 'scanner', re: /\bswing\s+(trade|setup|scan)/i, weight: 9 },

  { intent: 'market_why', re: /\bwhy\s+(is|are|did|has|was)\b.{0,40}\b(nifty|sensex|market|bank\s*nifty|index)\b/i, weight: 10 },
  { intent: 'market_why', re: /\bwhy\s+(did|is|has)\b.{0,30}\b(fall|fell|rise|rose|drop|crash|rally|up|down)\b/i, weight: 8 },

  { intent: 'regime', re: /\bmarket\s+(regime|condition|environment|state)\b/i, weight: 9 },
  { intent: 'regime', re: /\b(trend|volatility)\s+(regime|environment)\b/i, weight: 7 },

  { intent: 'market_overview', re: /\b(market|nifty|sensex)\s+(today|overview|summary|update|status)\b/i, weight: 7 },
  { intent: 'market_overview', re: /\b(how\s+is|what'?s)\s+the\s+market\b/i, weight: 8 },
  { intent: 'market_overview', re: /\b(major|key)\s+(market\s+)?risks?\b/i, weight: 7 },

  { intent: 'compare', re: /\bcompare\b/i, weight: 9 },
  { intent: 'compare', re: /\b(vs\.?|versus)\b/i, weight: 7 },
  { intent: 'compare', re: /\bwhich\s+is\s+better\b/i, weight: 7 },

  { intent: 'news', re: /\b(news|headlines?|announcement|article)\b/i, weight: 7 },

  { intent: 'risk_sizing', re: /\b(position\s+siz|how\s+many\s+shares|how\s+much\s+should\s+i|risk\s+per\s+trade)\b/i, weight: 9 },

  { intent: 'stock_analysis', re: /\banaly[sz]e\b/i, weight: 5 },
  { intent: 'stock_analysis', re: /\b(technical|fundamental)s?\s+(of|for|analysis)\b/i, weight: 6 },
  { intent: 'stock_analysis', re: /\b(should\s+i|what\s+about|view\s+on|outlook\s+for)\b/i, weight: 4 },

  { intent: 'explain_concept', re: /\bwhat\s+(is|are|does)\s+(a|an|the)?\s*(rsi|macd|atr|adx|vwap|supertrend|bollinger|pcr|max\s*pain|xirr|beta|sharpe)\b/i, weight: 9 },
  { intent: 'explain_concept', re: /\b(how\s+do(es)?|explain)\b.{0,20}\b(work|calculated|computed)\b/i, weight: 6 },
];

/** Words that look like tickers but are ordinary English. */
const STOPWORDS = new Set([
  'THE', 'AND', 'FOR', 'ARE', 'WHY', 'HOW', 'WHAT', 'WHEN', 'WHICH', 'THIS',
  'THAT', 'WITH', 'FROM', 'ABOUT', 'INTO', 'MY', 'IS', 'IT', 'DO', 'DOES',
  'CAN', 'SHOULD', 'WOULD', 'BUY', 'SELL', 'HOLD', 'TODAY', 'NOW', 'BEST',
  'GOOD', 'BAD', 'HIGH', 'LOW', 'CALL', 'PUT', 'OI', 'IV', 'PE', 'PB', 'RSI',
  'MACD', 'ATR', 'ADX', 'VWAP', 'PCR', 'NSE', 'BSE', 'FNO', 'SIP', 'IPO',
]);

/** Common index names users type in prose. */
const INDEX_ALIASES: Record<string, string> = {
  NIFTY: 'NIFTY 50',
  'NIFTY50': 'NIFTY 50',
  'NIFTY 50': 'NIFTY 50',
  BANKNIFTY: 'NIFTY BANK',
  'BANK NIFTY': 'NIFTY BANK',
  'NIFTY BANK': 'NIFTY BANK',
  FINNIFTY: 'NIFTY FIN SERVICE',
  SENSEX: 'SENSEX',
  VIX: 'INDIA VIX',
  'INDIA VIX': 'INDIA VIX',
};

/** Pull out things that could be symbols, then verify against the master. */
export async function extractSymbols(
  question: string,
): Promise<{ symbols: string[]; candidates: string[] }> {
  const upper = question.toUpperCase();
  const candidates = new Set<string>();

  // Multi-word index aliases first.
  for (const alias of Object.keys(INDEX_ALIASES)) {
    if (alias.includes(' ') && upper.includes(alias)) candidates.add(alias);
  }

  // Single tokens that look like tickers.
  for (const m of upper.matchAll(/\b[A-Z][A-Z0-9&-]{2,}\b/g)) {
    const token = m[0];
    if (STOPWORDS.has(token)) continue;
    candidates.add(token);
  }

  const resolved: string[] = [];
  const seen = new Set<string>();

  for (const candidate of candidates) {
    const lookup = INDEX_ALIASES[candidate] ?? candidate;
    const row = await instrumentsRepo.resolveSymbol(lookup);
    if (row && !seen.has(row.tradingsymbol)) {
      seen.add(row.tradingsymbol);
      resolved.push(row.tradingsymbol);
    }
  }

  return { symbols: resolved.slice(0, 5), candidates: [...candidates] };
}

const TIMEFRAME_PATTERNS: Array<[RegExp, string]> = [
  [/\b(intraday|5\s*min|5m)\b/i, '5m'],
  [/\b(15\s*min|15m)\b/i, '15m'],
  [/\b(hourly|1\s*hour|1h)\b/i, '1h'],
  [/\b(daily|1\s*day|1d|eod)\b/i, '1d'],
  [/\b(weekly|1\s*week|1w)\b/i, '1w'],
  [/\b(monthly|1\s*month)\b/i, '1M'],
  [/\bswing\b/i, '1d'],
  [/\b(long[\s-]?term|positional)\b/i, '1w'],
];

export async function detectIntent(question: string): Promise<IntentResult> {
  const scores = new Map<Intent, number>();
  const matched: string[] = [];

  for (const p of PATTERNS) {
    if (p.re.test(question)) {
      scores.set(p.intent, (scores.get(p.intent) ?? 0) + p.weight);
      matched.push(p.intent);
    }
  }

  const { symbols, candidates } = await extractSymbols(question);

  // A resolved symbol with no other strong signal means stock analysis.
  if (symbols.length === 1 && scores.size === 0) {
    scores.set('stock_analysis', 6);
  }
  if (symbols.length >= 2 && (scores.get('compare') ?? 0) > 0) {
    scores.set('compare', (scores.get('compare') ?? 0) + 4);
  }
  // "Compare" with fewer than two symbols cannot be a comparison.
  if (symbols.length < 2 && scores.has('compare')) {
    scores.set('compare', (scores.get('compare') ?? 0) - 6);
  }

  let timeframe: string | null = null;
  for (const [re, tf] of TIMEFRAME_PATTERNS) {
    if (re.test(question)) { timeframe = tf; break; }
  }

  const ranked = [...scores.entries()].sort((a, b) => b[1] - a[1]);
  const top = ranked[0];

  if (!top || top[1] <= 0) {
    return {
      intent: symbols.length > 0 ? 'stock_analysis' : 'unsupported',
      symbols,
      candidates,
      timeframe,
      confidence: symbols.length > 0 ? 0.4 : 0.1,
      reasoning:
        symbols.length > 0
          ? `No intent keywords matched, but ${symbols.join(', ')} resolved to a known instrument, so this is treated as a stock question.`
          : 'No intent keywords matched and no instrument was recognised in the question.',
    };
  }

  const totalScore = ranked.reduce((s, [, v]) => s + Math.max(0, v), 0);
  const confidence = totalScore > 0 ? Math.min(0.95, top[1] / totalScore) : 0.2;

  return {
    intent: top[0],
    symbols,
    candidates,
    timeframe,
    confidence,
    reasoning: `Matched intent patterns: ${[...new Set(matched)].join(', ')}. Resolved instruments: ${symbols.join(', ') || 'none'}.`,
  };
}

/** What the retrieval layer must fetch for each intent. */
export interface RetrievalPlan {
  needsQuote: boolean;
  needsTechnicals: boolean;
  needsFundamentals: boolean;
  needsOptionChain: boolean;
  needsFutures: boolean;
  needsNews: boolean;
  needsBreadth: boolean;
  needsRegime: boolean;
  needsPortfolio: boolean;
  needsScan: boolean;
  /** Facts without which the question cannot be answered at all. */
  requiredFactIds: string[];
}

export function planRetrieval(intent: Intent, symbolCount: number): RetrievalPlan {
  const base: RetrievalPlan = {
    needsQuote: false, needsTechnicals: false, needsFundamentals: false,
    needsOptionChain: false, needsFutures: false, needsNews: false,
    needsBreadth: false, needsRegime: false, needsPortfolio: false,
    needsScan: false, requiredFactIds: [],
  };

  switch (intent) {
    case 'stock_analysis':
      return { ...base,
        needsQuote: true, needsTechnicals: true, needsFundamentals: true,
        needsNews: true, needsRegime: true,
        requiredFactIds: ['price.ltp'] };

    case 'compare':
      return { ...base,
        needsQuote: true, needsTechnicals: true, needsFundamentals: true,
        requiredFactIds: symbolCount >= 2 ? ['price.ltp'] : ['price.ltp'] };

    case 'market_overview':
    case 'market_why':
      return { ...base,
        needsQuote: true, needsBreadth: true, needsRegime: true,
        needsNews: true, needsTechnicals: true,
        requiredFactIds: ['index.nifty.ltp'] };

    case 'regime':
      return { ...base, needsRegime: true, needsBreadth: true, needsQuote: true,
        requiredFactIds: ['regime.label'] };

    case 'option_chain':
    case 'fno_analysis':
      return { ...base,
        needsQuote: true, needsOptionChain: true, needsFutures: true,
        requiredFactIds: ['options.pcr_oi'] };

    case 'portfolio_analysis':
      return { ...base, needsPortfolio: true, needsRegime: true,
        requiredFactIds: ['portfolio.currentValue'] };

    case 'scanner':
      return { ...base, needsScan: true, needsRegime: true, requiredFactIds: [] };

    case 'news':
      return { ...base, needsNews: true, needsQuote: symbolCount > 0, requiredFactIds: [] };

    case 'risk_sizing':
      return { ...base, needsQuote: true, needsTechnicals: true, requiredFactIds: [] };

    case 'explain_concept':
      // Conceptual questions need no market data at all.
      return base;

    default:
      return base;
  }
}
