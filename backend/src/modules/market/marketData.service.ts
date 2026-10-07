/**
 * Market data service — the only place the rest of the backend gets prices.
 *
 * Responsibilities:
 *   · read-through cache (Redis hot → provider → Postgres persistence)
 *   · attach provenance to every value via `Sourced<T>`
 *   · degrade honestly: a cache miss + provider failure produces an
 *     `Unavailable`, never a stale value relabelled as live
 *   · candle assembly, including local aggregation for timeframes a provider
 *     does not serve natively (4h, 1w, 1M)
 */
import { getJson, setJson, redis } from '../../cache/redis.js';
import { scopedKey, K, TTL } from '../../cache/keys.js';
import { env } from '../../config/env.js';
import { query, queryRows, type QueryParam } from '../../db/pool.js';
import { logger } from '../../utils/logger.js';
import {
  sourced,
  unavailable,
  type Sourced,
} from '../../utils/sourced.js';
import { getMarketStatus, bucketStart, isIntraday, type Timeframe, type MarketStatus } from '../../utils/time.js';
import type { ProviderRegistry } from '../../providers/registry.js';
import { recordDataQualityEvent, attemptsFrom } from '../../providers/registry.js';
import type {
  NormalizedQuote,
  NormalizedCandle,
  QuoteRequest,
} from '../../providers/types.js';
import { symbolKey } from '../../providers/types.js';
import * as instruments from '../../db/repositories/instruments.js';
import type { InstrumentRow } from '../../db/repositories/instruments.js';
import type { Candle } from '../../analysis/indicators/index.js';

// ── market status (cached; holidays come from the DB) ──────────────────────

let holidayCache: { at: number; set: Set<string> } | null = null;

async function holidays(): Promise<Set<string>> {
  if (holidayCache && Date.now() - holidayCache.at < 3600_000) return holidayCache.set;
  try {
    const rows = await queryRows<{ d: string }>(
      `SELECT to_char(holiday_date, 'YYYY-MM-DD') AS d FROM trading_holidays WHERE exchange = 'NSE'`,
    );
    holidayCache = { at: Date.now(), set: new Set(rows.map((r) => r.d)) };
  } catch {
    holidayCache = { at: Date.now(), set: new Set() };
  }
  return holidayCache.set;
}

export async function marketStatus(): Promise<MarketStatus> {
  return getMarketStatus({ holidays: await holidays() });
}

// ── quotes ──────────────────────────────────────────────────────────────────

export interface CachedQuote extends NormalizedQuote {
  /** Provider the quote came from. */
  _source: string;
  /** When we cached it. */
  _cachedAt: string;
}

/**
 * Sanity checks before a tick or quote is accepted.
 *
 * A feed glitch that prints a zero or a 10× price must never reach the user as
 * data. Rejections are logged to the data-quality ledger rather than silently
 * swallowed.
 */
export function isSaneQuote(q: NormalizedQuote): { ok: true } | { ok: false; reason: string } {
  if (!Number.isFinite(q.ltp) || q.ltp <= 0) return { ok: false, reason: 'non_positive_ltp' };
  if (q.high !== null && q.low !== null && q.high < q.low) {
    return { ok: false, reason: 'high_below_low' };
  }
  if (q.high !== null && q.ltp > q.high * 1.2) return { ok: false, reason: 'ltp_far_above_high' };
  if (q.low !== null && q.low > 0 && q.ltp < q.low * 0.8) {
    return { ok: false, reason: 'ltp_far_below_low' };
  }
  // Circuit bands are exchange-enforced; a print outside them is bad data.
  if (q.upperCircuit !== null && q.upperCircuit > 0 && q.ltp > q.upperCircuit * 1.01) {
    return { ok: false, reason: 'above_upper_circuit' };
  }
  if (q.lowerCircuit !== null && q.lowerCircuit > 0 && q.ltp < q.lowerCircuit * 0.99) {
    return { ok: false, reason: 'below_lower_circuit' };
  }
  const age = Date.now() - new Date(q.timestamp).getTime();
  if (age < -120_000) return { ok: false, reason: 'timestamp_in_future' };
  return { ok: true };
}

