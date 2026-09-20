/**
 * Market-wide aggregates: indices, breadth, sector performance, movers, regime.
 *
 * Breadth and movers are *computed from real quotes we already hold*, not
 * scraped from a "top gainers" page. That costs one batched quote call for the
 * universe and gives us a number we can fully explain: which instruments were
 * scanned, how many had a usable quote, and how many were excluded.
 */
import { getJson, setJson } from '../../cache/redis.js';
import { K, TTL } from '../../cache/keys.js';
import { query } from '../../db/pool.js';
import { sourced, unavailable, type Sourced } from '../../utils/sourced.js';
import type { ProviderRegistry } from '../../providers/registry.js';
import * as instrumentsRepo from '../../db/repositories/instruments.js';
import type { InstrumentRow } from '../../db/repositories/instruments.js';
import { getQuotes, getCandles, marketStatus } from './marketData.service.js';
import { isAvailable } from '../../utils/sourced.js';
import { buildSnapshot } from '../../analysis/snapshot.js';
import { detectRegime, type RegimeResult } from '../../analysis/regime.js';
import { sma, last } from '../../analysis/indicators/index.js';
import { logger } from '../../utils/logger.js';

/** The headline indices the dashboard shows. */
export const HEADLINE_INDICES = [
  'NIFTY 50',
  'NIFTY BANK',
  'NIFTY FIN SERVICE',
  'NIFTY MIDCAP 100',
  'NIFTY NEXT 50',
  'INDIA VIX',
] as const;

export interface IndexQuoteView {
  symbol: string;
  name: string;
  ltp: number;
  prevClose: number | null;
  open: number | null;
  high: number | null;
  low: number | null;
  change: number | null;
  changePct: number | null;
}

export async function getIndices(
  registry: ProviderRegistry,
  symbols: readonly string[] = HEADLINE_INDICES,
): Promise<Array<{ symbol: string; data: Sourced<IndexQuoteView> }>> {
  const rows: Array<{ symbol: string; row: InstrumentRow | null }> = await Promise.all(
    symbols.map(async (s) => ({ symbol: s, row: await instrumentsRepo.resolveSymbol(s) })),
  );

  const found = rows.filter((r): r is { symbol: string; row: InstrumentRow } => r.row !== null);
  const quotes = await getQuotes(registry, found.map((f) => f.row));

  return rows.map(({ symbol, row }) => {
    if (!row) {
      return {
        symbol,
        data: unavailable(
          'instrument_not_found',
          `${symbol} is not in the instrument master. Run the instruments sync from Settings.`,
        ) as Sourced<IndexQuoteView>,
      };
    }
    const q = quotes.get(row.id);
    if (!q || !isAvailable(q)) {
      return { symbol, data: (q ?? unavailable('no_quote', `Live market data unavailable for ${symbol}.`)) as Sourced<IndexQuoteView> };
    }
    const v = q.value;
    const prevClose = v.prevClose;
    return {
      symbol,
      data: {
        ...q,
        value: {
          symbol,
          name: row.name ?? symbol,
          ltp: v.ltp,
          prevClose,
          open: v.open,
          high: v.high,
          low: v.low,
          change: prevClose !== null ? v.ltp - prevClose : null,
          changePct: prevClose !== null && prevClose > 0 ? ((v.ltp - prevClose) / prevClose) * 100 : null,
        },
      } as Sourced<IndexQuoteView>,
    };
  });
}

// ── breadth ─────────────────────────────────────────────────────────────────

export interface BreadthView {
  advances: number;
  declines: number;
  unchanged: number;
  totalScanned: number;
  /** Instruments in the universe whose quote could not be sourced. */
  excluded: number;
  advanceDeclineRatio: number | null;
  breadthPct: number | null;
  scope: string;
  method: string;
}

