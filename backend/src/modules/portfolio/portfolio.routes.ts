import { Router } from 'express';
import { z } from 'zod';
import {
  asyncHandler, respond, requireAuth, validate, auditLog, paginationSchema,
} from '../../middleware/index.js';
import { registryForUser } from '../../providers/registry.js';
import { isAvailable } from '../../utils/sourced.js';
import {
  listPortfolios, getPortfolio, getDefaultPortfolio, loadHoldings,
  addHolding, updateHolding, deleteHolding, addTransaction, listTransactions,
  analyzePortfolio, summariseHealth,
} from './portfolio.service.js';
import { query, queryOne } from '../../db/pool.js';
import { badRequest } from '../../utils/errors.js';
import { importHoldings } from './import.service.js';
import type { ProviderId } from '../../providers/types.js';

export const portfolioRouter = Router();
portfolioRouter.use(requireAuth);

const idParam = z.object({ id: z.string().uuid() });
const holdingParam = z.object({ id: z.string().uuid(), holdingId: z.string().uuid() });

// ── portfolios ──────────────────────────────────────────────────────────────

portfolioRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const list = await listPortfolios(req.user!.id);
    respond(
      res,
      list.map((p) => ({
        id: p.id, name: p.name, currency: p.currency,
        broker: p.broker, isDefault: p.is_default,
        createdAt: p.created_at.toISOString(),
      })),
    );
  }),
);

const createPortfolioSchema = z.object({
  name: z.string().min(1).max(80),
  currency: z.string().length(3).default('INR'),
});

portfolioRouter.post(
  '/',
  validate(createPortfolioSchema),
  auditLog('portfolio.create', 'portfolio'),
  asyncHandler(async (req, res) => {
    const { name, currency } = req.body as z.infer<typeof createPortfolioSchema>;
    const row = await queryOne<{ id: string }>(
      `INSERT INTO portfolios (user_id, name, currency) VALUES ($1,$2,$3)
       ON CONFLICT (user_id, name) DO NOTHING RETURNING id`,
      [req.user!.id, name, currency],
    );
    if (!row) throw badRequest(`A portfolio named "${name}" already exists`);
    respond(res, { id: row.id, name, currency }, {}, 201);
  }),
);

/** Summary of the user's default portfolio — what the dashboard card needs. */
portfolioRouter.get(
  '/summary',
  asyncHandler(async (req, res) => {
    const portfolio = await getDefaultPortfolio(req.user!.id);
    const registry = await registryForUser(req.user!.id);
    const analysis = await analyzePortfolio(registry, req.user!.id, portfolio.id);

    if (!isAvailable(analysis)) return respond(res, analysis);

    respond(res, {
      ...analysis,
      value: {
        portfolio: analysis.value.portfolio,
        health: summariseHealth(analysis.value),
      },
    });
  }),
);

portfolioRouter.get(
  '/:id',
  validate(idParam, 'params'),
  asyncHandler(async (req, res) => {
    const { id } = req.params as unknown as z.infer<typeof idParam>;
    const portfolio = await getPortfolio(req.user!.id, id);
    const holdings = await loadHoldings(id);
    respond(res, {
      portfolio: {
        id: portfolio.id, name: portfolio.name, currency: portfolio.currency,
        broker: portfolio.broker, isDefault: portfolio.is_default,
      },
      holdings: holdings.map((h) => ({
        id: h.id,
        instrumentId: h.instrument_id,
        symbol: `${h.exchange}:${h.tradingsymbol}`,
        tradingsymbol: h.tradingsymbol,
        name: h.name,
        sector: h.sector,
        quantity: h.quantity,
        avgPrice: h.avg_price,
        invested: h.quantity * h.avg_price,
        realizedPnl: h.realized_pnl,
        notes: h.notes,
      })),
    });
  }),
);

portfolioRouter.get(
  '/:id/analysis',
  validate(idParam, 'params'),
  asyncHandler(async (req, res) => {
    const { id } = req.params as unknown as z.infer<typeof idParam>;
    const registry = await registryForUser(req.user!.id);
    respond(res, await analyzePortfolio(registry, req.user!.id, id));
  }),
);

portfolioRouter.get(
  '/:id/health',
  validate(idParam, 'params'),
  asyncHandler(async (req, res) => {
    const { id } = req.params as unknown as z.infer<typeof idParam>;
    const registry = await registryForUser(req.user!.id);
    const analysis = await analyzePortfolio(registry, req.user!.id, id);
    if (!isAvailable(analysis)) return respond(res, analysis);
    respond(res, {
      ...analysis,
      value: {
        health: summariseHealth(analysis.value),
        observations: analysis.value.observations,
      },
    });
  }),
);

// ── holdings ────────────────────────────────────────────────────────────────

const addHoldingSchema = z.object({
  symbol: z.string().min(1).max(64),
  quantity: z.number().positive(),
  avgPrice: z.number().nonnegative(),
  notes: z.string().max(500).optional(),
});

portfolioRouter.post(
  '/:id/holding',
  validate(idParam, 'params'),
  validate(addHoldingSchema),
  auditLog('portfolio.holding.add', 'portfolio'),
  asyncHandler(async (req, res) => {
    const { id } = req.params as unknown as z.infer<typeof idParam>;
    const body = req.body as z.infer<typeof addHoldingSchema>;
    respond(res, await addHolding(req.user!.id, id, body), {}, 201);
  }),
);

