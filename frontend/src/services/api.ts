/**
 * Typed API client.
 *
 * Handles the access/refresh token dance: a 401 triggers exactly one refresh
 * attempt, and every request queued during that refresh waits for it rather
 * than each firing its own. On refresh failure the auth store is cleared and
 * the router sends the user to sign-in.
 */
import type { Sourced, ApiEnvelope, ApiError } from '@/types/api';

const BASE = import.meta.env['VITE_API_BASE_URL'] ?? '';

let accessToken: string | null = null;
let onUnauthorized: (() => void) | null = null;
let refreshPromise: Promise<string | null> | null = null;

export function setAccessToken(token: string | null): void {
  accessToken = token;
}

export function getAccessToken(): string | null {
  return accessToken;
}

export function setUnauthorizedHandler(fn: () => void): void {
  onUnauthorized = fn;
}

export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
    readonly requestId?: string,
  ) {
    super(message);
    this.name = 'ApiRequestError';
  }
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined | null>;
  signal?: AbortSignal;
  /** Skip the refresh-and-retry dance (used by the refresh call itself). */
  noRetry?: boolean;
}

/**
 * Exchange the refresh cookie for a new access token.
 *
 * Exported so the auth store's session restore goes through the SAME
 * in-flight promise as a 401-triggered retry. Two independent refreshes would
 * race, and the second would present a token the first had already rotated.
 */
export async function refreshAccessToken(): Promise<string | null> {
  // Collapse concurrent refreshes onto one in-flight request.
  refreshPromise ??= (async () => {
    try {
      const res = await fetch(`${BASE}/api/auth/refresh`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
      });
      if (!res.ok) return null;
      const json = (await res.json()) as ApiEnvelope<{ accessToken: string }>;
      accessToken = json.data.accessToken;
      return accessToken;
    } catch {
      return null;
    } finally {
      // Clear on the next tick so callers awaiting this promise still see it.
      setTimeout(() => { refreshPromise = null; }, 0);
    }
  })();

  return refreshPromise;
}

export async function request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const url = new URL(`${BASE}/api${path}`, window.location.origin);
  for (const [k, v] of Object.entries(opts.query ?? {})) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  }

  const doFetch = async (): Promise<Response> =>
    fetch(url.toString(), {
      method: opts.method ?? 'GET',
      credentials: 'include',
      headers: {
        accept: 'application/json',
        ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      ...(opts.signal ? { signal: opts.signal } : {}),
    });

  let res = await doFetch();

  if (res.status === 401 && !opts.noRetry) {
    const fresh = await refreshAccessToken();
    if (fresh) {
      res = await doFetch();
    } else {
      onUnauthorized?.();
      throw new ApiRequestError(401, 'UNAUTHORIZED', 'Your session has expired. Please sign in again.');
    }
  }

  const text = await res.text();
  let parsed: unknown = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new ApiRequestError(res.status, 'BAD_RESPONSE', 'The server returned a malformed response.');
    }
  }

  if (!res.ok) {
    const err = (parsed as ApiError | null)?.error;
    throw new ApiRequestError(
      res.status,
      err?.code ?? 'UNKNOWN',
      err?.message ?? `Request failed with status ${res.status}`,
      err?.details,
      err?.requestId,
    );
  }

  return (parsed as ApiEnvelope<T>).data;
}

/** Same as `request`, but returns the full envelope including `meta`. */
export async function requestWithMeta<T>(
  path: string,
  opts: RequestOptions = {},
): Promise<ApiEnvelope<T>> {
  const url = new URL(`${BASE}/api${path}`, window.location.origin);
  for (const [k, v] of Object.entries(opts.query ?? {})) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  }

  const res = await fetch(url.toString(), {
    method: opts.method ?? 'GET',
    credentials: 'include',
    headers: {
      accept: 'application/json',
      ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });

  const json = (await res.json()) as ApiEnvelope<T> | ApiError;
  if (!res.ok) {
    const err = (json as ApiError).error;
    throw new ApiRequestError(res.status, err?.code ?? 'UNKNOWN', err?.message ?? 'Request failed');
  }
  return json as ApiEnvelope<T>;
}

