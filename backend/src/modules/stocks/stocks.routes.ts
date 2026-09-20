/**
 * Stock analysis: the full technical picture for one symbol at one timeframe.
 *
 * This route is the reference implementation of the platform's data contract —
 * price carries provenance, indicators are labelled `calculated`, signals are
 * labelled `rule_signal`, and anything that could not be computed says so with
 * a reason rather than being omitted or faked.
 */
import { Router } from 'express';
import { z } from 'zod';
import {
  asyncHandler, respond, requireAuth, validate, timeframeSchema, symbolParamSchema,
} from '../../middleware/index.js';
import { notFound, dataUnavailable } from '../../utils/errors.js';
import { registryForUser } from '../../providers/registry.js';
import * as instrumentsRepo from '../../db/repositories/instruments.js';
import { getQuote, getCandles, marketStatus } from '../market/marketData.service.js';
import { buildSnapshot, InsufficientHistoryError } from '../../analysis/snapshot.js';
import { runSignalEngine } from '../../analysis/signals/engine.js';
import { sourced, isAvailable, unavailable } from '../../utils/sourced.js';
import { getFundamentals } from '../fundamentals/fundamentals.service.js';
import { getNewsForInstrument } from '../news/news.service.js';
import { getJson, setJson } from '../../cache/redis.js';
import { K, TTL } from '../../cache/keys.js';

export const stocksRouter = Router();
stocksRouter.use(requireAuth);

const analysisQuery = z.object({
  tf: timeframeSchema,
  bars: z.coerce.number().int().min(50).max(1000).default(300),
  refresh: z.coerce.boolean().default(false),
});

stocksRouter.get(
  '/:symbol/analysis',
  validate(symbolParamSchema, 'params'),
  validate(analysisQuery, 'query'),
  asyncHandler(async (req, res) => {
    const { symbol } = req.params as unknown as z.infer<typeof symbolParamSchema>;
    const { tf, bars, refresh } = req.query as unknown as z.infer<typeof analysisQuery>;

    const instrument = await instrumentsRepo.resolveSymbol(symbol);
    if (!instrument) throw notFound(`No instrument matches "${symbol}"`);

    const registry = await registryForUser(req.user!.id);
    const status = await marketStatus();

    // Quote and candles in parallel — they come from different capabilities.
    const [quote, candleResult] = await Promise.all([
      getQuote(registry, instrument),
      getCandles(registry, instrument, tf, { bars, forceRefresh: refresh }).catch(
        (err: unknown) => {
          throw dataUnavailable(
            `${instrument.tradingsymbol} price history (${tf})`,
            err instanceof Error ? err.message : 'unknown error',
          );
        },
      ),
    ]);

    let snapshot;
    try {
      snapshot = buildSnapshot(
        `${instrument.exchange}:${instrument.tradingsymbol}`,
        tf,
        candleResult.candles,
      );
    } catch (err) {
      if (err instanceof InsufficientHistoryError) {
        return respond(res, {
          instrument: instrumentView(instrument),
          quote,
          technicals: unavailable(
            'insufficient_history',
            `Technical analysis needs at least ${err.required} ${tf} bars; only ${err.available} are available from the configured provider.`,
            undefined,
            'calculated',
          ),
          signals: null,
        });
      }
      throw err;
    }

    const signals = runSignalEngine(snapshot);

    respond(
      res,
      {
        instrument: instrumentView(instrument),
        quote,
        technicals: sourced(snapshot, {
          source: `computed(${candleResult.source})`,
          asOf: snapshot.asOf,
          kind: 'calculated',
          freshness: 'quote',
          marketOpen: status.isSessionActive,
        }),
        signals: sourced(signals, {
          source: 'rule-engine-v1',
          asOf: snapshot.asOf,
          kind: 'rule_signal',
          freshness: 'quote',
          marketOpen: status.isSessionActive,
        }),
        dataQuality: {
          candlesUsed: candleResult.candles.length,
          candleSource: candleResult.source,
          servedFromStorage: candleResult.fromStorage,
          unavailableFields: snapshot.insufficient,
        },
      },
      { marketPhase: status.phase },
    );
  }),
);

stocksRouter.get(
  '/:symbol/fundamentals',
  validate(symbolParamSchema, 'params'),
  asyncHandler(async (req, res) => {
    const { symbol } = req.params as unknown as z.infer<typeof symbolParamSchema>;
    const instrument = await instrumentsRepo.resolveSymbol(symbol);
    if (!instrument) throw notFound(`No instrument matches "${symbol}"`);

    respond(res, {
      instrument: instrumentView(instrument),
      fundamentals: await getFundamentals(instrument),
    });
  }),
);

