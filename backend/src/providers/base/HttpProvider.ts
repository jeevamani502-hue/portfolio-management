/**
 * Shared HTTP plumbing for providers: timeout, retry with jitter, per-endpoint
 * throttling, and error normalization.
 *
 * Throttling is process-local by default and Redis-backed when a key prefix is
 * given, so several API pods cannot collectively exceed a broker's rate limit.
 */
import { request } from 'undici';
import { ProviderError } from '../../utils/errors.js';
import { logger } from '../../utils/logger.js';
import { redis } from '../../cache/redis.js';
import { K } from '../../cache/keys.js';
import type { ProviderId } from '../types.js';

export interface HttpOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  headers?: Record<string, string>;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  /** Pre-encoded body (e.g. form-urlencoded); sent verbatim, not JSON-wrapped. */
  rawBody?: string;
  /** Endpoint group for throttling, e.g. 'optionChain'. */
  throttleGroup?: string;
  timeoutMs?: number;
  retries?: number;
  /** Treat these HTTP statuses as non-retryable even if >= 500. */
  noRetryStatuses?: number[];
  /** Expect a non-JSON body (CSV, plain text). */
  raw?: boolean;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Merge header maps case-insensitively, with later sources winning.
 *
 * HTTP header names are case-insensitive, but JavaScript object keys are not.
 * A plain spread of `{'content-type': ...}` and `{'Content-Type': ...}` keeps
 * BOTH, and the client then puts the header on the wire twice. Some servers
 * tolerate that; Groww's rejects the request with `415 Unsupported Media
 * Type`, which is a genuinely baffling error to debug from the caller's side.
 *
 * Normalising to lower case here means a provider can write `Content-Type` or
 * `Authorization` in whatever casing reads best and still cleanly override the
 * defaults.
 */
export function mergeHeaders(
  ...sources: Array<Record<string, string> | undefined>
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const source of sources) {
    if (!source) continue;
    for (const [key, value] of Object.entries(source)) {
      if (value === undefined || value === null) continue;
      out[key.toLowerCase()] = value;
    }
  }
  return out;
}

export abstract class HttpProvider {
  protected abstract readonly providerId: ProviderId;
  protected abstract readonly baseUrl: string;
  /** Minimum ms between calls, per throttle group. */
  protected throttle: Record<string, number> = {};
  /** Use Redis for cross-process throttling. Off for free/unlimited sources. */
  protected distributedThrottle = true;

  private lastCallAt = new Map<string, number>();

  protected log = logger.child({ provider: this.constructor.name });

  // ── throttling ────────────────────────────────────────────────────────────

  private async waitForSlot(group: string): Promise<void> {
    const minGap = this.throttle[group] ?? this.throttle['default'] ?? 0;
    if (minGap <= 0) return;

    if (this.distributedThrottle) {
      // Redis-backed: SET NX with a PX equal to the gap acts as a leaky bucket.
      const key = K.providerThrottle(this.providerId, group);
      for (let attempt = 0; attempt < 50; attempt += 1) {
        const ok = await redis.set(key, '1', 'PX', minGap, 'NX');
        if (ok === 'OK') return;
        const ttl = await redis.pttl(key);
        await sleep(Math.max(10, Math.min(ttl, minGap)));
      }
      this.log.warn({ group }, 'Throttle wait exceeded 50 attempts; proceeding');
      return;
    }

    const last = this.lastCallAt.get(group) ?? 0;
    const wait = last + minGap - Date.now();
    if (wait > 0) await sleep(wait);
    this.lastCallAt.set(group, Date.now());
  }

  // ── request ───────────────────────────────────────────────────────────────

  protected async http<T>(path: string, opts: HttpOptions = {}): Promise<T> {
    const group = opts.throttleGroup ?? 'default';
    await this.waitForSlot(group);

    const url = new URL(path.startsWith('http') ? path : `${this.baseUrl}${path}`);
    for (const [k, v] of Object.entries(opts.query ?? {})) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }

    const retries = opts.retries ?? 2;
    const timeoutMs = opts.timeoutMs ?? 12_000;
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= retries; attempt += 1) {
      const started = Date.now();
      try {
        const res = await request(url, {
          method: opts.method ?? 'GET',
          headers: mergeHeaders(
            {
              accept: opts.raw ? '*/*' : 'application/json',
              ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}),
            },
            opts.headers,
          ),
          body:
            opts.rawBody !== undefined
              ? opts.rawBody
              : opts.body !== undefined
                ? JSON.stringify(opts.body)
                : undefined,
          headersTimeout: timeoutMs,
          bodyTimeout: timeoutMs,
        });

        const status = res.statusCode;
        const text = await res.body.text();

        if (status === 429) {
          const retryAfter = Number(res.headers['retry-after']) || 2;
          if (attempt < retries) {
            this.log.warn({ url: url.pathname, retryAfter }, 'Rate limited, backing off');
            await sleep(retryAfter * 1000);
            continue;
          }
          throw new ProviderError(this.providerId, 'Provider rate limit exceeded', {
            retryable: true,
            status: 429,
          });
        }

        if (status >= 400) {
          const retryable =
            status >= 500 && !(opts.noRetryStatuses ?? []).includes(status);
          if (retryable && attempt < retries) {
            await sleep(250 * 2 ** attempt + Math.random() * 200);
            continue;
          }
          throw new ProviderError(
            this.providerId,
            `HTTP ${status} from ${url.pathname}: ${text.slice(0, 300)}`,
            { retryable, status: status === 401 || status === 403 ? 401 : 502 },
          );
        }

        this.log.debug({ url: url.pathname, ms: Date.now() - started }, 'provider call ok');

        if (opts.raw) return text as unknown as T;
        if (!text) return null as unknown as T;
        try {
          return JSON.parse(text) as T;
        } catch {
          throw new ProviderError(
            this.providerId,
            `Malformed JSON from ${url.pathname}`,
            { retryable: false },
          );
        }
      } catch (err) {
        lastError = err as Error;
        if (err instanceof ProviderError && !err.retryable) throw err;
        if (attempt < retries) {
          await sleep(250 * 2 ** attempt + Math.random() * 200);
          continue;
        }
      }
    }

    throw new ProviderError(
      this.providerId,
      `Request failed after ${retries + 1} attempts: ${lastError?.message ?? 'unknown error'}`,
      { retryable: true },
    );
  }

  /** Convenience for probes: measures latency and never throws. */
  protected async probe(
    fn: () => Promise<unknown>,
  ): Promise<{ ok: boolean; latencyMs: number; detail?: string }> {
    const started = Date.now();
    try {
      await fn();
      return { ok: true, latencyMs: Date.now() - started };
    } catch (err) {
      return {
        ok: false,
        latencyMs: Date.now() - started,
        detail: err instanceof Error ? err.message.slice(0, 300) : 'unknown error',
      };
    }
  }
}

// ── small parsing helpers shared by providers ───────────────────────────────

/** Convert to a finite number, or null. Never returns 0 for missing input. */
export function num(v: unknown): number | null {
  if (v === null || v === undefined || v === '' || v === '-') return null;
  const n = typeof v === 'number' ? v : Number(String(v).replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

/** Same, but required — throws if absent, so a bad payload fails loudly. */
export function reqNum(v: unknown, field: string, provider: string): number {
  const n = num(v);
  if (n === null) {
    throw new ProviderError(provider, `Missing required numeric field "${field}"`, {
      retryable: false,
    });
  }
  return n;
}

export function isoOrNow(v: unknown): string {
  if (typeof v === 'number') {
    // Heuristic: seconds vs milliseconds since epoch.
    const ms = v < 1e12 ? v * 1000 : v;
    const d = new Date(ms);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  if (typeof v === 'string' && v) {
    const d = new Date(v);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  return new Date().toISOString();
}
