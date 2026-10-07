/**
 * Angel One SmartAPI provider.
 *
 * Docs: https://smartapi.angelbroking.com/docs
 *
 * Auth is TOTP-based, which is the reason this provider is a good failover
 * partner for Dhan: given the TOTP *secret*, the server can mint a fresh
 * session unattended, with no daily human login step. The secret is stored
 * AES-256-GCM encrypted like every other credential.
 */
import { authenticator } from 'otplib';
import { HttpProvider, num, isoOrNow } from '../base/HttpProvider.js';
import { ProviderError } from '../../utils/errors.js';
import type {
  MarketDataProvider,
  ProviderManifest,
  ProviderCredentials,
  QuoteRequest,
  CandleRequest,
  NormalizedQuote,
  NormalizedCandle,
  NormalizedInstrument,
  NormalizedHolding,
  NormalizedPosition,
  NormalizedOrder,
  OrderRequest,
  OrderStatus,
  TickStream,
  TickSubscription,
  ProviderId,
  Exchange,
  InstrumentType,
} from '../types.js';
import { symbolKey } from '../types.js';
import { toIst, type Timeframe } from '../../utils/time.js';
import { AngelOneTickStream } from './tickStream.js';

/**
 * SmartAPI's quote endpoint rejects more than 50 tokens per call with
 * "Tokens max limit exceeded". Verified against the live API: 50 passes, 51
 * does not. An option chain is several hundred contracts, so it must chunk.
 */
const MAX_QUOTE_TOKENS = 50;

/** Segments this platform models; Angel One's master covers more. */
const SUPPORTED_EXCHANGES = new Set<Exchange>(['NSE', 'BSE', 'NFO', 'BFO', 'MCX', 'CDS', 'INDICES']);

const SCRIP_MASTER_URL =
  'https://margincalculator.angelbroking.com/OpenAPI_File/files/OpenAPIScripMaster.json';

const ANGEL_INTERVAL: Record<Timeframe, string | null> = {
  '1m': 'ONE_MINUTE',
  '5m': 'FIVE_MINUTE',
  '15m': 'FIFTEEN_MINUTE',
  '30m': 'THIRTY_MINUTE',
  '1h': 'ONE_HOUR',
  '4h': null,
  '1d': 'ONE_DAY',
  '1w': null,
  '1M': null,
};

const EXCHANGE_MAP: Record<string, string> = {
  NSE: 'NSE',
  BSE: 'BSE',
  NFO: 'NFO',
  BFO: 'BFO',
  MCX: 'MCX',
  CDS: 'CDS',
  INDICES: 'NSE',
};

interface AngelEnvelope<T> {
  status?: boolean;
  message?: string;
  errorcode?: string;
  data?: T;
}

interface AngelQuoteLeg {
  exchange?: string;
  tradingSymbol?: string;
  symbolToken?: string;
  ltp?: number;
  open?: number;
  high?: number;
  low?: number;
  close?: number;
  lastTradeQty?: number;
  exchFeedTime?: string;
  netChange?: number;
  percentChange?: number;
  avgPrice?: number;
  tradeVolume?: number;
  opnInterest?: number;
  lowerCircuit?: number;
  upperCircuit?: number;
  totBuyQuan?: number;
  totSellQuan?: number;
  ['52WeekLow']?: number;
  ['52WeekHigh']?: number;
  depth?: {
    buy?: Array<{ price?: number; quantity?: number }>;
    sell?: Array<{ price?: number; quantity?: number }>;
  };
}

/**
 * Sessions shared across provider instances in this process, keyed by client
 * code.
 *
 * A registry is rebuilt every minute per user, and separately for the worker,
 * and each new AngelOneProvider used to log in afresh: one loginByPassword
 * per instance, several a minute across two processes. That is precisely
 * what Angel One's "exceeding access rate" throttle punishes, and when the
 * throttled call was the one starting the tick feed, the browser showed "No
 * live feed" until someone restarted the API. A session is good for hours;
 * instances now share it, and concurrent first-callers share one login.
 */