// ── endpoint helpers ────────────────────────────────────────────────────────

export const api = {
  auth: {
    login: (email: string, password: string) =>
      request<{ user: AuthUserDto; accessToken: string; expiresIn: string }>('/auth/login', {
        method: 'POST', body: { email, password }, noRetry: true,
      }),
    register: (email: string, password: string, fullName?: string) =>
      request<{ user: AuthUserDto; accessToken: string; expiresIn: string }>('/auth/register', {
        method: 'POST', body: { email, password, fullName }, noRetry: true,
      }),
    me: () => request<AuthUserDto>('/auth/me'),
    logout: () => request<{ loggedOut: boolean }>('/auth/logout', { method: 'POST' }),
  },

  market: {
    status: () => request<MarketStatusDto>('/market/status'),
    indices: (symbols?: string[]) =>
      request<Array<{ symbol: string; data: Sourced<IndexDto> }>>('/market/indices', {
        query: symbols ? { symbols: symbols.join(',') } : {},
      }),
    breadth: (scope = 'NIFTY50') => request<Sourced<BreadthDto>>('/market/breadth', { query: { scope } }),
    sectors: (scope = 'NIFTY50') => request<Sourced<SectorDto[]>>('/market/sectors', { query: { scope } }),
    movers: (type: string, scope = 'NIFTY50', limit = 10) =>
      request<Sourced<MoverDto[]>>('/market/movers', { query: { type, scope, limit } }),
    regime: () => request<Sourced<RegimeDto>>('/market/regime'),
    quote: (symbol: string) =>
      request<{ instrument: InstrumentDto; quote: Sourced<QuoteDto> }>(
        `/market/quote/${encodeURIComponent(symbol)}`,
      ),
    history: (symbol: string, tf: string, bars = 300) =>
      requestWithMeta<{ symbol: string; timeframe: string; candles: CandleDto[]; count: number }>(
        `/market/history/${encodeURIComponent(symbol)}`, { query: { tf, bars } },
      ),
    search: (q: string, limit = 15) =>
      request<InstrumentDto[]>('/market/search', { query: { q, limit } }),
  },

  stocks: {
    analysis: (symbol: string, tf: string) =>
      requestWithMeta<StockAnalysisDto>(`/stocks/${encodeURIComponent(symbol)}/analysis`, {
        query: { tf },
      }),
    fundamentals: (symbol: string) =>
      request<{ instrument: InstrumentDto; fundamentals: Sourced<FundamentalsDto> }>(
        `/stocks/${encodeURIComponent(symbol)}/fundamentals`,
      ),
    news: (symbol: string) =>
      request<{ instrument: InstrumentDto; news: Sourced<NewsDto[]> }>(
        `/stocks/${encodeURIComponent(symbol)}/news`,
      ),
    peers: (symbol: string) => request<PeersDto>(`/stocks/${encodeURIComponent(symbol)}/peers`),
  },

  marketChart: {
    /** Candles and indicator series in one response, aligned index-for-index. */
    get: (symbol: string, o: { tf: string; overlays?: string[]; panes?: string[]; bars?: number }) =>
      requestWithMeta<ChartDto>(`/market/chart/${encodeURIComponent(symbol)}`, {
        query: {
          tf: o.tf,
          ...(o.bars ? { bars: String(o.bars) } : {}),
          ...(o.overlays?.length ? { overlays: o.overlays.join(',') } : {}),
          ...(o.panes?.length ? { panes: o.panes.join(',') } : {}),
        },
      }),
  },

  options: {
    expiries: (symbol: string) => request<Sourced<string[]>>(`/options/${symbol}/expiries`),
    chain: (symbol: string, expiry?: string) =>
      requestWithMeta<Sourced<OptionChainDto>>(`/options/${symbol}/chain`, {
        query: expiry ? { expiry } : {},
      }),
    analytics: (symbol: string, expiry?: string) =>
      requestWithMeta<Sourced<OptionAnalyticsDto>>(`/options/${symbol}/analytics`, {
        query: expiry ? { expiry } : {},
      }),
    futures: (symbol: string) => request<Sourced<FuturesDto[]>>(`/options/${symbol}/futures`),
    /**
     * Capital and risk are required by the server — it will not assume an
     * amount, so the caller must always supply what the user typed.
     */
    setup: (
      symbol: string,
      params: { capital: number; riskPercent: number; expiry?: string; timeframe?: string },
    ) =>
      requestWithMeta<Sourced<OptionSetupDto>>(`/options/${symbol}/setup`, {
        query: {
          capital: String(params.capital),
          riskPercent: String(params.riskPercent),
          ...(params.expiry ? { expiry: params.expiry } : {}),
          ...(params.timeframe ? { timeframe: params.timeframe } : {}),
        },
      }),
  },

  paper: {
    config: () => request<PaperConfigDto | null>('/paper/config'),
    saveConfig: (body: Partial<PaperConfigInput>) =>
      request<PaperConfigDto>('/paper/config', { method: 'PUT', body }),
    performance: () => request<PaperPerformanceDto>('/paper/performance'),
    trades: (params: { status?: 'OPEN' | 'CLOSED'; limit?: number } = {}) =>
      request<PaperTradeDto[]>('/paper/trades', {
        query: {
          ...(params.status ? { status: params.status } : {}),
          ...(params.limit ? { limit: String(params.limit) } : {}),
        },
      }),
    sweep: () => request<{ entries: PaperSweepDto; exits: { checked: number; closed: number } }>(
      '/paper/sweep', { method: 'POST' },
    ),
    close: (id: string) =>
      request<{ closed: boolean }>(`/paper/trades/${id}/close`, { method: 'POST' }),
    advice: () => request<PositionAdviceDto[]>('/paper/advice'),
    status: () => request<PaperStatusDto>('/paper/status'),
    take: (underlying: string) =>
      request<{ opened: boolean; underlying: string }>('/paper/take', {
        method: 'POST', body: { underlying },
      }),
  },

  fno: {
    /**
     * The graded decision checklist. Capital and risk are required — the
     * server sizes nothing without them and assumes no account size.
     */
    decision: (
      symbol: string,
      params: {
        capital: number; riskPercent: number; expiry?: string;
        biasTimeframe?: '1h' | '1d'; entryTimeframe?: '5m' | '15m' | '1h'; record?: boolean;
      },
    ) =>
      requestWithMeta<Sourced<FnoDecisionDto>>(`/fno/${symbol}/decision`, {
        query: {
          capital: String(params.capital),
          riskPercent: String(params.riskPercent),
          ...(params.expiry ? { expiry: params.expiry } : {}),
          ...(params.biasTimeframe ? { biasTimeframe: params.biasTimeframe } : {}),
          ...(params.entryTimeframe ? { entryTimeframe: params.entryTimeframe } : {}),
          ...(params.record === false ? { record: 'false' } : {}),
        },
      }),
    signals: (params: { status?: 'ACTIVE' | 'RESOLVED'; underlying?: string; limit?: number } = {}) =>
      request<FnoSignalDto[]>('/fno/signals', {
        query: {
          ...(params.status ? { status: params.status } : {}),
          ...(params.underlying ? { underlying: params.underlying } : {}),
          ...(params.limit ? { limit: String(params.limit) } : {}),
        },
      }),
    performance: (sinceDays = 90) =>
      request<SignalPerformanceDto>('/fno/signals/performance', { query: { sinceDays } }),
  },

  live: {
    status: () => request<LiveStatusDto>('/live/status'),
    config: () => request<LiveConfigDto | null>('/live/config'),
    saveConfig: (body: Partial<LiveConfigInput>) =>
      request<LiveConfigDto>('/live/config', { method: 'PUT', body }),
    arm: (capital: number) => request<LiveConfigDto>('/live/arm', { method: 'POST', body: { capital } }),
    disarm: () => request<{ disarmed: boolean }>('/live/disarm', { method: 'POST' }),
    kill: () => request<{ cancelled: number; exits: number }>('/live/kill', { method: 'POST' }),
    resetKill: () => request<{ reset: boolean }>('/live/kill/reset', { method: 'POST' }),
    execute: (underlying: string) =>
      request<{ placed: boolean; reason: string; tradeId: number | null; orderId: string | null }>(
        '/live/execute', { method: 'POST', body: { underlying } },
      ),
    trades: (params: { status?: 'ACTIVE' | 'CLOSED'; limit?: number } = {}) =>
      request<LiveTradeDto[]>('/live/trades', {
        query: {
          ...(params.status ? { status: params.status } : {}),
          ...(params.limit ? { limit: String(params.limit) } : {}),
        },
      }),
    close: (id: string) => request<{ ok: boolean; reason: string }>(`/live/trades/${id}/close`, { method: 'POST' }),
    sync: () => request<{ synced: boolean }>('/live/sync', { method: 'POST' }),
    performance: () => request<LivePerformanceDto>('/live/performance'),
  },

  notifications: {
    list: (params: { limit?: number; unread?: boolean } = {}) =>
      request<{ items: NotificationDto[]; unreadCount: number }>('/notifications', {
        query: {
          ...(params.limit ? { limit: String(params.limit) } : {}),
          ...(params.unread ? { unread: 'true' } : {}),
        },
      }),
    markRead: (ids: number[]) =>
      request<{ updated: number }>('/notifications/read', { method: 'POST', body: { ids } }),
    markAllRead: () =>
      request<{ updated: number }>('/notifications/read', { method: 'POST', body: { all: true } }),
    test: () =>
      request<{ sent: boolean; sessions: number }>('/notifications/test', { method: 'POST' }),
  },

  scanner: {
    swing: (params: Record<string, string | number>) =>
      request<Sourced<ScanResultDto>>('/scanner/swing', { query: params }),
    ideas: () => request<unknown[]>('/scanner/ideas'),
  },

  portfolio: {
    list: () => request<PortfolioDto[]>('/portfolio'),
    summary: () => request<Sourced<{ portfolio: PortfolioDto; health: HealthDto }>>('/portfolio/summary'),
    detail: (id: string) =>
      request<{ portfolio: PortfolioDto; holdings: HoldingDto[] }>(`/portfolio/${id}`),
    analysis: (id: string) => request<Sourced<PortfolioAnalysisDto>>(`/portfolio/${id}/analysis`),
    addHolding: (id: string, body: { symbol: string; quantity: number; avgPrice: number; notes?: string }) =>
      request<{ id: string; symbol: string }>(`/portfolio/${id}/holding`, { method: 'POST', body }),
    deleteHolding: (id: string, holdingId: string) =>
      request<{ deleted: boolean }>(`/portfolio/${id}/holding/${holdingId}`, { method: 'DELETE' }),
    addTransaction: (id: string, body: Record<string, unknown>) =>
      request<{ id: string }>(`/portfolio/${id}/transaction`, { method: 'POST', body }),
    transactions: (id: string) => request<unknown[]>(`/portfolio/${id}/transactions`),
    /** Brokers that are configured AND can actually supply holdings. */
    importSources: () => request<ImportSourceDto[]>('/portfolio/import/sources'),
    importFrom: (id: string, provider: string, removeMissing = false) =>
      request<ImportResultDto>(`/portfolio/${id}/import/${provider}`, {
        method: 'POST', body: { removeMissing },
      }),
  },

  watchlists: {
    list: () => request<WatchlistDto[]>('/watchlists'),
    create: (name: string) => request<{ id: string }>('/watchlists', { method: 'POST', body: { name } }),
    remove: (id: string) => request<{ deleted: boolean }>(`/watchlists/${id}`, { method: 'DELETE' }),
    addItem: (id: string, symbol: string) =>
      request<{ id: string; symbol: string }>(`/watchlists/${id}/items`, {
        method: 'POST', body: { symbol },
      }),
    removeItem: (id: string, itemId: string) =>
      request<{ deleted: boolean }>(`/watchlists/${id}/items/${itemId}`, { method: 'DELETE' }),
    live: (id: string, tf = '1d', technicals = true) =>
      request<WatchlistRowDto[]>(`/watchlists/${id}/live`, { query: { tf, technicals } }),
  },

  news: {
    list: (params: Record<string, string | number> = {}) =>
      request<Sourced<NewsDto[]>>('/news', { query: params }),
    impact: (id: string) => request<NewsImpactDto>(`/news/${id}/impact`),
  },

  risk: {
    positionSize: (body: Record<string, number>) =>
      request<PositionSizeDto>('/risk/position-size', { method: 'POST', body }),
  },

  ai: {
    status: () => request<{ enabled: boolean; model: string | null; reason: string | null; note: string }>('/ai/status'),
    analyze: (question: string, timeframe?: string) =>
      request<AnalystResponseDto>('/ai/analyze', {
        method: 'POST', body: { question, timeframe },
      }),
  },

  alerts: {
    list: () => request<AlertDto[]>('/alerts'),
    kinds: () => request<AlertKindDto[]>('/alerts/kinds'),
    create: (body: Record<string, unknown>) =>
      request<{ id: string }>('/alerts', { method: 'POST', body }),
    remove: (id: string) => request<{ deleted: boolean }>(`/alerts/${id}`, { method: 'DELETE' }),
    update: (id: string, body: Record<string, unknown>) =>
      request<{ updated: boolean }>(`/alerts/${id}`, { method: 'PATCH', body }),
  },

  backtest: {
    strategies: () => requestWithMeta<StrategyDto[]>('/backtest/strategies'),
    run: (body: Record<string, unknown>) =>
      request<BacktestRunDto>('/backtest/run', { method: 'POST', body }),
    list: () => request<unknown[]>('/backtest'),
  },

  settings: {
    get: () => request<SettingsDto>('/settings'),
    patch: (body: Record<string, unknown>) =>
      request<{ updated: boolean }>('/settings', { method: 'PATCH', body }),
    providerCatalogue: () => request<ProviderCatalogueDto[]>('/settings/providers/catalogue'),
    providers: () => requestWithMeta<ConfiguredProviderDto[]>('/settings/providers'),
    saveProvider: (body: Record<string, unknown>) =>
      request<{ id: string; saved: boolean }>('/settings/providers', { method: 'POST', body }),
    testProvider: (provider: string) =>
      request<{ ok: boolean; latencyMs: number; detail: string | null }>(
        `/settings/providers/${provider}/test`, { method: 'POST' },
      ),
    deleteProvider: (provider: string) =>
      request<{ deleted: boolean }>(`/settings/providers/${provider}`, { method: 'DELETE' }),
    dataQuality: () => request<DataQualityEventDto[]>('/settings/data-quality'),
  },
};

