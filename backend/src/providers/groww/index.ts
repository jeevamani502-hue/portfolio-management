/**
 * Groww TradeAPI provider.
 *
 * Docs: https://groww.in/trade-api/docs
 *
 * AUTH — the part that trips everyone up
 * A Groww API key is NOT a bearer token. Presenting it directly returns
 * `403 Access forbidden` on every endpoint. It must first be exchanged:
 *
 *   timestamp = seconds since epoch
 *   checksum  = sha256(apiSecret + timestamp)
 *   POST /v1/token/api/access
 *     Authorization: Bearer <apiKey>
 *     { "key_type": "approval", "checksum": ..., "timestamp": ... }
 *   → { token, expiry, active }
 *
 * Groww issues these to a fixed daily cutoff rather than a rolling window, so
 * this class exchanges on demand and caches until shortly before expiry.
 * Supplying a pre-generated access token instead of the key/secret also works.
 *
 * SCOPES
 * The access token carries the roles the *account's TradeAPI plan* grants —
 * not anything chosen when the key was minted. On the free tier the roles are
 * `order-basic, non_trading-basic, order_read_only-basic`: holdings, positions,
 * margins and orders return 200, while every `/v1/live-data/*` call and
 * `/v1/historical/candle/range` return 403. Regenerating the key changes
 * nothing; only a paid plan adds the live-data role. `healthCheck()` inspects
 * the granted roles and says so, because that failure is otherwise
 * indistinguishable from a bad credential.
 *
 * VERIFICATION STATUS (probed against a live account)
 *   · token exchange   — verified
 *   · getInstruments() — verified against the live 20 MB CSV
 *   · getHoldings()    — verified, returns real positions
 *   · getPositions()   — verified
 *   · quotes / candles — endpoints reachable but 403 without the Live Data
 *     scope, so their response mapping remains unverified.
 */
import { createHash } from 'node:crypto';
import { HttpProvider, num, isoOrNow } from '../base/HttpProvider.js';
import { ProviderError } from '../../utils/errors.js';
import { getJson, setJson } from '../../cache/redis.js';
import type {
  MarketDataProvider,
  ProviderManifest,
  ProviderCredentials,
  QuoteRequest,
  CandleRequest,
  NormalizedQuote,
  NormalizedCandle,
  NormalizedInstrument,
  NormalizedIndex,
  NormalizedHolding,
  NormalizedPosition,
  ProviderId,
  Exchange,
  InstrumentType,
} from '../types.js';
import { symbolKey } from '../types.js';
import { toIst, type Timeframe } from '../../utils/time.js';

const INSTRUMENTS_CSV = 'https://growwapi-assets.groww.in/instruments/instrument.csv';

/** Groww's segment vocabulary, keyed by our exchange. */
const SEGMENT_FOR_EXCHANGE: Record<string, string> = {
  NSE: 'CASH',
  BSE: 'CASH',
  INDICES: 'CASH',
  NFO: 'FNO',
  BFO: 'FNO',
  MCX: 'COMMODITY',
  CDS: 'CURRENCY',
};

/** Candle intervals Groww accepts, in minutes. Daily and above use 1440. */
const INTERVAL_MINUTES: Record<Timeframe, number | null> = {
  '1m': 1,
  '5m': 5,
  '15m': 15,
  '30m': 30,
  '1h': 60,
  '4h': 240,
  '1d': 1440,
  '1w': null, // aggregated locally from daily
  '1M': null,
};

interface GrowwEnvelope<T> {
  status?: string;
  payload?: T;
  error?: { code?: string; message?: string };
}

interface GrowwQuotePayload {
  last_price?: number;
  day_change?: number;
  day_change_perc?: number;
  volume?: number;
  total_buy_quantity?: number;
  total_sell_quantity?: number;
  last_trade_time?: number;
  upper_circuit_limit?: number;
  lower_circuit_limit?: number;
  open_interest?: number;
  ohlc?: { open?: number; high?: number; low?: number; close?: number };
  week_52_high?: number;
  week_52_low?: number;
  depth?: {
    buy?: Array<{ price?: number; quantity?: number }>;
    sell?: Array<{ price?: number; quantity?: number }>;
  };
}

