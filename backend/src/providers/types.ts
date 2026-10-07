/**
 * The Market Data Provider contract.
 *
 * Every upstream — broker API, exchange file, vendor feed — is normalized to
 * these shapes. Nothing downstream (analysis, API, UI) knows which provider a
 * number came from except through the `source` field that travels with it.
 *
 * Design rules:
 *  1. A provider returns real data or throws. It never returns a placeholder.
 *  2. A provider declares its `capabilities`; the registry routes per capability.
 *  3. Timestamps are the *source's* timestamp, not the time we received it.
 *  4. Unknown/absent fields are `null`, never zero. Zero is a real price.
 */
import type { Timeframe } from '../utils/time.js';

export type Capability =
  | 'quote'
  | 'quoteBatch'
  | 'depth'
  | 'streamTicks'
  | 'historicalCandles'
  | 'intradayCandles'
  | 'instruments'
  | 'optionChain'
  | 'optionExpiries'
  | 'futuresChain'
  | 'marketBreadth'
  | 'indices'
  | 'gainersLosers'
  | 'fundamentals'
  | 'news'
  | 'mfNav'
  | 'holdings'
  | 'positions'
  | 'orders';

export type ProviderId =
  | 'groww'
  | 'dhan'
  | 'angelone'
  | 'kite'
  | 'upstox'
  | 'fyers'
  | 'nsepublic'
  | 'amfi'
  | 'eodhd'
  | 'fmp'
  | 'marketaux'
  | 'newsapi'
  | 'rss';

export type Exchange = 'NSE' | 'BSE' | 'NFO' | 'BFO' | 'MCX' | 'CDS' | 'INDICES';

export type InstrumentType = 'EQ' | 'INDEX' | 'FUT' | 'CE' | 'PE' | 'ETF' | 'MF';

// ── normalized instrument ───────────────────────────────────────────────────

export interface NormalizedInstrument {
  exchange: Exchange;
  tradingsymbol: string;
  name: string | null;
  isin: string | null;
  segment: string | null;
  instrumentType: InstrumentType;
  underlying: string | null;
  expiry: string | null; // YYYY-MM-DD
  strike: number | null;
  optionType: 'CE' | 'PE' | null;
  lotSize: number;
  tickSize: number;
  /** The provider's own identifier for this instrument. */
  providerToken: string;
}

// ── normalized quote ────────────────────────────────────────────────────────

export interface NormalizedQuote {
  symbol: string; // "NSE:RELIANCE"
  exchange: Exchange;
  tradingsymbol: string;
  ltp: number;
  prevClose: number | null;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number | null;
  /** Cumulative traded volume for the day. */
  volume: number | null;
  /** Exchange-reported average traded price (the true VWAP for the day). */
  avgPrice: number | null;
  oi: number | null;
  oiChange: number | null;
  bid: number | null;
  ask: number | null;
  bidQty: number | null;
  askQty: number | null;
  upperCircuit: number | null;
  lowerCircuit: number | null;
  week52High: number | null;
  week52Low: number | null;
  /** The instant this quote was true at the source. */
  timestamp: string; // ISO
  providerToken?: string;
}

export interface NormalizedCandle {
  ts: string; // ISO, bucket start
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  oi: number | null;
}

// ── normalized option chain ─────────────────────────────────────────────────

export interface OptionLeg {
  oi: number | null;
  oiChange: number | null;
  volume: number | null;
  ltp: number | null;
  /** Implied volatility in percent, as reported by the source. */
  iv: number | null;
  bid: number | null;
  ask: number | null;
  bidQty: number | null;
  askQty: number | null;
  prevClose: number | null;
}

export interface OptionStrike {
  strike: number;
  call: OptionLeg | null;
  put: OptionLeg | null;
}

export interface NormalizedOptionChain {
  underlying: string;
  expiry: string; // YYYY-MM-DD
  /** Spot price of the underlying at capture. */
  spot: number | null;
  /** Futures price for the same expiry, when the source provides it. */
  futuresPrice: number | null;
  strikes: OptionStrike[];
  timestamp: string; // ISO
  lotSize: number | null;
}

// ── other normalized shapes ─────────────────────────────────────────────────

export interface NormalizedIndex {
  symbol: string; // "NIFTY 50"
  ltp: number;
  prevClose: number | null;
  open: number | null;
  high: number | null;
  low: number | null;
  change: number | null;
  changePct: number | null;
  timestamp: string;
}

