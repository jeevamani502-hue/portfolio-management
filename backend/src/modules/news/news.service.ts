/**
 * News ingestion, entity mapping and retrieval.
 *
 * Entity mapping is the hard part: RSS gives us a headline, not a ticker. We
 * match against the instrument master using exact symbols, company names and
 * a small alias table, and we record *why* each match was made along with a
 * relevance score — so the UI can say "matched on company name" rather than
 * asserting a connection it cannot justify.
 */
import { query, queryRows } from '../../db/pool.js';
import { sha256 } from '../../utils/crypto.js';
import { logger } from '../../utils/logger.js';
import { sourced, unavailable, type Sourced } from '../../utils/sourced.js';
import { analyzeSentiment, type SentimentResult } from './sentiment.js';
import type { NormalizedNewsItem } from '../../providers/types.js';
import { getJson, setJson } from '../../cache/redis.js';
import { K, TTL } from '../../cache/keys.js';

export interface NewsView {
  id: string;
  headline: string;
  summary: string | null;
  url: string;
  publisher: string;
  author: string | null;
  category: string | null;
  publishedAt: string;
  sentiment: {
    label: 'POSITIVE' | 'NEUTRAL' | 'NEGATIVE' | null;
    score: number | null;
    confidence: number | null;
    method: string | null;
    caveat: string;
  };
  relatedInstruments: Array<{
    id: number;
    symbol: string;
    name: string | null;
    sector: string | null;
    relevance: number;
    matchReason: string;
  }>;
}

const SENTIMENT_CAVEAT =
  'Automated sentiment is a keyword-based classification of the headline text. It is frequently wrong on irony, conditionals and mistaken entity attribution, and it is not an assessment of what the news means for the price.';

// ── entity mapping ──────────────────────────────────────────────────────────

interface EntityCandidate {
  id: number;
  tradingsymbol: string;
  name: string | null;
  sector: string | null;
  /** Lowercased searchable forms. */
  forms: string[];
}

let entityCache: { at: number; list: EntityCandidate[] } | null = null;

/**
 * Words that are real English and would produce constant false positives if
 * matched as company names.
 */
const AMBIGUOUS = new Set([
  'india', 'bank', 'power', 'finance', 'motors', 'steel', 'cement', 'energy',
  'industries', 'limited', 'ltd', 'corporation', 'company', 'group', 'trust',
  'national', 'state', 'united', 'general', 'central', 'first', 'new', 'grasim',
]);

async function loadEntities(): Promise<EntityCandidate[]> {
  if (entityCache && Date.now() - entityCache.at < 3600_000) return entityCache.list;

  const rows = await queryRows<{
    id: number; tradingsymbol: string; name: string | null; sector: string | null;
  }>(
    `SELECT id, tradingsymbol, name, sector
       FROM instruments
      WHERE is_active = TRUE AND instrument_type IN ('EQ','INDEX','ETF')
        AND exchange IN ('NSE','INDICES')`,
  );

  const list: EntityCandidate[] = rows.map((r) => {
    const forms = new Set<string>();
    forms.add(r.tradingsymbol.toLowerCase());

    if (r.name) {
      const n = r.name.toLowerCase();
      forms.add(n);
      // "Reliance Industries Limited" → "reliance industries"
      const trimmed = n
        .replace(/\b(limited|ltd\.?|corporation|corp\.?|company|co\.?|inc\.?|plc)\b/g, '')
        .replace(/\s+/g, ' ')
        .trim();
      if (trimmed.length >= 4) forms.add(trimmed);
      // First two words, if distinctive: "hdfc bank", "tata motors"
      const words = trimmed.split(' ').filter(Boolean);
      if (words.length >= 2) {
        const pair = `${words[0]} ${words[1]}`;
        if (pair.length >= 6) forms.add(pair);
      }
    }

    return {
      id: r.id,
      tradingsymbol: r.tradingsymbol,
      name: r.name,
      sector: r.sector,
      forms: [...forms].filter((f) => f.length >= 3 && !AMBIGUOUS.has(f)),
    };
  });

  entityCache = { at: Date.now(), list };
  return list;
}

