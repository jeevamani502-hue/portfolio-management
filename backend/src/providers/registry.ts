/**
 * Provider registry: capability routing, ordered failover, health tracking and
 * a circuit breaker.
 *
 * The contract that matters: `run()` either returns real data from some
 * provider, or it throws. There is no code path that invents a value when every
 * provider fails — the caller converts the throw into an explicit
 * `Live market data unavailable` state.
 */
import { logger } from '../utils/logger.js';
import { capabilityUnsupported, ProviderError } from '../utils/errors.js';
import { query } from '../db/pool.js';
import { env } from '../config/env.js';
import { decryptJson } from '../utils/crypto.js';
import type {
  Capability,
  MarketDataProvider,
  ProviderCredentials,
  ProviderId,
} from './types.js';
import { hasCapability } from './types.js';
import { DhanProvider } from './dhan/index.js';
import { KiteProvider } from './kite/index.js';
import { AngelOneProvider } from './angelone/index.js';
import { NsePublicProvider } from './nsepublic/index.js';
import { GrowwProvider } from './groww/index.js';

export interface AttemptFailure {
  provider: string;
  error: string;
}

export class NoProviderError extends Error {
  readonly capability: Capability;
  readonly attempts: AttemptFailure[];

  constructor(capability: Capability, attempts: AttemptFailure[]) {
    super(
      attempts.length
        ? `All providers failed for "${capability}": ${attempts
            .map((a) => `${a.provider} (${a.error})`)
            .join('; ')}`
        : `No configured provider supports "${capability}"`,
    );
    this.name = 'NoProviderError';
    this.capability = capability;
    this.attempts = attempts;
  }
}

interface BreakerState {
  failures: number;
  openedAt: number | null;
}

const BREAKER_THRESHOLD = 4;
const BREAKER_COOLDOWN_MS = 60_000;

export interface ProviderHealth {
  id: ProviderId;
  configured: boolean;
  status: 'healthy' | 'degraded' | 'down' | 'unknown';
  lastOkAt: string | null;
  lastError: string | null;
  breakerOpen: boolean;
  capabilities: readonly Capability[];
}

export class ProviderRegistry {
  private providers = new Map<ProviderId, MarketDataProvider>();
  /** Explicit priority order; lower is tried first. */
  private priority = new Map<ProviderId, number>();
  private breakers = new Map<ProviderId, BreakerState>();
  private lastOk = new Map<ProviderId, number>();
  private lastError = new Map<ProviderId, string>();

  private log = logger.child({ component: 'ProviderRegistry' });

  register(provider: MarketDataProvider, priority: number): void {
    this.providers.set(provider.manifest.id, provider);
    this.priority.set(provider.manifest.id, priority);
  }

  get(id: ProviderId): MarketDataProvider | undefined {
    return this.providers.get(id);
  }

  all(): MarketDataProvider[] {
    return [...this.providers.values()];
  }

  /** Providers that can serve a capability, ordered, breaker-open ones last. */
  candidates(capability: Capability): MarketDataProvider[] {
    return this.all()
      .filter((p) => hasCapability(p, capability) && p.isConfigured())
      .sort((a, b) => {
        const aOpen = this.breakerOpen(a.manifest.id) ? 1 : 0;
        const bOpen = this.breakerOpen(b.manifest.id) ? 1 : 0;
        if (aOpen !== bOpen) return aOpen - bOpen;
        // Opt-in/unlicensed sources always sort behind licensed ones.
        const aOptIn = a.manifest.requiresOptIn ? 1 : 0;
        const bOptIn = b.manifest.requiresOptIn ? 1 : 0;
        if (aOptIn !== bOptIn) return aOptIn - bOptIn;
        return (this.priority.get(a.manifest.id) ?? 999) - (this.priority.get(b.manifest.id) ?? 999);
      });
  }

  private breakerOpen(id: ProviderId): boolean {
    const b = this.breakers.get(id);
    if (!b?.openedAt) return false;
    if (Date.now() - b.openedAt > BREAKER_COOLDOWN_MS) {
      // Half-open: allow one trial request through.
      b.openedAt = null;
      b.failures = BREAKER_THRESHOLD - 1;
      return false;
    }
    return true;
  }

  private recordSuccess(id: ProviderId): void {
    this.breakers.set(id, { failures: 0, openedAt: null });
    this.lastOk.set(id, Date.now());
    this.lastError.delete(id);
  }

  private recordFailure(id: ProviderId, message: string): void {
    const b = this.breakers.get(id) ?? { failures: 0, openedAt: null };
    b.failures += 1;
    if (b.failures >= BREAKER_THRESHOLD) {
      b.openedAt = Date.now();
      this.log.warn({ provider: id, failures: b.failures }, 'Circuit breaker opened');
    }
    this.breakers.set(id, b);
    this.lastError.set(id, message);
  }