export interface NormalizedBreadth {
  scope: string;
  advances: number;
  declines: number;
  unchanged: number;
  totalScanned: number;
  new52wHigh: number | null;
  new52wLow: number | null;
  timestamp: string;
}

export interface NormalizedMover {
  symbol: string;
  tradingsymbol: string;
  ltp: number;
  change: number;
  changePct: number;
  volume: number | null;
  timestamp: string;
}

export interface NormalizedNewsItem {
  headline: string;
  summary: string | null;
  url: string;
  publisher: string;
  author: string | null;
  category: string | null;
  publishedAt: string; // ISO
  /** Tickers the *provider* asserts; we re-map independently as well. */
  providerSymbols: string[];
  /** Sentiment as supplied by the provider, if any. We never invent one. */
  providerSentiment: { label: string; score: number } | null;
}

export interface NormalizedFundamentals {
  symbol: string;
  marketCap: number | null;
  revenueTtm: number | null;
  revenueGrowthYoy: number | null;
  ebitdaTtm: number | null;
  ebitdaMargin: number | null;
  netProfitTtm: number | null;
  profitGrowthYoy: number | null;
  epsTtm: number | null;
  epsGrowthYoy: number | null;
  pe: number | null;
  pb: number | null;
  roe: number | null;
  roce: number | null;
  debtToEquity: number | null;
  freeCashFlow: number | null;
  operatingCashFlow: number | null;
  dividendYield: number | null;
  bookValue: number | null;
  faceValue: number | null;
  promoterHolding: number | null;
  fiiHolding: number | null;
  diiHolding: number | null;
  publicHolding: number | null;
  pledgedPct: number | null;
  fiscalPeriod: string | null;
  asOf: string;
  raw: Record<string, unknown>;
}

/** A holding as reported by a broker, normalized across providers. */
export interface NormalizedHolding {
  tradingsymbol: string;
  isin: string | null;
  exchange: Exchange | null;
  quantity: number;
  averagePrice: number;
  /** Quantity not yet settled into the demat account. */
  t1Quantity: number;
  pledgedQuantity: number;
  /** Exchanges the holding can actually be sold on. */
  tradableExchanges: string[];
}

export interface NormalizedPosition {
  tradingsymbol: string;
  exchange: Exchange | null;
  segment: string | null;
  quantity: number;
  averagePrice: number;
  product: string | null;
}

// ── orders ──────────────────────────────────────────────────────────────────

export type OrderProduct = 'INTRADAY' | 'CARRYFORWARD';
export type OrderStatus = 'PENDING' | 'OPEN' | 'COMPLETE' | 'REJECTED' | 'CANCELLED';

export interface OrderRequest {
  exchange: Exchange;
  tradingsymbol: string;
  providerToken: string;
  side: 'BUY' | 'SELL';
  quantity: number;
  orderType: 'MARKET' | 'LIMIT';
  /** Required for LIMIT; ignored for MARKET. */
  price?: number;
  product: OrderProduct;
  /** Free-text tag the broker echoes back, where supported. */
  tag?: string;
}

export interface NormalizedOrder {
  orderId: string;
  status: OrderStatus;
  tradingsymbol: string;
  side: 'BUY' | 'SELL';
  quantity: number;
  filledQuantity: number;
  /** Average fill price; null until something has filled. */
  averagePrice: number | null;
  /** The broker's own status text, e.g. a rejection reason. */
  message: string | null;
  updatedAt: string;
}

export interface NormalizedTick {
  providerToken: string;
  ltp: number;
  volume: number | null;
  oi: number | null;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number | null;
  prevClose: number | null;
  timestamp: string;
}

// ── provider metadata ───────────────────────────────────────────────────────

export interface ProviderManifest {
  id: ProviderId;
  displayName: string;
  /** Docs URL, shown in the Settings UI so users can get their own keys. */
  docsUrl: string;
  capabilities: readonly Capability[];
  /** Credential fields the Settings UI should render. */
  credentialFields: ReadonlyArray<{
    key: string;
    label: string;
    secret: boolean;
    required: boolean;
    help?: string;
  }>;
  /** Minimum gap between requests, per endpoint group, in ms. */
  throttleMs: Readonly<Record<string, number>>;
  /** How the access token is obtained/refreshed. Drives Settings copy. */
  authModel: 'static_token' | 'daily_oauth' | 'totp_session' | 'api_key' | 'none';
  /** Notes surfaced verbatim in the UI (licensing caveats, etc). */
  notes?: string;
  /** True for sources whose terms require explicit operator opt-in. */
  requiresOptIn?: boolean;
}

