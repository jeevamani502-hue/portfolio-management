/**
 * Alerts: creation, listing, and the evaluation logic the worker calls.
 *
 * An alert fires only against data the platform actually holds. If a quote is
 * unavailable the alert does not fire and does not "assume no change" — it is
 * skipped and the reason recorded, because a price alert that silently stops
 * working is worse than one that visibly cannot evaluate.
 */
import { Router } from 'express';
import { z } from 'zod';
import {
  asyncHandler, respond, requireAuth, validate, auditLog, timeframeSchema,
} from '../../middleware/index.js';
import { query, queryOne, queryRows } from '../../db/pool.js';
import { notFound, badRequest } from '../../utils/errors.js';
import * as instrumentsRepo from '../../db/repositories/instruments.js';
import { redis } from '../../cache/redis.js';
import { K } from '../../cache/keys.js';

export const alertsRouter = Router();
alertsRouter.use(requireAuth);

const ALERT_KINDS = [
  'PRICE_ABOVE', 'PRICE_BELOW', 'PCT_CHANGE', 'RSI_ABOVE', 'RSI_BELOW',
  'VOLUME_MULTIPLE', 'BREAKOUT', 'SUPPORT_BROKEN', 'OI_CHANGE_PCT', 'NEWS', 'SIGNAL',
] as const;

/** What each alert kind requires in `params`, validated per kind. */
const PARAM_SCHEMAS: Record<string, z.ZodTypeAny> = {
  PRICE_ABOVE: z.object({ threshold: z.number().positive() }),
  PRICE_BELOW: z.object({ threshold: z.number().positive() }),
  PCT_CHANGE: z.object({ threshold: z.number().positive().max(100) }),
  RSI_ABOVE: z.object({ threshold: z.number().min(0).max(100) }),
  RSI_BELOW: z.object({ threshold: z.number().min(0).max(100) }),
  VOLUME_MULTIPLE: z.object({ threshold: z.number().positive().max(50) }),
  OI_CHANGE_PCT: z.object({ threshold: z.number().positive().max(1000) }),
  BREAKOUT: z.object({ lookback: z.number().int().min(5).max(250).default(20) }),
  SUPPORT_BROKEN: z.object({}).passthrough(),
  NEWS: z.object({}).passthrough(),
  SIGNAL: z.object({
    setup: z.string().optional(),
    minStrength: z.number().min(0).max(100).default(60),
  }),
};

const createSchema = z.object({
  symbol: z.string().min(1).max(64).optional(),
  name: z.string().max(120).optional(),
  kind: z.enum(ALERT_KINDS),
  params: z.record(z.unknown()).default({}),
  timeframe: timeframeSchema,
  channels: z.array(z.enum(['browser', 'email', 'telegram'])).min(1).default(['browser']),
  repeatMode: z.enum(['ONCE', 'DAILY', 'ALWAYS']).default('ONCE'),
  cooldownSec: z.number().int().min(30).max(86400).default(300),
});

/** Kinds that operate on the market as a whole rather than one instrument. */
const MARKET_WIDE = new Set(['NEWS']);

alertsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const rows = await queryRows<{
      id: string; name: string | null; kind: string; params: Record<string, unknown>;
      timeframe: string; channels: string[]; is_active: boolean; repeat_mode: string;
      cooldown_sec: number; last_fired_at: Date | null; fire_count: number;
      created_at: Date; tradingsymbol: string | null; exchange: string | null;
      instrument_name: string | null;
    }>(
      `SELECT a.id, a.name, a.kind, a.params, a.timeframe, a.channels, a.is_active,
              a.repeat_mode, a.cooldown_sec, a.last_fired_at, a.fire_count, a.created_at,
              i.tradingsymbol, i.exchange, i.name AS instrument_name
         FROM alerts a LEFT JOIN instruments i ON i.id = a.instrument_id
        WHERE a.user_id = $1
        ORDER BY a.is_active DESC, a.created_at DESC`,
      [req.user!.id],
    );

    respond(res, rows.map((r) => ({
      id: r.id,
      name: r.name,
      kind: r.kind,
      params: r.params,
      timeframe: r.timeframe,
      channels: r.channels,
      isActive: r.is_active,
      repeatMode: r.repeat_mode,
      cooldownSec: r.cooldown_sec,
      lastFiredAt: r.last_fired_at?.toISOString() ?? null,
      fireCount: r.fire_count,
      createdAt: r.created_at.toISOString(),
      symbol: r.tradingsymbol ? `${r.exchange}:${r.tradingsymbol}` : null,
      instrumentName: r.instrument_name,
    })));
  }),
);

alertsRouter.get(
  '/kinds',
  asyncHandler(async (_req, res) => {
    respond(res, [
      { kind: 'PRICE_ABOVE', label: 'Price crosses above', params: ['threshold'], needsSymbol: true },
      { kind: 'PRICE_BELOW', label: 'Price crosses below', params: ['threshold'], needsSymbol: true },
      { kind: 'PCT_CHANGE', label: 'Day change exceeds %', params: ['threshold'], needsSymbol: true },
      { kind: 'RSI_ABOVE', label: 'RSI rises above', params: ['threshold'], needsSymbol: true },
      { kind: 'RSI_BELOW', label: 'RSI falls below', params: ['threshold'], needsSymbol: true },
      { kind: 'VOLUME_MULTIPLE', label: 'Volume exceeds N× average', params: ['threshold'], needsSymbol: true },
      { kind: 'BREAKOUT', label: 'Breaks N-bar high', params: ['lookback'], needsSymbol: true },
      { kind: 'SUPPORT_BROKEN', label: 'Closes below mapped support', params: [], needsSymbol: true },
      { kind: 'OI_CHANGE_PCT', label: 'Open interest changes by %', params: ['threshold'], needsSymbol: true },
      { kind: 'SIGNAL', label: 'Rule-based setup detected', params: ['setup', 'minStrength'], needsSymbol: true },
      { kind: 'NEWS', label: 'News mentions this instrument', params: [], needsSymbol: false },
    ], {
      note:
        'Alerts are evaluated by a background worker against the same data the rest of the platform uses. ' +
        'When a price cannot be sourced the alert is skipped and the reason logged — it never assumes an unchanged value.',
    });
  }),
);

