/**
 * Live trading routes. Every mutating call is audit-logged: these are the
 * endpoints that move real money.
 */
import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, respond, requireAuth, validate, auditLog } from '../../middleware/index.js';
import { badRequest } from '../../utils/errors.js';
import * as live from './live.service.js';
import { RISK_LIMITS } from '../../config/riskLimits.js';
import * as hero from './heroZero.service.js';

export const liveRouter = Router();
liveRouter.use(requireAuth);

const configSchema = z.object({
  mode: z.enum(['OFF', 'CONFIRM', 'AUTO']).optional(),
  riskPerTradePct: z.number().min(RISK_LIMITS.live.riskPerTradePct.min).max(RISK_LIMITS.live.riskPerTradePct.max).optional(),
  maxOpenPositions: z.number().int().min(1).max(10).optional(),
  maxLotsPerTrade: z.number().int().min(1).max(50).optional(),
  maxTradesPerDay: z.number().int().min(1).max(20).optional(),
  maxDailyLossPct: z.number().min(RISK_LIMITS.live.dailyLossPct.min).max(RISK_LIMITS.live.dailyLossPct.max).optional(),
  underlyings: z.array(z.string().min(1).max(20)).min(1).max(6).optional(),
  minGrade: z.enum(['A', 'B', 'C']).optional(),
  allowExpiryDay: z.boolean().optional(),
  windowStartMin: z.number().int().min(555).max(930).optional(),
  windowEndMin: z.number().int().min(555).max(930).optional(),
  squareOffMin: z.number().int().min(600).max(925).optional(),
  product: z.enum(['INTRADAY', 'CARRYFORWARD']).optional(),
  scaleOut: z.boolean().optional(),
  entryTimeoutSec: z.number().int().min(15).max(600).optional(),
  heroZeroEnabled: z.boolean().optional(),
  heroZeroBudget: z.number().min(500).max(500000).optional(),
  heroZeroMinPremium: z.number().min(0.5).max(100).optional(),
  heroZeroMaxPremium: z.number().min(1).max(200).optional(),
  heroZeroMaxLots: z.number().int().min(1).max(20).optional(),
  heroZeroMaxTradesPerDay: z.number().int().min(1).max(5).optional(),
  heroZeroWindowStartMin: z.number().int().min(555).max(925).optional(),
  heroZeroWindowEndMin: z.number().int().min(555).max(925).optional(),
  heroZeroSquareOffMin: z.number().int().min(600).max(928).optional(),
  heroZeroStopPct: z.number().min(0).max(90).optional(),
  heroZeroTargetMultiple: z.number().min(1.5).max(10).optional(),
  heroZeroMinAgree: z.number().int().min(3).max(7).optional(),
  horizon: z.enum(['intraday', 'swing']).optional(),
  directionGuard: z.boolean().optional(),
  requireTimingAgreement: z.boolean().optional(),
  requireNamedSetup: z.boolean().optional(),
  reentryCooldownMin: z.number().int().min(0).max(240).optional(),
  cutLoserAtR: z.number().min(0).max(2).optional(),
  stopAtrMultiple: z.number().min(0.5).max(3).optional(),
  target1R: z.number().min(0.5).max(5).optional(),
  target2R: z.number().min(0.75).max(10).optional(),
});

liveRouter.get('/status', asyncHandler(async (req, res) => {
  respond(res, await live.getLiveStatus(req.user!.id));
}));

liveRouter.get('/config', asyncHandler(async (req, res) => {
  respond(res, await live.getLiveConfig(req.user!.id));
}));

liveRouter.put(
  '/config',
  validate(configSchema),
  auditLog('live.config', 'live_trade_config'),
  asyncHandler(async (req, res) => {
    try {
      respond(res, await live.upsertLiveConfig(req.user!.id, req.body as z.infer<typeof configSchema>));
    } catch (err) {
      throw badRequest(err instanceof Error ? err.message : 'could not save');
    }
  }),
);

