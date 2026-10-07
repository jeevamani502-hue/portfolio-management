/**
 * Upstream tick ingest.
 *
 * Holds one broker websocket for the whole deployment and fans every tick
 * out over Redis, so any number of API processes can serve live prices from
 * a single upstream subscription. The leader lock in the worker guarantees
 * "one": several processes each opening their own socket would multiply the
 * broker's connection count and, on most brokers, get the key throttled.
 *
 * What gets subscribed is deliberately bounded. A broker feed is not free
 * bandwidth — Angel One caps a connection at 1000 instruments — so this
 * watches the headline indices, index-option underlyings, the NIFTY 50
 * universe, and whatever users actually hold or have on a watchlist. Not
 * the whole instrument master.
 */
import { logger } from '../../utils/logger.js';
import { queryRows } from '../../db/pool.js';
import { redis } from '../../cache/redis.js';
import { K, TTL } from '../../cache/keys.js';
import { getWorkerRegistry } from '../../providers/registry.js';
import * as instrumentsRepo from '../../db/repositories/instruments.js';
import type { TickStream, NormalizedTick } from '../../providers/types.js';

const log = logger.child({ job: 'tick-ingest' });

/**
 * Angel One allows 1000 instruments per connection. Staying well under it
 * leaves room for a user adding a watchlist entry mid-session without the
 * subscription being silently truncated by the broker.
 */
const MAX_SUBSCRIPTIONS = 800;

let stream: TickStream | null = null;
let subscribedTokens = new Set<string>();
let statusHeartbeat: NodeJS.Timeout | null = null;

/**
 * How long the published feed status stays valid.
 *
 * It expires on purpose: a worker that dies without a clean shutdown would
 * otherwise leave "connected" behind forever and the UI would claim a live
 * feed that stopped hours ago. The heartbeat below renews it while the
 * socket is genuinely up, so absence of a heartbeat is absence of a feed.
 */
const FEED_STATUS_TTL_SEC = 30;
const FEED_HEARTBEAT_MS = 10_000;

function publishFeedStatus(connected: boolean): void {
  void redis.set(
    K.feedStatus,
    connected ? 'connected' : 'down',
    'EX',
    FEED_STATUS_TTL_SEC,
  );
}

/** Instruments worth streaming, most important first. */
async function instrumentsToWatch(): Promise<
  Array<{ id: number; token: string; symbol: string }>
> {
  const rows = await queryRows<{ id: number; provider_tokens: Record<string, string> | null; tradingsymbol: string; exchange: string }>(
    `SELECT DISTINCT i.id, i.provider_tokens, i.tradingsymbol, i.exchange
       FROM instruments i
      WHERE i.is_active = TRUE
        AND i.provider_tokens ? 'angelone'
        AND (
          -- Headline indices and the F&O underlyings.
          i.exchange = 'INDICES'
          -- The scanner universe.
          OR 'NIFTY50' = ANY(i.index_membership)
          OR 'BANKNIFTY' = ANY(i.index_membership)
          -- Anything a user actually holds.
          OR EXISTS (SELECT 1 FROM portfolio_holdings h WHERE h.instrument_id = i.id)
          -- Anything on a watchlist.
          OR EXISTS (SELECT 1 FROM watchlist_items w WHERE w.instrument_id = i.id)
          -- Open paper positions, so the advisor sees moves as they happen.
          OR EXISTS (SELECT 1 FROM paper_trades t WHERE t.instrument_id = i.id AND t.status = 'OPEN')
          -- Contracts the F&O signal tracker is following, so their premiums tick live too.
          OR EXISTS (SELECT 1 FROM fno_signals s WHERE s.instrument_id = i.id AND s.status = 'ACTIVE')
          -- Live positions: their exits are managed off this feed.
          OR EXISTS (SELECT 1 FROM live_trades l WHERE l.instrument_id = i.id AND l.status IN ('PENDING','OPEN','EXITING'))
        )
      LIMIT $1`,
    [MAX_SUBSCRIPTIONS],
  );

  return rows
    .map((r) => ({
      id: r.id,
      token: r.provider_tokens?.['angelone'] ?? '',
      symbol: `${r.exchange}:${r.tradingsymbol}`,
    }))
    .filter((r) => r.token);
}

