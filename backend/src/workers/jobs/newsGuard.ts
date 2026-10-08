/**
 * News guard — re-checks every open position when news lands on its underlying.
 *
 * Every two minutes in market hours, for each open paper position, open live
 * position and active journaled signal: find articles on the underlying
 * published since the position was last checked. If there are any, re-read
 * the chart (15m rule score, Supertrend, VWAP side, daily score) and let the
 * pure reaction rules decide — exit, tighten the stop, or hold. The user is
 * told what the news said, what the chart said, and what was done.
 *
 * The news only prompts the look. See newsReaction.ts for why it never acts
 * on its own.
 */
import { logger } from '../../utils/logger.js';
import { query, queryRows } from '../../db/pool.js';
import { registryForUser, type ProviderRegistry } from '../../providers/registry.js';
import * as instrumentsRepo from '../../db/repositories/instruments.js';
import { getCandles, getQuote } from '../../modules/market/marketData.service.js';
import { underlyingInstrumentFor } from '../../modules/options/options.service.js';
import { isAvailable } from '../../utils/sourced.js';
import { buildSnapshot } from '../../analysis/snapshot.js';
import { runSignalEngine } from '../../analysis/signals/engine.js';
import {
  decideNewsReaction, type NewsItemLite, type ChartRead, type NewsReaction,
} from '../../analysis/options/newsReaction.js';
import { closePaperTrade, tightenPaperStop } from '../../modules/paper/paper.service.js';
import { exitLive, tightenLiveStop } from '../../modules/live/live.service.js';
import { notify } from '../../modules/notifications/notifications.service.js';

const log = logger.child({ job: 'news-guard' });

/** Only articles this tightly matched to the underlying count. */
const MIN_RELEVANCE = 0.7;

/** How the index underlyings are spelled across the instrument master. */
const ALIASES: Record<string, string[]> = {
  NIFTY: ['NIFTY', 'NIFTY 50', 'NIFTY50'],
  BANKNIFTY: ['BANKNIFTY', 'NIFTY BANK'],
  FINNIFTY: ['FINNIFTY', 'NIFTY FIN SERVICE'],
  MIDCPNIFTY: ['MIDCPNIFTY', 'NIFTY MID SELECT', 'NIFTY MIDCAP SELECT'],
};

interface Position {
  kind: 'paper' | 'live' | 'signal';
  id: string;
  userId: string;
  underlying: string;
  tradingsymbol: string;
  action: 'BUY_CALL' | 'BUY_PUT';
  instrumentId: number | null;
  entryPremium: number;
  stopPremium: number;
  since: Date;
}

async function openPositions(): Promise<Position[]> {
  const paper = await queryRows<{
    id: string; user_id: string; underlying: string | null; tradingsymbol: string; instrument_id: string | null;
    entry_price: string; stop_price: string | null; entry_at: Date; news_checked_at: Date | null;
  }>(
    `SELECT id, user_id, underlying, tradingsymbol, instrument_id, entry_price, stop_price, entry_at, news_checked_at
       FROM paper_trades WHERE status = 'OPEN' AND kind = 'OPTION' AND underlying IS NOT NULL`,
  );
  const live = await queryRows<{
    id: string; user_id: string; underlying: string; tradingsymbol: string; instrument_id: string | null; action: 'BUY_CALL' | 'BUY_PUT';
    entry_price: string; stop_premium: string; entry_at: Date | null; news_checked_at: Date | null;
  }>(
    `SELECT id, user_id, underlying, tradingsymbol, instrument_id, action, entry_price, stop_premium, entry_at, news_checked_at
       FROM live_trades WHERE status = 'OPEN'`,
  );
  const signals = await queryRows<{
    id: string; user_id: string; underlying: string; tradingsymbol: string | null; instrument_id: string | null; action: 'BUY_CALL' | 'BUY_PUT';
    entry_premium: string; stop_premium: string; generated_at: Date; news_checked_at: Date | null;
  }>(
    `SELECT id, user_id, underlying, tradingsymbol, instrument_id, action, entry_premium, stop_premium, generated_at, news_checked_at
       FROM fno_signals WHERE status = 'ACTIVE'`,
  );
  return [
    ...paper.map<Position>((p) => ({
      kind: 'paper', id: p.id, userId: p.user_id, underlying: p.underlying!, tradingsymbol: p.tradingsymbol,
      action: p.tradingsymbol.endsWith('PE') ? 'BUY_PUT' : 'BUY_CALL', instrumentId: p.instrument_id ? Number(p.instrument_id) : null,
      entryPremium: Number(p.entry_price), stopPremium: Number(p.stop_price ?? 0), since: p.news_checked_at ?? p.entry_at,
    })),
    ...live.map<Position>((l) => ({
      kind: 'live', id: l.id, userId: l.user_id, underlying: l.underlying, tradingsymbol: l.tradingsymbol, action: l.action,
      instrumentId: l.instrument_id ? Number(l.instrument_id) : null, entryPremium: Number(l.entry_price),
      stopPremium: Number(l.stop_premium), since: l.news_checked_at ?? l.entry_at ?? new Date(),
    })),
    ...signals.map<Position>((s) => ({
      kind: 'signal', id: s.id, userId: s.user_id, underlying: s.underlying, tradingsymbol: s.tradingsymbol ?? s.underlying, action: s.action,
      instrumentId: s.instrument_id ? Number(s.instrument_id) : null, entryPremium: Number(s.entry_premium),
      stopPremium: Number(s.stop_premium), since: s.news_checked_at ?? s.generated_at,
    })),
  ];
}