  /**
   * Execute `fn` against each capable provider in order until one succeeds.
   *
   * A non-retryable failure (bad credentials, unsupported symbol) still moves
   * on to the next provider — the point of failover is that one misconfigured
   * broker should not take the platform down.
   */
  async run<T>(
    capability: Capability,
    fn: (provider: MarketDataProvider) => Promise<T>,
  ): Promise<{ value: T; provider: ProviderId; attempts: AttemptFailure[] }> {
    const list = this.candidates(capability);
    const attempts: AttemptFailure[] = [];

    if (list.length === 0) {
      const configuredAny = this.all().some((p) => p.isConfigured());
      this.log.warn(
        { capability, configuredAny },
        'No configured provider supports this capability',
      );
      throw new NoProviderError(capability, attempts);
    }

    for (const provider of list) {
      const id = provider.manifest.id;
      try {
        const value = await fn(provider);
        this.recordSuccess(id);
        return { value, provider: id, attempts };
      } catch (err) {
        const message =
          err instanceof Error ? err.message.slice(0, 300) : 'unknown provider error';
        attempts.push({ provider: id, error: message });
        this.recordFailure(id, message);
        this.log.warn({ provider: id, capability, err: message }, 'Provider call failed, failing over');
        await recordDataQualityEvent({
          kind: 'provider_error',
          provider: id,
          capability,
          detail: { message },
        }).catch(() => undefined);
      }
    }

    throw new NoProviderError(capability, attempts);
  }

  /** Same as `run`, but returns null instead of throwing. */
  async tryRun<T>(
    capability: Capability,
    fn: (provider: MarketDataProvider) => Promise<T>,
  ): Promise<{ value: T; provider: ProviderId } | null> {
    try {
      const res = await this.run(capability, fn);
      return { value: res.value, provider: res.provider };
    } catch {
      return null;
    }
  }

  async health(): Promise<ProviderHealth[]> {
    const out: ProviderHealth[] = [];
    for (const p of this.all()) {
      const id = p.manifest.id;
      const configured = p.isConfigured();
      let status: ProviderHealth['status'] = 'unknown';
      if (!configured) status = 'down';
      else if (this.breakerOpen(id)) status = 'down';
      else if ((this.breakers.get(id)?.failures ?? 0) > 0) status = 'degraded';
      else if (this.lastOk.has(id)) status = 'healthy';

      out.push({
        id,
        configured,
        status,
        lastOkAt: this.lastOk.has(id) ? new Date(this.lastOk.get(id)!).toISOString() : null,
        lastError: this.lastError.get(id) ?? null,
        breakerOpen: this.breakerOpen(id),
        capabilities: p.manifest.capabilities,
      });
    }
    return out;
  }

  /** Active probe of every configured provider; used by /health and Settings. */
  async probeAll(): Promise<Array<ProviderHealth & { latencyMs: number; detail?: string }>> {
    const results = await Promise.all(
      this.all().map(async (p) => {
        const probe = await p.healthCheck();
        if (probe.ok) this.recordSuccess(p.manifest.id);
        else if (p.isConfigured()) this.recordFailure(p.manifest.id, probe.detail ?? 'probe failed');
        return { id: p.manifest.id, probe };
      }),
    );
    const health = await this.health();
    return health.map((h) => {
      const r = results.find((x) => x.id === h.id);
      return { ...h, latencyMs: r?.probe.latencyMs ?? 0, detail: r?.probe.detail };
    });
  }
}

// ── construction ────────────────────────────────────────────────────────────

type ProviderFactory = (creds: ProviderCredentials) => MarketDataProvider;

const FACTORIES: Partial<Record<ProviderId, ProviderFactory>> = {
  groww: (c) => new GrowwProvider(c),
  dhan: (c) => new DhanProvider(c),
  kite: (c) => new KiteProvider(c),
  angelone: (c) => new AngelOneProvider(c),
  nsepublic: () => new NsePublicProvider(),
};

/**
 * Credentials for one provider: whatever the user saved, else the environment.
 *
 * Deliberately NOT a merge. If a user saves an API key and secret in Settings
 * while a stale access token still sits in the environment, merging would
 * hand the provider all three and the token would quietly win — the user
 * changes the key in the UI and nothing appears to happen. Replacing outright
 * makes the UI the single source of truth the moment it is used.
 */
function credentialsFor(
  id: ProviderId,
  overrides?: Partial<Record<ProviderId, ProviderCredentials>>,
): ProviderCredentials {
  const stored = overrides?.[id];
  const hasStored =
    stored !== undefined && Object.values(stored).some((v) => typeof v === 'string' && v.trim());
  return hasStored ? stored : envCredentials(id);
}

/**
 * Credentials from environment variables.
 *
 * These are a FALLBACK only, for headless deployments and background workers
 * that have no user context. When a user has saved credentials for a provider
 * in Settings, those replace these outright — see `credentialsFor`.
 */
