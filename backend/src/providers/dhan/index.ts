/**
 * DhanHQ v2 provider.
 *
 * Chosen as the default because it uses a long-lived static access token
 * (no daily re-login), exposes a first-class option-chain endpoint, and is
 * free for individual accounts.
 *
 * Docs: https://dhanhq.co/docs/v2/
 *
 * Rate limits enforced here (see manifest.throttleMs) mirror the published
 * per-endpoint caps; the option-chain endpoint in particular is ~1 req / 3 s
 * and will hard-fail if you exceed it.
 *
 * NOTE FOR OPERATORS: broker JSON field names do change between API versions.
 * `npm run provider:verify -- dhan` exercises every mapping below against your
 * live credentials and reports any field this adapter could not find.
 */
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
  NormalizedOptionChain,
  OptionStrike,
  NormalizedIndex,
  ProviderId,
  Exchange,
  InstrumentType,
  OrderRequest, OrderStatus, NormalizedOrder, NormalizedFunds, NormalizedPosition } from '../types.js';
import { symbolKey } from '../types.js';
import { isIntraday, type Timeframe } from '../../utils/time.js';

const SCRIP_MASTER_URL = 'https://images.dhan.co/api-data/api-scrip-master-detailed.csv';

/** Dhan's exchange-segment vocabulary. */
const SEGMENT: Record<string, string> = {
  NSE: 'NSE_EQ',
  BSE: 'BSE_EQ',
  NFO: 'NSE_FNO',
  BFO: 'BSE_FNO',
  MCX: 'MCX_COMM',
  CDS: 'NSE_CURRENCY',
  INDICES: 'IDX_I',
};

/** Intraday interval values Dhan accepts, in minutes. */
const INTRADAY_INTERVAL: Partial<Record<Timeframe, string>> = {
  '1m': '1',
  '5m': '5',
  '15m': '15',
  '30m': '25', // Dhan supports 1/5/15/25/60; 30m is aggregated from 15m upstream
  '1h': '60',
};

interface DhanQuoteLeg {
  last_price?: number;
  volume?: number;
  net_change?: number;
  average_price?: number;
  oi?: number;
  oi_day_high?: number;
  oi_day_low?: number;
  upper_circuit_limit?: number;
  lower_circuit_limit?: number;
  last_trade_time?: string | number;
  ohlc?: { open?: number; high?: number; low?: number; close?: number };
  depth?: {
    buy?: Array<{ price?: number; quantity?: number }>;
    sell?: Array<{ price?: number; quantity?: number }>;
  };
}

interface DhanMarketFeedResponse {
  status?: string;
  data?: Record<string, Record<string, DhanQuoteLeg>>;
}

interface DhanHistoricalResponse {
  open?: number[];
  high?: number[];
  low?: number[];
  close?: number[];
  volume?: number[];
  open_interest?: number[];
  timestamp?: number[];
}

interface DhanOptionLeg {
  last_price?: number;
  oi?: number;
  previous_oi?: number;
  volume?: number;
  implied_volatility?: number;
  top_bid_price?: number;
  top_ask_price?: number;
  top_bid_quantity?: number;
  top_ask_quantity?: number;
  previous_close_price?: number;
}

interface DhanOptionChainResponse {
  status?: string;
  data?: {
    last_price?: number;
    oc?: Record<string, { ce?: DhanOptionLeg; pe?: DhanOptionLeg }>;
  };
}

export class DhanProvider extends HttpProvider implements MarketDataProvider {
  protected readonly providerId: ProviderId = 'dhan';
  protected readonly baseUrl = 'https://api.dhan.co/v2';

  private clientId: string | undefined;
  private accessToken: string | undefined;

  /** Instrument-master cache; the CSV is ~10 MB so we fetch it at most hourly. */
  private scripCache: { at: number; rows: NormalizedInstrument[] } | null = null;

