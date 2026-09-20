import { logger } from '../../utils/logger.js';
import { env } from '../../config/env.js';
import { RssNewsProvider } from '../../providers/news/rss.js';
import { ingestNews } from '../../modules/news/news.service.js';

const log = logger.child({ job: 'news-poller' });

/**
 * Fetch and ingest news.
 *
 * RSS is the default because it is free and publisher-sanctioned. No feed URLs
 * ship with the project — shipping a list would embed an implicit claim about
 * which publishers permit this use, which is the operator's call. Configure
 * RSS_FEEDS to switch the poller on.
 */
export async function pollNews(): Promise<void> {
  const provider = new RssNewsProvider({});

  if (!provider.isConfigured()) {
    log.info(
      'No news source configured. Set RSS_FEEDS to a comma-separated list of feeds you are entitled to read, and the news feed will begin populating.',
    );
    return;
  }

  try {
    const items = await provider.getNews({ limit: 100 });
    const result = await ingestNews(items, 'rss');
    log.info(result, 'News ingestion complete');
  } catch (err) {
    log.error({ err, feeds: env.RSS_FEEDS.length }, 'News polling failed');
  }
}
