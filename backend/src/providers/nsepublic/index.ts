/**
 * NSE public-endpoint provider — DISABLED BY DEFAULT.
 *
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │  READ THIS BEFORE ENABLING                                              │
 * │                                                                         │
 * │  The www.nseindia.com JSON endpoints are undocumented, unsupported, and │
 * │  not licensed for redistribution. They are cookie-gated and aggressively│
 * │  rate-limited; NSE may block you, change the shape without notice, or   │
 * │  consider automated access a terms violation.                           │
 * │                                                                         │
 * │  This adapter exists because the brief asked for NSE/BSE public data    │
 * │  "where legally permitted" — that determination is the operator's to    │
 * │  make, not this code's. It therefore:                                   │
 * │    · stays off unless NSE_PUBLIC_ENABLED=true is set explicitly         │
 * │    · self-throttles hard (default one request per 3 s)                  │
 * │    · is registered at the LOWEST priority, behind every licensed feed   │
 * │    · records a data_quality_event on every use so its footprint is      │
 * │      auditable                                                          │
 * │                                                                         │
 * │  For production, prefer a broker API (Dhan/Angel One/Kite) or a         │
 * │  licensed vendor feed. For redistribution you need an exchange data     │
 * │  vendor licence.                                                        │
 * └─────────────────────────────────────────────────────────────────────────┘
 */
import { HttpProvider, num, isoOrNow } from '../base/HttpProvider.js';
import { ProviderError } from '../../utils/errors.js';
import { env } from '../../config/env.js';
import type {
  MarketDataProvider,
  ProviderManifest,
  NormalizedOptionChain,
  NormalizedBreadth,
  NormalizedMover,
  NormalizedIndex,
  OptionStrike,
  ProviderId,
} from '../types.js';

const BROWSER_HEADERS = {
  'user-agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  'accept-language': 'en-US,en;q=0.9',
  accept: 'application/json, text/plain, */*',
  referer: 'https://www.nseindia.com/',
};

interface NseOptionLeg {
  openInterest?: number;
  changeinOpenInterest?: number;
  totalTradedVolume?: number;
  impliedVolatility?: number;
  lastPrice?: number;
  bidprice?: number;
  askPrice?: number;
  bidQty?: number;
  askQty?: number;
  pchangeinOpenInterest?: number;
}

interface NseChainRow {
  strikePrice?: number;
  expiryDate?: string;
  CE?: NseOptionLeg;
  PE?: NseOptionLeg;
}

export class NsePublicProvider extends HttpProvider implements MarketDataProvider {
  protected readonly providerId: ProviderId = 'nsepublic';
  protected readonly baseUrl = 'https://www.nseindia.com';

  private cookie: string | null = null;
  private cookieAt = 0;

  readonly manifest: ProviderManifest = {
    id: 'nsepublic',
    displayName: 'NSE public endpoints (unofficial)',
    docsUrl: 'https://www.nseindia.com/',
    authModel: 'none',
    requiresOptIn: true,
    capabilities: ['optionChain', 'optionExpiries', 'marketBreadth', 'gainersLosers', 'indices'],
    credentialFields: [],
    throttleMs: {
      default: env.NSE_PUBLIC_MIN_INTERVAL_MS,
      optionChain: Math.max(env.NSE_PUBLIC_MIN_INTERVAL_MS, 5_000),
      cookie: 30_000,
    },
    notes:
      'Undocumented and unlicensed for redistribution. Off unless NSE_PUBLIC_ENABLED=true. Used only as a last-resort fallback and never as a primary source.',
  };

  constructor() {
    super();
    this.throttle = { ...this.manifest.throttleMs };
  }

  isConfigured(): boolean {
    return env.NSE_PUBLIC_ENABLED;
  }