export interface EntityMatch {
  instrumentId: number;
  symbol: string;
  relevance: number;
  matchReason: 'exact_symbol' | 'company_name' | 'name_fragment';
}

/**
 * Map free text to instruments.
 *
 * Relevance reflects how confident the *match* is, not how important the news
 * is. A headline literally containing "RELIANCE" scores higher than one
 * containing "reliance industries' unit", which scores higher again than a
 * partial name fragment.
 */
export async function mapEntities(text: string): Promise<EntityMatch[]> {
  const entities = await loadEntities();
  const lower = ` ${text.toLowerCase().replace(/[^a-z0-9\s&.-]/g, ' ').replace(/\s+/g, ' ')} `;
  const matches = new Map<number, EntityMatch>();

  for (const e of entities) {
    for (const form of e.forms) {
      // Word-boundary containment to avoid "ITC" matching "switch".
      if (!lower.includes(` ${form} `) && !lower.includes(` ${form},`) && !lower.includes(` ${form}'`)) {
        continue;
      }

      const isSymbol = form === e.tradingsymbol.toLowerCase();
      const isFullName = e.name !== null && form === e.name.toLowerCase();

      const relevance = isSymbol ? 0.95 : isFullName ? 0.9 : 0.7;
      const matchReason: EntityMatch['matchReason'] = isSymbol
        ? 'exact_symbol'
        : isFullName
          ? 'company_name'
          : 'name_fragment';

      const existing = matches.get(e.id);
      if (!existing || existing.relevance < relevance) {
        matches.set(e.id, {
          instrumentId: e.id,
          symbol: e.tradingsymbol,
          relevance,
          matchReason,
        });
      }
      break;
    }
  }

  return [...matches.values()].sort((a, b) => b.relevance - a.relevance).slice(0, 8);
}

// ── ingestion ───────────────────────────────────────────────────────────────

export interface IngestResult {
  fetched: number;
  inserted: number;
  duplicates: number;
  entitiesMapped: number;
}

export async function ingestNews(
  items: NormalizedNewsItem[],
  source: string,
): Promise<IngestResult> {
  let inserted = 0;
  let duplicates = 0;
  let entitiesMapped = 0;

  for (const item of items) {
    try {
      const urlHash = sha256(item.url);
      const text = `${item.headline}. ${item.summary ?? ''}`;

      // Prefer the provider's sentiment when it supplies one, but keep ours
      // as the transparent fallback and record which was used.
      let sentiment: SentimentResult | null = null;
      let method: string;
      let label: string | null;
      let score: number | null;
      let confidence: number | null;

      if (item.providerSentiment) {
        method = `provider:${source}`;
        score = item.providerSentiment.score;
        label = score > 0.15 ? 'POSITIVE' : score < -0.15 ? 'NEGATIVE' : 'NEUTRAL';
        // A provider score with no stated methodology gets a capped confidence.
        confidence = 0.5;
      } else {
        sentiment = analyzeSentiment(text);
        method = sentiment.method;
        label = sentiment.label;
        score = sentiment.score;
        confidence = sentiment.confidence;
      }

      const rows = await queryRows<{ id: string }>(
        `INSERT INTO news_articles
           (headline, summary, url, url_hash, publisher, author, category, published_at,
            sentiment, sentiment_score, sentiment_confidence, sentiment_method, source)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
         ON CONFLICT (url_hash) DO NOTHING
         RETURNING id`,
        [
          item.headline, item.summary, item.url, urlHash, item.publisher, item.author,
          item.category, item.publishedAt, label, score, confidence, method, source,
        ],
      );

      const articleId = rows[0]?.id;
      if (!articleId) { duplicates += 1; continue; }
      inserted += 1;

      const matches = await mapEntities(text);
      for (const m of matches) {
        await query(
          `INSERT INTO news_entities (article_id, instrument_id, relevance, match_reason)
           VALUES ($1,$2,$3,$4) ON CONFLICT (article_id, instrument_id) DO NOTHING`,
          [articleId, m.instrumentId, m.relevance, m.matchReason],
        );
        entitiesMapped += 1;
      }
    } catch (err) {
      logger.warn({ err, url: item.url }, 'Failed to ingest a news item');
    }
  }

  logger.info({ source, fetched: items.length, inserted, duplicates }, 'News ingestion complete');
  return { fetched: items.length, inserted, duplicates, entitiesMapped };
}