  readonly manifest: ProviderManifest = {
    id: 'dhan',
    displayName: 'Dhan (DhanHQ v2)',
    docsUrl: 'https://dhanhq.co/docs/v2/',
    authModel: 'static_token',
    capabilities: [
      'quote',
      'quoteBatch',
      'depth',
      'historicalCandles',
      'intradayCandles',
      'instruments',
      'optionChain',
      'optionExpiries',
      'indices',
      'positions',
      'orders',
      'funds',
    ],
    credentialFields: [
      {
        key: 'clientId',
        label: 'Client ID',
        secret: false,
        required: true,
        help: 'Your Dhan client id, visible in the DhanHQ web console.',
      },
      {
        key: 'accessToken',
        label: 'Access Token',
        secret: true,
        required: true,
        help: 'Generate under DhanHQ → My Profile → DhanHQ Trading APIs. Long-lived.',
      },
    ],
    throttleMs: {
      default: 250,
      marketfeed: 1_000,
      optionChain: 3_100,
      historical: 1_000,
      scripMaster: 60_000,
    },
    notes:
      'Free for individual accounts. The option-chain endpoint is limited to roughly one request every three seconds.',
  };

  constructor(creds: ProviderCredentials = {}) {
    super();
    this.clientId = creds.clientId;
    this.accessToken = creds.accessToken;
    this.throttle = { ...this.manifest.throttleMs };
  }

  isConfigured(): boolean {
    return Boolean(this.clientId && this.accessToken);
  }

  private headers(): Record<string, string> {
    if (!this.isConfigured()) {
      throw new ProviderError('dhan', 'Dhan credentials are not configured', {
        retryable: false,
        status: 401,
      });
    }
    return {
      'access-token': this.accessToken!,
      'client-id': this.clientId!,
      'content-type': 'application/json',
    };
  }

  async healthCheck() {
    if (!this.isConfigured()) {
      return { ok: false, latencyMs: 0, detail: 'Credentials not configured' };
    }
    return this.probe(async () => {
      // NIFTY 50 index, security id 13 on IDX_I — the cheapest authenticated call.
      await this.http<DhanMarketFeedResponse>('/marketfeed/ltp', {
        method: 'POST',
        headers: this.headers(),
        body: { IDX_I: [13] },
        throttleGroup: 'marketfeed',
        retries: 0,
      });
    });
  }

  // ── quotes ────────────────────────────────────────────────────────────────

  async getQuote(req: QuoteRequest): Promise<NormalizedQuote> {
    const [quote] = await this.getQuotes([req]);
    if (!quote) {
      throw new ProviderError('dhan', `No quote returned for ${req.tradingsymbol}`, {
        retryable: false,
      });
    }
    return quote;
  }

  async getQuotes(reqs: QuoteRequest[]): Promise<NormalizedQuote[]> {
    if (reqs.length === 0) return [];

    // Group security ids by Dhan exchange segment.
    const payload: Record<string, number[]> = {};
    const lookup = new Map<string, QuoteRequest>();

    for (const r of reqs) {
      if (!r.providerToken) {
        throw new ProviderError(
          'dhan',
          `Instrument ${r.exchange}:${r.tradingsymbol} has no Dhan security id. Run the instruments sync.`,
          { retryable: false },
        );
      }
      const seg = SEGMENT[r.exchange] ?? 'NSE_EQ';
      (payload[seg] ??= []).push(Number(r.providerToken));
      lookup.set(`${seg}:${r.providerToken}`, r);
    }

    const res = await this.http<DhanMarketFeedResponse>('/marketfeed/quote', {
      method: 'POST',
      headers: this.headers(),
      body: payload,
      throttleGroup: 'marketfeed',
    });

    const out: NormalizedQuote[] = [];
    for (const [seg, bySecurity] of Object.entries(res.data ?? {})) {
      for (const [securityId, leg] of Object.entries(bySecurity)) {
        const req = lookup.get(`${seg}:${securityId}`);
        if (!req) continue;
        const ltp = num(leg.last_price);
        // A quote without a last price is not a quote. Skip rather than zero-fill.
        if (ltp === null) continue;

        const ohlc = leg.ohlc ?? {};
        const bestBid = leg.depth?.buy?.[0];
        const bestAsk = leg.depth?.sell?.[0];

        out.push({
          symbol: symbolKey(req.exchange, req.tradingsymbol),
          exchange: req.exchange,
          tradingsymbol: req.tradingsymbol,
          ltp,
          prevClose: num(ohlc.close),
          open: num(ohlc.open),
          high: num(ohlc.high),
          low: num(ohlc.low),
          close: num(ohlc.close),
          volume: num(leg.volume),
          avgPrice: num(leg.average_price),
          oi: num(leg.oi),
          oiChange: null,
          bid: num(bestBid?.price),
          ask: num(bestAsk?.price),
          bidQty: num(bestBid?.quantity),
          askQty: num(bestAsk?.quantity),
          upperCircuit: num(leg.upper_circuit_limit),
          lowerCircuit: num(leg.lower_circuit_limit),
          week52High: null, // not in the marketfeed payload; sourced from EOD job
          week52Low: null,
          timestamp: isoOrNow(leg.last_trade_time),
          providerToken: securityId,
        });
      }
    }
    return out;
  }