interface GrowwCandlePayload {
  candles?: Array<Array<number>>;
  start_time?: string;
  end_time?: string;
  interval_in_minutes?: number;
}

export class GrowwProvider extends HttpProvider implements MarketDataProvider {
  protected readonly providerId: ProviderId = 'groww';
  protected readonly baseUrl = 'https://api.groww.in';

  private apiKey: string | undefined;
  private apiSecret: string | undefined;
  /** Supplied directly, or minted from apiKey + apiSecret. */
  private accessToken: string | undefined;
  private accessTokenExpiresAt = 0;
  /** Roles carried by the current access token, for scope diagnostics. */
  private grantedRoles: string[] = [];
  private exchangeInFlight: Promise<string> | null = null;

  /** The instrument CSV is ~20 MB; fetch it at most hourly. */
  private scripCache: { at: number; rows: NormalizedInstrument[] } | null = null;

  readonly manifest: ProviderManifest = {
    id: 'groww',
    displayName: 'Groww TradeAPI',
    docsUrl: 'https://groww.in/trade-api/docs',
    authModel: 'static_token',
    capabilities: [
      'quote',
      'quoteBatch',
      'historicalCandles',
      'intradayCandles',
      'instruments',
      'indices',
      'holdings',
      'positions',
    ],
    credentialFields: [
      {
        key: 'apiKey',
        label: 'API Key',
        secret: true,
        required: false,
        help:
          'From groww.in/trade-api/api-keys. Supply this with the API secret and the server mints a daily access token itself. Live quotes and historical candles need a paid TradeAPI plan on the Groww account — on the free tier holdings and positions work but charts and quotes stay refused, and minting a new key will not change that.',
      },
      {
        key: 'apiSecret',
        label: 'API Secret',
        secret: true,
        required: false,
        help:
          'Shown once when the key is created. Used to sign the token exchange; it is hashed, never sent to Groww in plaintext.',
      },
      {
        key: 'accessToken',
        label: 'Access Token (alternative)',
        secret: true,
        required: false,
        help:
          'Use instead of key + secret if you mint tokens yourself. This is NOT the session token from the Groww website or app — that is rejected with 403 everywhere.',
      },
    ],
    throttleMs: {
      // Published limits are roughly 10 requests/second for live data and
      // 300/minute overall; these gaps stay comfortably inside both.
      default: 250,
      live: 120,
      historical: 400,
      instruments: 3600_000,
    },
    notes:
      'Free with a Groww account once Trading APIs are enabled. The instrument master is a public CSV and needs no token; quotes, candles and holdings do.',
  };

  constructor(creds: ProviderCredentials = {}) {
    super();
    this.apiKey = creds.apiKey;
    this.apiSecret = creds.apiSecret;
    if (creds.accessToken) {
      this.accessToken = creds.accessToken;
      this.accessTokenExpiresAt = readJwtExpiry(creds.accessToken) ?? Number.MAX_SAFE_INTEGER;
      this.grantedRoles = readJwtRoles(creds.accessToken);
    }
    this.throttle = { ...this.manifest.throttleMs };
  }

  isConfigured(): boolean {
    return Boolean(this.accessToken || (this.apiKey && this.apiSecret));
  }