// ── retrieval ───────────────────────────────────────────────────────────────

interface NewsRow {
  id: string;
  headline: string;
  summary: string | null;
  url: string;
  publisher: string;
  author: string | null;
  category: string | null;
  published_at: Date;
  sentiment: string | null;
  sentiment_score: number | null;
  sentiment_confidence: number | null;
  sentiment_method: string | null;
  source: string;
  related: Array<{
    id: number; symbol: string; name: string | null; sector: string | null;
    relevance: number; match_reason: string;
  }> | null;
}

const NEWS_SELECT = `
  n.id, n.headline, n.summary, n.url, n.publisher, n.author, n.category,
  n.published_at, n.sentiment, n.sentiment_score, n.sentiment_confidence,
  n.sentiment_method, n.source,
  (SELECT json_agg(json_build_object(
      'id', i.id, 'symbol', i.tradingsymbol, 'name', i.name, 'sector', i.sector,
      'relevance', ne.relevance, 'match_reason', ne.match_reason)
     ORDER BY ne.relevance DESC)
     FROM news_entities ne JOIN instruments i ON i.id = ne.instrument_id
    WHERE ne.article_id = n.id) AS related
`;

function toView(r: NewsRow): NewsView {
  return {
    id: r.id,
    headline: r.headline,
    summary: r.summary,
    url: r.url,
    publisher: r.publisher,
    author: r.author,
    category: r.category,
    publishedAt: r.published_at.toISOString(),
    sentiment: {
      label: (r.sentiment as NewsView['sentiment']['label']) ?? null,
      score: r.sentiment_score,
      confidence: r.sentiment_confidence,
      method: r.sentiment_method,
      caveat: SENTIMENT_CAVEAT,
    },
    relatedInstruments: (r.related ?? []).map((e) => ({
      id: e.id,
      symbol: e.symbol,
      name: e.name,
      sector: e.sector,
      relevance: e.relevance,
      matchReason: e.match_reason,
    })),
  };
}

export interface NewsFilters {
  symbol?: string;
  sector?: string;
  sentiment?: 'POSITIVE' | 'NEUTRAL' | 'NEGATIVE';
  limit?: number;
  offset?: number;
  sinceHours?: number;
}