export async function getBreadth(
  registry: ProviderRegistry,
  scope = 'NIFTY50',
): Promise<Sourced<BreadthView>> {
  const cacheKey = `${K.breadth}:${scope}`;
  const cached = await getJson<{ view: BreadthView; asOf: string; source: string }>(cacheKey);
  const status = await marketStatus();

  if (cached) {
    return sourced(cached.view, {
      source: cached.source,
      asOf: cached.asOf,
      freshness: 'breadth',
      kind: 'calculated',
      marketOpen: status.isSessionActive,
    });
  }

  const universe = await instrumentsRepo.getUniverse({
    index: scope === 'NSE' ? undefined : scope,
    limit: 500,
  });

  if (universe.length === 0) {
    return unavailable(
      'empty_universe',
      'No instruments in the scan universe. Run the instruments sync and index-membership seed first.',
      undefined,
      'calculated',
    );
  }

  const quotes = await getQuotes(registry, universe);

  let advances = 0;
  let declines = 0;
  let unchanged = 0;
  let excluded = 0;
  let oldest: number | null = null;
  const sources = new Set<string>();

  for (const row of universe) {
    const q = quotes.get(row.id);
    if (!q || !isAvailable(q) || q.value.prevClose === null || q.value.prevClose <= 0) {
      excluded += 1;
      continue;
    }
    sources.add(q.source);
    const t = new Date(q.asOf).getTime();
    if (oldest === null || t < oldest) oldest = t;

    const change = q.value.ltp - q.value.prevClose;
    if (change > 0) advances += 1;
    else if (change < 0) declines += 1;
    else unchanged += 1;
  }

  const totalScanned = advances + declines + unchanged;
  if (totalScanned === 0) {
    return unavailable(
      'no_usable_quotes',
      `Live market data unavailable: none of the ${universe.length} instruments in the ${scope} universe returned a usable quote.`,
      undefined,
      'calculated',
    );
  }

  const view: BreadthView = {
    advances,
    declines,
    unchanged,
    totalScanned,
    excluded,
    advanceDeclineRatio: declines > 0 ? advances / declines : null,
    breadthPct: (advances / totalScanned) * 100,
    scope,
    method:
      `Each instrument in the ${scope} universe is classified by comparing its last traded price with its previous close. ` +
      `${totalScanned} of ${universe.length} instruments returned a usable quote; ${excluded} were excluded because no live price could be sourced.`,
  };

  const asOf = new Date(oldest ?? Date.now()).toISOString();
  const source = [...sources].join('+') || 'computed';
  await setJson(cacheKey, { view, asOf, source }, TTL.breadth);

  // Persist for the breadth-history chart.
  void query(
    `INSERT INTO market_breadth (scope, captured_at, advances, declines, unchanged, total_scanned, source)
     VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (scope, captured_at) DO NOTHING`,
    [scope, asOf, advances, declines, unchanged, totalScanned, source],
  ).catch(() => undefined);

  return sourced(view, {
    source,
    asOf,
    freshness: 'breadth',
    kind: 'calculated',
    marketOpen: status.isSessionActive,
  });
}

// ── movers ──────────────────────────────────────────────────────────────────

export type MoverKind =
  | 'gainers' | 'losers' | 'volume' | 'gapup' | 'gapdown'
  | 'near52high' | 'near52low' | 'active';

export interface MoverView {
  symbol: string;
  tradingsymbol: string;
  name: string | null;
  sector: string | null;
  ltp: number;
  prevClose: number | null;
  change: number | null;
  changePct: number | null;
  volume: number | null;
  /** Populated for gap scans: (open − prevClose) / prevClose. */
  gapPct: number | null;
  /** Populated for 52-week scans. */
  distanceFrom52wPct: number | null;
}