/**
 * Start streaming, if a provider can.
 *
 * Returns false when no provider implements `streamTicks`, which is not an
 * error — the platform falls back to fetching quotes on request, and the
 * gateway reports the feed as unavailable rather than showing a stale price
 * as live.
 */
export async function startTickIngest(): Promise<boolean> {
  if (stream?.connected) return true;

  const registry = await getWorkerRegistry();
  const provider = registry
    .all()
    .find((p) => p.isConfigured() && typeof p.openTickStream === 'function');

  if (!provider) {
    log.info('No configured provider implements streamTicks; prices will be fetched on request.');
    return false;
  }

  const watch = await instrumentsToWatch();
  if (watch.length === 0) {
    log.warn('Nothing to stream — the instrument master has no Angel One tokens yet.');
    return false;
  }

  // Token to instrument id, so a tick can be published on the right channel.
  const instrumentByToken = new Map(watch.map((w) => [w.token, w]));

  stream = await provider.openTickStream!({
    tokens: watch.map((w) => w.token),
    onTick: (tick: NormalizedTick) => {
      const inst = instrumentByToken.get(tick.providerToken);
      if (!inst) return;

      // The gateway's wire format is deliberately compact — these messages
      // go out several times a second per symbol, and the field names are a
      // meaningful share of the bytes. Publishing the internal NormalizedTick
      // shape instead would be silently dropped by the fan-out, which reads
      // `s` for the symbol key.
      void redis.publish(
        K.tickChannel(inst.id),
        JSON.stringify({
          s: inst.symbol,
          ltp: tick.ltp,
          ch: null,
          chp: null,
          v: tick.volume,
          oi: tick.oi,
          src: provider.manifest.id,
          t: Date.parse(tick.timestamp),
        }),
      );

      // Keep the hot quote cache warm from the stream, so a page load
      // between ticks still gets the latest price rather than a REST call.
      // Deliberately unscoped by user: this is the shared upstream feed the
      // worker owns, and the API re-reads it per user through its own key.
      void redis.set(
        K.streamTick(inst.id),
        JSON.stringify({ ltp: tick.ltp, ts: tick.timestamp, source: provider.manifest.id }),
        'EX',
        TTL.quote,
      );
    },
    onStatus: ({ connected, reason }) => {
      if (connected) log.info({ instruments: watch.length }, 'Upstream tick feed connected');
      else log.warn({ reason }, 'Upstream tick feed down');
      publishFeedStatus(connected);
    },
  });

  subscribedTokens = new Set(watch.map((w) => w.token));

  // Renew the status key while the socket is up. Without this it expires
  // after half a minute and the header reports "no live feed" while ticks
  // are still arriving — which is worse than either state being true.
  if (statusHeartbeat) clearInterval(statusHeartbeat);
  statusHeartbeat = setInterval(() => {
    publishFeedStatus(stream?.connected ?? false);
  }, FEED_HEARTBEAT_MS);
  statusHeartbeat.unref();
  publishFeedStatus(true);

  log.info({ instruments: watch.length }, 'Tick ingest started');
  return true;
}

/**
 * Pick up instruments added since the stream opened.
 *
 * A user adding a watchlist entry mid-session should see it stream without
 * waiting for a restart.
 */
export async function refreshSubscriptions(): Promise<void> {
  if (!stream?.connected) return;

  const watch = await instrumentsToWatch();
  const wanted = new Set(watch.map((w) => w.token));

  const added = [...wanted].filter((t) => !subscribedTokens.has(t));
  const removed = [...subscribedTokens].filter((t) => !wanted.has(t));

  if (added.length > 0) await stream.subscribe(added);
  if (removed.length > 0) await stream.unsubscribe(removed);
  if (added.length > 0 || removed.length > 0) {
    log.info({ added: added.length, removed: removed.length }, 'Tick subscriptions updated');
  }
  subscribedTokens = wanted;
}

export async function stopTickIngest(): Promise<void> {
  if (statusHeartbeat) clearInterval(statusHeartbeat);
  statusHeartbeat = null;
  await stream?.close();
  stream = null;
  subscribedTokens = new Set();
  publishFeedStatus(false);
}

export const tickIngestConnected = (): boolean => stream?.connected ?? false;