interface SharedSession {
  jwt: string;
  feedToken: string | null;
  issuedAt: number;
}
const sharedSessions = new Map<string, SharedSession>();
const sharedLogins = new Map<string, Promise<SharedSession>>();
/** Sessions last several hours; re-login proactively after 6. */
const SESSION_TTL_MS = 6 * 3600_000;

export class AngelOneProvider extends HttpProvider implements MarketDataProvider {
  protected readonly providerId: ProviderId = 'angelone';
  protected readonly baseUrl = 'https://apiconnect.angelone.in';

  private apiKey: string | undefined;
  private clientCode: string | undefined;
  private mpin: string | undefined;
  private totpSecret: string | undefined;

  private jwt: string | null = null;
  private feedToken: string | null = null;
  private jwtIssuedAt = 0;

  private scripCache: { at: number; rows: NormalizedInstrument[] } | null = null;

  readonly manifest: ProviderManifest = {
    id: 'angelone',
    displayName: 'Angel One SmartAPI',
    docsUrl: 'https://smartapi.angelbroking.com/docs',
    authModel: 'totp_session',
    capabilities: [
      'quote',
      'quoteBatch',
      'depth',
      'historicalCandles',
      'intradayCandles',
      'instruments',
      'holdings',
      'positions',
      'streamTicks',
      'orders',
    ],
    credentialFields: [
      { key: 'apiKey', label: 'API Key', secret: false, required: true },
      { key: 'clientCode', label: 'Client Code', secret: false, required: true },
      { key: 'mpin', label: 'MPIN', secret: true, required: true },
      {
        key: 'totpSecret',
        label: 'TOTP Secret',
        secret: true,
        required: true,
        help: 'The base32 secret shown when you enable TOTP. Lets the server refresh the session without a manual login.',
      },
    ],
    throttleMs: { default: 350, quote: 400, historical: 400, login: 2_000, instruments: 3600_000 },
    notes:
      'Free to use with an Angel One account, live data and historical candles included. ' +
      'Sessions are refreshed automatically via TOTP, so there is no daily login step. ' +
      'When creating the app, SmartAPI demands an HTTPS Redirect URL and rejects localhost, ' +
      'http:// and bare IPs — but it is never used here: this provider authenticates through ' +
      'loginByPassword (client code + MPIN + TOTP), not a browser redirect. Any HTTPS URL you ' +
      'control will do. There is no native option-chain endpoint, but chains assemble from the ' +
      'contract master plus batched quotes, so F&O works without a second provider.',
  };

  constructor(creds: ProviderCredentials = {}) {
    super();
    this.apiKey = creds.apiKey;
    this.clientCode = creds.clientCode;
    this.mpin = creds.mpin;
    this.totpSecret = creds.totpSecret;
    this.throttle = { ...this.manifest.throttleMs };
  }

  isConfigured(): boolean {
    return Boolean(this.apiKey && this.clientCode && this.mpin && this.totpSecret);
  }

