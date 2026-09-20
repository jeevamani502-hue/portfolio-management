/**
 * Watchlists.
 *
 * The `/live` endpoint is the interesting one: it returns price, change, RSI,
 * trend and the strongest current signal for every item in one call, computed
 * from stored candles so that a 50-symbol watchlist costs one batched quote
 * request rather than fifty analysis runs.
 */
import { Router } from 'express';
import { z } from 'zod';
import {
  asyncHandler, respond, requireAuth, validate, auditLog, timeframeSchema,
} from '../../middleware/index.js';
import { query, queryOne, queryRows } from '../../db/pool.js';
import { notFound, badRequest } from '../../utils/errors.js';
import { registryForUser } from '../../providers/registry.js';
import * as instrumentsRepo from '../../db/repositories/instruments.js';
import { getQuotes, getCandles, marketStatus } from '../market/marketData.service.js';
import { buildSnapshot } from '../../analysis/snapshot.js';
import { runSignalEngine } from '../../analysis/signals/engine.js';
import { isAvailable, sourced } from '../../utils/sourced.js';
import { logger } from '../../utils/logger.js';

export const watchlistRouter = Router();
watchlistRouter.use(requireAuth);

const idParam = z.object({ id: z.string().uuid() });
const itemParam = z.object({ id: z.string().uuid(), itemId: z.string().uuid() });

interface WatchlistRow {
  id: string;
  name: string;
  is_default: boolean;
  sort_order: number;
  item_count: number;
}

watchlistRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const rows = await queryRows<WatchlistRow>(
      `SELECT w.id, w.name, w.is_default, w.sort_order,
              (SELECT count(*)::int FROM watchlist_items wi WHERE wi.watchlist_id = w.id) AS item_count
         FROM watchlists w WHERE w.user_id = $1
        ORDER BY w.is_default DESC, w.sort_order, w.name`,
      [req.user!.id],
    );
    respond(res, rows.map((r) => ({
      id: r.id, name: r.name, isDefault: r.is_default,
      sortOrder: r.sort_order, itemCount: r.item_count,
    })));
  }),
);

const createSchema = z.object({ name: z.string().min(1).max(80) });

watchlistRouter.post(
  '/',
  validate(createSchema),
  auditLog('watchlist.create', 'watchlist'),
  asyncHandler(async (req, res) => {
    const { name } = req.body as z.infer<typeof createSchema>;
    const row = await queryOne<{ id: string }>(
      `INSERT INTO watchlists (user_id, name) VALUES ($1,$2)
       ON CONFLICT (user_id, name) DO NOTHING RETURNING id`,
      [req.user!.id, name],
    );
    if (!row) throw badRequest(`A watchlist named "${name}" already exists`);
    respond(res, { id: row.id, name }, {}, 201);
  }),
);

watchlistRouter.delete(
  '/:id',
  validate(idParam, 'params'),
  auditLog('watchlist.delete', 'watchlist'),
  asyncHandler(async (req, res) => {
    const { id } = req.params as unknown as z.infer<typeof idParam>;
    const result = await query(`DELETE FROM watchlists WHERE id = $1 AND user_id = $2`, [
      id, req.user!.id,
    ]);
    if (result.rowCount === 0) throw notFound('Watchlist not found');
    respond(res, { deleted: true });
  }),
);

async function assertOwned(userId: string, watchlistId: string): Promise<void> {
  const row = await queryOne<{ id: string }>(
    `SELECT id FROM watchlists WHERE id = $1 AND user_id = $2`,
    [watchlistId, userId],
  );
  if (!row) throw notFound('Watchlist not found');
}

const addItemSchema = z.object({
  symbol: z.string().min(1).max(64),
  note: z.string().max(300).optional(),
});

watchlistRouter.post(
  '/:id/items',
  validate(idParam, 'params'),
  validate(addItemSchema),
  asyncHandler(async (req, res) => {
    const { id } = req.params as unknown as z.infer<typeof idParam>;
    const { symbol, note } = req.body as z.infer<typeof addItemSchema>;
    await assertOwned(req.user!.id, id);

    const instrument = await instrumentsRepo.resolveSymbol(symbol);
    if (!instrument) throw badRequest(`No instrument matches "${symbol}"`);

    const row = await queryOne<{ id: string }>(
      `INSERT INTO watchlist_items (watchlist_id, instrument_id, note)
       VALUES ($1,$2,$3) ON CONFLICT (watchlist_id, instrument_id) DO NOTHING
       RETURNING id`,
      [id, instrument.id, note ?? null],
    );
    if (!row) throw badRequest(`${instrument.tradingsymbol} is already in this watchlist`);

    respond(res, {
      id: row.id,
      symbol: `${instrument.exchange}:${instrument.tradingsymbol}`,
      name: instrument.name,
    }, {}, 201);
  }),
);