export async function cacheQuote(
  instrumentId: number,
  quote: NormalizedQuote,
  source: string,
  /**
   * Whose broker session produced this price. Caching without it lets the
   * next user read a feed they are not entitled to — see `scopedKey`.
   */
  userId: string | null = null,
): Promise<void> {
  const payload: CachedQuote = { ...quote, _source: source, _cachedAt: new Date().toISOString() };
  await setJson(
    scopedKey(K.quote(instrumentId), userId, env.SHARED_FEED_LICENSED),
    payload,
    TTL.quote,
  );
}

/** Persist the latest quote for cold-start reads and EOD reconciliation. */
export async function persistQuote(
  instrumentId: number,
  q: NormalizedQuote,
  source: string,
): Promise<void> {
  try {
    await query(
      `INSERT INTO market_prices (instrument_id, ltp, prev_close, open, high, low, close,
                                  volume, avg_price, oi, bid, ask, bid_qty, ask_qty,
                                  upper_circuit, lower_circuit, week52_high, week52_low,
                                  source, as_of, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20, now())
       ON CONFLICT (instrument_id) DO UPDATE SET
         ltp = EXCLUDED.ltp, prev_close = EXCLUDED.prev_close, open = EXCLUDED.open,
         high = EXCLUDED.high, low = EXCLUDED.low, close = EXCLUDED.close,
         volume = EXCLUDED.volume, avg_price = EXCLUDED.avg_price, oi = EXCLUDED.oi,
         bid = EXCLUDED.bid, ask = EXCLUDED.ask, bid_qty = EXCLUDED.bid_qty,
         ask_qty = EXCLUDED.ask_qty, upper_circuit = EXCLUDED.upper_circuit,
         lower_circuit = EXCLUDED.lower_circuit,
         week52_high = COALESCE(EXCLUDED.week52_high, market_prices.week52_high),
         week52_low  = COALESCE(EXCLUDED.week52_low,  market_prices.week52_low),
         source = EXCLUDED.source, as_of = EXCLUDED.as_of, updated_at = now()
       WHERE EXCLUDED.as_of >= market_prices.as_of`,
      [
        instrumentId, q.ltp, q.prevClose, q.open, q.high, q.low, q.close, q.volume,
        q.avgPrice, q.oi, q.bid, q.ask, q.bidQty, q.askQty, q.upperCircuit,
        q.lowerCircuit, q.week52High, q.week52Low, source, q.timestamp,
      ],
    );
  } catch (err) {
    logger.warn({ err, instrumentId }, 'Failed to persist quote');
  }
}

export interface QuoteResult {
  instrument: InstrumentRow;
  quote: Sourced<NormalizedQuote>;
}

/**
 * Fetch one quote with provenance.
 *
 * Path: Redis (fresh) → provider → Postgres (marked delayed) → unavailable.
 */