  // ── candles ───────────────────────────────────────────────────────────────

  async getCandles(req: CandleRequest): Promise<NormalizedCandle[]> {
    if (!req.providerToken) {
      throw new ProviderError('dhan', `Missing Dhan security id for ${req.tradingsymbol}`, {
        retryable: false,
      });
    }
    const segment = SEGMENT[req.exchange] ?? 'NSE_EQ';
    const instrument =
      req.exchange === 'INDICES' ? 'INDEX' : req.exchange === 'NFO' ? 'OPTIDX' : 'EQUITY';
    const fromDate = req.from.toISOString().slice(0, 10);
    const toDate = req.to.toISOString().slice(0, 10);

    let res: DhanHistoricalResponse;
    if (isIntraday(req.timeframe)) {
      const interval = INTRADAY_INTERVAL[req.timeframe];
      if (!interval) {
        throw new ProviderError('dhan', `Unsupported intraday timeframe ${req.timeframe}`, {
          retryable: false,
        });
      }
      res = await this.http<DhanHistoricalResponse>('/charts/intraday', {
        method: 'POST',
        headers: this.headers(),
        body: {
          securityId: req.providerToken,
          exchangeSegment: segment,
          instrument,
          interval,
          fromDate,
          toDate,
        },
        throttleGroup: 'historical',
      });
    } else {
      res = await this.http<DhanHistoricalResponse>('/charts/historical', {
        method: 'POST',
        headers: this.headers(),
        body: {
          securityId: req.providerToken,
          exchangeSegment: segment,
          instrument,
          expiryCode: 0,
          fromDate,
          toDate,
        },
        throttleGroup: 'historical',
      });
    }

    return parseColumnarCandles(res, 'dhan');
  }

  // ── option chain ──────────────────────────────────────────────────────────

  async getOptionExpiries(underlyingSecurityId: string): Promise<string[]> {
    const res = await this.http<{ data?: string[] }>('/optionchain/expirylist', {
      method: 'POST',
      headers: this.headers(),
      body: {
        UnderlyingScrip: Number(underlyingSecurityId),
        UnderlyingSeg: 'IDX_I',
      },
      throttleGroup: 'optionChain',
    });
    return (res.data ?? []).filter(Boolean);
  }

  async getOptionChain(
    underlyingSecurityId: string,
    expiry: string,
    opts?: { segment?: 'IDX_I' | 'NSE_FNO'; underlyingName?: string },
  ): Promise<NormalizedOptionChain> {
    const res = await this.http<DhanOptionChainResponse>('/optionchain', {
      method: 'POST',
      headers: this.headers(),
      body: {
        UnderlyingScrip: Number(underlyingSecurityId),
        UnderlyingSeg: opts?.segment ?? 'IDX_I',
        Expiry: expiry,
      },
      throttleGroup: 'optionChain',
    });

    const oc = res.data?.oc;
    if (!oc || Object.keys(oc).length === 0) {
      throw new ProviderError('dhan', `Empty option chain for expiry ${expiry}`, {
        retryable: true,
      });
    }

    const strikes: OptionStrike[] = Object.entries(oc)
      .map(([strikeStr, legs]) => {
        const strike = Number(strikeStr);
        return {
          strike,
          call: mapDhanLeg(legs.ce),
          put: mapDhanLeg(legs.pe),
        };
      })
      .filter((s) => Number.isFinite(s.strike))
      .sort((a, b) => a.strike - b.strike);

    return {
      underlying: opts?.underlyingName ?? underlyingSecurityId,
      expiry,
      spot: num(res.data?.last_price),
      futuresPrice: null,
      strikes,
      timestamp: new Date().toISOString(),
      lotSize: null,
    };
  }