// Re-export DTO types so components import them from one place.
export type * from '@/types/api';
import type {
  AuthUserDto, MarketStatusDto, IndexDto, BreadthDto, SectorDto, MoverDto, RegimeDto,
  QuoteDto, InstrumentDto, CandleDto, StockAnalysisDto, FundamentalsDto, NewsDto,
  PeersDto, OptionChainDto, OptionAnalyticsDto, OptionSetupDto, FuturesDto, ScanResultDto, PortfolioDto,
  PaperConfigDto, PaperConfigInput, PaperPerformanceDto, PaperTradeDto, PaperSweepDto,
  ChartDto,
  ImportSourceDto, ImportResultDto,
  PositionAdviceDto, PaperStatusDto,
  HealthDto, HoldingDto, PortfolioAnalysisDto, WatchlistDto, WatchlistRowDto,
  NewsImpactDto, PositionSizeDto, AnalystResponseDto, AlertDto, AlertKindDto,
  StrategyDto, BacktestRunDto, SettingsDto, ProviderCatalogueDto, ConfiguredProviderDto,
  DataQualityEventDto,
  FnoDecisionDto, FnoSignalDto, SignalPerformanceDto, NotificationDto,
  LiveStatusDto, LiveConfigDto, LiveConfigInput, LiveTradeDto, LivePerformanceDto,
} from '@/types/api';