  /**
   * Exchange apiKey + apiSecret for an access token.
   *
   * Concurrent callers collapse onto one exchange: Groww supersedes the prior
   * session when a new token is minted, so racing exchanges would leave one
   * caller holding a token that was just invalidated.
   */
  private async exchangeToken(): Promise<string> {
    if (!this.apiKey || !this.apiSecret) {
      throw new ProviderError('groww', 'Groww API key and secret are not configured', {
        retryable: false,
        status: 401,
      });
    }

    const timestamp = String(Math.floor(Date.now() / 1000));
    const checksum = createHash('sha256').update(this.apiSecret + timestamp).digest('hex');

    const res = await this.http<{ token?: string; expiry?: string; active?: boolean }>(
      '/v1/token/api/access',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
          'X-API-VERSION': '1.0',
        },
        body: { key_type: 'approval', checksum, timestamp },
        throttleGroup: 'auth',
        retries: 1,
      },
    );

    if (!res.token) {
      throw new ProviderError('groww', 'Token exchange returned no token', {
        retryable: false,
        status: 401,
      });
    }

    // Clear any previously granted scopes before recording the new ones, so a
    // downgraded key cannot appear to still hold a permission it lost.
    this.grantedRoles = [];

    this.accessToken = res.token;
    this.grantedRoles = readJwtRoles(res.token);
    this.accessTokenExpiresAt =
      readJwtExpiry(res.token) ??
      (res.expiry ? new Date(res.expiry).getTime() : Date.now() + 3600_000);

    this.log.info(
      { roles: this.grantedRoles, expiresAt: new Date(this.accessTokenExpiresAt).toISOString() },
      'Groww access token minted',
    );
    return res.token;
  }

  /**
   * A valid access token, re-minting only when genuinely necessary.
   *
   * Minting is deliberately rare. Groww supersedes the previous session each
   * time a token is issued, so if several API pods (or repeated restarts)
   * each mint their own, they invalidate one another and the exchange itself
   * starts refusing with "Token key not found or inactive". The token is
   * therefore shared through Redis, keyed by a hash of the API key, and only
   * one process mints per expiry window.
   */
  private async token(): Promise<string> {
    // 60s of headroom so a slow request cannot straddle the expiry boundary.
    if (this.accessToken && Date.now() < this.accessTokenExpiresAt - 60_000) {
      return this.accessToken;
    }

    if (!this.apiKey || !this.apiSecret) {
      if (this.accessToken) return this.accessToken; // expired, but it is all we have
      throw new ProviderError('groww', 'Groww credentials are not configured', {
        retryable: false,
        status: 401,
      });
    }

    this.exchangeInFlight ??= this.tokenFromCacheOrExchange().finally(() => {
      this.exchangeInFlight = null;
    });
    return this.exchangeInFlight;
  }

  /** Redis key for the shared token, derived from the API key (never the secret). */
  private cacheKey(): string {
    return `groww:token:${createHash('sha256').update(this.apiKey ?? '').digest('hex').slice(0, 16)}`;
  }

  private async tokenFromCacheOrExchange(): Promise<string> {
    const key = this.cacheKey();

    // Another process may already hold a live token.
    try {
      const cached = await getJson<{ token: string; expiresAt: number }>(key);
      if (cached && Date.now() < cached.expiresAt - 60_000) {
        this.accessToken = cached.token;
        this.accessTokenExpiresAt = cached.expiresAt;
        this.grantedRoles = readJwtRoles(cached.token);
        this.log.debug('Reused the shared Groww access token');
        return cached.token;
      }
    } catch {
      // Cache unavailable — fall through and mint. Correct, just chattier.
    }

    const token = await this.exchangeToken();

    try {
      const ttlSeconds = Math.max(
        60,
        Math.floor((this.accessTokenExpiresAt - Date.now()) / 1000),
      );
      await setJson(key, { token, expiresAt: this.accessTokenExpiresAt }, ttlSeconds);
    } catch {
      // Losing the cache write only costs an extra mint later.
    }

    return token;
  }

  private async headers(): Promise<Record<string, string>> {
    return {
      Authorization: `Bearer ${await this.token()}`,
      Accept: 'application/json',
      'X-API-VERSION': '1.0',
    };
  }

  /** Whether the granted roles include live market data. */
  private hasLiveDataScope(): boolean {
    return this.grantedRoles.some((r) => /live[-_]?data|market[-_]?data/i.test(r));
  }

  /** Groww's `exchange_symbols` form, e.g. `NSE_RELIANCE`. */
  private exchangeSymbol(exchange: Exchange, tradingsymbol: string): string {
    const ex = exchange === 'INDICES' ? 'NSE' : exchange === 'NFO' ? 'NSE' : exchange;
    return `${ex}_${tradingsymbol}`;
  }

  private exchangeFor(exchange: Exchange): string {
    return exchange === 'INDICES' || exchange === 'NFO' ? 'NSE' : exchange === 'BFO' ? 'BSE' : exchange;
  }

  /**
   * Probe in two stages, so a scope problem is never reported as a bad
   * credential.
   *
   * Stage 1 mints a token — that alone proves the key and secret are good.
   * Stage 2 tries a live-data call. If stage 1 passed and stage 2 is refused,
   * the account is fine and the API key simply lacks the Live Data
   * permission, which is a different fix entirely.
   */
  async healthCheck() {
    if (!this.isConfigured()) {
      return {
        ok: false,
        latencyMs: 0,
        detail: 'Supply either an API key + secret, or a pre-generated access token.',
      };
    }

    const started = Date.now();

    try {
      await this.token();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'unknown error';

      /*
       * Groww distinguishes three exchange failures that all look alike from
       * the outside. Naming them saves a long debugging detour, because the
       * remedy is different in each case.
       */
      let detail: string;
      if (/not found or inactive/i.test(message)) {
        detail =
          'Groww reports this API key as not found or inactive. That normally means the key was regenerated, revoked, or expired — creating a new key deactivates the previous one. Generate a fresh key and secret in Groww → Profile → Trading APIs and save both here.';
      } else if (/checksum/i.test(message) || /invalid.*signature/i.test(message)) {
        detail =
          'Groww rejected the request signature. The API secret does not match the key — re-copy the secret shown when the key was created.';
      } else if (/403|forbidden/i.test(message)) {
        detail =
          'Groww refused the token exchange. Confirm Trading APIs are enabled on the account. Note that a Groww website/app session token is not an API key.';
      } else {
        detail = message.slice(0, 300);
      }

      return { ok: false, latencyMs: Date.now() - started, detail };
    }

    try {
      await this.http<GrowwEnvelope<Record<string, number>>>('/v1/live-data/ltp', {
        headers: await this.headers(),
        query: { segment: 'CASH', exchange_symbols: 'NSE_RELIANCE' },
        throttleGroup: 'live',
        retries: 0,
      });
      return { ok: true, latencyMs: Date.now() - started };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'unknown error';

      if (/HTTP 403|Access forbidden/i.test(message) && !this.hasLiveDataScope()) {
        return {
          ok: false,
          latencyMs: Date.now() - started,
          detail:
            `Authentication succeeded, but this account's TradeAPI plan does not include Live Data — ` +
            `granted roles are ${this.grantedRoles.join(', ') || 'none'}. Holdings, positions, orders and ` +
            `margins work. Live quotes AND historical candles are both refused, so charts, indicators, the ` +
            `scanner, backtests and option chains stay unavailable. This is a subscription, not a key ` +
            `setting: generating another API key grants the same roles. Subscribe at groww.in/trade-api, ` +
            `then click Test connection again — the existing key picks up the new roles on its next token ` +
            `exchange.`,
        };
      }

      return { ok: false, latencyMs: Date.now() - started, detail: message.slice(0, 300) };
    }
  }

  // ── holdings & positions ─────────────────────────────────────────────────

  async getHoldings(): Promise<NormalizedHolding[]> {
    const res = await this.http<GrowwEnvelope<{ holdings?: GrowwHolding[] }>>(
      '/v1/holdings/user',
      { headers: await this.headers(), throttleGroup: 'default' },
    );

    const out: NormalizedHolding[] = [];
    for (const h of res.payload?.holdings ?? []) {
      const tradingsymbol = (h.trading_symbol ?? '').trim().toUpperCase();
      const quantity = num(h.quantity);
      if (!tradingsymbol || quantity === null || quantity <= 0) continue;

      const exchanges = h.tradable_exchanges ?? [];
      out.push({
        tradingsymbol,
        isin: (h.isin ?? '').trim() || null,
        // Groww reports which exchanges the holding can trade on rather than
        // where it was bought; prefer NSE when both are allowed.
        exchange: exchanges.includes('NSE') ? 'NSE' : exchanges.includes('BSE') ? 'BSE' : null,
        quantity,
        averagePrice: num(h.average_price) ?? 0,
        t1Quantity: num(h.t1_quantity) ?? 0,
        pledgedQuantity: num(h.pledge_quantity) ?? 0,
        tradableExchanges: exchanges,
      });
    }
    return out;
  }

  async getPositions(): Promise<NormalizedPosition[]> {
    const res = await this.http<GrowwEnvelope<{ positions?: GrowwPosition[] }>>(
      '/v1/positions/user',
      { headers: await this.headers(), throttleGroup: 'default' },
    );

    const out: NormalizedPosition[] = [];
    for (const p of res.payload?.positions ?? []) {
      const tradingsymbol = (p.trading_symbol ?? '').trim().toUpperCase();
      if (!tradingsymbol) continue;
      const net = (num(p.quantity) ?? 0) || (num(p.net_carry_forward_quantity) ?? 0);
      out.push({
        tradingsymbol,
        exchange: p.exchange === 'BSE' ? 'BSE' : p.exchange === 'NSE' ? 'NSE' : null,
        segment: p.segment ?? null,
        quantity: net,
        averagePrice: num(p.net_price) ?? num(p.average_price) ?? 0,
        product: p.product ?? null,
      });
    }
    return out;
  }

  // ── quotes ────────────────────────────────────────────────────────────────

  async getQuote(req: QuoteRequest): Promise<NormalizedQuote> {
    const res = await this.http<GrowwEnvelope<GrowwQuotePayload>>('/v1/live-data/quote', {
      headers: await this.headers(),
      query: {
        exchange: this.exchangeFor(req.exchange),
        segment: SEGMENT_FOR_EXCHANGE[req.exchange] ?? 'CASH',
        trading_symbol: req.tradingsymbol,
      },
      throttleGroup: 'live',
    });

    const p = res.payload;
    const ltp = num(p?.last_price);
    if (!p || ltp === null) {
      throw new ProviderError('groww', `No quote returned for ${req.tradingsymbol}`, {
        retryable: true,
      });
    }

    const ohlc = p.ohlc ?? {};
    const bid = p.depth?.buy?.[0];
    const ask = p.depth?.sell?.[0];

    return {
      symbol: symbolKey(req.exchange, req.tradingsymbol),
      exchange: req.exchange,
      tradingsymbol: req.tradingsymbol,
      ltp,
      prevClose: num(ohlc.close),
      open: num(ohlc.open),
      high: num(ohlc.high),
      low: num(ohlc.low),
      close: num(ohlc.close),
      volume: num(p.volume),
      // Groww's quote payload carries no exchange average price; VWAP is
      // computed from intraday candles instead of being invented here.
      avgPrice: null,
      oi: num(p.open_interest),
      oiChange: null,
      bid: num(bid?.price),
      ask: num(ask?.price),
      bidQty: num(bid?.quantity),
      askQty: num(ask?.quantity),
      upperCircuit: num(p.upper_circuit_limit),
      lowerCircuit: num(p.lower_circuit_limit),
      week52High: num(p.week_52_high),
      week52Low: num(p.week_52_low),
      timestamp: isoOrNow(p.last_trade_time),
      ...(req.providerToken !== undefined ? { providerToken: req.providerToken } : {}),
    };
  }

  /**
   * Batch quotes via the OHLC endpoint, which accepts up to 50 symbols and is
   * the cheapest call that still returns open/high/low/close — enough for the
   * watchlist and breadth calculations. A single-symbol request falls through
   * to the richer `quote` endpoint.
   */
  async getQuotes(reqs: QuoteRequest[]): Promise<NormalizedQuote[]> {
    if (reqs.length === 0) return [];
    if (reqs.length === 1) return [await this.getQuote(reqs[0]!)];

    const out: NormalizedQuote[] = [];

    // Group by Groww segment; the endpoint takes one segment per call.
    const bySegment = new Map<string, QuoteRequest[]>();
    for (const r of reqs) {
      const seg = SEGMENT_FOR_EXCHANGE[r.exchange] ?? 'CASH';
      (bySegment.get(seg) ?? bySegment.set(seg, []).get(seg)!).push(r);
    }

    for (const [segment, group] of bySegment) {
      for (let i = 0; i < group.length; i += 50) {
        const chunk = group.slice(i, i + 50);
        const lookup = new Map(
          chunk.map((r) => [this.exchangeSymbol(r.exchange, r.tradingsymbol), r]),
        );

        const res = await this.http<
          GrowwEnvelope<Record<string, { open?: number; high?: number; low?: number; close?: number; last_price?: number }>>
        >('/v1/live-data/ohlc', {
          headers: await this.headers(),
          query: { segment, exchange_symbols: [...lookup.keys()].join(',') },
          throttleGroup: 'live',
        });

        for (const [key, value] of Object.entries(res.payload ?? {})) {
          const req = lookup.get(key);
          if (!req || !value) continue;

          // Groww's OHLC payload may omit last_price; the close is the best
          // available mark in that case, and it is a real traded price.
          const ltp = num(value.last_price) ?? num(value.close);
          if (ltp === null) continue;

          out.push({
            symbol: symbolKey(req.exchange, req.tradingsymbol),
            exchange: req.exchange,
            tradingsymbol: req.tradingsymbol,
            ltp,
            prevClose: num(value.close),
            open: num(value.open),
            high: num(value.high),
            low: num(value.low),
            close: num(value.close),
            volume: null,
            avgPrice: null,
            oi: null,
            oiChange: null,
            bid: null,
            ask: null,
            bidQty: null,
            askQty: null,
            upperCircuit: null,
            lowerCircuit: null,
            week52High: null,
            week52Low: null,
            timestamp: new Date().toISOString(),
          });
        }
      }
    }

    return out;
  }

  // ── candles ───────────────────────────────────────────────────────────────

  async getCandles(req: CandleRequest): Promise<NormalizedCandle[]> {
    const interval = INTERVAL_MINUTES[req.timeframe];
    if (interval === null) {
      throw new ProviderError(
        'groww',
        `Timeframe ${req.timeframe} is aggregated locally, not requested upstream`,
        { retryable: false },
      );
    }

    // Groww expects IST wall-clock strings: "YYYY-MM-DD HH:mm:ss".
    const fmt = (d: Date): string => {
      const p = toIst(d);
      const pad = (n: number) => String(n).padStart(2, '0');
      return `${p.dateKey} ${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}`;
    };

    const res = await this.http<GrowwEnvelope<GrowwCandlePayload>>('/v1/historical/candle/range', {
      headers: await this.headers(),
      query: {
        exchange: this.exchangeFor(req.exchange),
        segment: SEGMENT_FOR_EXCHANGE[req.exchange] ?? 'CASH',
        trading_symbol: req.tradingsymbol,
        start_time: fmt(req.from),
        end_time: fmt(req.to),
        interval_in_minutes: interval,
      },
      throttleGroup: 'historical',
      timeoutMs: 30_000,
    });

    const rows = res.payload?.candles ?? [];
    const out: NormalizedCandle[] = [];

    // Row shape: [epochSeconds, open, high, low, close, volume]
    for (const row of rows) {
      const open = num(row[1]);
      const high = num(row[2]);
      const low = num(row[3]);
      const close = num(row[4]);
      const ts = row[0];
      if (open === null || high === null || low === null || close === null || ts === undefined) {
        continue; // a partial candle is dropped, never patched
      }
      out.push({
        ts: isoOrNow(ts),
        open,
        high,
        low,
        close,
        volume: num(row[5]) ?? 0,
        oi: null,
      });
    }

    return out;
  }

  // ── indices ───────────────────────────────────────────────────────────────

  async getIndices(symbols: string[] = ['NIFTY', 'BANKNIFTY']): Promise<NormalizedIndex[]> {
    const res = await this.http<GrowwEnvelope<Record<string, number>>>('/v1/live-data/ltp', {
      headers: await this.headers(),
      query: {
        segment: 'CASH',
        exchange_symbols: symbols.map((s) => `NSE_${s}`).join(','),
      },
      throttleGroup: 'live',
    });

    const out: NormalizedIndex[] = [];
    for (const [key, value] of Object.entries(res.payload ?? {})) {
      const ltp = num(value);
      if (ltp === null) continue;
      out.push({
        symbol: key.replace(/^NSE_/, ''),
        ltp,
        // The LTP endpoint returns only a price. Reporting nulls here is
        // correct: the change fields are genuinely unknown from this call.
        prevClose: null,
        open: null,
        high: null,
        low: null,
        change: null,
        changePct: null,
        timestamp: new Date().toISOString(),
      });
    }
    return out;
  }

  // ── instruments (public CSV — no token required) ──────────────────────────

  async getInstruments(): Promise<NormalizedInstrument[]> {
    if (this.scripCache && Date.now() - this.scripCache.at < 3600_000) {
      return this.scripCache.rows;
    }
    const csv = await this.http<string>(INSTRUMENTS_CSV, {
      raw: true,
      throttleGroup: 'instruments',
      timeoutMs: 180_000,
    });
    const rows = parseGrowwInstruments(csv);
    this.scripCache = { at: Date.now(), rows };
    return rows;
  }
}

