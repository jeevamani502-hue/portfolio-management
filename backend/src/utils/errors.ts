/** Typed application errors with stable machine-readable codes. */

export type ErrorCode =
  | 'VALIDATION_ERROR'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'RATE_LIMITED'
  | 'PROVIDER_ERROR'
  | 'PROVIDER_UNCONFIGURED'
  | 'DATA_UNAVAILABLE'
  | 'CAPABILITY_UNSUPPORTED'
  | 'AI_DISABLED'
  | 'AI_INSUFFICIENT_EVIDENCE'
  | 'UPSTREAM_TIMEOUT'
  | 'INTERNAL_ERROR';

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly statusCode: number;
  readonly details?: unknown;
  readonly expose: boolean;

  constructor(
    code: ErrorCode,
    message: string,
    statusCode = 500,
    details?: unknown,
    expose = true,
  ) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
    this.expose = expose;
    Error.captureStackTrace?.(this, AppError);
  }
}

export const badRequest = (msg: string, details?: unknown) =>
  new AppError('VALIDATION_ERROR', msg, 400, details);

export const unauthorized = (msg = 'Authentication required') =>
  new AppError('UNAUTHORIZED', msg, 401);

export const forbidden = (msg = 'You do not have access to this resource') =>
  new AppError('FORBIDDEN', msg, 403);

export const notFound = (msg = 'Resource not found') => new AppError('NOT_FOUND', msg, 404);

export const conflict = (msg: string, details?: unknown) =>
  new AppError('CONFLICT', msg, 409, details);

export const rateLimited = (msg = 'Too many requests', retryAfterSec?: number) =>
  new AppError('RATE_LIMITED', msg, 429, { retryAfterSec });

/** An upstream data provider failed. Never converted into a fabricated value. */
export class ProviderError extends AppError {
  readonly provider: string;
  readonly retryable: boolean;

  constructor(provider: string, message: string, opts?: { retryable?: boolean; status?: number }) {
    super('PROVIDER_ERROR', message, opts?.status ?? 502, { provider });
    this.name = 'ProviderError';
    this.provider = provider;
    this.retryable = opts?.retryable ?? true;
  }
}

export const providerUnconfigured = (provider: string) =>
  new AppError(
    'PROVIDER_UNCONFIGURED',
    `Market data provider "${provider}" is not configured. Add credentials in Settings → Market Data Provider.`,
    503,
    { provider },
  );

export const capabilityUnsupported = (capability: string, tried: string[]) =>
  new AppError(
    'CAPABILITY_UNSUPPORTED',
    `No configured provider can supply "${capability}".`,
    503,
    { capability, tried },
  );

/**
 * The honest failure. Returned whenever real data cannot be obtained —
 * the alternative (inventing a plausible number) is never acceptable here.
 */
export const dataUnavailable = (
  what: string,
  reason: string,
  attempted?: Array<{ provider: string; error: string }>,
) =>
  new AppError('DATA_UNAVAILABLE', `Live market data unavailable for ${what}.`, 503, {
    what,
    reason,
    attempted,
  });

export function isAppError(e: unknown): e is AppError {
  return e instanceof AppError;
}

/** Normalize any thrown value into an AppError. */
export function toAppError(e: unknown): AppError {
  if (isAppError(e)) return e;
  if (e instanceof Error) {
    return new AppError('INTERNAL_ERROR', e.message, 500, undefined, false);
  }
  return new AppError('INTERNAL_ERROR', 'Unexpected error', 500, undefined, false);
}