export async function getNews(filters: NewsFilters = {}): Promise<Sourced<NewsView[]>> {
  const { symbol, sector, sentiment, limit = 30, offset = 0, sinceHours = 72 } = filters;

  const cacheKey = K.news(
    `${symbol ?? 'all'}:${sector ?? 'all'}:${sentiment ?? 'all'}:${limit}:${offset}:${sinceHours}`,
  );
  const cached = await getJson<{ list: NewsView[]; asOf: string }>(cacheKey);
  if (cached) {
    return sourced(cached.list, {
      source: 'news-store',
      asOf: cached.asOf,
      freshness: 'news',
      kind: 'market_data',
    });
  }

  const rows = await queryRows<NewsRow>(
    `SELECT ${NEWS_SELECT}
       FROM news_articles n
      WHERE n.published_at > now() - ($4 || ' hours')::interval
        AND ($1::text IS NULL OR EXISTS (
              SELECT 1 FROM news_entities ne JOIN instruments i ON i.id = ne.instrument_id
               WHERE ne.article_id = n.id AND i.tradingsymbol = $1))
        AND ($2::text IS NULL OR EXISTS (
              SELECT 1 FROM news_entities ne JOIN instruments i ON i.id = ne.instrument_id
               WHERE ne.article_id = n.id AND i.sector = $2))
        AND ($3::text IS NULL OR n.sentiment = $3)
      ORDER BY n.published_at DESC
      LIMIT $5 OFFSET $6`,
    [
      symbol?.toUpperCase() ?? null,
      sector ?? null,
      sentiment ?? null,
      String(sinceHours),
      limit,
      offset,
    ],
  );

  if (rows.length === 0) {
    return unavailable(
      'no_news',
      'No news articles are stored for this filter. Configure a news source in Settings → Market Data Provider (RSS feeds work without an API key) and the news poller will begin populating this feed.',
    );
  }

  const list = rows.map(toView);
  const asOf = list[0]!.publishedAt;
  await setJson(cacheKey, { list, asOf }, TTL.news);

  return sourced(list, {
    source: 'news-store',
    asOf,
    freshness: 'news',
    kind: 'market_data',
  });
}

export async function getNewsForInstrument(
  instrumentId: number,
  limit = 20,
): Promise<Sourced<NewsView[]>> {
  const rows = await queryRows<NewsRow>(
    `SELECT ${NEWS_SELECT}
       FROM news_articles n
       JOIN news_entities ne ON ne.article_id = n.id
      WHERE ne.instrument_id = $1
      ORDER BY n.published_at DESC
      LIMIT $2`,
    [instrumentId, limit],
  );

  if (rows.length === 0) {
    return unavailable(
      'no_news',
      'No news articles are linked to this instrument yet.',
    );
  }

  const list = rows.map(toView);
  return sourced(list, {
    source: 'news-store',
    asOf: list[0]!.publishedAt,
    freshness: 'news',
    kind: 'market_data',
  });
}

/**
 * The news → stock impact view (brief section 16).
 *
 * States *potential relevance* based on how the entity was matched, and is
 * explicit that no directional claim is being made.
 */
export interface NewsImpactView {
  article: NewsView;
  impacts: Array<{
    symbol: string;
    name: string | null;
    relevance: number;
    relevanceLabel: 'High' | 'Medium' | 'Low';
    reason: string;
    potentialImpact: string;
  }>;
  disclaimer: string;
}

export async function getNewsImpact(articleId: string): Promise<NewsImpactView | null> {
  const rows = await queryRows<NewsRow>(
    `SELECT ${NEWS_SELECT} FROM news_articles n WHERE n.id = $1`,
    [articleId],
  );
  const row = rows[0];
  if (!row) return null;

  const article = toView(row);

  return {
    article,
    impacts: article.relatedInstruments.map((e) => {
      const relevanceLabel = e.relevance >= 0.9 ? 'High' : e.relevance >= 0.7 ? 'Medium' : 'Low';
      const reason =
        e.matchReason === 'exact_symbol'
          ? 'The article text contains this trading symbol directly.'
          : e.matchReason === 'company_name'
            ? 'The article text contains the full registered company name.'
            : 'The article text contains a fragment of the company name, which may refer to a different entity.';

      return {
        symbol: e.symbol,
        name: e.name,
        relevance: e.relevance,
        relevanceLabel: relevanceLabel as 'High' | 'Medium' | 'Low',
        reason,
        potentialImpact:
          `This article mentions ${e.name ?? e.symbol}. Whether it moves the price, and in which direction, ` +
          `depends on what the market already expected — which this system does not measure.`,
      };
    }),
    disclaimer:
      'Relevance describes how confidently the article was matched to the instrument, not how significant the news is or what it implies for the price. No directional claim is made.',
  };
}