export async function getQuote(
  registry: ProviderRegistry,
  instrument: InstrumentRow,
  opts: { allowCache?: boolean } = {},
): Promise<Sourced<NormalizedQuote>> {
  const { allowCache = true } = opts;
  const status = await marketStatus();

  if (allowCache) {
    const hit = await getJson<CachedQuote>(
      scopedKey(K.quote(instrument.id), registry.userId, env.SHARED_FEED_LICENSED),
    );
    if (hit) {
      return sourced(hit, {
        source: hit._source,
        asOf: hit.timestamp,
        freshness: 'quote',
        marketOpen: status.isSessionActive,
      });
    }
  }

  // Live fetch.
  try {
    const { value, provider } = await registry.run('quote', async (p) => {
      if (!p.getQuote) throw new Error('quote not implemented');
      const token = instruments.providerToken(instrument, p.manifest.id);
      const req: QuoteRequest = {
        exchange: instrument.exchange,
        tradingsymbol: instrument.tradingsymbol,
        providerToken: token,
      };
      return p.getQuote(req);
    });

    const sane = isSaneQuote(value);
    if (!sane.ok) {
      await recordDataQualityEvent({
        kind: 'sanity_reject',
        provider,
        capability: 'quote',
        symbol: symbolKey(instrument.exchange, instrument.tradingsymbol),
        detail: { reason: sane.reason, ltp: value.ltp },
      });
      throw new Error(`Quote failed sanity check: ${sane.reason}`);
    }

    await Promise.all([
      cacheQuote(instrument.id, value, provider, registry.userId),
      persistQuote(instrument.id, value, provider),
    ]);

    return sourced(value, {
      source: provider,
      asOf: value.timestamp,
      freshness: 'quote',
      marketOpen: status.isSessionActive,
    });
  } catch (err) {
    // Last resort: the stored row, explicitly marked as not live.
    const stored = await fetchStoredQuote(instrument);
    if (stored) {
      await recordDataQualityEvent({
        kind: 'stale_read',
        capability: 'quote',
        symbol: symbolKey(instrument.exchange, instrument.tradingsymbol),
        detail: { asOf: stored.quote.timestamp },
      });
      return sourced(stored.quote, {
        source: `${stored.source} (stored)`,
        asOf: stored.quote.timestamp,
        freshness: 'quote',
        // Never claim live for a value that came from the database after a
        // provider failure, even during market hours.
        marketOpen: false,
      });
    }

    return unavailable(
      'no_provider_data',
      `Live market data unavailable for ${instrument.tradingsymbol}.`,
      attemptsFrom(err),
    );
  }
}

async function fetchStoredQuote(
  instrument: InstrumentRow,
): Promise<{ quote: NormalizedQuote; source: string } | null> {
  const rows = await queryRows<{
    ltp: number; prev_close: number | null; open: number | null; high: number | null;
    low: number | null; close: number | null; volume: number | null; avg_price: number | null;
    oi: number | null; bid: number | null; ask: number | null; bid_qty: number | null;
    ask_qty: number | null; upper_circuit: number | null; lower_circuit: number | null;
    week52_high: number | null; week52_low: number | null; source: string; as_of: Date;
  }>(`SELECT * FROM market_prices WHERE instrument_id = $1`, [instrument.id]);

  const r = rows[0];
  if (!r || r.ltp === null) return null;

  return {
    source: r.source,
    quote: {
      symbol: symbolKey(instrument.exchange, instrument.tradingsymbol),
      exchange: instrument.exchange,
      tradingsymbol: instrument.tradingsymbol,
      ltp: r.ltp,
      prevClose: r.prev_close,
      open: r.open,
      high: r.high,
      low: r.low,
      close: r.close,
      volume: r.volume,
      avgPrice: r.avg_price,
      oi: r.oi,
      oiChange: null,
      bid: r.bid,
      ask: r.ask,
      bidQty: r.bid_qty,
      askQty: r.ask_qty,
      upperCircuit: r.upper_circuit,
      lowerCircuit: r.lower_circuit,
      week52High: r.week52_high,
      week52Low: r.week52_low,
      timestamp: r.as_of.toISOString(),
    },
  };
}

/**
 * Batch quotes. Uses the cache for hits and issues one provider call for the
 * remainder, which is what keeps a 50-symbol watchlist to a single upstream
 * request rather than fifty.
 */
