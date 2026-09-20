import pino from 'pino';
import { env, isProd } from '../config/env.js';

/**
 * Structured logger. Redaction is belt-and-braces: even if a credential object
 * is accidentally logged, the secret fields never reach the log sink.
 */
export const logger = pino({
  level: env.LOG_LEVEL,
  redact: {
    paths: [
      'password', '*.password', '*.password_hash', 'passwordHash',
      'token', '*.token', 'accessToken', '*.accessToken', 'access_token', '*.access_token',
      'apiSecret', '*.apiSecret', 'api_secret', '*.api_secret',
      'apiKey', '*.apiKey', 'api_key', '*.api_key',
      'mpin', '*.mpin', 'totpSecret', '*.totpSecret', 'totp_secret',
      'credentials', '*.credentials', 'credentials_enc', '*.credentials_enc',
      'authorization', 'req.headers.authorization', 'req.headers.cookie',
    ],
    censor: '[redacted]',
  },
  transport: isProd
    ? undefined
    : { target: 'pino/file', options: { destination: 1 } },
  base: { service: 'bharat-terminal' },
});

export type Logger = typeof logger;

export const childLogger = (bindings: Record<string, unknown>) => logger.child(bindings);
