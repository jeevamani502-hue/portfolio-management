/**
 * RSS news provider.
 *
 * Publisher-sanctioned feeds are the zero-cost, zero-legal-risk default for
 * market news: RSS exists precisely to be consumed programmatically. Feeds are
 * configured via the RSS_FEEDS environment variable so an operator can point
 * at whichever publications they are entitled to read.
 *
 * No feed URLs are hardcoded — shipping a default list would embed an implicit
 * claim about which publishers permit this use, which is the operator's call.
 */
import { XMLParser } from 'fast-xml-parser';
import { HttpProvider } from '../base/HttpProvider.js';
import { env } from '../../config/env.js';
import { logger } from '../../utils/logger.js';
import type {
  MarketDataProvider,
  ProviderManifest,
  NormalizedNewsItem,
  ProviderId,
} from '../types.js';

interface RssItem {
  title?: string | { '#text'?: string };
  description?: string;
  link?: string | { '@_href'?: string };
  pubDate?: string;
  published?: string;
  updated?: string;
  'dc:creator'?: string;
  author?: string | { name?: string };
  category?: string | string[];
  guid?: string | { '#text'?: string };
}

export class RssNewsProvider extends HttpProvider implements MarketDataProvider {
  protected readonly providerId: ProviderId = 'rss';
  protected readonly baseUrl = '';
  protected override distributedThrottle = false;

  private feeds: string[];
  private parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    textNodeName: '#text',
  });

  readonly manifest: ProviderManifest = {
    id: 'rss',
    displayName: 'RSS feeds',
    docsUrl: 'https://www.rssboard.org/rss-specification',
    authModel: 'none',
    capabilities: ['news'],
    credentialFields: [
      {
        key: 'feeds',
        label: 'Feed URLs',
        secret: false,
        required: true,
        help: 'Comma-separated RSS/Atom URLs from publications you are entitled to read (for example a business daily\'s markets feed, or exchange corporate-announcement feeds).',
      },
    ],
    throttleMs: { default: 1_000 },
    notes:
      'Free and publisher-sanctioned. Entity tagging is done locally against the instrument master, since RSS carries no ticker metadata.',
  };

  constructor(creds: { feeds?: string } = {}) {
    super();
    this.feeds = creds.feeds
      ? creds.feeds.split(',').map((s) => s.trim()).filter(Boolean)
      : env.RSS_FEEDS;
    this.throttle = { ...this.manifest.throttleMs };
  }

  isConfigured(): boolean {
    return this.feeds.length > 0;
  }

  async healthCheck() {
    if (!this.isConfigured()) {
      return { ok: false, latencyMs: 0, detail: 'No feed URLs configured' };
    }
    return this.probe(async () => {
      await this.http<string>(this.feeds[0]!, { raw: true, retries: 0, timeoutMs: 10_000 });
    });
  }

  async getNews(params: { limit?: number } = {}): Promise<NormalizedNewsItem[]> {
    const { limit = 50 } = params;
    const all: NormalizedNewsItem[] = [];

    // One slow feed must not sink the batch.
    const results = await Promise.allSettled(
      this.feeds.map(async (url) => {
        const xml = await this.http<string>(url, { raw: true, timeoutMs: 15_000, retries: 1 });
        return this.parseFeed(xml, url);
      }),
    );

    for (const r of results) {
      if (r.status === 'fulfilled') all.push(...r.value);
      else logger.warn({ err: r.reason }, 'RSS feed fetch failed');
    }

    // Dedupe by URL, newest first.
    const seen = new Set<string>();
    return all
      .filter((item) => {
        if (seen.has(item.url)) return false;
        seen.add(item.url);
        return true;
      })
      .sort((a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime())
      .slice(0, limit);
  }

  private parseFeed(xml: string, feedUrl: string): NormalizedNewsItem[] {
    const parsed = this.parser.parse(xml) as Record<string, unknown>;

    // RSS 2.0: rss.channel.item — Atom: feed.entry
    const channel = (parsed['rss'] as Record<string, unknown> | undefined)?.['channel'] as
      | Record<string, unknown>
      | undefined;
    const atom = parsed['feed'] as Record<string, unknown> | undefined;

    const rawItems = (channel?.['item'] ?? atom?.['entry'] ?? []) as RssItem | RssItem[];
    const items = Array.isArray(rawItems) ? rawItems : [rawItems];

    const publisher =
      text(channel?.['title']) ?? text(atom?.['title']) ?? hostOf(feedUrl) ?? 'RSS';

    const out: NormalizedNewsItem[] = [];
    for (const item of items) {
      if (!item) continue;
      const headline = text(item.title);
      const url = linkOf(item);
      if (!headline || !url) continue;

      const publishedRaw = item.pubDate ?? item.published ?? item.updated;
      const published = publishedRaw ? new Date(publishedRaw) : null;

      out.push({
        headline: decodeEntities(headline).trim(),
        summary: item.description ? stripHtml(decodeEntities(String(item.description))).slice(0, 1000) : null,
        url,
        publisher,
        author: text(item['dc:creator']) ?? text(item.author) ?? null,
        category: Array.isArray(item.category) ? item.category[0] ?? null : (item.category ?? null),
        publishedAt:
          published && !Number.isNaN(published.getTime())
            ? published.toISOString()
            : new Date().toISOString(),
        providerSymbols: [],
        // RSS carries no sentiment. We do not invent one here; the news
        // service applies a transparent lexicon classifier downstream.
        providerSentiment: null,
      });
    }
    return out;
  }
}

function text(v: unknown): string | null {
  if (typeof v === 'string') return v;
  if (v && typeof v === 'object') {
    const t = (v as Record<string, unknown>)['#text'];
    if (typeof t === 'string') return t;
    const n = (v as Record<string, unknown>)['name'];
    if (typeof n === 'string') return n;
  }
  return null;
}

function linkOf(item: RssItem): string | null {
  if (typeof item.link === 'string' && item.link) return item.link;
  if (item.link && typeof item.link === 'object') {
    const href = (item.link as Record<string, unknown>)['@_href'];
    if (typeof href === 'string') return href;
  }
  const guid = text(item.guid);
  if (guid?.startsWith('http')) return guid;
  return null;
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

export function stripHtml(html: string): string {
  return html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

const ENTITIES: Record<string, string> = {
  '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'",
  '&apos;': "'", '&nbsp;': ' ', '&rsquo;': '’', '&lsquo;': '‘',
  '&ldquo;': '“', '&rdquo;': '”', '&ndash;': '–', '&mdash;': '—',
};

export function decodeEntities(s: string): string {
  return s
    .replace(/&[a-z]+;|&#\d+;/gi, (m) => {
      if (ENTITIES[m]) return ENTITIES[m]!;
      const num = /^&#(\d+);$/.exec(m);
      return num ? String.fromCharCode(Number(num[1])) : m;
    });
}