  /** SmartAPI requires these client headers on every call. */
  private baseHeaders(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'X-UserType': 'USER',
      'X-SourceID': 'WEB',
      'X-ClientLocalIP': '127.0.0.1',
      'X-ClientPublicIP': '127.0.0.1',
      'X-MACAddress': '00:00:00:00:00:00',
      'X-PrivateKey': this.apiKey ?? '',
    };
  }

  private sessionExpired(): boolean {
    return !this.jwt || Date.now() - this.jwtIssuedAt > SESSION_TTL_MS;
  }

  private adopt(session: SharedSession): void {
    this.jwt = session.jwt;
    this.feedToken = session.feedToken;
    this.jwtIssuedAt = session.issuedAt;
  }

  private async ensureSession(): Promise<void> {
    if (!this.sessionExpired()) return;

    const key = this.clientCode ?? '';
    const shared = sharedSessions.get(key);
    if (shared && Date.now() - shared.issuedAt <= SESSION_TTL_MS) {
      this.adopt(shared);
      return;
    }

    // Collapse concurrent callers — across instances, not just within one —
    // onto a single login.
    let inFlight = sharedLogins.get(key);
    if (!inFlight) {
      inFlight = this.login().finally(() => {
        sharedLogins.delete(key);
      });
      sharedLogins.set(key, inFlight);
    }
    this.adopt(await inFlight);
  }

  private async login(): Promise<SharedSession> {
    if (!this.isConfigured()) {
      throw new ProviderError('angelone', 'Angel One credentials are not configured', {
        retryable: false,
        status: 401,
      });
    }
    let totp: string;
    try {
      totp = authenticator.generate(this.totpSecret!);
    } catch {
      throw new ProviderError('angelone', 'TOTP secret is not valid base32', { retryable: false });
    }

    const res = await this.http<
      AngelEnvelope<{ jwtToken?: string; refreshToken?: string; feedToken?: string }>
    >(
      '/rest/auth/angelbroking/user/v1/loginByPassword',
      {
        method: 'POST',
        headers: this.baseHeaders(),
        body: { clientcode: this.clientCode, password: this.mpin, totp },
        throttleGroup: 'login',
        retries: 1,
      },
    );

    const token = res.data?.jwtToken;
    if (!res.status || !token) {
      throw new ProviderError(
        'angelone',
        `Login failed: ${res.message ?? res.errorcode ?? 'unknown'}`,
        { retryable: false, status: 401 },
      );
    }
    const session: SharedSession = {
      jwt: token.startsWith('Bearer ') ? token.slice(7) : token,
      // Issued only at login, and required by the websocket handshake — the
      // REST JWT alone is rejected there.
      feedToken: res.data?.feedToken ?? null,
      issuedAt: Date.now(),
    };
    sharedSessions.set(this.clientCode ?? '', session);
    this.log.info('Angel One session established via TOTP');
    return session;
  }

  private async authHeaders(): Promise<Record<string, string>> {
    await this.ensureSession();
    return { ...this.baseHeaders(), Authorization: `Bearer ${this.jwt}` };
  }

  async healthCheck() {
    if (!this.isConfigured()) {
      return { ok: false, latencyMs: 0, detail: 'Credentials not configured' };
    }
    return this.probe(async () => {
      const headers = await this.authHeaders();
      const res = await this.http<AngelEnvelope<unknown>>(
        '/rest/secure/angelbroking/user/v1/getProfile',
        { headers, retries: 0 },
      );
      if (!res.status) throw new Error(res.message ?? 'profile call failed');
    });
  }

  // ── quotes ────────────────────────────────────────────────────────────────

  async getQuote(req: QuoteRequest): Promise<NormalizedQuote> {
    const [q] = await this.getQuotes([req]);
    if (!q) {
      throw new ProviderError('angelone', `No quote for ${req.tradingsymbol}`, { retryable: false });
    }
    return q;
  }

  async getQuotes(reqs: QuoteRequest[]): Promise<NormalizedQuote[]> {
    if (reqs.length === 0) return [];
    const headers = await this.authHeaders();

    // A request without a token cannot be addressed. Throwing on the first one
    // used to abort the whole batch — which is how a 664-contract option chain
    // died on a handful of rows carried by a different provider. Skip them and
    // price what we can; the caller renders missing legs as blank rather than
    // losing the chain. Only a batch with nothing addressable is an error.
    const addressable = reqs.filter((r) => r.providerToken);
    if (addressable.length === 0) {
      throw new ProviderError(
        'angelone',
        `None of the ${reqs.length} requested instruments carry an Angel One symbol token. Run the instruments sync.`,
        { retryable: false },
      );
    }

    const byToken = new Map(addressable.map((r) => [r.providerToken!, r]));
    const out: NormalizedQuote[] = [];

    // SmartAPI rejects more than 50 tokens per call with "Tokens max limit
    // exceeded" — verified empirically: 50 succeeds, 51 does not. The throttle
    // group paces the chunks so a full chain does not trip the rate limit.
    for (let i = 0; i < addressable.length; i += MAX_QUOTE_TOKENS) {
      const slice = addressable.slice(i, i + MAX_QUOTE_TOKENS);
      const tokensByExchange: Record<string, string[]> = {};
      for (const r of slice) {
        const ex = EXCHANGE_MAP[r.exchange] ?? 'NSE';
        (tokensByExchange[ex] ??= []).push(r.providerToken!);
      }

      const res = await this.http<
        AngelEnvelope<{ fetched?: AngelQuoteLeg[]; unfetched?: unknown[] }>
      >('/rest/secure/angelbroking/market/v1/quote/', {
        method: 'POST',
        headers,
        body: { mode: 'FULL', exchangeTokens: tokensByExchange },
        throttleGroup: 'quote',
      });

      if (!res.status) {
        throw new ProviderError('angelone', res.message ?? 'Quote call failed', {
          retryable: true,
        });
      }
      out.push(...this.mapQuoteLegs(res.data?.fetched ?? [], byToken));
    }

    return out;
  }

  /** Turn SmartAPI quote legs into normalized quotes. */
  private mapQuoteLegs(
    legs: AngelQuoteLeg[],
    byToken: Map<string, QuoteRequest>,
  ): NormalizedQuote[] {
    const out: NormalizedQuote[] = [];
    for (const leg of legs) {
      const ltp = num(leg.ltp);
      if (ltp === null) continue;
      const req = leg.symbolToken ? byToken.get(leg.symbolToken) : undefined;
      const exchange = (req?.exchange ?? leg.exchange ?? 'NSE') as Exchange;
      const tradingsymbol = req?.tradingsymbol ?? leg.tradingSymbol ?? '';
      const bid = leg.depth?.buy?.[0];
      const ask = leg.depth?.sell?.[0];

      out.push({
        symbol: symbolKey(exchange, tradingsymbol),
        exchange,
        tradingsymbol,
        ltp,
        prevClose: num(leg.close),
        open: num(leg.open),
        high: num(leg.high),
        low: num(leg.low),
        close: num(leg.close),
        volume: num(leg.tradeVolume),
        avgPrice: num(leg.avgPrice),
        oi: num(leg.opnInterest),
        oiChange: null,
        bid: num(bid?.price),
        ask: num(ask?.price),
        bidQty: num(bid?.quantity),
        askQty: num(ask?.quantity),
        upperCircuit: num(leg.upperCircuit),
        lowerCircuit: num(leg.lowerCircuit),
        week52High: num(leg['52WeekHigh']),
        week52Low: num(leg['52WeekLow']),
        timestamp: isoOrNow(leg.exchFeedTime),
        providerToken: leg.symbolToken,
      });
    }
    return out;
  }

  // ── candles ───────────────────────────────────────────────────────────────

  async getCandles(req: CandleRequest): Promise<NormalizedCandle[]> {
    if (!req.providerToken) {
      throw new ProviderError('angelone', `Missing symbol token for ${req.tradingsymbol}`, {
        retryable: false,
      });
    }
    const interval = ANGEL_INTERVAL[req.timeframe];
    if (!interval) {
      throw new ProviderError(
        'angelone',
        `Timeframe ${req.timeframe} is aggregated locally, not requested upstream`,
        { retryable: false },
      );
    }

    // SmartAPI expects IST wall-clock strings: "YYYY-MM-DD HH:mm".
    const fmt = (d: Date) => {
      const p = toIst(d);
      const pad = (n: number) => String(n).padStart(2, '0');
      return `${p.dateKey} ${pad(p.hour)}:${pad(p.minute)}`;
    };

    const headers = await this.authHeaders();
    const res = await this.http<AngelEnvelope<unknown[][]>>(
      '/rest/secure/angelbroking/historical/v1/getCandleData',
      {
        method: 'POST',
        headers,
        body: {
          exchange: EXCHANGE_MAP[req.exchange] ?? 'NSE',
          symboltoken: req.providerToken,
          interval,
          fromdate: fmt(req.from),
          todate: fmt(req.to),
        },
        throttleGroup: 'historical',
      },
    );

    if (!res.status) {
      throw new ProviderError('angelone', res.message ?? 'Candle call failed', { retryable: true });
    }

    // Row shape: [timestamp, open, high, low, close, volume]
    const out: NormalizedCandle[] = [];
    for (const row of res.data ?? []) {
      const open = num(row[1]);
      const high = num(row[2]);
      const low = num(row[3]);
      const close = num(row[4]);
      if (open === null || high === null || low === null || close === null) continue;
      out.push({
        ts: isoOrNow(row[0] as string),
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

  // ── instruments ───────────────────────────────────────────────────────────

  // ── realtime ──────────────────────────────────────────────────────────────

  /**
   * Open the live tick feed.
   *
   * Logging in first is deliberate: the handshake needs both the session JWT
   * and the feed token, and the feed token is only issued by login.
   */
  async openTickStream(sub: TickSubscription): Promise<TickStream> {
    await this.ensureSession();
    if (!this.jwt || !this.feedToken) {
      throw new ProviderError(
        'angelone',
        'No feed token from the Angel One session, so the tick stream cannot authenticate.',
        { retryable: false, status: 401 },
      );
    }

    // Resolving a token back to its exchange needs the contract master,
    // which is cached after the first sync.
    const rows = this.scripCache?.rows ?? (await this.getInstruments());
    const exchangeByToken = new Map<string, Exchange>();
    for (const r of rows) {
      if (r.providerToken) exchangeByToken.set(r.providerToken, r.exchange);
    }

    const stream = new AngelOneTickStream(
      {
        jwtToken: this.jwt,
        feedToken: this.feedToken,
        apiKey: this.apiKey!,
        clientCode: this.clientCode!,
      },
      sub,
      (token) => exchangeByToken.get(token),
    );
    await stream.open();
    if (sub.tokens.length > 0) await stream.subscribe(sub.tokens);
    return stream;
  }

  // ── portfolio ─────────────────────────────────────────────────────────────

  /**
   * Demat holdings.
   *
   * Field names follow SmartAPI's documented getAllHolding shape. Parsing is
   * defensive because this could only be verified against an account with no
   * holdings in it: every field is read through `num`, and a row missing its
   * trading symbol is skipped rather than stored as an empty position.
   */
  async getHoldings(): Promise<NormalizedHolding[]> {
    const headers = await this.authHeaders();
    const res = await this.http<
      AngelEnvelope<{
        holdings?: Array<{
          tradingsymbol?: string;
          exchange?: string;
          isin?: string;
          quantity?: number | string;
          t1quantity?: number | string;
          realisedquantity?: number | string;
          averageprice?: number | string;
          collateralquantity?: number | string;
          product?: string;
        }>;
      }>
    >('/rest/secure/angelbroking/portfolio/v1/getAllHolding', { headers, throttleGroup: 'default' });

    if (!res.status) {
      throw new ProviderError('angelone', res.message ?? 'Holdings call failed', {
        retryable: true,
      });
    }

    const out: NormalizedHolding[] = [];
    for (const h of res.data?.holdings ?? []) {
      const tradingsymbol = h.tradingsymbol?.trim().toUpperCase();
      if (!tradingsymbol) continue;

      const rawExchange = h.exchange?.trim().toUpperCase();
      const exchange =
        rawExchange && SUPPORTED_EXCHANGES.has(rawExchange as Exchange)
          ? (rawExchange as Exchange)
          : null;

      out.push({
        // Angel One returns the series-suffixed symbol here too, and the rest
        // of the platform matches on the bare one.
        tradingsymbol:
          exchange === 'NSE' ? tradingsymbol.replace(/-[A-Z0-9]{1,3}$/, '') || tradingsymbol : tradingsymbol,
        isin: h.isin?.trim() || null,
        exchange,
        quantity: num(h.quantity) ?? 0,
        averagePrice: num(h.averageprice) ?? 0,
        t1Quantity: num(h.t1quantity) ?? 0,
        // Angel One reports pledged stock as collateral quantity.
        pledgedQuantity: num(h.collateralquantity) ?? 0,
        tradableExchanges: exchange ? [exchange] : [],
      });
    }
    return out;
  }

  /** Open F&O and intraday positions. */
  async getPositions(): Promise<NormalizedPosition[]> {
    const headers = await this.authHeaders();
    const res = await this.http<
      AngelEnvelope<
        Array<{
          tradingsymbol?: string;
          exchange?: string;
          producttype?: string;
          symbolgroup?: string;
          netqty?: number | string;
          totalbuyavgprice?: number | string;
          buyavgprice?: number | string;
          avgnetprice?: number | string;
        }> | null
      >
    >('/rest/secure/angelbroking/order/v1/getPosition', { headers, throttleGroup: 'default' });

    if (!res.status) {
      throw new ProviderError('angelone', res.message ?? 'Positions call failed', {
        retryable: true,
      });
    }

    // An account with nothing open returns data: null, not an empty array.
    const rows = Array.isArray(res.data) ? res.data : [];
    const out: NormalizedPosition[] = [];

    for (const p of rows) {
      const tradingsymbol = p.tradingsymbol?.trim().toUpperCase();
      if (!tradingsymbol) continue;

      const netQty = num(p.netqty) ?? 0;
      // A closed position still appears with a zero net quantity; it is not
      // a position any more and should not be reported as one.
      if (netQty === 0) continue;

      const rawExchange = p.exchange?.trim().toUpperCase();
      const exchange =
        rawExchange && SUPPORTED_EXCHANGES.has(rawExchange as Exchange)
          ? (rawExchange as Exchange)
          : null;

      out.push({
        tradingsymbol,
        exchange,
        segment: p.symbolgroup?.trim() ?? null,
        quantity: netQty,
        averagePrice:
          num(p.totalbuyavgprice) ?? num(p.buyavgprice) ?? num(p.avgnetprice) ?? 0,
        product: p.producttype?.trim() ?? null,
      });
    }
    return out;
  }

  // ── orders ────────────────────────────────────────────────────────────────
  // SmartAPI order endpoints. Every call here moves real money, so each one
  // logs what it sent and the broker's verbatim reply.

  async placeOrder(req: OrderRequest): Promise<{ orderId: string }> {
    const headers = await this.authHeaders();
    // Options tick in 0.05; the broker rejects a price off the grid.
    const price = req.orderType === 'LIMIT' ? (Math.round((req.price ?? 0) * 20) / 20).toFixed(2) : '0';
    const body = {
      variety: 'NORMAL',
      tradingsymbol: req.tradingsymbol,
      symboltoken: req.providerToken,
      transactiontype: req.side,
      exchange: EXCHANGE_MAP[req.exchange] ?? req.exchange,
      ordertype: req.orderType,
      producttype: req.product,
      duration: 'DAY',
      price,
      squareoff: '0',
      stoploss: '0',
      quantity: String(req.quantity),
      ...(req.tag ? { ordertag: req.tag.slice(0, 20) } : {}),
    };
    this.log.info({ order: body }, 'Placing order');
    const res = await this.http<AngelEnvelope<{ orderid?: string; uniqueorderid?: string; script?: string }>>(
      '/rest/secure/angelbroking/order/v1/placeOrder',
      { method: 'POST', headers, body, throttleGroup: 'order', retries: 0 },
    );
    this.log.info({ reply: res }, 'Order reply');
    const orderId = res.data?.orderid;
    if (!res.status || !orderId) {
      throw new ProviderError('angelone', `Order rejected: ${res.message ?? res.errorcode ?? 'unknown'}`, {
        retryable: false,
      });
    }
    return { orderId };
  }

  async cancelOrder(orderId: string): Promise<void> {
    const headers = await this.authHeaders();
    const res = await this.http<AngelEnvelope<unknown>>(
      '/rest/secure/angelbroking/order/v1/cancelOrder',
      { method: 'POST', headers, body: { variety: 'NORMAL', orderid: orderId }, throttleGroup: 'order', retries: 0 },
    );
    this.log.info({ orderId, reply: res }, 'Cancel reply');
    if (!res.status) {
      throw new ProviderError('angelone', `Cancel failed: ${res.message ?? 'unknown'}`, { retryable: false });
    }
  }

  async getOrders(): Promise<NormalizedOrder[]> {
    const headers = await this.authHeaders();
    const res = await this.http<
      AngelEnvelope<Array<{
        orderid?: string; status?: string; orderstatus?: string; text?: string;
        tradingsymbol?: string; transactiontype?: string; quantity?: string | number;
        filledshares?: string | number; averageprice?: string | number; updatetime?: string;
      }> | null>
    >('/rest/secure/angelbroking/order/v1/getOrderBook', { headers, throttleGroup: 'order' });
    if (!res.status) {
      throw new ProviderError('angelone', res.message ?? 'Order book call failed', { retryable: true });
    }
    const rows = Array.isArray(res.data) ? res.data : [];
    return rows
      .filter((o) => o.orderid)
      .map((o) => {
        const raw = (o.status ?? o.orderstatus ?? '').toLowerCase();
        const status: OrderStatus =
          raw === 'complete' ? 'COMPLETE'
          : raw === 'rejected' ? 'REJECTED'
          : raw === 'cancelled' ? 'CANCELLED'
          : raw === 'open' || raw.includes('pending') || raw.includes('received') ? 'OPEN'
          : 'PENDING';
        const avg = num(o.averageprice);
        return {
          orderId: String(o.orderid),
          status,
          tradingsymbol: (o.tradingsymbol ?? '').toUpperCase(),
          side: (o.transactiontype ?? 'BUY').toUpperCase() === 'SELL' ? 'SELL' : 'BUY',
          quantity: num(o.quantity) ?? 0,
          filledQuantity: num(o.filledshares) ?? 0,
          averagePrice: avg !== null && avg > 0 ? avg : null,
          message: o.text?.trim() || null,
          updatedAt: o.updatetime ? new Date(o.updatetime).toISOString() : new Date().toISOString(),
        } satisfies NormalizedOrder;
      });
  }

  async getInstruments(): Promise<NormalizedInstrument[]> {
    if (this.scripCache && Date.now() - this.scripCache.at < 6 * 3600_000) {
      return this.scripCache.rows;
    }
    // Public file, no auth required.
    const rows = await this.http<AngelScripRow[]>(SCRIP_MASTER_URL, {
      throttleGroup: 'instruments',
      timeoutMs: 180_000,
    });

    const parsed = parseAngelScripMaster(rows);
    this.scripCache = { at: Date.now(), rows: parsed };
    return parsed;
  }
}


/** One row of Angel One's public scrip master. */
export interface AngelScripRow {
  token?: string;
  symbol?: string;
  name?: string;
  expiry?: string;
  strike?: string;
  lotsize?: string;
  instrumenttype?: string;
  exch_seg?: string;
  tick_size?: string;
}

/**
 * Normalize Angel One's scrip master into this platform's instrument shape.
 *
 * Pure and exported so the quirks below stay pinned by tests. Every one of
 * them was a real outage: symbols that never matched, indices filed on the
 * wrong exchange, and single rows that aborted the entire upsert batch and
 * left the app showing no data at all while Settings reported "connected".
 */
export function parseAngelScripMaster(rows: readonly AngelScripRow[]): NormalizedInstrument[] {
  const parsed: NormalizedInstrument[] = [];
  for (const r of rows) {
    const token = r.token?.trim();
    const rawSymbol = r.symbol?.trim().toUpperCase();
    const rawExchange = r.exch_seg?.trim().toUpperCase() as Exchange | undefined;
    if (!token || !rawSymbol || !rawExchange) continue;
    // Angel One's master also covers NCDEX and NCO (commodity and currency
    // segments this platform does not model). They fail the instruments
    // exchange check constraint, and one rejected row aborts the whole
    // batch, so drop them here rather than let them poison the sync.
    if (!SUPPORTED_EXCHANGES.has(rawExchange)) continue;

    const it = (r.instrumenttype ?? '').toUpperCase();
    let instrumentType: InstrumentType = 'EQ';
    if (it.startsWith('OPT')) {
      instrumentType = rawSymbol.endsWith('PE') ? 'PE' : 'CE';
    } else if (it.startsWith('FUT')) instrumentType = 'FUT';
    else if (it === 'AMXIDX' || it === 'INDEX') instrumentType = 'INDEX';

    // Angel One files indices under exch_seg NSE/BSE; this platform keeps
    // them on their own pseudo-exchange, and `provider_tokens` merges on
    // exchange + tradingsymbol. Left alone, NIFTY 50 would land on a second
    // NSE row and the dashboard's INDICES lookup would never find the token.
    const exchange: Exchange = instrumentType === 'INDEX' ? 'INDICES' : rawExchange;

    // NSE cash symbols carry a two-or-three character series suffix —
    // RELIANCE-EQ, IDEA-BE, SGBAUG28-SG. Every other provider, and every
    // lookup in this codebase, uses the bare symbol. Without stripping it
    // the token merge silently misses and Angel One can price nothing.
    // Only the final segment goes: HCL-INSYS-EQ must become HCL-INSYS, not
    // HCL. Derivatives (RELIANCE29SEP261170PE) carry no suffix, and BSE
    // symbols never do, so both are left untouched.
    const tradingsymbol =
      rawExchange === 'NSE' && instrumentType !== 'INDEX'
        ? rawSymbol.replace(/-[A-Z0-9]{1,3}$/, '') || rawSymbol
        : rawSymbol;

    // Angel reports strike in paise (multiplied by 100).
    const rawStrike = num(r.strike);
    const strike = rawStrike !== null && rawStrike > 0 ? rawStrike / 100 : null;

    parsed.push({
      exchange,
      tradingsymbol,
      name: r.name?.trim() ?? null,
      isin: null,
      segment: exchange,
      instrumentType,
      underlying: r.name?.trim().toUpperCase() ?? null,
      expiry: normalizeAngelExpiry(r.expiry),
      strike,
      optionType: instrumentType === 'CE' || instrumentType === 'PE' ? instrumentType : null,
      // Angel One ships 0 (and occasionally -1) as the lot size for rows
      // that do not trade in lots — indices above all. The schema requires
      // lot_size > 0, so an unclamped 0 aborts the entire upsert batch and
      // the whole master fails to sync on one bad row. 1 is the honest
      // value for a non-lot instrument.
      lotSize: Math.max(1, Math.trunc(num(r.lotsize) ?? 1)),
      // Same reasoning: a 0 tick would corrupt price rounding downstream.
      tickSize: Math.max(0.01, (num(r.tick_size) || 5) / 100),
      providerToken: token,
    });
  }
  return parsed;
}

const MONTHS: Record<string, string> = {
  JAN: '01', FEB: '02', MAR: '03', APR: '04', MAY: '05', JUN: '06',
  JUL: '07', AUG: '08', SEP: '09', OCT: '10', NOV: '11', DEC: '12',
};

/** Angel expiries look like "28MAR2024"; normalize to YYYY-MM-DD. */
export function normalizeAngelExpiry(raw: string | undefined): string | null {
  if (!raw) return null;
  const m = /^(\d{2})([A-Z]{3})(\d{4})$/.exec(raw.trim().toUpperCase());
  if (!m) return null;
  const month = MONTHS[m[2]!];
  if (!month) return null;
  return `${m[3]}-${month}-${m[1]}`;
}