  private assertEnabled(): void {
    if (!env.NSE_PUBLIC_ENABLED) {
      throw new ProviderError(
        'nsepublic',
        'NSE public endpoints are disabled. Set NSE_PUBLIC_ENABLED=true only if you have determined this access is permitted for your use.',
        { retryable: false, status: 401 },
      );
    }
  }

  /** NSE hands out a session cookie on the homepage; API calls 401 without it. */
  private async ensureCookie(): Promise<string> {
    this.assertEnabled();
    if (this.cookie && Date.now() - this.cookieAt < 10 * 60_000) return this.cookie;

    const { request } = await import('undici');
    const res = await request('https://www.nseindia.com/option-chain', {
      headers: BROWSER_HEADERS,
      headersTimeout: 15_000,
      bodyTimeout: 15_000,
    });
    await res.body.text();

    const raw = res.headers['set-cookie'];
    const cookies = Array.isArray(raw) ? raw : raw ? [raw] : [];
    if (cookies.length === 0) {
      throw new ProviderError('nsepublic', 'NSE did not return a session cookie', {
        retryable: true,
      });
    }
    this.cookie = cookies.map((c) => c.split(';')[0]).join('; ');
    this.cookieAt = Date.now();
    return this.cookie;
  }

  private async headers(): Promise<Record<string, string>> {
    return { ...BROWSER_HEADERS, cookie: await this.ensureCookie() };
  }

  async healthCheck() {
    if (!this.isConfigured()) {
      return { ok: false, latencyMs: 0, detail: 'Disabled (NSE_PUBLIC_ENABLED=false)' };
    }
    return this.probe(async () => {
      await this.ensureCookie();
    });
  }

  private isIndexUnderlying(symbol: string): boolean {
    return ['NIFTY', 'BANKNIFTY', 'FINNIFTY', 'MIDCPNIFTY', 'NIFTYNXT50'].includes(
      symbol.toUpperCase(),
    );
  }

  private async fetchChain(underlying: string): Promise<{ records?: { data?: NseChainRow[]; expiryDates?: string[]; underlyingValue?: number; timestamp?: string } }> {
    this.assertEnabled();
    const sym = underlying.toUpperCase();
    const path = this.isIndexUnderlying(sym)
      ? `/api/option-chain-indices?symbol=${encodeURIComponent(sym)}`
      : `/api/option-chain-equities?symbol=${encodeURIComponent(sym)}`;

    return this.http(path, {
      headers: await this.headers(),
      throttleGroup: 'optionChain',
      retries: 1,
    });
  }

  async getOptionExpiries(underlying: string): Promise<string[]> {
    const res = await this.fetchChain(underlying);
    const raw = res.records?.expiryDates ?? [];
    return raw.map(normalizeNseDate).filter((d): d is string => d !== null);
  }

  async getOptionChain(underlying: string, expiry: string): Promise<NormalizedOptionChain> {
    const res = await this.fetchChain(underlying);
    const rows = res.records?.data ?? [];
    if (rows.length === 0) {
      throw new ProviderError('nsepublic', `Empty chain for ${underlying}`, { retryable: true });
    }

    const wanted = rows.filter((r) => normalizeNseDate(r.expiryDate) === expiry);
    if (wanted.length === 0) {
      throw new ProviderError('nsepublic', `No strikes for expiry ${expiry}`, { retryable: false });
    }

    const strikes: OptionStrike[] = wanted
      .map((r) => ({
        strike: num(r.strikePrice) ?? NaN,
        call: mapNseLeg(r.CE),
        put: mapNseLeg(r.PE),
      }))
      .filter((s) => Number.isFinite(s.strike))
      .sort((a, b) => a.strike - b.strike);

    return {
      underlying: underlying.toUpperCase(),
      expiry,
      spot: num(res.records?.underlyingValue),
      futuresPrice: null,
      strikes,
      // NSE reports its own capture time; prefer it over our clock.
      timestamp: isoOrNow(res.records?.timestamp),
      lotSize: null,
    };
  }