export interface ProviderCredentials {
  [key: string]: string | undefined;
}

export interface QuoteRequest {
  exchange: Exchange;
  tradingsymbol: string;
  providerToken?: string;
}

export interface CandleRequest {
  exchange: Exchange;
  tradingsymbol: string;
  providerToken?: string;
  timeframe: Timeframe;
  from: Date;
  to: Date;
}

export interface TickSubscription {
  tokens: string[];
  onTick: (tick: NormalizedTick) => void;
  onStatus: (status: { connected: boolean; reason?: string }) => void;
}

export interface TickStream {
  subscribe(tokens: string[]): Promise<void>;
  unsubscribe(tokens: string[]): Promise<void>;
  close(): Promise<void>;
  readonly connected: boolean;
}

/**
 * The provider interface. Every method is optional except `manifest`,
 * `isConfigured` and `healthCheck` — a provider implements only the
 * capabilities it declares, and the registry never calls the others.
 */
export interface MarketDataProvider {
  readonly manifest: ProviderManifest;

  /** True when credentials sufficient for operation are present. */
  isConfigured(): boolean;

  /** Cheap liveness probe. Must not throw; returns a structured result. */
  healthCheck(): Promise<{ ok: boolean; latencyMs: number; detail?: string }>;

  getQuote?(req: QuoteRequest): Promise<NormalizedQuote>;
  getQuotes?(reqs: QuoteRequest[]): Promise<NormalizedQuote[]>;
  getCandles?(req: CandleRequest): Promise<NormalizedCandle[]>;
  getInstruments?(): Promise<NormalizedInstrument[]>;
  getOptionExpiries?(underlying: string): Promise<string[]>;
  /**
   * `opts` lets providers that address the underlying by an internal id
   * (Dhan uses a security id plus a segment) receive what they need without
   * every caller knowing which provider it is talking to.
   */
  getOptionChain?(
    underlying: string,
    expiry: string,
    opts?: { segment?: 'IDX_I' | 'NSE_FNO'; underlyingName?: string },
  ): Promise<NormalizedOptionChain>;
  getIndices?(symbols?: string[]): Promise<NormalizedIndex[]>;
  getBreadth?(scope?: string): Promise<NormalizedBreadth>;
  getMovers?(kind: string): Promise<NormalizedMover[]>;
  getFundamentals?(symbol: string): Promise<NormalizedFundamentals>;
  getNews?(params: { symbols?: string[]; limit?: number }): Promise<NormalizedNewsItem[]>;
  getHoldings?(): Promise<NormalizedHolding[]>;
  getPositions?(): Promise<NormalizedPosition[]>;
  openTickStream?(sub: TickSubscription): Promise<TickStream>;

  /**
   * Order routing. Only providers that declare the `orders` capability
   * implement these, and nothing in the platform calls them except the live
   * trading module, which is off until the user arms it.
   */
  placeOrder?(req: OrderRequest): Promise<{ orderId: string }>;
  cancelOrder?(orderId: string): Promise<void>;
  /** The day's order book, newest state of each order. */
  getOrders?(): Promise<NormalizedOrder[]>;
}

export const hasCapability = (p: MarketDataProvider, c: Capability): boolean =>
  p.manifest.capabilities.includes(c);

/** Canonical "EXCHANGE:SYMBOL" key used across cache, WS and API. */
export const symbolKey = (exchange: string, tradingsymbol: string): string =>
  `${exchange.toUpperCase()}:${tradingsymbol.toUpperCase()}`;

export function parseSymbolKey(key: string): { exchange: Exchange; tradingsymbol: string } {
  const idx = key.indexOf(':');
  if (idx === -1) return { exchange: 'NSE', tradingsymbol: key.toUpperCase() };
  return {
    exchange: key.slice(0, idx).toUpperCase() as Exchange,
    tradingsymbol: key.slice(idx + 1).toUpperCase(),
  };
}