alertsRouter.post(
  '/',
  validate(createSchema),
  auditLog('alert.create', 'alerts'),
  asyncHandler(async (req, res) => {
    const b = req.body as z.infer<typeof createSchema>;

    const paramSchema = PARAM_SCHEMAS[b.kind];
    const parsed = paramSchema ? paramSchema.safeParse(b.params) : { success: true as const, data: b.params };
    if (!parsed.success) {
      throw badRequest(
        `Invalid parameters for a ${b.kind} alert`,
        'error' in parsed ? parsed.error.issues : undefined,
      );
    }

    let instrumentId: number | null = null;
    if (b.symbol) {
      const instrument = await instrumentsRepo.resolveSymbol(b.symbol);
      if (!instrument) throw badRequest(`No instrument matches "${b.symbol}"`);
      instrumentId = instrument.id;
    } else if (!MARKET_WIDE.has(b.kind)) {
      throw badRequest(`A ${b.kind} alert requires a symbol`);
    }

    const row = await queryOne<{ id: string }>(
      `INSERT INTO alerts
         (user_id, instrument_id, name, kind, params, timeframe, channels, repeat_mode, cooldown_sec)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9)
       RETURNING id`,
      [
        req.user!.id, instrumentId, b.name ?? null, b.kind,
        JSON.stringify(parsed.data ?? {}), b.timeframe, b.channels,
        b.repeatMode, b.cooldownSec,
      ],
    );

    // Keep the evaluator's hot set current so it only polls watched instruments.
    if (instrumentId !== null) await redis.sadd(K.alertWatchSet, String(instrumentId));

    respond(res, { id: row!.id, created: true }, {}, 201);
  }),
);

const patchSchema = z.object({
  name: z.string().max(120).optional(),
  isActive: z.boolean().optional(),
  channels: z.array(z.enum(['browser', 'email', 'telegram'])).min(1).optional(),
  repeatMode: z.enum(['ONCE', 'DAILY', 'ALWAYS']).optional(),
  cooldownSec: z.number().int().min(30).max(86400).optional(),
  params: z.record(z.unknown()).optional(),
});

alertsRouter.patch(
  '/:id',
  validate(z.object({ id: z.string().uuid() }), 'params'),
  validate(patchSchema),
  auditLog('alert.update', 'alerts'),
  asyncHandler(async (req, res) => {
    const { id } = req.params as unknown as { id: string };
    const b = req.body as z.infer<typeof patchSchema>;

    const result = await query(
      `UPDATE alerts SET
         name = COALESCE($3, name),
         is_active = COALESCE($4, is_active),
         channels = COALESCE($5, channels),
         repeat_mode = COALESCE($6, repeat_mode),
         cooldown_sec = COALESCE($7, cooldown_sec),
         params = COALESCE($8::jsonb, params)
       WHERE id = $1 AND user_id = $2`,
      [
        id, req.user!.id, b.name ?? null, b.isActive ?? null,
        b.channels ?? null, b.repeatMode ?? null, b.cooldownSec ?? null,
        b.params ? JSON.stringify(b.params) : null,
      ],
    );
    if (result.rowCount === 0) throw notFound('Alert not found');
    respond(res, { updated: true });
  }),
);

alertsRouter.delete(
  '/:id',
  validate(z.object({ id: z.string().uuid() }), 'params'),
  auditLog('alert.delete', 'alerts'),
  asyncHandler(async (req, res) => {
    const { id } = req.params as unknown as { id: string };
    const result = await query(`DELETE FROM alerts WHERE id = $1 AND user_id = $2`, [
      id, req.user!.id,
    ]);
    if (result.rowCount === 0) throw notFound('Alert not found');
    respond(res, { deleted: true });
  }),
);

alertsRouter.get(
  '/:id/events',
  validate(z.object({ id: z.string().uuid() }), 'params'),
  asyncHandler(async (req, res) => {
    const { id } = req.params as unknown as { id: string };
    const owned = await queryOne<{ id: string }>(
      `SELECT id FROM alerts WHERE id = $1 AND user_id = $2`,
      [id, req.user!.id],
    );
    if (!owned) throw notFound('Alert not found');

    const rows = await queryRows<{
      triggered_at: Date; observed: Record<string, unknown>; source: string;
      data_as_of: Date; delivered: Record<string, unknown>;
    }>(
      `SELECT triggered_at, observed, source, data_as_of, delivered
         FROM alert_events WHERE alert_id = $1 ORDER BY triggered_at DESC LIMIT 100`,
      [id],
    );

    respond(res, rows.map((r) => ({
      triggeredAt: r.triggered_at.toISOString(),
      observed: r.observed,
      source: r.source,
      dataAsOf: r.data_as_of.toISOString(),
      delivered: r.delivered,
    })), {
      note: 'Each event records the exact values that satisfied the rule, with their source and timestamp.',
    });
  }),
);
