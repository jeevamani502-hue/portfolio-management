/**
 * One chart read per underlying for the direction guard: the bias chart's
 * rule score and four 15-minute timing readings. Shared by the paper and
 * live exit managers so they judge a position by exactly the same numbers.
 * Results are cached for a short while because the live manager runs every
 * 15 seconds and the chart does not change that fast.
 */
import type { ProviderRegistry } from '../../providers/registry.js';
import * as instrumentsRepo from '../../db/repositories/instruments.js';
import { getCandles } from './marketData.service.js';
import { underlyingInstrumentFor } from '../options/options.service.js';
import { buildSnapshot } from '../../analysis/snapshot.js';
import { runSignalEngine } from '../../analysis/signals/engine.js';
import { logger } from '../../utils/logger.js';
import type { DirectionRead } from '../../analysis/options/directionGuard.js';

const log = logger.child({ module: 'direction-read' });
const CACHE_MS = 45_000;
const cache = new Map<string, { at: number; read: DirectionRead }>();

export async function readDirection(
  registry: ProviderRegistry,
  underlying: string,
  horizon: 'intraday' | 'swing',
): Promise<DirectionRead> {
  const biasTf: '1h' | '1d' = horizon === 'intraday' ? '1h' : '1d';
  const key = `${registry.userId ?? 'shared'}:${underlying}:${biasTf}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.read;

  const read: DirectionRead = { biasScore: null, biasTimeframe: biasTf, timingScore: null, supertrend: null, aboveVwap: null, emaUp: null, asOf: null };
  const row = await instrumentsRepo.resolveSymbol(underlyingInstrumentFor(underlying));
  if (!row) return read;

  try {
    const intra = await getCandles(registry, row, '15m', { bars: 300 });
    if (intra.candles.length >= 30) {
      const snap = buildSnapshot(row.tradingsymbol, '15m', intra.candles);
      read.timingScore = runSignalEngine(snap).overallScore;
      read.supertrend = snap.trend.supertrendDirection;
      read.aboveVwap = snap.vwap === null ? null : snap.price.close > snap.vwap;
      read.emaUp = snap.movingAverages.ema9 !== null && snap.movingAverages.ema20 !== null
        ? snap.movingAverages.ema9 > snap.movingAverages.ema20 : null;
      read.asOf = snap.asOf;
    }
  } catch (err) {
    log.debug({ err: (err as Error).message, underlying }, '15m read failed');
  }
  try {
    const bias = await getCandles(registry, row, biasTf, { bars: 300 });
    if (bias.candles.length >= 30) {
      read.biasScore = runSignalEngine(buildSnapshot(row.tradingsymbol, biasTf, bias.candles)).overallScore;
    }
  } catch (err) {
    log.debug({ err: (err as Error).message, underlying, biasTf }, 'bias read failed');
  }
  cache.set(key, { at: Date.now(), read });
  return read;
}