  // ── indices ───────────────────────────────────────────────────────────────

  async getIndices(securityIds: string[] = ['13', '25', '27', '21']): Promise<NormalizedIndex[]> {
    const res = await this.http<DhanMarketFeedResponse>('/marketfeed/quote', {
      method: 'POST',
      headers: this.headers(),
      body: { IDX_I: securityIds.map(Number) },
      throttleGroup: 'marketfeed',
    });

    const out: NormalizedIndex[] = [];
    for (const [securityId, leg] of Object.entries(res.data?.['IDX_I'] ?? {})) {
      const ltp = num(leg.last_price);
      if (ltp === null) continue;
      const prevClose = num(leg.ohlc?.close);
      const change = prevClose !== null ? ltp - prevClose : num(leg.net_change);
      out.push({
        symbol: securityId,
        ltp,
        prevClose,
        open: num(leg.ohlc?.open),
        high: num(leg.ohlc?.high),
        low: num(leg.ohlc?.low),
        change,
        changePct: prevClose ? ((ltp - prevClose) / prevClose) * 100 : null,
        timestamp: isoOrNow(leg.last_trade_time),
      });
    }
    return out;
  }

  // ── instruments ───────────────────────────────────────────────────────────

  // ── orders, positions, funds (DhanHQ v2) ──────────────────────────────────
  // Orders are addressed by Dhan's security id, which the instrument sync
  // stores against each contract once Dhan is connected. Every request and
  // reply is logged: these move money.

  async placeOrder(req: OrderRequest): Promise<{ orderId: string }> {
    if (!req.providerToken) {
      throw new ProviderError('dhan', `No Dhan security id for ${req.tradingsymbol}. Run the instruments sync and try again.`, { retryable: false });
    }
    const body = {
      dhanClientId: this.clientId,
      correlationId: (req.tag ?? '').slice(0, 25),
      transactionType: req.side,
      exchangeSegment: SEGMENT[req.exchange] ?? 'NSE_FNO',
      productType: req.product === 'INTRADAY' ? 'INTRADAY' : 'MARGIN',
      orderType: req.orderType,
      validity: 'DAY',
      securityId: req.providerToken,
      quantity: req.quantity,
      disclosedQuantity: 0,
      price: req.orderType === 'LIMIT' ? Number((Math.round((req.price ?? 0) * 20) / 20).toFixed(2)) : 0,
      afterMarketOrder: false,
    };
    this.log.info({ order: body }, 'Placing order');
    let res: { orderId?: string; orderStatus?: string; errorMessage?: string; errorCode?: string };
    try {
      res = await this.http('/orders', { method: 'POST', headers: this.headers(), body, throttleGroup: 'default', retries: 0 });
    } catch (err) {
      throw new ProviderError('dhan', `Order rejected: ${(err as Error).message.slice(0, 300)}`, { retryable: false });
    }
    this.log.info({ reply: res }, 'Order reply');
    if (!res.orderId || res.orderStatus === 'REJECTED') {
      throw new ProviderError('dhan', `Order rejected: ${res.errorMessage ?? res.orderStatus ?? res.errorCode ?? 'unknown'}`, { retryable: false });
    }
    return { orderId: String(res.orderId) };
  }

  async cancelOrder(orderId: string): Promise<void> {
    let res: { orderStatus?: string; errorMessage?: string };
    try {
      res = await this.http(`/orders/${encodeURIComponent(orderId)}`, { method: 'DELETE', headers: this.headers(), throttleGroup: 'default', retries: 0 });
    } catch (err) {
      throw new ProviderError('dhan', `Cancel failed: ${(err as Error).message.slice(0, 300)}`, { retryable: false });
    }
    this.log.info({ orderId, reply: res }, 'Cancel reply');
    if (res.orderStatus && res.orderStatus === 'REJECTED') {
      throw new ProviderError('dhan', `Cancel failed: ${res.errorMessage ?? 'rejected'}`, { retryable: false });
    }
  }