export async function getMovers(
  registry: ProviderRegistry,
  kind: MoverKind,
  opts: { scope?: string; limit?: number } = {},
): Promise<Sourced<MoverView[]>> {
  const { scope = 'NIFTY50', limit = 10 } = opts;
  const cacheKey = `${K.movers(kind)}:${scope}:${limit}`;
  const cached = await getJson<{ list: MoverView[]; asOf: string; source: string }>(cacheKey);
  const status = await marketStatus();

  if (cached) {
    return sourced(cached.list, {
      source: cached.source, asOf: cached.asOf, freshness: 'breadth',
      kind: 'calculated', marketOpen: status.isSessionActive,
    });
  }

  const universe = await instrumentsRepo.getUniverse({
    index: scope === 'NSE' ? undefined : scope,
    limit: 500,
  });
  if (universe.length === 0) {
    return unavailable('empty_universe', 'No instruments in the scan universe.', undefined, 'calculated');
  }

  const quotes = await getQuotes(registry, universe);
  const sources = new Set<string>();
  let oldest: number | null = null;

  const rows: MoverView[] = [];
  for (const inst of universe) {
    const q = quotes.get(inst.id);
    if (!q || !isAvailable(q)) continue;
    sources.add(q.source);
    const t = new Date(q.asOf).getTime();
    if (oldest === null || t < oldest) oldest = t;

    const v = q.value;
    const prevClose = v.prevClose;
    const change = prevClose !== null ? v.ltp - prevClose : null;
    const changePct = prevClose !== null && prevClose > 0 ? (change! / prevClose) * 100 : null;
    const gapPct =
      v.open !== null && prevClose !== null && prevClose > 0
        ? ((v.open - prevClose) / prevClose) * 100
        : null;

    let distanceFrom52wPct: number | null = null;
    if (kind === 'near52high' && v.week52High !== null && v.week52High > 0) {
      distanceFrom52wPct = ((v.week52High - v.ltp) / v.week52High) * 100;
    } else if (kind === 'near52low' && v.week52Low !== null && v.week52Low > 0) {
      distanceFrom52wPct = ((v.ltp - v.week52Low) / v.week52Low) * 100;
    }

    rows.push({
      symbol: `${inst.exchange}:${inst.tradingsymbol}`,
      tradingsymbol: inst.tradingsymbol,
      name: inst.name,
      sector: inst.sector,
      ltp: v.ltp,
      prevClose,
      change,
      changePct,
      volume: v.volume,
      gapPct,
      distanceFrom52wPct,
    });
  }

  let list: MoverView[];
  switch (kind) {
    case 'gainers':
      list = rows.filter((r) => r.changePct !== null).sort((a, b) => b.changePct! - a.changePct!);
      break;
    case 'losers':
      list = rows.filter((r) => r.changePct !== null).sort((a, b) => a.changePct! - b.changePct!);
      break;
    case 'volume':
    case 'active':
      list = rows.filter((r) => r.volume !== null).sort((a, b) => b.volume! - a.volume!);
      break;
    case 'gapup':
      list = rows.filter((r) => r.gapPct !== null && r.gapPct > 0).sort((a, b) => b.gapPct! - a.gapPct!);
      break;
    case 'gapdown':
      list = rows.filter((r) => r.gapPct !== null && r.gapPct < 0).sort((a, b) => a.gapPct! - b.gapPct!);
      break;
    case 'near52high':
      list = rows
        .filter((r) => r.distanceFrom52wPct !== null && r.distanceFrom52wPct <= 5)
        .sort((a, b) => a.distanceFrom52wPct! - b.distanceFrom52wPct!);
      break;
    case 'near52low':
      list = rows
        .filter((r) => r.distanceFrom52wPct !== null && r.distanceFrom52wPct <= 5)
        .sort((a, b) => a.distanceFrom52wPct! - b.distanceFrom52wPct!);
      break;
    default:
      list = rows;
  }

  const top = list.slice(0, limit);
  if (top.length === 0) {
    return unavailable(
      'no_matches',
      kind === 'near52high' || kind === 'near52low'
        ? '52-week high/low data is not available from the configured provider for this universe. It is populated by the end-of-day job.'
        : `No instruments currently match the "${kind}" scan.`,
      undefined,
      'calculated',
    );
  }

  const asOf = new Date(oldest ?? Date.now()).toISOString();
  const source = [...sources].join('+') || 'computed';
  await setJson(cacheKey, { list: top, asOf, source }, TTL.movers);

  return sourced(top, {
    source, asOf, freshness: 'breadth', kind: 'calculated',
    marketOpen: status.isSessionActive,
  });
}