stocksRouter.get(
  '/:symbol/news',
  validate(symbolParamSchema, 'params'),
  asyncHandler(async (req, res) => {
    const { symbol } = req.params as unknown as z.infer<typeof symbolParamSchema>;
    const instrument = await instrumentsRepo.resolveSymbol(symbol);
    if (!instrument) throw notFound(`No instrument matches "${symbol}"`);

    respond(res, {
      instrument: instrumentView(instrument),
      news: await getNewsForInstrument(instrument.id, 20),
    });
  }),
);

/**
 * Peer comparison within the same sector.
 *
 * Peers are ranked by closeness of market cap where fundamentals exist, which
 * is a better comparison set than an alphabetical sector slice.
 */
stocksRouter.get(
  '/:symbol/peers',
  validate(symbolParamSchema, 'params'),
  asyncHandler(async (req, res) => {
    const { symbol } = req.params as unknown as z.infer<typeof symbolParamSchema>;
    const instrument = await instrumentsRepo.resolveSymbol(symbol);
    if (!instrument) throw notFound(`No instrument matches "${symbol}"`);

    if (!instrument.sector) {
      return respond(res, {
        instrument: instrumentView(instrument),
        peers: [],
        note: 'No sector classification is stored for this instrument, so peers cannot be identified.',
      });
    }

    const cacheKey = `peers:${instrument.id}`;
    const cached = await getJson<unknown>(cacheKey);
    if (cached) return respond(res, cached);

    const { queryRows } = await import('../../db/pool.js');
    const peers = await queryRows<{
      id: number; tradingsymbol: string; name: string | null; exchange: string;
      market_cap: number | null; pe: number | null; pb: number | null; roe: number | null;
    }>(
      `SELECT i.id, i.tradingsymbol, i.name, i.exchange,
              f.market_cap, f.pe, f.pb, f.roe
         FROM instruments i
         LEFT JOIN fundamentals f ON f.instrument_id = i.id
        WHERE i.sector = $1 AND i.instrument_type = 'EQ' AND i.is_active = TRUE
          AND i.id <> $2
        ORDER BY f.market_cap DESC NULLS LAST
        LIMIT 12`,
      [instrument.sector, instrument.id],
    );

    const payload = {
      instrument: instrumentView(instrument),
      sector: instrument.sector,
      peers: peers.map((p) => ({
        id: p.id,
        symbol: `${p.exchange}:${p.tradingsymbol}`,
        tradingsymbol: p.tradingsymbol,
        name: p.name,
        marketCap: p.market_cap,
        pe: p.pe,
        pb: p.pb,
        roe: p.roe,
      })),
      note:
        'Peers are other active NSE equities carrying the same sector tag, ordered by market capitalisation where fundamental data is stored. Valuation fields are blank where no fundamentals provider is configured.',
    };

    await setJson(cacheKey, payload, TTL.fundamentals);
    respond(res, payload);
  }),
);

/** Compare two or more symbols side by side. */
const compareQuery = z.object({
  symbols: z.string().min(1),
  tf: timeframeSchema,
});

stocksRouter.get(
  '/compare',
  validate(compareQuery, 'query'),
  asyncHandler(async (req, res) => {
    const { symbols, tf } = req.query as unknown as z.infer<typeof compareQuery>;
    const list = symbols.split(',').map((s) => s.trim()).filter(Boolean).slice(0, 5);
    const registry = await registryForUser(req.user!.id);

    const results = await Promise.all(
      list.map(async (sym) => {
        const instrument = await instrumentsRepo.resolveSymbol(sym);
        if (!instrument) {
          return { requested: sym, resolved: false as const, error: 'Instrument not found' };
        }
        try {
          const [quote, candles] = await Promise.all([
            getQuote(registry, instrument),
            getCandles(registry, instrument, tf, { bars: 250 }),
          ]);
          const snapshot = buildSnapshot(instrument.tradingsymbol, tf, candles.candles);
          const signals = runSignalEngine(snapshot);
          return {
            requested: sym,
            resolved: true as const,
            instrument: instrumentView(instrument),
            quote,
            scores: signals.scores,
            overallScore: signals.overallScore,
            trend: snapshot.trend.assessment.label,
            rsi: snapshot.momentum.rsi14,
            atrPct: snapshot.volatility.atrPct,
            changePct: isAvailable(quote) && quote.value.prevClose
              ? ((quote.value.ltp - quote.value.prevClose) / quote.value.prevClose) * 100
              : null,
          };
        } catch (err) {
          return {
            requested: sym,
            resolved: false as const,
            error: err instanceof Error ? err.message : 'Analysis failed',
          };
        }
      }),
    );

    respond(res, results);
  }),
);

function instrumentView(i: instrumentsRepo.InstrumentRow) {
  return {
    id: i.id,
    symbol: `${i.exchange}:${i.tradingsymbol}`,
    tradingsymbol: i.tradingsymbol,
    name: i.name,
    exchange: i.exchange,
    instrumentType: i.instrument_type,
    sector: i.sector,
    industry: i.industry,
    isin: i.isin,
    lotSize: i.lot_size,
    indexMembership: i.index_membership,
  };
}