watchlistRouter.delete(
  '/:id/items/:itemId',
  validate(itemParam, 'params'),
  asyncHandler(async (req, res) => {
    const { id, itemId } = req.params as unknown as z.infer<typeof itemParam>;
    await assertOwned(req.user!.id, id);
    const result = await query(
      `DELETE FROM watchlist_items WHERE id = $1 AND watchlist_id = $2`,
      [itemId, id],
    );
    if (result.rowCount === 0) throw notFound('Watchlist item not found');
    respond(res, { deleted: true });
  }),
);

const liveQuery = z.object({
  tf: timeframeSchema,
  /** Technical columns require candle history; skip for a fast price-only view. */
  technicals: z.coerce.boolean().default(true),
});

watchlistRouter.get(
  '/:id/live',
  validate(idParam, 'params'),
  validate(liveQuery, 'query'),
  asyncHandler(async (req, res) => {
    const { id } = req.params as unknown as z.infer<typeof idParam>;
    const { tf, technicals } = req.query as unknown as z.infer<typeof liveQuery>;
    await assertOwned(req.user!.id, id);

    const items = await queryRows<{
      item_id: string; instrument_id: number; note: string | null;
    }>(
      `SELECT wi.id AS item_id, wi.instrument_id, wi.note
         FROM watchlist_items wi WHERE wi.watchlist_id = $1 ORDER BY wi.sort_order, wi.added_at`,
      [id],
    );

    if (items.length === 0) return respond(res, []);

    const instruments = await instrumentsRepo.getByIds(items.map((i) => i.instrument_id));
    const registry = await registryForUser(req.user!.id);
    const quotes = await getQuotes(registry, instruments);
    const status = await marketStatus();

    const byId = new Map(instruments.map((i) => [i.id, i]));

    const rows = await Promise.all(
      items.map(async (item) => {
        const inst = byId.get(item.instrument_id);
        if (!inst) return null;
        const quote = quotes.get(inst.id) ?? null;

        let rsi: number | null = null;
        let trend: string | null = null;
        let signal: { label: string; direction: string; strength: number } | null = null;
        let score: number | null = null;
        let technicalsNote: string | null = null;

        if (technicals) {
          try {
            // Stored candles only — a watchlist refresh must not fan out into
            // one provider call per symbol.
            const candles = await getCandles(registry, inst, tf, { bars: 250 });
            if (candles.candles.length >= 30) {
              const snapshot = buildSnapshot(inst.tradingsymbol, tf, candles.candles);
              const signals = runSignalEngine(snapshot);
              rsi = snapshot.momentum.rsi14;
              trend = snapshot.trend.assessment.label;
              score = signals.overallScore;
              const best = signals.setups[0];
              if (best) {
                signal = { label: best.label, direction: best.direction, strength: best.strength };
              }
            } else {
              technicalsNote = `Only ${candles.candles.length} ${tf} bars available; at least 30 are needed.`;
            }
          } catch (err) {
            logger.debug({ err, symbol: inst.tradingsymbol }, 'Watchlist technicals unavailable');
            technicalsNote = 'Price history could not be loaded for this symbol.';
          }
        }

        const hasNews = await queryOne<{ c: number }>(
          `SELECT count(*)::int AS c FROM news_entities ne
             JOIN news_articles n ON n.id = ne.article_id
            WHERE ne.instrument_id = $1 AND n.published_at > now() - interval '24 hours'`,
          [inst.id],
        );

        return {
          itemId: item.item_id,
          instrumentId: inst.id,
          symbol: `${inst.exchange}:${inst.tradingsymbol}`,
          tradingsymbol: inst.tradingsymbol,
          name: inst.name,
          sector: inst.sector,
          note: item.note,
          quote,
          technicals: {
            timeframe: tf,
            rsi,
            trend,
            score,
            signal,
            note: technicalsNote,
          },
          newsCount24h: hasNews?.c ?? 0,
        };
      }),
    );

    respond(res, rows.filter((r) => r !== null), { marketPhase: status.phase });
  }),
);