/** The real account balance, fetched from the broker on every call. */
liveRouter.get('/funds', asyncHandler(async (req, res) => {
  try {
    respond(res, await live.brokerFunds(req.user!.id));
  } catch (err) {
    throw badRequest(err instanceof Error ? err.message : 'could not fetch funds');
  }
}));

/** Arm for today. The capital base is read from the broker, not the request. */
liveRouter.post(
  '/arm',
  auditLog('live.arm', 'live_trade_config'),
  asyncHandler(async (req, res) => {
    try {
      respond(res, await live.arm(req.user!.id));
    } catch (err) {
      throw badRequest(err instanceof Error ? err.message : 'could not arm');
    }
  }),
);

liveRouter.post('/disarm', auditLog('live.disarm', 'live_trade_config'), asyncHandler(async (req, res) => {
  await live.disarm(req.user!.id);
  respond(res, { disarmed: true });
}));

liveRouter.post('/kill', auditLog('live.kill', 'live_trade_config'), asyncHandler(async (req, res) => {
  respond(res, await live.killSwitch(req.user!.id));
}));

liveRouter.post('/kill/reset', auditLog('live.kill.reset', 'live_trade_config'), asyncHandler(async (req, res) => {
  await live.resetKillSwitch(req.user!.id);
  respond(res, { reset: true });
}));

/** Place the entry for the decision the user is looking at. CONFIRM mode. */
liveRouter.post(
  '/execute',
  validate(z.object({ underlying: z.string().min(1).max(20) })),
  auditLog('live.execute', 'live_trades'),
  asyncHandler(async (req, res) => {
    const { underlying } = req.body as { underlying: string };
    const result = await live.executeLive(req.user!.id, underlying.toUpperCase(), 'CONFIRM');
    if (!result.placed) throw badRequest(result.reason);
    respond(res, result, {}, 201);
  }),
);

/** Hero Zero: today's read on each underlying, the settings and the attempt count. */
liveRouter.get('/hero-zero', asyncHandler(async (req, res) => {
  const scan = await hero.heroZeroScan(req.user!.id);
  if (!scan) throw badRequest('Live trading is not set up yet. Save your settings first.');
  respond(res, scan);
}));

/** Place the Hero Zero order the user is looking at. CONFIRM mode. */
liveRouter.post(
  '/hero-zero/execute',
  validate(z.object({ underlying: z.string().min(1).max(20) })),
  auditLog('live.hero_zero.execute', 'live_trades'),
  asyncHandler(async (req, res) => {
    const { underlying } = req.body as { underlying: string };
    const result = await hero.executeHeroZero(req.user!.id, underlying.toUpperCase(), 'CONFIRM');
    if (!result.placed) throw badRequest(result.reason);
    respond(res, result, {}, 201);
  }),
);

const listSchema = z.object({
  status: z.enum(['ACTIVE', 'CLOSED']).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

liveRouter.get('/trades', validate(listSchema, 'query'), asyncHandler(async (req, res) => {
  const q = req.query as unknown as z.infer<typeof listSchema>;
  respond(res, await live.listLiveTrades(req.user!.id, { ...(q.status ? { status: q.status } : {}), limit: q.limit }));
}));

liveRouter.post(
  '/trades/:id/close',
  validate(z.object({ id: z.coerce.number().int().positive() }), 'params'),
  auditLog('live.close', 'live_trades'),
  asyncHandler(async (req, res) => {
    const { id } = req.params as unknown as { id: number };
    const r = await live.closeLive(req.user!.id, id);
    if (!r.ok) throw badRequest(r.reason);
    respond(res, r);
  }),
);

/** Reconcile with the broker now, instead of waiting for the worker. */
liveRouter.post('/sync', asyncHandler(async (req, res) => {
  await live.syncLiveOrders(req.user!.id);
  const reconciled = await live.reconcileWithBroker(req.user!.id);
  await live.manageLiveExits(req.user!.id);
  respond(res, { synced: true, reconciled });
}));

liveRouter.get('/performance', asyncHandler(async (req, res) => {
  respond(res, await live.livePerformance(req.user!.id));
}));
