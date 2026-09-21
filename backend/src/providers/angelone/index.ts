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
  ProviderId,
  Exchange,
  InstrumentType,
} from '../types.js';
import { symbolKey } from '../types.js';
import { toIst, type Timeframe } from '../../utils/time.js';

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

export class AngelOneProvider extends HttpProvider implements MarketDataProvider {
  protected readonly providerId: ProviderId = 'angelone';
  protected readonly baseUrl = 'https://apiconnect.angelone.in';

  private apiKey: string | undefined;
  private clientCode: string | undefined;
  private mpin: string | undefined;
  private totpSecret: string | undefined;

  private jwt: string | null = null;
  private jwtIssuedAt = 0;
  private loginInFlight: Promise<void> | null = null;

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
      'indices',
      'holdings',
      'positions',
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

  /** Sessions last several hours; re-login proactively after 6. */
  private sessionExpired(): boolean {
    return !this.jwt || Date.now() - this.jwtIssuedAt > 6 * 3600_000;
  }

  private async ensureSession(): Promise<void> {
    if (!this.sessionExpired()) return;
    // Collapse concurrent callers onto one login.
    this.loginInFlight ??= this.login().finally(() => {
      this.loginInFlight = null;
    });
    await this.loginInFlight;
  }

  private async login(): Promise<void> {
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

    const res = await this.http<AngelEnvelope<{ jwtToken?: string; refreshToken?: string }>>(
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
    this.jwt = token.startsWith('Bearer ') ? token.slice(7) : token;
    this.jwtIssuedAt = Date.now();
    this.log.info('Angel One session established via TOTP');
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