export async function getQuotes(
  registry: ProviderRegistry,
  rows: InstrumentRow[],
): Promise<Map<number, Sourced<NormalizedQuote>>> {
  const out = new Map<number, Sourced<NormalizedQuote>>();
  if (rows.length === 0) return out;

  const status = await marketStatus();
  const misses: InstrumentRow[] = [];

  const cachedRaw = await redis.mget(
    rows.map((r) => scopedKey(K.quote(r.id), registry.userId, env.SHARED_FEED_LICENSED)),
  );
  rows.forEach((row, i) => {
    const raw = cachedRaw[i];
    if (!raw) { misses.push(row); return; }
    try {
      const hit = JSON.parse(raw) as CachedQuote;
      out.set(row.id, sourced(hit, {
        source: hit._source,
        asOf: hit.timestamp,
        freshness: 'quote',
        marketOpen: status.isSessionActive,
      }));
    } catch {
      misses.push(row);
    }
  });

  if (misses.length === 0) return out;

  try {
    const { value, provider } = await registry.run('quoteBatch', async (p) => {
      if (!p.getQuotes) throw new Error('quoteBatch not implemented');
      const reqs: QuoteRequest[] = misses.map((r) => ({
        exchange: r.exchange,
        tradingsymbol: r.tradingsymbol,
        providerToken: instruments.providerToken(r, p.manifest.id),
      }));
      return p.getQuotes(reqs);
    });

    const bySymbol = new Map(value.map((q) => [symbolKey(q.exchange, q.tradingsymbol), q]));

    await Promise.all(
      misses.map(async (row) => {
        const q = bySymbol.get(symbolKey(row.exchange, row.tradingsymbol));
        if (!q) {
          out.set(row.id, unavailable(
            'not_in_provider_response',
            `Live market data unavailable for ${row.tradingsymbol}.`,
          ));
          return;
        }
        const sane = isSaneQuote(q);
        if (!sane.ok) {
          await recordDataQualityEvent({
            kind: 'sanity_reject', provider, capability: 'quoteBatch',
            symbol: row.tradingsymbol, detail: { reason: sane.reason },
          });
          out.set(row.id, unavailable('failed_sanity_check',
            `Quote for ${row.tradingsymbol} failed validation and was discarded.`));
          return;
        }
        await Promise.all([
          cacheQuote(row.id, q, provider, registry.userId),
          persistQuote(row.id, q, provider),
        ]);
        out.set(row.id, sourced(q, {
          source: provider,
          asOf: q.timestamp,
          freshness: 'quote',
          marketOpen: status.isSessionActive,
        }));
      }),
    );
  } catch (err) {
    const attempts = attemptsFrom(err);
    for (const row of misses) {
      const stored = await fetchStoredQuote(row);
      out.set(row.id, stored
        ? sourced(stored.quote, {
            source: `${stored.source} (stored)`,
            asOf: stored.quote.timestamp,
            freshness: 'quote',
            marketOpen: false,
          })
        : unavailable('no_provider_data',
            `Live market data unavailable for ${row.tradingsymbol}.`, attempts));
    }
  }

  return out;
}

// ── candles ─────────────────────────────────────────────────────────────────

/** Timeframes we request upstream; everything else is aggregated locally. */
const NATIVE_TIMEFRAMES = new Set<Timeframe>(['1m', '5m', '15m', '30m', '1h', '1d']);

const BASE_FOR_DERIVED: Partial<Record<Timeframe, Timeframe>> = {
  '4h': '1h',
  '1w': '1d',
  '1M': '1d',
};

/**
 * Aggregate candles into a larger timeframe.
 *
 * Weekly and monthly bucket by IST calendar week/month; 4h buckets by the
 * session-anchored grid so the first bar starts at the open.
 */