async function freshNews(underlying: string, since: Date): Promise<NewsItemLite[]> {
  const aliases = ALIASES[underlying] ?? [underlying];
  const rows = await queryRows<{
    headline: string; sentiment: NewsItemLite['sentiment']; sentiment_score: string | null;
    relevance: string; published_at: Date;
  }>(
    `SELECT DISTINCT ON (n.id) n.headline, n.sentiment, n.sentiment_score, e.relevance::text AS relevance, n.published_at
       FROM news_articles n
       JOIN news_entities e ON e.article_id = n.id
       JOIN instruments i ON i.id = e.instrument_id
      WHERE n.published_at > $1
        AND e.relevance >= $2
        AND (i.tradingsymbol = ANY($3::text[]) OR i.underlying = $4)
      ORDER BY n.id, e.relevance DESC
      LIMIT 10`,
    [since, MIN_RELEVANCE, aliases, underlying],
  );
  return rows.map((r) => ({
    headline: r.headline,
    sentiment: r.sentiment,
    score: r.sentiment_score === null ? null : Number(r.sentiment_score),
    relevance: Number(r.relevance),
    publishedAt: r.published_at.toISOString(),
  }));
}

/** The chart as the reaction rules want it, from stored candles. */
async function readChart(registry: ProviderRegistry, underlying: string): Promise<ChartRead> {
  const read: ChartRead = { intradayScore: null, intradaySupertrend: null, aboveVwap: null, dailyScore: null };
  const row = await instrumentsRepo.resolveSymbol(underlyingInstrumentFor(underlying));
  if (!row) return read;
  try {
    const intra = await getCandles(registry, row, '15m', { bars: 300 });
    if (intra.candles.length >= 30) {
      const snap = buildSnapshot(row.tradingsymbol, '15m', intra.candles);
      read.intradayScore = runSignalEngine(snap).overallScore;
      read.intradaySupertrend = snap.trend.supertrendDirection;
      read.aboveVwap = snap.vwap === null ? null : snap.price.close > snap.vwap;
    }
  } catch (err) {
    log.debug({ err, underlying }, 'Intraday read failed');
  }
  try {
    const daily = await getCandles(registry, row, '1d', { bars: 300 });
    if (daily.candles.length >= 30) {
      read.dailyScore = runSignalEngine(buildSnapshot(row.tradingsymbol, '1d', daily.candles)).overallScore;
    }
  } catch (err) {
    log.debug({ err, underlying }, 'Daily read failed');
  }
  return read;
}