// ── sector performance ──────────────────────────────────────────────────────

export interface SectorView {
  sector: string;
  avgChangePct: number;
  advances: number;
  declines: number;
  count: number;
  topGainer: { symbol: string; changePct: number } | null;
  topLoser: { symbol: string; changePct: number } | null;
}

export async function getSectorPerformance(
  registry: ProviderRegistry,
  scope = 'NIFTY50',
): Promise<Sourced<SectorView[]>> {
  const cacheKey = `${K.sectors}:${scope}`;
  const cached = await getJson<{ list: SectorView[]; asOf: string; source: string }>(cacheKey);
  const status = await marketStatus();
  if (cached) {
    return sourced(cached.list, {
      source: cached.source, asOf: cached.asOf, freshness: 'breadth',
      kind: 'calculated', marketOpen: status.isSessionActive,
    });
  }

  const universe = (await instrumentsRepo.getUniverse({
    index: scope === 'NSE' ? undefined : scope,
    limit: 500,
  })).filter((i) => i.sector);

  if (universe.length === 0) {
    return unavailable(
      'no_sector_data',
      'No instruments carry a sector classification yet. Run the sector seed to populate it.',
      undefined,
      'calculated',
    );
  }

  const quotes = await getQuotes(registry, universe);
  const bySector = new Map<string, Array<{ symbol: string; changePct: number }>>();
  const sources = new Set<string>();
  let oldest: number | null = null;

  for (const inst of universe) {
    const q = quotes.get(inst.id);
    if (!q || !isAvailable(q) || q.value.prevClose === null || q.value.prevClose <= 0) continue;
    sources.add(q.source);
    const t = new Date(q.asOf).getTime();
    if (oldest === null || t < oldest) oldest = t;

    const changePct = ((q.value.ltp - q.value.prevClose) / q.value.prevClose) * 100;
    const list = bySector.get(inst.sector!) ?? [];
    list.push({ symbol: inst.tradingsymbol, changePct });
    bySector.set(inst.sector!, list);
  }

  const list: SectorView[] = [...bySector.entries()]
    .map(([sector, members]) => {
      const sorted = [...members].sort((a, b) => b.changePct - a.changePct);
      return {
        sector,
        avgChangePct: members.reduce((s, m) => s + m.changePct, 0) / members.length,
        advances: members.filter((m) => m.changePct > 0).length,
        declines: members.filter((m) => m.changePct < 0).length,
        count: members.length,
        topGainer: sorted[0] ?? null,
        topLoser: sorted.at(-1) ?? null,
      };
    })
    .sort((a, b) => b.avgChangePct - a.avgChangePct);

  if (list.length === 0) {
    return unavailable('no_usable_quotes', 'Live market data unavailable for sector calculation.',
      undefined, 'calculated');
  }

  const asOf = new Date(oldest ?? Date.now()).toISOString();
  const source = [...sources].join('+') || 'computed';
  await setJson(cacheKey, { list, asOf, source }, TTL.sectors);

  return sourced(list, {
    source, asOf, freshness: 'breadth', kind: 'calculated',
    marketOpen: status.isSessionActive,
  });
}

// ── regime ──────────────────────────────────────────────────────────────────

