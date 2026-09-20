/**
 * Environment loading + validation.
 *
 * The process refuses to boot on an unsafe configuration: a missing or
 * wrong-length credential encryption key, or a JWT secret left at a
 * placeholder value. Failing at boot is far safer than discovering at
 * runtime that broker secrets were written with a predictable key.
 */
import { config as loadDotenv } from 'dotenv';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { z } from 'zod';

/**
 * Load `.env` from the backend directory first, then fall back to the monorepo
 * root. In a workspace layout the file usually lives at the root, but the
 * process runs with the backend as its cwd, so plain `dotenv/config` would
 * miss it. Earlier files win: `dotenv` does not overwrite an already-set key.
 */
const here = dirname(fileURLToPath(import.meta.url));
for (const candidate of [
  resolve(process.cwd(), '.env'),
  resolve(here, '../../.env'), // backend/.env
  resolve(here, '../../../.env'), // monorepo root
]) {
  if (existsSync(candidate)) loadDotenv({ path: candidate });
}

const bool = (def: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? def : v.toLowerCase() === 'true'));

const int = (def: number) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? def : Number(v)))
    .pipe(z.number().int());

const optional = z
  .string()
  .optional()
  .transform((v) => (v === '' ? undefined : v));

/** Base64 string that must decode to exactly `bytes` bytes. */
const base64Key = (bytes: number) =>
  z.string().refine(
    (v) => {
      try {
        return Buffer.from(v, 'base64').length === bytes;
      } catch {
        return false;
      }
    },
    { message: `must be base64 decoding to exactly ${bytes} bytes` },
  );

const PLACEHOLDERS = new Set(['', 'changeme', 'secret', 'please-change', 'xxx']);

const secret = z
  .string()
  .min(24, 'must be at least 24 characters')
  .refine((v) => !PLACEHOLDERS.has(v.toLowerCase()), { message: 'must not be a placeholder value' });

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: int(4000),
  API_BASE_URL: z.string().url().default('http://localhost:4000'),
  FRONTEND_ORIGIN: z.string().default('http://localhost:5173'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  DATABASE_POOL_MAX: int(20),
  TIMESCALE_ENABLED: bool(true),

  REDIS_URL: z.string().min(1).default('redis://localhost:6379'),
  REDIS_QUOTE_TTL_SECONDS: int(300),
  /**
   * Development escape hatch: run without a Redis server, using an in-process
   * substitute. Refused when NODE_ENV=production (checked below) because the
   * store is process-local — it would silently break tick fan-out and leader
   * election across instances.
   */
  USE_IN_MEMORY_REDIS: bool(false),

  JWT_ACCESS_SECRET: secret,
  JWT_REFRESH_SECRET: secret,
  JWT_ACCESS_TTL: z.string().default('15m'),
  JWT_REFRESH_TTL: z.string().default('7d'),
  BCRYPT_ROUNDS: int(12),
  CREDENTIAL_ENC_KEY: base64Key(32),

  PRIMARY_PROVIDER: z
    .enum(['groww', 'dhan', 'angelone', 'kite', 'upstox', 'fyers', 'nsepublic'])
    .default('dhan'),
  FAILOVER_PROVIDERS: z
    .string()
    .optional()
    .transform((v) =>
      (v ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  SHARED_FEED_LICENSED: bool(false),

  GROWW_API_KEY: optional,
  GROWW_API_SECRET: optional,
  GROWW_ACCESS_TOKEN: optional,

  DHAN_CLIENT_ID: optional,
  DHAN_ACCESS_TOKEN: optional,

  ANGELONE_API_KEY: optional,
  ANGELONE_CLIENT_CODE: optional,
  ANGELONE_MPIN: optional,
  ANGELONE_TOTP_SECRET: optional,

  KITE_API_KEY: optional,
  KITE_API_SECRET: optional,
  KITE_ACCESS_TOKEN: optional,

  UPSTOX_API_KEY: optional,
  UPSTOX_API_SECRET: optional,
  UPSTOX_REDIRECT_URI: optional,
  UPSTOX_ACCESS_TOKEN: optional,

  FYERS_APP_ID: optional,
  FYERS_SECRET_ID: optional,
  FYERS_ACCESS_TOKEN: optional,

  NSE_PUBLIC_ENABLED: bool(false),
  NSE_PUBLIC_MIN_INTERVAL_MS: int(3000),

  EODHD_API_KEY: optional,
  FMP_API_KEY: optional,
  MARKETAUX_API_KEY: optional,
  NEWSAPI_KEY: optional,
  RSS_FEEDS: z
    .string()
    .optional()
    .transform((v) =>
      (v ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    ),

  ANTHROPIC_API_KEY: optional,
  AI_MODEL: z.string().default('claude-opus-5'),
  AI_MAX_TOKENS: int(4096),
  AI_ENABLED: bool(true),

  SMTP_URL: optional,
  ALERT_FROM_EMAIL: optional,
  TELEGRAM_BOT_TOKEN: optional,
  VAPID_PUBLIC_KEY: optional,
  VAPID_PRIVATE_KEY: optional,
});

export type Env = z.infer<typeof schema>;

function load(): Env {
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    // Deliberately not using the logger: it depends on env.
    console.error(
      '\nInvalid environment configuration. The server will not start.\n' +
        `${issues}\n\n` +
        'Copy .env.example to .env and fill in the required values.\n' +
        'Generate secrets with:\n' +
        '  node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))"\n',
    );
    process.exit(1);
  }
  if (parsed.data.NODE_ENV === 'production' && parsed.data.USE_IN_MEMORY_REDIS) {
    console.error(
      [
        '',
        'USE_IN_MEMORY_REDIS cannot be enabled in production.',
        'The in-process store is not shared between instances, so tick fan-out and',
        'realtime leader election would silently misbehave. Point REDIS_URL at a',
        'real Redis server instead.',
        '',
      ].join('\n'),
    );
    process.exit(1);
  }

  return parsed.data;
}

export const env = load();

export const isProd = env.NODE_ENV === 'production';
export const isTest = env.NODE_ENV === 'test';

/** True when the AI analyst can actually be called. */
export const aiAvailable = (): boolean => env.AI_ENABLED && Boolean(env.ANTHROPIC_API_KEY);