async function markChecked(p: Position): Promise<void> {
  const table = p.kind === 'paper' ? 'paper_trades' : p.kind === 'live' ? 'live_trades' : 'fno_signals';
  await query(`UPDATE ${table} SET news_checked_at = now() WHERE id = $1`, [p.id]);
}

async function act(p: Position, r: NewsReaction): Promise<string> {
  if (p.kind === 'signal') return r.kind === 'HOLD' ? 'noted' : `${r.kind.toLowerCase()} suggested`;
  if (r.kind === 'EXIT') {
    const ok = p.kind === 'paper'
      ? await closePaperTrade(p.userId, p.id, 'NEWS')
      : await exitLive(p.userId, Number(p.id), 'NEWS', r.reason);
    return ok ? 'exited' : 'exit failed — no price to close at';
  }
  if (r.kind === 'TIGHTEN' && r.newStop !== undefined && r.newStop > p.stopPremium) {
    if (p.kind === 'paper') await tightenPaperStop(p.id, r.newStop);
    else await tightenLiveStop(Number(p.id), r.newStop);
    return `stop raised to ₹${r.newStop.toFixed(2)}`;
  }
  return 'held';
}

export async function guardAgainstNews(): Promise<void> {
  const positions = await openPositions();
  if (positions.length === 0) return;

  const registries = new Map<string, ProviderRegistry>();
  const charts = new Map<string, ChartRead>();
  let looked = 0;
  let acted = 0;

  for (const p of positions) {
    try {
      const news = await freshNews(p.underlying, p.since);
      await markChecked(p);
      if (news.length === 0) continue;
      looked += 1;

      let registry = registries.get(p.userId);
      if (!registry) { registry = await registryForUser(p.userId); registries.set(p.userId, registry); }

      const chartKey = `${p.userId}:${p.underlying}`;
      let chart = charts.get(chartKey);
      if (!chart) { chart = await readChart(registry, p.underlying); charts.set(chartKey, chart); }

      let currentPremium: number | null = null;
      if (p.instrumentId !== null) {
        const contract = await instrumentsRepo.getById(p.instrumentId);
        const q = contract ? await getQuote(registry, contract) : null;
        currentPremium = q && isAvailable(q) ? q.value.ltp : null;
      }

      const reaction = decideNewsReaction(news, {
        action: p.action, entryPremium: p.entryPremium, currentPremium, stopPremium: p.stopPremium,
      }, chart);
      const outcome = await act(p, reaction);
      if (reaction.kind !== 'HOLD') acted += 1;

      // Neutral news that changes nothing is not worth a ping.
      if (reaction.kind === 'HOLD' && reaction.tone === 'NEUTRAL') continue;

      const kindLabel = p.kind === 'paper' ? 'paper' : p.kind === 'live' ? 'LIVE' : 'tracked signal';
      await notify(p.userId, {
        kind: p.kind === 'live' ? 'live' : p.kind === 'paper' ? 'paper_advice' : 'fno_exit',
        severity: reaction.kind === 'EXIT' ? 'warning' : reaction.kind === 'TIGHTEN' ? 'action' : 'info',
        title: `${p.tradingsymbol} (${kindLabel}): news — ${reaction.kind === 'HOLD' ? 'holding' : outcome}`,
        message:
          `“${reaction.headlines[0] ?? 'news'}”${reaction.headlines.length > 1 ? ` (+${reaction.headlines.length - 1} more)` : ''}. ` +
          `${reaction.reason} Chart factors against: ${reaction.chartAgainst} of ${reaction.chartReadable} readable. ` +
          'The headline prompted the look; the chart decided.',
        payload: { positionKind: p.kind, id: p.id, reaction, chart, headlines: reaction.headlines },
        link: p.kind === 'live' ? '/live' : p.kind === 'paper' ? '/paper' : '/fno',
      });
      log.info({ kind: p.kind, id: p.id, reaction: reaction.kind, tone: reaction.tone, outcome }, 'News guard reacted');
    } catch (err) {
      log.warn({ err, kind: p.kind, id: p.id }, 'News guard failed for this position');
    }
  }

  if (looked > 0) log.info({ positions: positions.length, looked, acted }, 'News guard sweep complete');
}