  async getOrders(): Promise<NormalizedOrder[]> {
    const rows = await this.http<Array<{
      orderId?: string | number; orderStatus?: string; tradingSymbol?: string; transactionType?: string;
      quantity?: number | string; filledQty?: number | string; averageTradedPrice?: number | string;
      omsErrorDescription?: string; updateTime?: string; createTime?: string;
    }>>('/orders', { headers: this.headers(), throttleGroup: 'default' });
    return (Array.isArray(rows) ? rows : [])
      .filter((o) => o.orderId !== undefined && o.orderId !== null)
      .map((o) => {
        const raw = (o.orderStatus ?? '').toUpperCase();
        const status: OrderStatus =
          raw === 'TRADED' ? 'COMPLETE'
          : raw === 'REJECTED' ? 'REJECTED'
          : raw === 'CANCELLED' || raw === 'EXPIRED' ? 'CANCELLED'
          : raw === 'PENDING' || raw === 'TRANSIT' || raw === 'PART_TRADED' ? 'OPEN'
          : 'PENDING';
        const avg = num(o.averageTradedPrice);
        return {
          orderId: String(o.orderId),
          status,
          tradingsymbol: (o.tradingSymbol ?? '').toUpperCase(),
          side: (o.transactionType ?? 'BUY').toUpperCase() === 'SELL' ? 'SELL' : 'BUY',
          quantity: num(o.quantity) ?? 0,
          filledQuantity: num(o.filledQty) ?? 0,
          averagePrice: avg !== null && avg > 0 ? avg : null,
          message: o.omsErrorDescription?.trim() || null,
          updatedAt: isoOrNow(o.updateTime ?? o.createTime),
        } satisfies NormalizedOrder;
      });
  }

  async getPositions(): Promise<NormalizedPosition[]> {
    const rows = await this.http<Array<{
      tradingSymbol?: string; securityId?: string; netQty?: number | string; buyAvg?: number | string;
      costPrice?: number | string; productType?: string; exchangeSegment?: string;
    }>>('/positions', { headers: this.headers(), throttleGroup: 'default' });
    const out: NormalizedPosition[] = [];
    for (const p of Array.isArray(rows) ? rows : []) {
      const tradingsymbol = (p.tradingSymbol ?? '').trim().toUpperCase();
      const netQty = num(p.netQty) ?? 0;
      if (!tradingsymbol || netQty === 0) continue;
      out.push({
        tradingsymbol,
        exchange: DHAN_SEGMENT_TO_EXCHANGE[(p.exchangeSegment ?? '').toUpperCase()] ?? null,
        segment: p.exchangeSegment ?? null,
        quantity: netQty,
        averagePrice: num(p.buyAvg) ?? num(p.costPrice) ?? 0,
        product: p.productType ?? null,
      });
    }
    return out;
  }

  /** Fund limit as Dhan reports it. Dhan spells the field `availabelBalance`. */
  async getFunds(): Promise<NormalizedFunds> {
    const r = await this.http<{
      availabelBalance?: number | string; availableBalance?: number | string; sodLimit?: number | string;
      collateralAmount?: number | string; utilizedAmount?: number | string; withdrawableBalance?: number | string;
    }>('/fundlimit', { headers: this.headers(), throttleGroup: 'default' });
    const availableCash = num(r.availabelBalance) ?? num(r.availableBalance);
    if (availableCash === null) throw new ProviderError('dhan', 'Fund limit reply had no available balance figure', { retryable: true });
    const used = num(r.utilizedAmount);
    return {
      availableCash, net: used === null ? null : availableCash + used, utilised: used,
      collateral: num(r.collateralAmount), m2mUnrealised: null, m2mRealised: null, fetchedAt: new Date().toISOString(),
    };
  }

  async getInstruments(): Promise<NormalizedInstrument[]> {
    if (this.scripCache && Date.now() - this.scripCache.at < 3600_000) {
      return this.scripCache.rows;
    }
    const csv = await this.http<string>(SCRIP_MASTER_URL, {
      raw: true,
      throttleGroup: 'scripMaster',
      timeoutMs: 120_000,
    });
    const rows = parseDhanScripMaster(csv);
    this.scripCache = { at: Date.now(), rows };
    return rows;
  }
}

// ── pure mappers (exported for unit tests) ─────────────────────────────────