export function aggregateCandles(
  candles: readonly NormalizedCandle[],
  target: Timeframe,
): NormalizedCandle[] {
  if (candles.length === 0) return [];

  const keyFor = (ts: string): string => {
    const d = new Date(ts);
    if (target === '1w') {
      // ISO week key.
      const tmp = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
      const day = tmp.getUTCDay() || 7;
      tmp.setUTCDate(tmp.getUTCDate() + 4 - day);
      const yearStart = new Date(Date.UTC(tmp.getUTCFullYear(), 0, 1));
      const week = Math.ceil(((tmp.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
      return `${tmp.getUTCFullYear()}-W${week}`;
    }
    if (target === '1M') {
      return `${d.getUTCFullYear()}-${d.getUTCMonth() + 1}`;
    }
    return bucketStart(d, target).toISOString();
  };

  const buckets = new Map<string, NormalizedCandle[]>();
  const order: string[] = [];
  for (const c of candles) {
    const key = keyFor(c.ts);
    if (!buckets.has(key)) { buckets.set(key, []); order.push(key); }
    buckets.get(key)!.push(c);
  }

  return order.map((key) => {
    const group = buckets.get(key)!;
    return {
      ts: group[0]!.ts,
      open: group[0]!.open,
      high: Math.max(...group.map((c) => c.high)),
      low: Math.min(...group.map((c) => c.low)),
      close: group.at(-1)!.close,
      volume: group.reduce((s, c) => s + c.volume, 0),
      oi: group.at(-1)!.oi ?? null,
    };
  });
}

export async function persistCandles(
  instrumentId: number,
  timeframe: Timeframe,
  candles: readonly NormalizedCandle[],
  source: string,
): Promise<void> {
  if (candles.length === 0) return;
  const BATCH = 500;
  for (let i = 0; i < candles.length; i += BATCH) {
    const batch = candles.slice(i, i + BATCH);
    const values: QueryParam[] = [];
    const tuples: string[] = [];
    batch.forEach((c, idx) => {
      const b = idx * 9;
      // Every column needs an explicit cast, not just the timestamp.
      // PostgreSQL infers parameter types from the first row of a multi-row
      // VALUES list and defaults anything untyped to text, so this failed
      // with "column instrument_id is of type bigint but expression is of
      // type text" — silently, in a catch, on every single batch. Nothing
      // was ever cached, so every chart and every scanner sweep re-fetched
      // from the broker and eventually tripped its rate limit.
      tuples.push(
        `($${b + 1}::bigint,$${b + 2}::text,$${b + 3}::timestamptz,` +
        `$${b + 4}::numeric,$${b + 5}::numeric,$${b + 6}::numeric,$${b + 7}::numeric,` +
        `$${b + 8}::bigint,$${b + 9}::numeric)`,
      );
      values.push(instrumentId, timeframe, c.ts, c.open, c.high, c.low, c.close, c.volume, c.oi);
    });
    try {
      await query(
        `INSERT INTO candles (instrument_id, timeframe, ts, open, high, low, close, volume, oi, source)
         SELECT v.*, $${values.length + 1}::text FROM (VALUES ${tuples.join(',')}) AS v(
           instrument_id, timeframe, ts, open, high, low, close, volume, oi)
         ON CONFLICT (instrument_id, timeframe, ts) DO UPDATE SET
           open = EXCLUDED.open, high = EXCLUDED.high, low = EXCLUDED.low,
           close = EXCLUDED.close, volume = EXCLUDED.volume, oi = EXCLUDED.oi,
           source = EXCLUDED.source`,
        [...values, source],
      );
    } catch (err) {
      logger.error(
        { err, instrumentId, timeframe, bars: batch.length },
        'Failed to persist candle batch — every later request will re-fetch from the provider and count against its rate limit.',
      );
    }
  }
}

async function loadStoredCandles(
  instrumentId: number,
  timeframe: Timeframe,
  from: Date,
  to: Date,
): Promise<{ candles: NormalizedCandle[]; source: string | null }> {
  const rows = await queryRows<{
    ts: Date; open: number; high: number; low: number; close: number;
    volume: number; oi: number | null; source: string;
  }>(
    `SELECT ts, open, high, low, close, volume, oi, source
       FROM candles
      WHERE instrument_id = $1 AND timeframe = $2 AND ts >= $3 AND ts <= $4
      ORDER BY ts`,
    [instrumentId, timeframe, from, to],
  );
  return {
    candles: rows.map((r) => ({
      ts: r.ts.toISOString(), open: r.open, high: r.high, low: r.low,
      close: r.close, volume: r.volume, oi: r.oi,
    })),
    source: rows[0]?.source ?? null,
  };
}

export interface CandleResult {
  candles: Candle[];
  source: string;
  asOf: string | null;
  /** True when we served stored data because the provider could not be reached. */
  fromStorage: boolean;
}

/** How many bars back we need for a given timeframe to compute SMA200 etc. */
export function defaultLookback(timeframe: Timeframe, bars = 300): { from: Date; to: Date } {
  const to = new Date();
  const perBarMs: Record<Timeframe, number> = {
    '1m': 60_000, '5m': 300_000, '15m': 900_000, '30m': 1_800_000,
    '1h': 3_600_000, '4h': 14_400_000,
    // Calendar span per bar, inflated to cover weekends and holidays.
    '1d': 86_400_000 * 1.45, '1w': 86_400_000 * 7, '1M': 86_400_000 * 31,
  };
  const from = new Date(to.getTime() - perBarMs[timeframe] * bars);
  return { from, to };
}

/**
 * Fetch candles for analysis.
 *
 * Reads storage first (cheap, and historical bars do not change), then tops up
 * from the provider when the stored series is stale or short.
 */
export async function getCandles(
  registry: ProviderRegistry,
  instrument: InstrumentRow,
  timeframe: Timeframe,
  opts: { bars?: number; from?: Date; to?: Date; forceRefresh?: boolean } = {},
): Promise<CandleResult> {
  const bars = opts.bars ?? 300;
  const range = opts.from && opts.to ? { from: opts.from, to: opts.to } : defaultLookback(timeframe, bars);

  const native = NATIVE_TIMEFRAMES.has(timeframe);
  const fetchTimeframe = native ? timeframe : (BASE_FOR_DERIVED[timeframe] ?? '1d');

  // 1. Stored series.
  let stored = opts.forceRefresh
    ? { candles: [] as NormalizedCandle[], source: null as string | null }
    : await loadStoredCandles(instrument.id, timeframe, range.from, range.to);

  const newestStored = stored.candles.at(-1);
  const staleMs = newestStored ? Date.now() - new Date(newestStored.ts).getTime() : Infinity;
  const perBarMs = isIntraday(timeframe) ? 60_000 * 15 : 86_400_000;
  const needsRefresh = stored.candles.length < Math.min(bars, 60) || staleMs > perBarMs;

  if (!needsRefresh && stored.candles.length > 0) {
    return {
      candles: stored.candles,
      source: `${stored.source ?? 'stored'} (stored)`,
      asOf: newestStored?.ts ?? null,
      fromStorage: true,
    };
  }

  // 2. Provider refresh.
  try {
    const capability = isIntraday(fetchTimeframe) ? 'intradayCandles' : 'historicalCandles';
    const { value, provider } = await registry.run(capability, async (p) => {
      if (!p.getCandles) throw new Error('candles not implemented');
      return p.getCandles({
        exchange: instrument.exchange,
        tradingsymbol: instrument.tradingsymbol,
        providerToken: instruments.providerToken(instrument, p.manifest.id),
        timeframe: fetchTimeframe,
        from: range.from,
        to: range.to,
      });
    });

    const finalCandles = native ? value : aggregateCandles(value, timeframe);

    // Persist the base series; derived timeframes are recomputed on read so we
    // never store two representations that could drift apart.
    void persistCandles(instrument.id, fetchTimeframe, value, provider);
    if (!native) void persistCandles(instrument.id, timeframe, finalCandles, `${provider}+agg`);

    return {
      candles: finalCandles,
      source: provider,
      asOf: finalCandles.at(-1)?.ts ?? null,
      fromStorage: false,
    };
  } catch (err) {
    if (stored.candles.length > 0) {
      logger.warn(
        { symbol: instrument.tradingsymbol, timeframe },
        'Provider candle fetch failed; serving stored history',
      );
      await recordDataQualityEvent({
        kind: 'stale_read',
        capability: 'historicalCandles',
        symbol: instrument.tradingsymbol,
        detail: { staleMs, bars: stored.candles.length },
      });
      return {
        candles: stored.candles,
        source: `${stored.source ?? 'stored'} (stored)`,
        asOf: newestStored?.ts ?? null,
        fromStorage: true,
      };
    }
    throw err;
  }
}
