import { Redis } from 'ioredis';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';
import { createMemoryRedis, type MemoryRedis } from './memoryRedis.js';

/**
 * Every consumer in the codebase uses this subset, so the real client and the
 * in-memory substitute are interchangeable behind it.
 */
export type RedisLike = Redis | MemoryRedis;

/**
 * Three connections by role:
 *  - `redis`      commands (cache, locks, rate limits)
 *  - `publisher`  pub/sub publishing from the ingest worker
 *  - `subscriber` pub/sub receiving in the WS gateway
 *
 * ioredis forbids running normal commands on a connection in subscriber mode,
 * which is why the split is mandatory rather than stylistic.
 */
function build(role: string): RedisLike {
  if (env.USE_IN_MEMORY_REDIS) return createMemoryRedis(role);

  const client = new Redis(env.REDIS_URL, {
    maxRetriesPerRequest: role === 'commands' ? 3 : null,
    enableReadyCheck: true,
    lazyConnect: false,
    retryStrategy: (times) => Math.min(times * 200, 5_000),
  });
  client.on('error', (err) => logger.error({ err, role }, 'Redis error'));
  client.on('reconnecting', () => logger.warn({ role }, 'Redis reconnecting'));
  client.on('ready', () => logger.info({ role }, 'Redis ready'));
  return client;
}

export const redis = build('commands');

let _publisher: RedisLike | null = null;
let _subscriber: RedisLike | null = null;

export const publisher = (): RedisLike => (_publisher ??= build('publisher'));
export const subscriber = (): RedisLike => (_subscriber ??= build('subscriber'));

export async function pingRedis(): Promise<boolean> {
  try {
    return (await redis.ping()) === 'PONG';
  } catch {
    return false;
  }
}

export async function closeRedis(): Promise<void> {
  await Promise.allSettled([
    redis.quit(),
    _publisher?.quit(),
    _subscriber?.quit(),
  ]);
}

// ── typed JSON helpers ──────────────────────────────────────────────────────

export async function getJson<T>(key: string): Promise<T | null> {
  const raw = await redis.get(key);
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    logger.warn({ key }, 'Discarding malformed cache entry');
    await redis.del(key);
    return null;
  }
}

export async function setJson(key: string, value: unknown, ttlSeconds?: number): Promise<void> {
  const payload = JSON.stringify(value);
  if (ttlSeconds && ttlSeconds > 0) await redis.set(key, payload, 'EX', ttlSeconds);
  else await redis.set(key, payload);
}

export async function mgetJson<T>(keys: string[]): Promise<Array<T | null>> {
  if (keys.length === 0) return [];
  const raws = await redis.mget(keys);
  return raws.map((raw) => {
    if (raw === null) return null;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  });
}

/**
 * Cache-aside with an explicit "don't cache failures" contract: if the loader
 * throws, nothing is written, so a provider outage can never poison the cache
 * with a placeholder value.
 */
export async function cached<T>(
  key: string,
  ttlSeconds: number,
  loader: () => Promise<T>,
): Promise<T> {
  const hit = await getJson<T>(key);
  if (hit !== null) return hit;
  const value = await loader();
  await setJson(key, value, ttlSeconds);
  return value;
}

// ── distributed lock (used for realtime-worker leader election) ─────────────

export async function acquireLock(key: string, token: string, ttlMs: number): Promise<boolean> {
  const res = await redis.set(key, token, 'PX', ttlMs, 'NX');
  return res === 'OK';
}

const RENEW_SCRIPT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("pexpire", KEYS[1], ARGV[2])
else
  return 0
end`;

const RELEASE_SCRIPT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
else
  return 0
end`;

export async function renewLock(key: string, token: string, ttlMs: number): Promise<boolean> {
  const res = await redis.eval(RENEW_SCRIPT, 1, key, token, String(ttlMs));
  return res === 1;
}

export async function releaseLock(key: string, token: string): Promise<void> {
  await redis.eval(RELEASE_SCRIPT, 1, key, token);
}