export async function getRegime(registry: ProviderRegistry): Promise<Sourced<RegimeResult>> {
  const cached = await getJson<{ result: RegimeResult; asOf: string; source: string }>(K.regime);
  const status = await marketStatus();
  if (cached) {
    return sourced(cached.result, {
      source: cached.source, asOf: cached.asOf, freshness: 'breadth',
      kind: 'calculated', marketOpen: status.isSessionActive,
    });
  }

  const nifty = await instrumentsRepo.resolveSymbol('NIFTY 50');
  if (!nifty) {
    return unavailable(
      'index_not_found',
      'NIFTY 50 is not in the instrument master. Run the instruments sync first.',
      undefined,
      'calculated',
    );
  }

  let indexSnapshot;
  try {
    const candleResult = await getCandles(registry, nifty, '1d', { bars: 250 });
    if (candleResult.candles.length < 30) {
      return unavailable(
        'insufficient_history',
        `Regime detection needs at least 30 daily bars of NIFTY 50 history; ${candleResult.candles.length} are available.`,
        undefined,
        'calculated',
      );
    }
    indexSnapshot = buildSnapshot('NIFTY 50', '1d', candleResult.candles);
  } catch (err) {
    logger.warn({ err }, 'Regime detection could not build the index snapshot');
    return unavailable(
      'index_history_unavailable',
      'Live market data unavailable: NIFTY 50 history could not be loaded.',
      undefined,
      'calculated',
    );
  }

  // India VIX, if the provider carries it.
  let vix: number | null = null;
  const vixRow = await instrumentsRepo.resolveSymbol('INDIA VIX');
  if (vixRow) {
    const q = await getQuotes(registry, [vixRow]);
    const got = q.get(vixRow.id);
    if (got && isAvailable(got)) vix = got.value.ltp;
  }

  const breadth = await getBreadth(registry, 'NIFTY50');
  const participation = await calculateParticipation(registry);

  const result = detectRegime({
    index: indexSnapshot,
    vix,
    vixPercentile: null, // populated once VIX history accumulates
    breadth: isAvailable(breadth)
      ? {
          advances: breadth.value.advances,
          declines: breadth.value.declines,
          unchanged: breadth.value.unchanged,
          totalScanned: breadth.value.totalScanned,
        }
      : null,
    pctAboveSma50: participation.pctAboveSma50,
    pctAboveSma200: participation.pctAboveSma200,
    newHighs: null,
    newLows: null,
  });

  const asOf = indexSnapshot.asOf;
  await setJson(K.regime, { result, asOf, source: 'computed' }, TTL.regime);

  return sourced(result, {
    source: 'computed', asOf, freshness: 'breadth', kind: 'calculated',
    marketOpen: status.isSessionActive,
  });
}

/**
 * Share of the universe trading above its own 50/200 SMA.
 *
 * Uses stored daily candles only — this must not fan out into hundreds of
 * provider calls on a dashboard load.
 */
async function calculateParticipation(
  _registry: ProviderRegistry,
): Promise<{ pctAboveSma50: number | null; pctAboveSma200: number | null }> {
  const rows = await query<{ instrument_id: number; closes: number[] }>(
    `SELECT instrument_id, array_agg(close ORDER BY ts) AS closes
       FROM (
         SELECT c.instrument_id, c.ts, c.close,
                row_number() OVER (PARTITION BY c.instrument_id ORDER BY c.ts DESC) AS rn
           FROM candles c
           JOIN instruments i ON i.id = c.instrument_id
          WHERE c.timeframe = '1d'
            AND i.instrument_type = 'EQ'
            AND i.is_active = TRUE
            AND c.ts > now() - interval '400 days'
       ) t
      WHERE rn <= 200
      GROUP BY instrument_id
     HAVING count(*) >= 50`,
  );

  if (rows.rows.length === 0) return { pctAboveSma50: null, pctAboveSma200: null };

  let above50 = 0;
  let total50 = 0;
  let above200 = 0;
  let total200 = 0;

  for (const r of rows.rows) {
    const closes = r.closes;
    const close = closes.at(-1);
    if (close === undefined) continue;

    const s50 = last(sma(closes, 50));
    if (s50 !== null) { total50 += 1; if (close > s50) above50 += 1; }

    const s200 = last(sma(closes, 200));
    if (s200 !== null) { total200 += 1; if (close > s200) above200 += 1; }
  }

  return {
    pctAboveSma50: total50 > 0 ? (above50 / total50) * 100 : null,
    pctAboveSma200: total200 > 0 ? (above200 / total200) * 100 : null,
  };
}
