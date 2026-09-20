/** Centralised Redis key namespace. One place to audit TTLs and collisions. */

export const K = {
  /** Latest normalized quote for an instrument. */
  quote: (instrumentId: number | string) => `q:${instrumentId}`,
  /** Pub/sub channel carrying ticks for one instrument. */
  tickChannel: (instrumentId: number | string) => `ticks:${instrumentId}`,
  /** Pattern the WS gateway subscribes to. */
  tickChannelPattern: 'ticks:*',
  /** Broadcast channels. */
  breadthChannel: 'bcast:breadth',
  signalChannel: 'bcast:signals',
  alertChannel: (userId: string) => `bcast:alerts:${userId}`,

  /** Index snapshot set (NIFTY/BANKNIFTY/etc). */
  indices: 'market:indices',
  breadth: 'market:breadth',
  sectors: 'market:sectors',
  movers: (kind: string) => `market:movers:${kind}`,
  regime: 'market:regime',
  marketStatus: 'market:status',

  /** Computed indicator payload. */
  indicators: (instrumentId: number, tf: string) => `ind:${instrumentId}:${tf}`,
  analysis: (instrumentId: number, tf: string) => `an:${instrumentId}:${tf}`,
  candles: (instrumentId: number, tf: string) => `cd:${instrumentId}:${tf}`,

  optionChain: (underlying: string, expiry: string) => `oc:${underlying}:${expiry}`,
  optionExpiries: (underlying: string) => `oe:${underlying}`,

  fundamentals: (instrumentId: number) => `fu:${instrumentId}`,
  news: (scope: string) => `news:${scope}`,

  /** Symbol → instrument row resolution. */
  symbolLookup: (symbol: string) => `sym:${symbol.toUpperCase()}`,

  /** Provider health + circuit breaker state. */
  providerHealth: (provider: string) => `ph:${provider}`,
  providerThrottle: (provider: string, endpoint: string) => `pt:${provider}:${endpoint}`,

  /** Token-bucket rate limiting. */
  rateLimit: (bucket: string, id: string) => `rl:${bucket}:${id}`,

  /** Leader election for the single realtime ingest worker. */
  realtimeLeader: 'lock:realtime-leader',
  lock: (name: string) => `lock:${name}`,

  /** Instruments with at least one active alert (evaluator hot set). */
  alertWatchSet: 'alerts:watched',
} as const;

/** Default TTLs in seconds. Kept together so freshness policy is reviewable. */
export const TTL = {
  quote: 300,
  indices: 10,
  breadth: 60,
  sectors: 60,
  movers: 60,
  regime: 300,
  indicators: 300,
  analysis: 60,
  candlesIntraday: 60,
  candlesDaily: 3600,
  optionChain: 60,
  optionExpiries: 3600,
  fundamentals: 6 * 3600,
  news: 300,
  symbolLookup: 3600,
  marketStatus: 30,
} as const;