export function mapDhanLeg(leg: DhanOptionLeg | undefined) {
  if (!leg) return null;
  const oi = num(leg.oi);
  const prevOi = num(leg.previous_oi);
  return {
    oi,
    oiChange: oi !== null && prevOi !== null ? oi - prevOi : null,
    volume: num(leg.volume),
    ltp: num(leg.last_price),
    iv: num(leg.implied_volatility),
    bid: num(leg.top_bid_price),
    ask: num(leg.top_ask_price),
    bidQty: num(leg.top_bid_quantity),
    askQty: num(leg.top_ask_quantity),
    prevClose: num(leg.previous_close_price),
  };
}

/** Dhan returns candles as parallel arrays; zip them, dropping malformed rows. */
export function parseColumnarCandles(
  res: DhanHistoricalResponse,
  provider: string,
): NormalizedCandle[] {
  const ts = res.timestamp ?? [];
  const o = res.open ?? [];
  const h = res.high ?? [];
  const l = res.low ?? [];
  const c = res.close ?? [];
  const v = res.volume ?? [];
  const oi = res.open_interest ?? [];

  if (ts.length === 0) return [];
  if (o.length !== ts.length || c.length !== ts.length) {
    throw new ProviderError(provider, 'Candle arrays have mismatched lengths', {
      retryable: false,
    });
  }

  const out: NormalizedCandle[] = [];
  for (let i = 0; i < ts.length; i += 1) {
    const open = num(o[i]);
    const high = num(h[i]);
    const low = num(l[i]);
    const close = num(c[i]);
    const t = ts[i];
    if (open === null || high === null || low === null || close === null || t === undefined) {
      continue; // a partial candle is dropped, never patched
    }
    out.push({
      ts: isoOrNow(t),
      open,
      high,
      low,
      close,
      volume: num(v[i]) ?? 0,
      oi: num(oi[i]),
    });
  }
  return out;
}

