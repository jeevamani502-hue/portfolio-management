/**
 * In-process Redis substitute for local development.
 *
 * WHY THIS EXISTS
 * Running the platform normally needs Redis (hot quote cache, rate-limit
 * buckets, pub/sub tick fan-out, leader-election locks). On a developer
 * machine without Docker that is a hard stop before the UI can even be seen.
 * This implements the exact slice of the ioredis surface the codebase uses,
 * backed by a Map, so `npm run dev` works with nothing installed.
 *
 * WHAT IT IS NOT
 * It is not Redis. State lives in one process, so it is wrong the moment you
 * run more than one API pod: the tick fan-out reaches only clients attached to
 * this process, and the realtime leader lock guards only this process. It is
 * therefore refused outright when NODE_ENV=production (see config/env.ts), and
 * the server logs a prominent warning on every boot that uses it.
 *
 * It changes no application code: `redis.ts` picks this or the real client,
 * and nothing downstream can tell the difference.
 */
import { EventEmitter } from 'node:events';
import { logger } from '../utils/logger.js';

interface Entry {
  value: string;
  /** Epoch ms after which the key is gone, or null for no expiry. */
  expiresAt: number | null;
}

type PMessageHandler = (pattern: string, channel: string, message: string) => void;

/**
 * A single store shared by every client instance in the process, so the
 * "publisher" and "subscriber" connections see each other exactly as separate
 * ioredis connections to one server would.
 */
class MemoryStore {
  readonly strings = new Map<string, Entry>();
  readonly sets = new Map<string, Set<string>>();
  readonly patternSubscribers = new Map<string, Set<PMessageHandler>>();

  /** Lazy expiry: checked on read rather than swept on a timer. */
  live(key: string): Entry | undefined {
    const entry = this.strings.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt !== null && entry.expiresAt <= Date.now()) {
      this.strings.delete(key);
      return undefined;
    }
    return entry;
  }
}

const store = new MemoryStore();