// ── pure mapper, exported for tests ────────────────────────────────────────

/**
 * Parse Groww's instrument CSV.
 *
 * Column order is read from the header row rather than assumed, so a schema
 * change surfaces as missing fields instead of silently shifted values.
 *
 * Real header (verified against the live file):
 *   exchange, exchange_token, trading_symbol, groww_symbol, name,
 *   instrument_type, segment, series, isin, underlying_symbol,
 *   underlying_exchange_token, expiry_date, strike_price, lot_size,
 *   tick_size, freeze_quantity, is_reserved, buy_allowed, sell_allowed,
 *   internal_trading_symbol, is_intraday
 */
export function parseGrowwInstruments(csv: string): NormalizedInstrument[] {
  const lines = csv.split(/\r?\n/);
  const headerLine = lines[0];
  if (!headerLine) return [];

  const header = headerLine.split(',').map((h) => h.trim().toLowerCase());
  const col = (name: string): number => header.indexOf(name);

  const iExchange = col('exchange');
  const iToken = col('exchange_token');
  const iSymbol = col('trading_symbol');
  const iName = col('name');
  const iType = col('instrument_type');
  const iSegment = col('segment');
  const iIsin = col('isin');
  const iUnderlying = col('underlying_symbol');
  const iExpiry = col('expiry_date');
  const iStrike = col('strike_price');
  const iLot = col('lot_size');
  const iTick = col('tick_size');

  if (iExchange < 0 || iSymbol < 0 || iType < 0 || iSegment < 0) {
    throw new ProviderError('groww', 'Instrument CSV header did not match the expected columns', {
      retryable: false,
    });
  }

  const out: NormalizedInstrument[] = [];

  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line) continue;
    const f = line.split(',');

    const rawExchange = (f[iExchange] ?? '').trim().toUpperCase();
    const tradingsymbol = (f[iSymbol] ?? '').trim().toUpperCase();
    const rawType = (f[iType] ?? '').trim().toUpperCase();
    const rawSegment = (f[iSegment] ?? '').trim().toUpperCase();
    if (!rawExchange || !tradingsymbol || !rawType) continue;

    // Map Groww's (segment, instrument_type) pair onto our model. Indices live
    // in the CASH segment with type IDX, but belong on our INDICES exchange.
    let exchange: Exchange;
    let instrumentType: InstrumentType;

    if (rawType === 'IDX') {
      exchange = 'INDICES';
      instrumentType = 'INDEX';
    } else if (rawSegment === 'CASH') {
      exchange = rawExchange === 'BSE' ? 'BSE' : 'NSE';
      instrumentType = 'EQ';
    } else if (rawSegment === 'FNO') {
      exchange = rawExchange === 'BSE' ? 'BFO' : 'NFO';
      instrumentType = rawType === 'FUT' ? 'FUT' : rawType === 'CE' ? 'CE' : rawType === 'PE' ? 'PE' : 'FUT';
    } else if (rawSegment === 'COMMODITY') {
      exchange = 'MCX';
      instrumentType = rawType === 'FUT' ? 'FUT' : rawType === 'CE' ? 'CE' : 'PE';
    } else if (rawSegment === 'CURRENCY') {
      exchange = 'CDS';
      instrumentType = rawType === 'FUT' ? 'FUT' : rawType === 'CE' ? 'CE' : 'PE';
    } else {
      continue;
    }

    const expiryRaw = iExpiry >= 0 ? (f[iExpiry] ?? '').trim() : '';
    const underlying = iUnderlying >= 0 ? (f[iUnderlying] ?? '').trim().toUpperCase() : '';

    // Groww reuses the `isin` column for index rows, putting the index name
    // there (e.g. "NIFTYPVTBANK"). A real ISIN is 12 characters: two-letter
    // country code, nine alphanumerics, one check digit. Validate rather than
    // storing a name in a field other code will treat as an identifier.
    const isinRaw = iIsin >= 0 ? (f[iIsin] ?? '').trim().toUpperCase() : '';
    const isin = /^[A-Z]{2}[A-Z0-9]{9}\d$/.test(isinRaw) ? isinRaw : null;

    out.push({
      exchange,
      tradingsymbol,
      name: (iName >= 0 ? (f[iName] ?? '').trim() : '') || null,
      isin,
      segment: rawSegment || null,
      instrumentType,
      underlying: underlying || null,
      // Already ISO (YYYY-MM-DD) in the source file.
      expiry: /^\d{4}-\d{2}-\d{2}$/.test(expiryRaw) ? expiryRaw : null,
      strike: iStrike >= 0 ? num(f[iStrike]) : null,
      optionType: instrumentType === 'CE' || instrumentType === 'PE' ? instrumentType : null,
      lotSize: (iLot >= 0 ? num(f[iLot]) : null) ?? 1,
      tickSize: (iTick >= 0 ? num(f[iTick]) : null) ?? 0.05,
      providerToken: (iToken >= 0 ? (f[iToken] ?? '').trim() : '') || tradingsymbol,
    });
  }

  return out;
}

