/**
 * API server entrypoint.
 *
 * Boots the HTTP app plus the WebSocket gateway on the same port, verifies the
 * database and Redis are reachable, and installs graceful-shutdown handlers so
 * in-flight requests finish before the process exits.
 */
import { createServer } from 'node:http';
import { env, isProd, aiAvailable } from './config/env.js';
import { logger } from './utils/logger.js';
import { createApp } from './app.js';
import { pingDb, hasTimescale, closeDb } from './db/pool.js';
import { pingRedis, closeRedis } from './cache/redis.js';
import { getRegistry } from './providers/registry.js';
import { attachWebSocketServer } from './websocket/server.js';
import { formatIstDateTime } from './utils/time.js';

async function main(): Promise<void> {
  logger.info(
    { env: env.NODE_ENV, port: env.PORT, ist: formatIstDateTime() },
    'Bharat Terminal API starting',
  );

  // Fail fast and loudly on missing infrastructure — a server that boots
  // without a database only fails later, in the middle of a user's request.
  const [dbOk, redisOk] = await Promise.all([pingDb(), pingRedis()]);

  if (!dbOk) {
    logger.fatal(
      { databaseUrl: env.DATABASE_URL.replace(/:\/\/[^@]*@/, '://***@') },
      'Cannot reach PostgreSQL. Start it with `npm run infra:up` (or point DATABASE_URL at your instance) and run `npm run migrate`.',
    );
    process.exit(1);
  }
  if (!redisOk) {
    logger.fatal(
      { redisUrl: env.REDIS_URL },
      'Cannot reach Redis. Start it with `npm run infra:up` (or point REDIS_URL at your instance).',
    );
    process.exit(1);
  }

  const timescale = await hasTimescale();
  logger.info(
    { timescale },
    timescale
      ? 'TimescaleDB detected — candle and snapshot tables are hypertables.'
      : 'TimescaleDB not present — running on plain PostgreSQL. Time-series tables work but will not compress or partition.',
  );

  // Surface provider configuration at boot so a missing broker key is obvious
  // immediately rather than at the first dashboard load.
  const registry = getRegistry();
  const configured = registry.all().filter((p) => p.isConfigured());
  if (configured.length === 0) {
    logger.warn(
      'No market-data provider is configured. The API will start, but every market endpoint will honestly report "Live market data unavailable" until credentials are added via environment variables or Settings → Market Data Provider.',
    );
  } else {
    logger.info(
      { providers: configured.map((p) => p.manifest.id) },
      'Market data providers configured',
    );
  }

  if (!aiAvailable()) {
    logger.warn(
      'AI analyst disabled (no ANTHROPIC_API_KEY). Analyst questions will be answered with deterministic summaries built from retrieved data.',
    );
  }

  const app = createApp();
  const server = createServer(app);
  attachWebSocketServer(server);

  server.listen(env.PORT, () => {
    logger.info(
      { url: `http://localhost:${env.PORT}`, ws: `ws://localhost:${env.PORT}/ws` },
      'API listening',
    );
  });

  // Node's default 5s keep-alive timeout races load balancers that reuse
  // connections; 65s sits safely above the common 60s LB idle timeout.
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 70_000;

  // ── graceful shutdown ──
  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'Shutting down');

    const force = setTimeout(() => {
      logger.error('Graceful shutdown timed out after 15s — forcing exit');
      process.exit(1);
    }, 15_000);
    force.unref();

    server.close(() => logger.info('HTTP server closed'));
    await Promise.allSettled([closeDb(), closeRedis()]);
    logger.info('Shutdown complete');
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  process.on('unhandledRejection', (reason) => {
    logger.error({ reason }, 'Unhandled promise rejection');
  });
  process.on('uncaughtException', (err) => {
    logger.fatal({ err }, 'Uncaught exception — exiting');
    if (isProd) process.exit(1);
  });
}

void main();