const patchHoldingSchema = z.object({
  quantity: z.number().nonnegative().optional(),
  avgPrice: z.number().nonnegative().optional(),
  notes: z.string().max(500).optional(),
});

portfolioRouter.patch(
  '/:id/holding/:holdingId',
  validate(holdingParam, 'params'),
  validate(patchHoldingSchema),
  auditLog('portfolio.holding.update', 'portfolio'),
  asyncHandler(async (req, res) => {
    const { id, holdingId } = req.params as unknown as z.infer<typeof holdingParam>;
    await updateHolding(req.user!.id, id, holdingId, req.body as z.infer<typeof patchHoldingSchema>);
    respond(res, { updated: true });
  }),
);

portfolioRouter.delete(
  '/:id/holding/:holdingId',
  validate(holdingParam, 'params'),
  auditLog('portfolio.holding.delete', 'portfolio'),
  asyncHandler(async (req, res) => {
    const { id, holdingId } = req.params as unknown as z.infer<typeof holdingParam>;
    await deleteHolding(req.user!.id, id, holdingId);
    respond(res, { deleted: true });
  }),
);

// ── transactions ────────────────────────────────────────────────────────────

const addTransactionSchema = z.object({
  symbol: z.string().min(1).max(64).optional(),
  side: z.enum(['BUY', 'SELL', 'DIVIDEND', 'BONUS', 'SPLIT', 'DEPOSIT', 'WITHDRAWAL', 'CHARGE']),
  quantity: z.number().nonnegative().optional(),
  price: z.number().nonnegative().optional(),
  amount: z.number().optional(),
  charges: z.number().nonnegative().default(0),
  tradedAt: z.coerce.date(),
  notes: z.string().max(500).optional(),
  externalId: z.string().max(120).optional(),
});

portfolioRouter.post(
  '/:id/transaction',
  validate(idParam, 'params'),
  validate(addTransactionSchema),
  auditLog('portfolio.transaction.add', 'portfolio'),
  asyncHandler(async (req, res) => {
    const { id } = req.params as unknown as z.infer<typeof idParam>;
    const body = req.body as z.infer<typeof addTransactionSchema>;
    respond(res, await addTransaction(req.user!.id, id, body), {}, 201);
  }),
);

portfolioRouter.get(
  '/:id/transactions',
  validate(idParam, 'params'),
  validate(paginationSchema, 'query'),
  asyncHandler(async (req, res) => {
    const { id } = req.params as unknown as z.infer<typeof idParam>;
    const { limit, offset } = req.query as unknown as z.infer<typeof paginationSchema>;
    await getPortfolio(req.user!.id, id);
    respond(res, await listTransactions(id, limit, offset));
  }),
);

// ── broker import ───────────────────────────────────────────────────────────

const importSchema = z.object({
  /** Delete holdings the broker no longer reports. Off by default. */
  removeMissing: z.boolean().default(false),
});

portfolioRouter.post(
  '/:id/import/:provider',
  validate(z.object({ id: z.string().uuid(), provider: z.string().max(40) }), 'params'),
  validate(importSchema),
  auditLog('portfolio.import', 'portfolio'),
  asyncHandler(async (req, res) => {
    const { id, provider } = req.params as unknown as { id: string; provider: string };
    const { removeMissing } = req.body as z.infer<typeof importSchema>;
    const registry = await registryForUser(req.user!.id);

    respond(
      res,
      await importHoldings(registry, req.user!.id, id, provider as ProviderId, { removeMissing }),
    );
  }),
);

/** Which configured providers can supply holdings. */
portfolioRouter.get(
  '/import/sources',
  asyncHandler(async (req, res) => {
    const registry = await registryForUser(req.user!.id);
    respond(
      res,
      registry
        .all()
        .filter((p) => p.manifest.capabilities.includes('holdings'))
        .map((p) => ({
          id: p.manifest.id,
          displayName: p.manifest.displayName,
          configured: p.isConfigured(),
        })),
    );
  }),
);

portfolioRouter.get(
  '/:id/snapshots',
  validate(idParam, 'params'),
  asyncHandler(async (req, res) => {
    const { id } = req.params as unknown as z.infer<typeof idParam>;
    await getPortfolio(req.user!.id, id);
    const { rows } = await query<{
      snapshot_date: Date; market_value: number; invested: number;
      unrealized_pnl: number; day_pnl: number | null;
    }>(
      `SELECT snapshot_date, market_value, invested, unrealized_pnl, day_pnl
         FROM portfolio_snapshots WHERE portfolio_id = $1 ORDER BY snapshot_date`,
      [id],
    );
    respond(res, rows.map((r) => ({
      date: r.snapshot_date.toISOString().slice(0, 10),
      marketValue: r.market_value,
      invested: r.invested,
      unrealizedPnl: r.unrealized_pnl,
      dayPnl: r.day_pnl,
    })), {
      note: rows.length === 0
        ? 'No daily snapshots recorded yet. The portfolio-valuation worker writes one per trading day; risk metrics and the equity curve populate from these.'
        : undefined,
    });
  }),
);
