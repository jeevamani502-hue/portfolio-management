import express, { type Express } from 'express';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import helmet from 'helmet';
import cors from 'cors';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import pinoHttp from 'pino-http';
import { env, isProd, aiAvailable } from './config/env.js';
import { logger } from './utils/logger.js';
import {
  requestContext, scrubSecrets, errorHandler, notFoundHandler, rateLimit, respond, asyncHandler,
} from './middleware/index.js';
import { pingDb, hasTimescale } from './db/pool.js';
import { pingRedis } from './cache/redis.js';
import { getRegistry } from './providers/registry.js';
import { marketStatus } from './modules/market/marketData.service.js';

import { authRouter } from './modules/auth/auth.routes.js';
import { marketRouter } from './modules/market/market.routes.js';
import { stocksRouter } from './modules/stocks/stocks.routes.js';
import { optionsRouter } from './modules/options/options.routes.js';
import { portfolioRouter } from './modules/portfolio/portfolio.routes.js';
import { watchlistRouter } from './modules/watchlist/watchlist.routes.js';
import { scannerRouter } from './modules/scanner/scanner.routes.js';
import { newsRouter } from './modules/news/news.routes.js';
import { riskRouter } from './modules/risk/risk.routes.js';
import { settingsRouter } from './modules/settings/settings.routes.js';
import { aiRouter } from './modules/ai/ai.routes.js';
import { alertsRouter } from './modules/alerts/alerts.routes.js';
import { paperRouter } from './modules/paper/paper.routes.js';
import { backtestRouter } from './modules/backtest/backtest.routes.js';
import { fnoRouter } from './modules/fno/fno.routes.js';
import { notificationsRouter } from './modules/notifications/notifications.routes.js';
import { liveRouter } from './modules/live/live.routes.js';
import { agentRouter } from './modules/agent/agent.routes.js';

export function createApp(): Express {
  const app = express();

  // Behind a reverse proxy in production, so req.ip reflects the real client.
  if (isProd) app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use(
    helmet({
      // The API serves JSON only; CSP belongs on the frontend's own host.
      contentSecurityPolicy: false,
      crossOriginResourcePolicy: { policy: 'cross-origin' },
    }),
  );

  app.use(
    cors({
      origin: env.FRONTEND_ORIGIN.split(',').map((s) => s.trim()),
      credentials: true,
      exposedHeaders: ['X-Request-Id', 'X-RateLimit-Remaining', 'X-RateLimit-Reset'],
    }),
  );

  app.use(compression());
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: true, limit: '1mb' }));
  app.use(cookieParser());
  app.use(requestContext);

  app.use(
    pinoHttp({
      logger,
      genReqId: (req) => (req as express.Request).id,
      autoLogging: {
        ignore: (req) => req.url === '/health' || req.url === '/health/live',
      },
      customLogLevel: (_req, res, err) =>
        err || res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info',
    }),
  );

  // Belt-and-braces: strip anything credential-shaped from every JSON response.
  app.use(scrubSecrets);

  // ── health ────────────────────────────────────────────────────────────────

  app.get('/health/live', (_req, res) => {
    res.json({ status: 'ok', uptime: process.uptime() });
  });

  app.get(
    '/health',
    asyncHandler(async (_req, res) => {
      const [db, redisOk, timescale, market] = await Promise.all([
        pingDb(),
        pingRedis(),
        pingDb().then((ok) => (ok ? hasTimescale() : false)).catch(() => false),
        marketStatus().catch(() => null),
      ]);

      const providers = getRegistry()
        .all()
        .map((p) => ({
          id: p.manifest.id,
          configured: p.isConfigured(),
          capabilities: p.manifest.capabilities.length,
        }));

      const healthy = db && redisOk;
      res.status(healthy ? 200 : 503).json({
        status: healthy ? 'ok' : 'degraded',
        checks: {
          database: db ? 'ok' : 'down',
          redis: redisOk ? 'ok' : 'down',
          timescaledb: timescale ? 'present' : 'absent (plain PostgreSQL)',
          ai: aiAvailable() ? 'configured' : 'not configured',
        },
        market: market
          ? { phase: market.phase, isOpen: market.isOpen, nowIst: market.nowIst }
          : null,
        providers,
        version: process.env['npm_package_version'] ?? '0.1.0',
      });
    }),
  );

  // ── API ───────────────────────────────────────────────────────────────────

  const api = express.Router();

  // Global per-user (or per-IP) budget. Route-level limiters are tighter
  // where the work is expensive — scans, AI calls, auth.
  api.use(rateLimit({ bucket: 'global', limit: 300, windowSeconds: 60 }));

  api.use('/auth', authRouter);
  api.use('/market', marketRouter);
  api.use('/stocks', stocksRouter);
  api.use('/paper', paperRouter);
  api.use('/options', optionsRouter);
  api.use('/futures', optionsRouter); // futures analysis lives on the same router
  api.use('/portfolio', portfolioRouter);
  api.use('/watchlists', watchlistRouter);
  api.use('/scanner', scannerRouter);
  api.use('/news', newsRouter);
  api.use('/risk', riskRouter);
  api.use('/settings', settingsRouter);
  api.use('/ai', aiRouter);
  api.use('/alerts', alertsRouter);
  api.use('/backtest', backtestRouter);
  api.use('/fno', fnoRouter);
  api.use('/notifications', notificationsRouter);
  api.use('/live', liveRouter);
  api.use('/agent', agentRouter);

  api.get('/', (_req, res) => {
    respond(res, {
      name: 'AdviSha API',
      version: '1',
      documentation: '/api/routes',
      principle: 'Real data, calculated transparently. No value is ever fabricated.',
    });
  });

  app.use('/api', api);

  /*
   * Serve the built frontend, when there is one.
   *
   * A single-service deployment is both cheaper and simpler than a separate
   * static host: same origin, so no CORS to configure and no second URL to
   * keep in step. Mounted after /api so a route can never be shadowed by a
   * file, and the SPA fallback explicitly excludes /api — otherwise a typo'd
   * endpoint would return index.html with a 200 and the client would try to
   * parse HTML as JSON.
   *
   * In development this directory does not exist and Vite serves the app
   * instead, so nothing here runs.
   */
  const webRoot = resolve(env.WEB_ROOT ?? join(process.cwd(), '..', 'frontend', 'dist'));
  if (existsSync(join(webRoot, 'index.html'))) {
    logger.info({ webRoot }, 'Serving the frontend build from the API process');

    // Hashed assets are immutable; index.html must never be cached or a
    // deploy leaves clients on the old bundle indefinitely.
    app.use(
      express.static(webRoot, {
        index: false,
        setHeaders: (res, path) => {
          res.setHeader(
            'Cache-Control',
            path.endsWith('index.html') ? 'no-cache' : 'public, max-age=31536000, immutable',
          );
        },
      }),
    );

    app.get(/^(?!\/api\/).*/, (req, res, next) => {
      if (req.method !== 'GET') return next();
      res.sendFile(join(webRoot, 'index.html'));
    });
  }

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
