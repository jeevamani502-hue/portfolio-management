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
} from '../types.js';
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
  IDX_I: 'INDICES',
};

export function parseDhanScripMaster(csv: string): NormalizedInstrument[] {
  const lines = csv.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) return [];

  const header = splitCsvLine(lines[0]!).map((h) => h.trim().toUpperCase());
  const col = (name: string) => header.indexOf(name);

  const iSecId = col('SECURITY_ID');
  const iSegment = col('EXCH_ID') >= 0 ? col('EXCH_ID') : col('SEGMENT');
  const iSymbol = col('UNDERLYING_SYMBOL') >= 0 ? col('UNDERLYING_SYMBOL') : col('SYMBOL_NAME');
  const iDisplay = col('DISPLAY_NAME');
  const iTrading = col('TRADING_SYMBOL') >= 0 ? col('TRADING_SYMBOL') : col('SEM_TRADING_SYMBOL');
  const iIsin = col('ISIN');
  const iInstr = col('INSTRUMENT');
  const iExpiry = col('SM_EXPIRY_DATE') >= 0 ? col('SM_EXPIRY_DATE') : col('EXPIRY_DATE');
  const iStrike = col('STRIKE_PRICE');
  const iOptType = col('OPTION_TYPE');
  const iLot = col('LOT_SIZE');
  const iTick = col('TICK_SIZE');
  const iExchSeg = col('EXCHANGE_SEGMENT') >= 0 ? col('EXCHANGE_SEGMENT') : iSegment;

  const out: NormalizedInstrument[] = [];

  for (let i = 1; i < lines.length; i += 1) {
    const f = splitCsvLine(lines[i]!);
    const securityId = f[iSecId]?.trim();
    const tradingsymbol = (f[iTrading] ?? f[iSymbol] ?? '').trim().toUpperCase();
    if (!securityId || !tradingsymbol) continue;

    const segRaw = (f[iExchSeg] ?? '').trim().toUpperCase();
    const exchange = DHAN_SEGMENT_TO_EXCHANGE[segRaw];
    if (!exchange) continue;

    const instrRaw = (f[iInstr] ?? '').trim().toUpperCase();
    const optType = (f[iOptType] ?? '').trim().toUpperCase();
    let instrumentType: InstrumentType = 'EQ';
    if (instrRaw.includes('INDEX')) instrumentType = 'INDEX';
    else if (instrRaw.startsWith('FUT')) instrumentType = 'FUT';
    else if (optType === 'CE' || optType === 'PE') instrumentType = optType;
    else if (instrRaw === 'ETF') instrumentType = 'ETF';

    const expiryRaw = (f[iExpiry] ?? '').trim();
    const expiry = expiryRaw && expiryRaw !== '0' ? expiryRaw.slice(0, 10) : null;

    out.push({
      exchange,
      tradingsymbol,
      name: (f[iDisplay] ?? f[iSymbol] ?? '').trim() || null,
      isin: (f[iIsin] ?? '').trim() || null,
      segment: segRaw || null,
      instrumentType,
      underlying: (f[iSymbol] ?? '').trim().toUpperCase() || null,
      expiry,
      strike: num(f[iStrike]),
      optionType: optType === 'CE' || optType === 'PE' ? optType : null,
      lotSize: num(f[iLot]) ?? 1,
      tickSize: num(f[iTick]) ?? 0.05,
      providerToken: securityId,
    });
  }
  return out;
}
