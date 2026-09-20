/** Express middleware: request id, auth, RBAC, validation, rate limit, errors. */
import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { randomUUID } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { z, type ZodSchema } from 'zod';
import { env, isProd } from '../config/env.js';
import { logger } from '../utils/logger.js';
import { redis } from '../cache/redis.js';
import { K } from '../cache/keys.js';
import { AppError, toAppError, unauthorized, forbidden, badRequest } from '../utils/errors.js';
import { query } from '../db/pool.js';

// ── request context ─────────────────────────────────────────────────────────

export interface AuthUser {
  id: string;
  email: string;
  role: 'user' | 'analyst' | 'admin';
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      // `id` is declared by pino-http as ReqId (string | number | object);
      // we always assign a string. Use `requestId(req)` to read it as one.
      user?: AuthUser;
      startedAt: number;
    }
  }
}

/** The request id as a string, whatever pino-http's ReqId type widens it to. */
export const requestId = (req: Request): string => String(req.id ?? 'unknown');

export const requestContext: RequestHandler = (req, res, next) => {
  req.id = (req.headers['x-request-id'] as string) || randomUUID();
  req.startedAt = Date.now();
  res.setHeader('X-Request-Id', requestId(req));
  next();
};

// ── response envelope ───────────────────────────────────────────────────────

export interface ResponseMeta {
  requestId: string;
  generatedAt: string;
  [key: string]: unknown;
}

/** Wrap a payload in the standard `{ data, meta }` envelope. */
export function respond(
  res: Response,
  data: unknown,
  extraMeta: Record<string, unknown> = {},
  status = 200,
): void {
  const meta: ResponseMeta = {
    requestId: requestId(res.req),
    generatedAt: new Date().toISOString(),
    ...extraMeta,
  };
  res.status(status).json({ data, meta });
}

/** Wrap an async handler so rejections reach the error middleware. */
export function asyncHandler<T extends RequestHandler>(fn: T): RequestHandler {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

// ── authentication ──────────────────────────────────────────────────────────

export interface AccessTokenPayload {
  sub: string;
  email: string;
  role: AuthUser['role'];
}

export function signAccessToken(user: AuthUser): string {
  return jwt.sign(
    { sub: user.id, email: user.email, role: user.role } satisfies AccessTokenPayload,
    env.JWT_ACCESS_SECRET,
    { expiresIn: env.JWT_ACCESS_TTL as jwt.SignOptions['expiresIn'] },
  );
}

export function verifyAccessToken(token: string): AccessTokenPayload {
  return jwt.verify(token, env.JWT_ACCESS_SECRET) as AccessTokenPayload;
}

function extractToken(req: Request): string | null {
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) return header.slice(7);
  return null;
}

/** Require a valid access token. */
export const requireAuth: RequestHandler = (req, _res, next) => {
  const token = extractToken(req);
  if (!token) return next(unauthorized('Missing bearer token'));
  try {
    const payload = verifyAccessToken(token);
    req.user = { id: payload.sub, email: payload.email, role: payload.role };
    next();
  } catch (err) {
    const expired = err instanceof jwt.TokenExpiredError;
    next(unauthorized(expired ? 'Access token expired' : 'Invalid access token'));
  }
};

/** Attach the user when a token is present, but do not require one. */
export const optionalAuth: RequestHandler = (req, _res, next) => {
  const token = extractToken(req);
  if (token) {
    try {
      const payload = verifyAccessToken(token);
      req.user = { id: payload.sub, email: payload.email, role: payload.role };
    } catch {
      // Ignore — the route is public.
    }
  }
  next();
};

export function requireRole(...roles: AuthUser['role'][]): RequestHandler {
  return (req, _res, next) => {
    if (!req.user) return next(unauthorized());
    if (!roles.includes(req.user.role)) {
      return next(forbidden(`This action requires one of: ${roles.join(', ')}`));
    }
    next();
  };
}

// ── validation ──────────────────────────────────────────────────────────────

type Source = 'body' | 'query' | 'params';

/** Validate and REPLACE the request part with the parsed (typed) value. */
export function validate<T extends ZodSchema>(schema: T, source: Source = 'body'): RequestHandler {
  return (req, _res, next) => {
    const result = schema.safeParse(req[source]);
    if (!result.success) {
      return next(
        badRequest(
          'Request validation failed',
          result.error.issues.map((i) => ({
            path: i.path.join('.'),
            message: i.message,
            code: i.code,
          })),
        ),
      );
    }
    // Express 4 allows reassigning req.query/params; cast is required.
    (req as unknown as Record<Source, unknown>)[source] = result.data;
    next();
  };
}

// ── rate limiting (Redis token bucket) ──────────────────────────────────────

export interface RateLimitOptions {
  bucket: string;
  limit: number;
  windowSeconds: number;
  /** Key by user when authenticated, else by IP. */
  keyFn?: (req: Request) => string;
}