function envCredentials(id: ProviderId): ProviderCredentials {
  switch (id) {
    case 'groww':
      return {
        apiKey: env.GROWW_API_KEY,
        apiSecret: env.GROWW_API_SECRET,
        accessToken: env.GROWW_ACCESS_TOKEN,
      };
    case 'dhan':
      return { clientId: env.DHAN_CLIENT_ID, accessToken: env.DHAN_ACCESS_TOKEN };
    case 'kite':
      return {
        apiKey: env.KITE_API_KEY,
        apiSecret: env.KITE_API_SECRET,
        accessToken: env.KITE_ACCESS_TOKEN,
      };
    case 'angelone':
      return {
        apiKey: env.ANGELONE_API_KEY,
        clientCode: env.ANGELONE_CLIENT_CODE,
        mpin: env.ANGELONE_MPIN,
        totpSecret: env.ANGELONE_TOTP_SECRET,
      };
    default:
      return {};
  }
}

/**
 * Build the registry from env defaults.
 *
 * Per-user credentials (stored encrypted in `api_providers`) are layered on top
 * by `registryForUser`, which is what request handlers use. The env-level
 * registry exists for background workers, which have no user context.
 */
export function buildRegistry(overrides?: Partial<Record<ProviderId, ProviderCredentials>>): ProviderRegistry {
  const registry = new ProviderRegistry();
  const order: ProviderId[] = [
    env.PRIMARY_PROVIDER,
    ...(env.FAILOVER_PROVIDERS as ProviderId[]),
  ];

  let priority = 0;
  const seen = new Set<ProviderId>();

  for (const id of order) {
    const factory = FACTORIES[id];
    if (!factory || seen.has(id)) continue;
    registry.register(factory(credentialsFor(id, overrides)), priority);
    seen.add(id);
    priority += 10;
  }

  // Register every remaining known provider at lower priority so a configured
  // but unlisted provider is still usable as a last resort.
  for (const [id, factory] of Object.entries(FACTORIES) as Array<[ProviderId, ProviderFactory]>) {
    if (seen.has(id)) continue;
    registry.register(factory(credentialsFor(id, overrides)), priority + 100);
    seen.add(id);
  }

  return registry;
}

let defaultRegistry: ProviderRegistry | null = null;
export const getRegistry = (): ProviderRegistry => (defaultRegistry ??= buildRegistry());

/** Force a rebuild after credentials change. */
export const resetRegistry = (): void => {
  defaultRegistry = null;
};

// ── per-user registry ───────────────────────────────────────────────────────

const userRegistryCache = new Map<string, { at: number; registry: ProviderRegistry }>();
const USER_REGISTRY_TTL_MS = 60_000;

/**
 * A registry using this user's own broker credentials.
 *
 * This is what keeps the platform on the right side of data-redistribution
 * rules by default: each user's dashboard is powered by their own licensed
 * broker session, not a shared feed.
 */
export async function registryForUser(userId: string): Promise<ProviderRegistry> {
  const hit = userRegistryCache.get(userId);
  if (hit && Date.now() - hit.at < USER_REGISTRY_TTL_MS) return hit.registry;

  const { rows } = await query<{ provider: ProviderId; credentials_enc: string | null; priority: number; is_enabled: boolean }>(
    `SELECT provider, credentials_enc, priority, is_enabled
       FROM api_providers
      WHERE user_id = $1 AND is_enabled = TRUE
      ORDER BY priority ASC`,
    [userId],
  );

  const overrides: Partial<Record<ProviderId, ProviderCredentials>> = {};
  for (const row of rows) {
    if (!row.credentials_enc) continue;
    try {
      overrides[row.provider] = decryptJson<ProviderCredentials>(row.credentials_enc);
    } catch (err) {
      logger.error(
        { userId, provider: row.provider, err },
        'Failed to decrypt stored provider credentials — re-enter them in Settings',
      );
    }
  }

  const registry = buildRegistry(overrides);
  userRegistryCache.set(userId, { at: Date.now(), registry });
  return registry;
}

export const invalidateUserRegistry = (userId: string): void => {
  userRegistryCache.delete(userId);
};

// ── data-quality ledger ─────────────────────────────────────────────────────

export interface DataQualityEvent {
  kind:
    | 'stale_read'
    | 'provider_error'
    | 'sanity_reject'
    | 'missing_capability'
    | 'rate_limited'
    | 'fallback_used';
  provider?: string;
  capability?: string;
  symbol?: string;
  detail?: Record<string, unknown>;
}

export async function recordDataQualityEvent(e: DataQualityEvent): Promise<void> {
  try {
    await query(
      `INSERT INTO data_quality_events (kind, provider, capability, symbol, detail)
       VALUES ($1, $2, $3, $4, $5)`,
      [e.kind, e.provider ?? null, e.capability ?? null, e.symbol ?? null, JSON.stringify(e.detail ?? {})],
    );
  } catch {
    // The ledger must never break a request path.
  }
}

/** Turn a registry failure into the attempt list used by `unavailable()`. */
export function attemptsFrom(err: unknown): AttemptFailure[] | undefined {
  if (err instanceof NoProviderError) return err.attempts;
  if (err instanceof ProviderError) return [{ provider: err.provider, error: err.message }];
  return undefined;
}

export { capabilityUnsupported };