/** Convert a Redis glob pattern (`ticks:*`) to a RegExp. */
function patternToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${escaped.replace(/\*/g, '.*').replace(/\?/g, '.')}$`);
}

export class MemoryRedis extends EventEmitter {
  readonly status = 'ready';
  private readonly ownPatterns = new Map<string, PMessageHandler>();

  constructor(private readonly role: string) {
    super();
    // Mirror ioredis's async 'ready' so callers that wait for it still work.
    setImmediate(() => this.emit('ready'));
  }

  // ── strings ───────────────────────────────────────────────────────────────

  async get(key: string): Promise<string | null> {
    return store.live(key)?.value ?? null;
  }

  async mget(keys: string[]): Promise<Array<string | null>> {
    return keys.map((k) => store.live(k)?.value ?? null);
  }

  /**
   * Supports the argument forms this codebase uses:
   *   set(k, v) · set(k, v, 'EX', s) · set(k, v, 'PX', ms) · set(k, v, 'PX', ms, 'NX')
   * Returns 'OK', or null when NX is given and the key already exists.
   */
  async set(key: string, value: string, ...args: Array<string | number>): Promise<'OK' | null> {
    let expiresAt: number | null = null;
    let nx = false;

    for (let i = 0; i < args.length; i += 1) {
      const token = String(args[i]).toUpperCase();
      if (token === 'EX') {
        expiresAt = Date.now() + Number(args[i + 1]) * 1000;
        i += 1;
      } else if (token === 'PX') {
        expiresAt = Date.now() + Number(args[i + 1]);
        i += 1;
      } else if (token === 'NX') {
        nx = true;
      }
    }

    if (nx && store.live(key) !== undefined) return null;

    store.strings.set(key, { value, expiresAt });
    return 'OK';
  }

  async del(...keys: string[]): Promise<number> {
    let removed = 0;
    for (const key of keys) {
      if (store.strings.delete(key)) removed += 1;
      if (store.sets.delete(key)) removed += 1;
    }
    return removed;
  }

  async incr(key: string): Promise<number> {
    const entry = store.live(key);
    const next = (entry ? Number(entry.value) : 0) + 1;
    store.strings.set(key, { value: String(next), expiresAt: entry?.expiresAt ?? null });
    return next;
  }

  async expire(key: string, seconds: number): Promise<number> {
    const entry = store.live(key);
    if (!entry) return 0;
    entry.expiresAt = Date.now() + seconds * 1000;
    return 1;
  }

  async ttl(key: string): Promise<number> {
    const entry = store.live(key);
    if (!entry) return -2;                     // key does not exist
    if (entry.expiresAt === null) return -1;   // exists, no expiry
    return Math.max(0, Math.ceil((entry.expiresAt - Date.now()) / 1000));
  }

  async pttl(key: string): Promise<number> {
    const entry = store.live(key);
    if (!entry) return -2;
    if (entry.expiresAt === null) return -1;
    return Math.max(0, entry.expiresAt - Date.now());
  }

  // ── sets ──────────────────────────────────────────────────────────────────

  async sadd(key: string, ...members: string[]): Promise<number> {
    const set = store.sets.get(key) ?? new Set<string>();
    let added = 0;
    for (const m of members) {
      if (!set.has(m)) { set.add(m); added += 1; }
    }
    store.sets.set(key, set);
    return added;
  }

  async smembers(key: string): Promise<string[]> {
    return [...(store.sets.get(key) ?? [])];
  }

  async srem(key: string, ...members: string[]): Promise<number> {
    const set = store.sets.get(key);
    if (!set) return 0;
    let removed = 0;
    for (const m of members) if (set.delete(m)) removed += 1;
    return removed;
  }

  // ── scripting ─────────────────────────────────────────────────────────────

  /**
   * The codebase evaluates exactly two Lua scripts — the compare-and-renew and
   * compare-and-delete halves of the distributed lock. Rather than embed a Lua
   * interpreter, both are recognised by shape and executed natively. Anything
   * else throws loudly instead of silently returning a wrong answer.
   */
  async eval(script: string, numKeys: number, ...args: Array<string | number>): Promise<unknown> {
    const keys = args.slice(0, numKeys).map(String);
    const argv = args.slice(numKeys).map(String);
    const key = keys[0];
    const token = argv[0];

    const isCompareAndRenew = script.includes('pexpire') && script.includes('get');
    const isCompareAndDelete = script.includes('del') && script.includes('get');

    if (key === undefined || token === undefined) return 0;

    const current = store.live(key)?.value;
    if (current !== token) return 0;

    if (isCompareAndRenew) {
      const entry = store.strings.get(key)!;
      entry.expiresAt = Date.now() + Number(argv[1]);
      return 1;
    }
    if (isCompareAndDelete) {
      store.strings.delete(key);
      return 1;
    }

    throw new Error(
      'MemoryRedis.eval received an unrecognised script. Add a native equivalent in memoryRedis.ts, or run a real Redis.',
    );
  }

  // ── pub/sub ───────────────────────────────────────────────────────────────

  async publish(channel: string, message: string): Promise<number> {
    let delivered = 0;
    for (const [pattern, handlers] of store.patternSubscribers) {
      if (!patternToRegExp(pattern).test(channel)) continue;
      for (const handler of handlers) {
        // Async delivery, matching real pub/sub: a publisher never runs a
        // subscriber's callback inside its own call stack.
        setImmediate(() => handler(pattern, channel, message));
        delivered += 1;
      }
    }
    return delivered;
  }

  async psubscribe(...patterns: string[]): Promise<number> {
    for (const pattern of patterns) {
      const handler: PMessageHandler = (p, c, m) => this.emit('pmessage', p, c, m);
      this.ownPatterns.set(pattern, handler);
      const set = store.patternSubscribers.get(pattern) ?? new Set<PMessageHandler>();
      set.add(handler);
      store.patternSubscribers.set(pattern, set);
    }
    return patterns.length;
  }

  async punsubscribe(...patterns: string[]): Promise<number> {
    for (const pattern of patterns) {
      const handler = this.ownPatterns.get(pattern);
      if (!handler) continue;
      store.patternSubscribers.get(pattern)?.delete(handler);
      this.ownPatterns.delete(pattern);
    }
    return patterns.length;
  }

  // ── lifecycle ─────────────────────────────────────────────────────────────

  async ping(): Promise<'PONG'> {
    return 'PONG';
  }

  async quit(): Promise<'OK'> {
    for (const pattern of [...this.ownPatterns.keys()]) await this.punsubscribe(pattern);
    this.removeAllListeners();
    return 'OK';
  }

  disconnect(): void {
    void this.quit();
  }
}

let warned = false;

export function createMemoryRedis(role: string): MemoryRedis {
  if (!warned) {
    warned = true;
    logger.warn(
      'Using the IN-MEMORY Redis substitute. Cache, rate limits, pub/sub and locks are process-local ' +
        'and lost on restart. Correct for single-process local development only — never for production ' +
        'or any multi-instance deployment.',
    );
  }
  return new MemoryRedis(role);
}

/** Test hook: wipe all state between cases. */
export function resetMemoryRedis(): void {
  store.strings.clear();
  store.sets.clear();
  store.patternSubscribers.clear();
}
