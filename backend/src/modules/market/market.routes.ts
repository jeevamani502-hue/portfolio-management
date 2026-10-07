import { Router } from 'express';
import { z } from 'zod';
import {
  asyncHandler, respond, requireAuth, validate, timeframeSchema, symbolParamSchema,
} from '../../middleware/index.js';
import { notFound, dataUnavailable } from '../../utils/errors.js';
import { computeIndicators } from './indicators.service.js';
import { registryForUser } from '../../providers/registry.js';
import * as instrumentsRepo from '../../db/repositories/instruments.js';
import { getQuote, getQuotes, getCandles, marketStatus } from './marketData.service.js';
import {
  getIndices, getBreadth, getMovers, getSectorPerformance, getRegime,
  HEADLINE_INDICES, type MoverKind,
} from './market.service.js';
import { collectSources, isAvailable } from '../../utils/sourced.js';
import { formatIstDateTime } from '../../utils/time.js';

export const marketRouter = Router();

marketRouter.use(requireAuth);

// ── market status ───────────────────────────────────────────────────────────

marketRouter.get(
  '/status',
  asyncHandler(async (_req, res) => {
    const status = await marketStatus();
    respond(res, {
      ...status,
      label:
        status.phase === 'OPEN' ? 'Market open'
        : status.phase === 'PRE_OPEN' ? 'Pre-open session'
        : status.phase === 'CLOSING' ? 'Closing session'
        : status.phase === 'POST' ? 'Post-close session'
        : status.phase === 'WEEKEND' ? 'Weekend — market closed'
        : status.phase === 'HOLIDAY' ? 'Trading holiday'
        : 'Market closed',
    });
  }),
);

// ── indices ─────────────────────────────────────────────────────────────────

const indicesQuery = z.object({
  symbols: z.string().optional(),
});

marketRouter.get(
  '/indices',
  validate(indicesQuery, 'query'),
  asyncHandler(async (req, res) => {
    const registry = await registryForUser(req.user!.id);
    const { symbols } = req.query as unknown as z.infer<typeof indicesQuery>;
    const list = symbols
      ? symbols.split(',').map((s) => s.trim()).filter(Boolean)
      : [...HEADLINE_INDICES];

    const result = await getIndices(registry, list);
    respond(res, result, {
      sources: collectSources(result.map((r) => r.data)),
      istTime: formatIstDateTime(),
    });
  }),
);

// ── breadth / sectors / movers / regime ─────────────────────────────────────

const scopeQuery = z.object({
  scope: z.string().max(40).default('NIFTY50'),
});

marketRouter.get(
  '/breadth',
  validate(scopeQuery, 'query'),
  asyncHandler(async (req, res) => {
    const registry = await registryForUser(req.user!.id);
    const { scope } = req.query as unknown as z.infer<typeof scopeQuery>;
    respond(res, await getBreadth(registry, scope));
  }),
);

marketRouter.get(
  '/sectors',
  validate(scopeQuery, 'query'),
  asyncHandler(async (req, res) => {
    const registry = await registryForUser(req.user!.id);
    const { scope } = req.query as unknown as z.infer<typeof scopeQuery>;
    respond(res, await getSectorPerformance(registry, scope));
  }),
);

const moversQuery = z.object({
  type: z.enum([
    'gainers', 'losers', 'volume', 'gapup', 'gapdown', 'near52high', 'near52low', 'active',
  ]).default('gainers'),
  scope: z.string().max(40).default('NIFTY50'),
  limit: z.coerce.number().int().min(1).max(50).default(10),
});

marketRouter.get(
  '/movers',
  validate(moversQuery, 'query'),
  asyncHandler(async (req, res) => {
    const registry = await registryForUser(req.user!.id);
    const { type, scope, limit } = req.query as unknown as z.infer<typeof moversQuery>;
    respond(res, await getMovers(registry, type as MoverKind, { scope, limit }));
  }),
);

marketRouter.get(
  '/regime',
  asyncHandler(async (req, res) => {
    const registry = await registryForUser(req.user!.id);
    respond(res, await getRegime(registry));
  }),
);

// ── quotes ──────────────────────────────────────────────────────────────────

marketRouter.get(
  '/quote/:symbol',
  validate(symbolParamSchema, 'params'),
  asyncHandler(async (req, res) => {
    const { symbol } = req.params as unknown as z.infer<typeof symbolParamSchema>;
    const instrument = await instrumentsRepo.resolveSymbol(symbol);
    if (!instrument) throw notFound(`No instrument matches "${symbol}"`);

    const registry = await registryForUser(req.user!.id);
    const quote = await getQuote(registry, instrument);

    respond(res, {
      instrument: {
        id: instrument.id,
        symbol: `${instrument.exchange}:${instrument.tradingsymbol}`,
        tradingsymbol: instrument.tradingsymbol,
        name: instrument.name,
        exchange: instrument.exchange,
        instrumentType: instrument.instrument_type,
        sector: instrument.sector,
        lotSize: instrument.lot_size,
      },
      quote,
    });
  }),
);

const batchQuoteSchema = z.object({
  symbols: z.array(z.string().min(1).max(64)).min(1).max(100),
});

