/**
 * Live trading routes. Every mutating call is audit-logged: these are the
 * endpoints that move real money.
 */
import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, respond, requireAuth, validate, auditLog } from '../../middleware/index.js';
import { badRequest } from '../../utils/errors.js';
import * as live from './live.service.js';

export const liveRouter = Router();
liveRouter.use(requireAuth);

const configSchema = z.object({
  mode: z.enum(['OFF', 'CONFIRM', 'AUTO']).optional(),
  riskPerTradePct: z.number().min(0.1).max(10).optional(),
  maxOpenPositions: z.number().int().min(1).max(10).optional(),
  maxLotsPerTrade: z.number().int().min(1).max(50).optional(),
  maxTradesPerDay: z.number().int().min(1).max(20).optional(),
  maxDailyLossPct: z.number().min(0.1).max(25).optional(),
  underlyings: z.array(z.string().min(1).max(20)).min(1).max(6).optional(),
  minGrade: z.enum(['A', 'B', 'C']).optional(),
  allowExpiryDay: z.boolean().optional(),
  windowStartMin: z.number().int().min(555).max(930).optional(),
  windowEndMin: z.number().int().min(555).max(930).optional(),
  squareOffMin: z.number().int().min(600).max(925).optional(),
  product: z.enum(['INTRADAY', 'CARRYFORWARD']).optional(),
  scaleOut: z.boolean().optional(),
  entryTimeoutSec: z.number().int().min(15).max(600).optional(),
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
  await live.manageLiveExits(req.user!.id);
  respond(res, { synced: true });
}));

liveRouter.get('/performance', asyncHandler(async (req, res) => {
  respond(res, await live.livePerformance(req.user!.id));
}));