// ── Groww response shapes for account endpoints ────────────────────────────

interface GrowwHolding {
  isin?: string;
  trading_symbol?: string;
  quantity?: number;
  average_price?: number;
  pledge_quantity?: number;
  t1_quantity?: number;
  demat_free_quantity?: number;
  tradable_exchanges?: string[];
}

interface GrowwPosition {
  trading_symbol?: string;
  exchange?: string;
  segment?: string;
  quantity?: number;
  net_carry_forward_quantity?: number;
  net_price?: number;
  average_price?: number;
  product?: string;
}

/** Epoch ms of a JWT's `exp`, or null when it cannot be read. */
export function readJwtExpiry(token: string): number | null {
  try {
    const part = token.split('.')[1];
    if (!part) return null;
    const payload = JSON.parse(Buffer.from(part, 'base64url').toString()) as { exp?: number };
    return typeof payload.exp === 'number' ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
}

/**
 * Roles a Groww token grants.
 *
 * They live inside `sub`, which is itself a JSON *string* rather than an
 * object — hence the second parse.
 */
export function readJwtRoles(token: string): string[] {
  try {
    const part = token.split('.')[1];
    if (!part) return [];
    const payload = JSON.parse(Buffer.from(part, 'base64url').toString()) as { sub?: string };
    if (!payload.sub) return [];
    const sub = JSON.parse(payload.sub) as { role?: string };
    return (sub.role ?? '').split(',').map((r) => r.trim()).filter(Boolean);
  } catch {
    return [];
  }
}