  async getBreadth(scope = 'NSE'): Promise<NormalizedBreadth> {
    this.assertEnabled();
    const res = await this.http<{
      advance?: { declines?: string; advances?: string; unchanged?: string };
      timestamp?: string;
    }>('/api/allIndices', { headers: await this.headers() });

    const a = num(res.advance?.advances);
    const d = num(res.advance?.declines);
    const u = num(res.advance?.unchanged);
    if (a === null || d === null) {
      throw new ProviderError('nsepublic', 'Breadth fields missing from response', {
        retryable: true,
      });
    }
    return {
      scope,
      advances: a,
      declines: d,
      unchanged: u ?? 0,
      totalScanned: a + d + (u ?? 0),
      new52wHigh: null,
      new52wLow: null,
      timestamp: isoOrNow(res.timestamp),
    };
  }

  async getIndices(): Promise<NormalizedIndex[]> {
    this.assertEnabled();
    const res = await this.http<{
      data?: Array<{
        index?: string;
        last?: number;
        previousClose?: number;
        open?: number;
        high?: number;
        low?: number;
        variation?: number;
        percentChange?: number;
      }>;
      timestamp?: string;
    }>('/api/allIndices', { headers: await this.headers() });

    const out: NormalizedIndex[] = [];
    for (const row of res.data ?? []) {
      const ltp = num(row.last);
      if (!row.index || ltp === null) continue;
      out.push({
        symbol: row.index.toUpperCase(),
        ltp,
        prevClose: num(row.previousClose),
        open: num(row.open),
        high: num(row.high),
        low: num(row.low),
        change: num(row.variation),
        changePct: num(row.percentChange),
        timestamp: isoOrNow(res.timestamp),
      });
    }
    return out;
  }

  async getMovers(kind: string): Promise<NormalizedMover[]> {
    this.assertEnabled();
    const res = await this.http<{
      NIFTY?: { data?: Array<Record<string, unknown>> };
      legends?: unknown;
    }>(`/api/live-analysis-variations?index=${kind === 'losers' ? 'loosers' : 'gainers'}`, {
      headers: await this.headers(),
    });

    const rows = res.NIFTY?.data ?? [];
    const out: NormalizedMover[] = [];
    for (const r of rows) {
      const symbol = String(r['symbol'] ?? '').toUpperCase();
      const ltp = num(r['ltp']);
      const change = num(r['net_price']);
      if (!symbol || ltp === null) continue;
      out.push({
        symbol: `NSE:${symbol}`,
        tradingsymbol: symbol,
        ltp,
        change: change ?? 0,
        changePct: num(r['perChange']) ?? 0,
        volume: num(r['trade_quantity']),
        timestamp: new Date().toISOString(),
      });
    }
    return out;
  }
}

export function mapNseLeg(leg: NseOptionLeg | undefined) {
  if (!leg) return null;
  return {
    oi: num(leg.openInterest),
    oiChange: num(leg.changeinOpenInterest),
    volume: num(leg.totalTradedVolume),
    ltp: num(leg.lastPrice),
    iv: num(leg.impliedVolatility),
    bid: num(leg.bidprice),
    ask: num(leg.askPrice),
    bidQty: num(leg.bidQty),
    askQty: num(leg.askQty),
    prevClose: null,
  };
}

const NSE_MONTHS: Record<string, string> = {
  Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06',
  Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12',
};

/** NSE expiry strings look like "28-Mar-2024". */
export function normalizeNseDate(raw: string | undefined): string | null {
  if (!raw) return null;
  const m = /^(\d{2})-([A-Za-z]{3})-(\d{4})$/.exec(raw.trim());
  if (!m) return null;
  const month = NSE_MONTHS[m[2]!.slice(0, 1).toUpperCase() + m[2]!.slice(1).toLowerCase()];
  if (!month) return null;
  return `${m[3]}-${month}-${m[1]}`;
}