/** Minimal CSV splitter that honours quoted fields. */
function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        cur += '"';
        i += 1;
      } else inQuotes = !inQuotes;
    } else if (ch === ',' && !inQuotes) {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

const DHAN_SEGMENT_TO_EXCHANGE: Record<string, Exchange> = {
  NSE_EQ: 'NSE',
  BSE_EQ: 'BSE',
  NSE_FNO: 'NFO',
  BSE_FNO: 'BFO',
  MCX_COMM: 'MCX',
  NSE_CURRENCY: 'CDS',
  BSE_CURRENCY: 'CDS',
  IDX_I: 'INDICES',
};

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * Dhan's detailed scrip master (`api-scrip-master-detailed.csv`) has no
 * exchange-segment or trading-symbol column. The segment is EXCH_ID plus the
 * one-letter SEGMENT (E equity, D derivatives, C currency, M commodity,
 * I index), and SYMBOL_NAME is only unique on NSE derivatives: BSE options
 * all read "BSXOPT" and MCX futures repeat the underlying. Derivative
 * symbols are therefore built here in Dhan's own NSE spelling
 * (BANKNIFTY-Oct2026-71900-CE, NIFTY-Oct2026-FUT) so every contract gets a
 * unique row and NSE rows match what Dhan itself prints.
 */
export function dhanSegment(exchId: string, segment: string): string | null {
  const ex = exchId.trim().toUpperCase();
  const seg = segment.trim().toUpperCase();
  if (seg === 'I') return 'IDX_I';
  if (ex === 'NSE') return seg === 'E' ? 'NSE_EQ' : seg === 'D' ? 'NSE_FNO' : seg === 'C' ? 'NSE_CURRENCY' : null;
  if (ex === 'BSE') return seg === 'E' ? 'BSE_EQ' : seg === 'D' ? 'BSE_FNO' : seg === 'C' ? 'BSE_CURRENCY' : null;
  if (ex === 'MCX') return seg === 'M' ? 'MCX_COMM' : null;
  return null;
}

function formatStrike(strike: number): string {
  return Number.isInteger(strike) ? String(strike) : String(Number(strike.toFixed(2)));
}

export function dhanDerivativeSymbol(
  underlying: string,
  expiry: string,
  strike: number | null,
  optionType: 'CE' | 'PE' | null,
): string {
  const [y, m] = expiry.split('-');
  const mon = `${MONTHS[Number(m) - 1] ?? m}${y}`;
  const base = `${underlying.toUpperCase()}-${mon}`;
  return optionType && strike !== null ? `${base}-${formatStrike(strike)}-${optionType}` : `${base}-FUT`;
}

export function parseDhanScripMaster(csv: string): NormalizedInstrument[] {
  const lines = csv.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) return [];

  const header = splitCsvLine(lines[0]!).map((h) => h.trim().toUpperCase());
  const col = (...names: string[]) => {
    for (const n of names) { const i = header.indexOf(n); if (i >= 0) return i; }
    return -1;
  };
  const cell = (f: string[], i: number) => (i >= 0 ? (f[i] ?? '').trim() : '');

  const iSecId = col('SECURITY_ID', 'SEM_SMST_SECURITY_ID');
  const iExch = col('EXCH_ID', 'SEM_EXM_EXCH_ID');
  const iSeg = col('SEGMENT', 'SEM_SEGMENT');
  const iUnderlying = col('UNDERLYING_SYMBOL', 'SM_SYMBOL_NAME');
  const iSymbolName = col('SYMBOL_NAME', 'SEM_TRADING_SYMBOL');
  const iDisplay = col('DISPLAY_NAME', 'SEM_CUSTOM_SYMBOL');
  const iIsin = col('ISIN');
  const iInstr = col('INSTRUMENT', 'SEM_INSTRUMENT_NAME');
  const iExpiry = col('SM_EXPIRY_DATE', 'SEM_EXPIRY_DATE');
  const iStrike = col('STRIKE_PRICE', 'SEM_STRIKE_PRICE');
  const iOptType = col('OPTION_TYPE', 'SEM_OPTION_TYPE');
  const iLot = col('LOT_SIZE', 'SEM_LOT_UNITS');
  const iTick = col('TICK_SIZE', 'SEM_TICK_SIZE');
  if (iSecId < 0 || iExch < 0 || iSeg < 0) return [];

  const out: NormalizedInstrument[] = [];
  const seen = new Set<string>();

  for (let i = 1; i < lines.length; i += 1) {
    const f = splitCsvLine(lines[i]!);
    const securityId = cell(f, iSecId);
    if (!securityId) continue;

    const segRaw = dhanSegment(cell(f, iExch), cell(f, iSeg));
    const exchange = segRaw ? DHAN_SEGMENT_TO_EXCHANGE[segRaw] : undefined;
    if (!segRaw || !exchange) continue;

    const instrRaw = cell(f, iInstr).toUpperCase();
    const optType = cell(f, iOptType).toUpperCase();
    const optionType: 'CE' | 'PE' | null = optType === 'CE' || optType === 'PE' ? optType : null;
    let instrumentType: InstrumentType = 'EQ';
    if (instrRaw.includes('INDEX') || segRaw === 'IDX_I') instrumentType = 'INDEX';
    else if (optionType) instrumentType = optionType;
    else if (instrRaw.startsWith('FUT')) instrumentType = 'FUT';
    else if (instrRaw === 'ETF') instrumentType = 'ETF';

    const expiryRaw = cell(f, iExpiry).slice(0, 10);
    const expiry = /^\d{4}-\d{2}-\d{2}$/.test(expiryRaw) && Number(expiryRaw.slice(0, 4)) >= 1990 ? expiryRaw : null;
    const strike = optionType ? num(cell(f, iStrike)) : null;
    const underlying = cell(f, iUnderlying).toUpperCase() || null;

    const isDerivative = instrumentType === 'FUT' || optionType !== null;
    let tradingsymbol: string;
    if (isDerivative && underlying && expiry) {
      tradingsymbol = dhanDerivativeSymbol(underlying, expiry, strike, optionType);
    } else {
      tradingsymbol = (underlying ?? cell(f, iSymbolName)).toUpperCase();
    }
    if (!tradingsymbol) continue;
    const key = `${exchange}:${tradingsymbol}`;
    if (seen.has(key)) continue;
    seen.add(key);

    out.push({
      exchange,
      tradingsymbol,
      name: cell(f, iDisplay) || cell(f, iSymbolName) || null,
      isin: cell(f, iIsin).replace(/^NA$/i, '') || null,
      segment: segRaw,
      instrumentType,
      underlying,
      expiry,
      strike,
      optionType,
      lotSize: num(cell(f, iLot)) ?? 1,
      tickSize: num(cell(f, iTick)) ?? 0.05,
      providerToken: securityId,
    });
  }
  return out;
}