marketRouter.post(
  '/quotes',
  validate(batchQuoteSchema),
  asyncHandler(async (req, res) => {
    const { symbols } = req.body as z.infer<typeof batchQuoteSchema>;
    const resolved = await Promise.all(
      symbols.map(async (s) => ({ input: s, row: await instrumentsRepo.resolveSymbol(s) })),
    );
    const found = resolved.filter((r): r is { input: string; row: NonNullable<typeof r.row> } => r.row !== null);

    const registry = await registryForUser(req.user!.id);
    const quotes = await getQuotes(registry, found.map((f) => f.row));

    const data = resolved.map(({ input, row }) => ({
      requested: input,
      symbol: row ? `${row.exchange}:${row.tradingsymbol}` : null,
      resolved: row !== null,
      quote: row ? (quotes.get(row.id) ?? null) : null,
    }));

    respond(res, data, {
      sources: collectSources(
        data.map((d) => d.quote).filter((q): q is NonNullable<typeof q> => q !== null),
      ),
    });
  }),
);

// ── history ─────────────────────────────────────────────────────────────────

const historyQuery = z.object({
  tf: timeframeSchema,
  bars: z.coerce.number().int().min(10).max(2000).default(300),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

marketRouter.get(
  '/history/:symbol',
  validate(symbolParamSchema, 'params'),
  validate(historyQuery, 'query'),
  asyncHandler(async (req, res) => {
    const { symbol } = req.params as unknown as z.infer<typeof symbolParamSchema>;
    const { tf, bars, from, to } = req.query as unknown as z.infer<typeof historyQuery>;

    const instrument = await instrumentsRepo.resolveSymbol(symbol);
    if (!instrument) throw notFound(`No instrument matches "${symbol}"`);

    const registry = await registryForUser(req.user!.id);
    try {
      const result = await getCandles(registry, instrument, tf, {
        bars,
        ...(from && to ? { from, to } : {}),
      });
      respond(res, {
        symbol: `${instrument.exchange}:${instrument.tradingsymbol}`,
        timeframe: tf,
        candles: result.candles,
        count: result.candles.length,
      }, {
        source: result.source,
        asOf: result.asOf,
        dataStatus: result.fromStorage ? 'stored' : 'live',
      });
    } catch (err) {
      throw dataUnavailable(
        `${instrument.tradingsymbol} (${tf})`,
        err instanceof Error ? err.message : 'unknown error',
      );
    }
  }),
);

// ── search ──────────────────────────────────────────────────────────────────

const searchQuery = z.object({
  q: z.string().min(1).max(64),
  limit: z.coerce.number().int().min(1).max(50).default(15),
  types: z.string().optional(),
});

marketRouter.get(
  '/search',
  validate(searchQuery, 'query'),
  asyncHandler(async (req, res) => {
    const { q, limit, types } = req.query as unknown as z.infer<typeof searchQuery>;
    const parsedTypes = types
      ? (types.split(',').map((t) => t.trim().toUpperCase()) as Array<'EQ' | 'INDEX' | 'ETF' | 'FUT' | 'CE' | 'PE'>)
      : undefined;

    const rows = await instrumentsRepo.searchInstruments(q, {
      limit,
      ...(parsedTypes ? { types: parsedTypes } : {}),
    });

    respond(
      res,
      rows.map((r) => ({
        id: r.id,
        symbol: `${r.exchange}:${r.tradingsymbol}`,
        tradingsymbol: r.tradingsymbol,
        name: r.name,
        exchange: r.exchange,
        instrumentType: r.instrument_type,
        sector: r.sector,
        lotSize: r.lot_size,
      })),
    );
  }),
);

/**
 * Candles plus indicator series, aligned index-for-index.
 *
 * One request rather than two so the chart cannot render a line against a
 * different set of bars from the ones it was computed on.
 */
const chartSchema = z.object({
  tf: timeframeSchema,
  bars: z.coerce.number().int().min(50).max(1000).default(300),
  overlays: z.string().optional(),
  panes: z.string().optional(),
});

marketRouter.get(
  '/chart/:symbol',
  validate(symbolParamSchema, 'params'),
  validate(chartSchema, 'query'),
  asyncHandler(async (req, res) => {
    const { symbol } = req.params as unknown as z.infer<typeof symbolParamSchema>;
    const q = req.query as unknown as z.infer<typeof chartSchema>;

    const instrument = await instrumentsRepo.resolveSymbol(symbol);
    if (!instrument) throw notFound(`No instrument matches "${symbol}"`);

    const registry = await registryForUser(req.user!.id);
    const result = await getCandles(registry, instrument, q.tf, { bars: q.bars });

    if (result.candles.length === 0) {
      throw dataUnavailable(
        `${instrument.tradingsymbol} (${q.tf})`,
        'no price history returned for this timeframe',
      );
    }

    const split = (v: string | undefined) =>
      v === undefined ? undefined : v.split(',').map((x) => x.trim()).filter(Boolean);

    respond(
      res,
      {
        symbol: `${instrument.exchange}:${instrument.tradingsymbol}`,
        name: instrument.name,
        timeframe: q.tf,
        candles: result.candles,
        indicators: computeIndicators(result.candles, {
          ...(split(q.overlays) ? { overlays: split(q.overlays) as never } : {}),
          ...(split(q.panes) ? { panes: split(q.panes) as never } : {}),
        }),
      },
      {
        source: result.source,
        asOf: result.asOf,
        dataStatus: result.fromStorage ? 'stored' : 'live',
      },
    );
  }),
);