export function rateLimit(opts: RateLimitOptions): RequestHandler {
  const { bucket, limit, windowSeconds } = opts;
  const keyFn = opts.keyFn ?? ((req: Request) => req.user?.id ?? req.ip ?? 'anonymous');

  return asyncHandler(async (req, res, next) => {
    const key = K.rateLimit(bucket, keyFn(req));
    // INCR + EXPIRE on first hit is a fixed window: cheap and adequate here.
    const count = await redis.incr(key);
    if (count === 1) await redis.expire(key, windowSeconds);

    const ttl = count === 1 ? windowSeconds : await redis.ttl(key);
    res.setHeader('X-RateLimit-Limit', String(limit));
    res.setHeader('X-RateLimit-Remaining', String(Math.max(0, limit - count)));
    res.setHeader('X-RateLimit-Reset', String(Math.max(0, ttl)));

    if (count > limit) {
      res.setHeader('Retry-After', String(Math.max(1, ttl)));
      return next(
        new AppError('RATE_LIMITED', `Rate limit exceeded for ${bucket}`, 429, {
          limit,
          windowSeconds,
          retryAfterSec: ttl,
        }),
      );
    }
    next();
  });
}

// ── secret scrubbing ────────────────────────────────────────────────────────

const SECRET_KEY_PATTERN =
  /(password|secret|token|apikey|api_key|mpin|totp|credentials_enc|authorization)/i;

/**
 * Marks a response as exempt from secret scrubbing.
 *
 * Exactly one thing legitimately returns a token-shaped value: the auth
 * endpoints issuing this user's own JWT. Everything else — above all broker
 * credentials — stays subject to the scrubber. The exemption is opt-in per
 * route so it is greppable and auditable, rather than a pattern carve-out
 * that would also whitelist `accessToken` on the provider endpoints.
 */
export const allowTokensInResponse: RequestHandler = (_req, res, next) => {
  res.locals['skipSecretScrub'] = true;
  next();
};

/**
 * Defence in depth: walk every outgoing JSON body and strip anything that
 * looks like a credential. A bug in a controller must not be able to leak a
 * broker secret to the browser.
 */
function scrub(value: unknown, depth = 0): unknown {
  if (depth > 12 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => scrub(v, depth + 1));

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (SECRET_KEY_PATTERN.test(k)) {
      // `hasCredentials`-style booleans are safe and useful; values are not.
      out[k] = typeof v === 'boolean' ? v : '[redacted]';
      continue;
    }
    out[k] = scrub(v, depth + 1);
  }
  return out;
}

export const scrubSecrets: RequestHandler = (_req, res, next) => {
  const originalJson = res.json.bind(res);
  res.json = (body: unknown) =>
    originalJson(res.locals['skipSecretScrub'] === true ? body : scrub(body));
  next();
};

// ── audit logging ───────────────────────────────────────────────────────────

export function auditLog(action: string, resource?: string): RequestHandler {
  return (req, res, next) => {
    res.on('finish', () => {
      if (res.statusCode >= 400) return;
      void query(
        `INSERT INTO audit_logs (user_id, action, resource, resource_id, ip, user_agent, metadata)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [
          req.user?.id ?? null,
          action,
          resource ?? null,
          (req.params as Record<string, string>)?.['id'] ?? null,
          req.ip ?? null,
          req.headers['user-agent'] ?? null,
          JSON.stringify({ method: req.method, path: req.path, status: res.statusCode }),
        ],
      ).catch(() => undefined);
    });
    next();
  };
}

// ── errors ──────────────────────────────────────────────────────────────────

export const notFoundHandler: RequestHandler = (req, res) => {
  res.status(404).json({
    error: {
      code: 'NOT_FOUND',
      message: `No route matches ${req.method} ${req.path}`,
      requestId: requestId(req),
    },
  });
};

export function errorHandler(
  err: unknown,
  req: Request,
  res: Response,
  _next: NextFunction,
): void {
  const appErr = toAppError(err);
  const level = appErr.statusCode >= 500 ? 'error' : 'warn';

  logger[level](
    {
      err: appErr,
      requestId: requestId(req),
      path: req.path,
      method: req.method,
      status: appErr.statusCode,
      userId: req.user?.id,
      durationMs: Date.now() - req.startedAt,
    },
    appErr.message,
  );

  if (res.headersSent) return;

  res.status(appErr.statusCode).json({
    error: {
      code: appErr.code,
      // Internal errors get a generic message in production; the request id
      // is the bridge to the full detail in the logs.
      message: appErr.expose || !isProd ? appErr.message : 'An internal error occurred',
      details: appErr.expose ? appErr.details : undefined,
      requestId: requestId(req),
    },
  });
}

// ── common schemas ──────────────────────────────────────────────────────────

export const TIMEFRAMES = ['1m', '5m', '15m', '30m', '1h', '4h', '1d', '1w', '1M'] as const;

export const timeframeSchema = z.enum(TIMEFRAMES).default('1d');

export const paginationSchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export const symbolParamSchema = z.object({
  symbol: z.string().min(1).max(64),
});

export const uuidParamSchema = z.object({
  id: z.string().uuid(),
});
