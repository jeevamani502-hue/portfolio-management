/**
 * Option chain service.
 *
 * Two acquisition paths:
 *  1. Providers with a native option-chain endpoint (Dhan, NSE-public) — used
 *     directly.
 *  2. Providers without one (Kite) — the chain is ASSEMBLED from the
 *     instrument master plus one batched quote call. This is why the registry
 *     routes per capability rather than per provider.
 *
 * Everything downstream (PCR, max pain, greeks, buildup) is computed from the
 * normalized chain, so the analytics are identical regardless of source.
 */
import { getJson, setJson } from '../../cache/redis.js';
import { K, TTL } from '../../cache/keys.js';
import { query, queryRows } from '../../db/pool.js';
import { sourced, unavailable, type Sourced } from '../../utils/sourced.js';
import { logger } from '../../utils/logger.js';
import type { ProviderRegistry } from '../../providers/registry.js';
import { attemptsFrom } from '../../providers/registry.js';
import type { NormalizedOptionChain, OptionStrike, QuoteRequest } from '../../providers/types.js';
import * as instrumentsRepo from '../../db/repositories/instruments.js';
import type { InstrumentRow } from '../../db/repositories/instruments.js';
import { getQuote, marketStatus } from '../market/marketData.service.js';
import { isAvailable } from '../../utils/sourced.js';
import {
  calculatePcr, calculateMaxPain, deriveOiLevels, computeChainGreeks,
  calculateIvSkew, calculateIvPercentile, analyzeOiShift, classifyBuildup,
  type PcrResult, type MaxPainResult, type OiLevels, type StrikeGreeks,
  type IvSkew, type IvPercentileResult, type ChainOiShift, type BuildupResult,
} from '../../analysis/options/analytics.js';

/** Index underlyings and their Dhan security ids on the IDX_I segment. */
const INDEX_UNDERLYINGS: Record<string, { dhanScrip: string; displayName: string }> = {
  NIFTY: { dhanScrip: '13', displayName: 'NIFTY 50' },
  BANKNIFTY: { dhanScrip: '25', displayName: 'NIFTY BANK' },
  FINNIFTY: { dhanScrip: '27', displayName: 'NIFTY FIN SERVICE' },
  MIDCPNIFTY: { dhanScrip: '442', displayName: 'NIFTY MIDCAP SELECT' },
};

export const isIndexUnderlying = (s: string): boolean =>
  Object.hasOwn(INDEX_UNDERLYINGS, s.toUpperCase());

// ── expiries ────────────────────────────────────────────────────────────────

export async function getExpiries(
  registry: ProviderRegistry,
  underlying: string,
): Promise<Sourced<string[]>> {
  const sym = underlying.toUpperCase();
  const cacheKey = K.optionExpiries(sym);
  const cached = await getJson<{ list: string[]; asOf: string; source: string }>(cacheKey);
  if (cached) {
    return sourced(cached.list, {
      source: cached.source, asOf: cached.asOf, freshness: 'optionChain', kind: 'market_data',
    });
  }

  // The instrument master is authoritative and free; try it before the network.
  const local = await instrumentsRepo.getExpiries(sym);
  if (local.length > 0) {
    const payload = { list: local, asOf: new Date().toISOString(), source: 'instrument-master' };
    await setJson(cacheKey, payload, TTL.optionExpiries);
    return sourced(local, {
      source: 'instrument-master', asOf: payload.asOf,
      freshness: 'optionChain', kind: 'market_data',
    });
  }

  try {
    const { value, provider } = await registry.run('optionExpiries', async (p) => {
      if (!p.getOptionExpiries) throw new Error('optionExpiries not implemented');
      const scrip = INDEX_UNDERLYINGS[sym]?.dhanScrip;
      // Dhan addresses the underlying by security id; others by symbol.
      return p.getOptionExpiries(p.manifest.id === 'dhan' && scrip ? scrip : sym);
    });
    const payload = { list: value, asOf: new Date().toISOString(), source: provider };
    await setJson(cacheKey, payload, TTL.optionExpiries);
    return sourced(value, {
      source: provider, asOf: payload.asOf, freshness: 'optionChain', kind: 'market_data',
    });
  } catch (err) {
    return unavailable(
      'no_expiries',
      `Option expiries unavailable for ${sym}. Run the instruments sync so the contract master is populated, or configure a provider with option-chain support.`,
      attemptsFrom(err),
    );
  }
}

// ── chain ───────────────────────────────────────────────────────────────────

export async function getOptionChain(
  registry: ProviderRegistry,
  underlying: string,
  expiry: string,
): Promise<Sourced<NormalizedOptionChain>> {
  const sym = underlying.toUpperCase();
  const cacheKey = K.optionChain(sym, expiry);
  const status = await marketStatus();

  const cached = await getJson<{ chain: NormalizedOptionChain; source: string }>(cacheKey);
  if (cached) {
    return sourced(cached.chain, {
      source: cached.source,
      asOf: cached.chain.timestamp,
      freshness: 'optionChain',
      marketOpen: status.isSessionActive,
    });
  }

  // Path 1: a provider with a native endpoint.
  try {
    const { value, provider } = await registry.run('optionChain', async (p) => {
      if (!p.getOptionChain) throw new Error('optionChain not implemented');
      const meta = INDEX_UNDERLYINGS[sym];
      if (p.manifest.id === 'dhan' && meta) {
        return p.getOptionChain(meta.dhanScrip, expiry, {
          segment: 'IDX_I',
          underlyingName: sym,
        });
      }
      return p.getOptionChain(sym, expiry);
    });

    if (value.strikes.length > 0) {
      await setJson(cacheKey, { chain: value, source: provider }, TTL.optionChain);
      void persistChainSnapshot(sym, value, provider);
      return sourced(value, {
        source: provider,
        asOf: value.timestamp,
        freshness: 'optionChain',
        marketOpen: status.isSessionActive,
      });
    }
  } catch (err) {
    logger.debug({ err, sym, expiry }, 'Native option chain unavailable; attempting assembly');
  }

  // Path 2: assemble from the contract master + a batched quote call.
  let assemblyError: unknown = null;
  try {
    const assembled = await assembleChain(registry, sym, expiry);
    if (assembled) {
      await setJson(cacheKey, { chain: assembled.chain, source: assembled.source }, TTL.optionChain);
      void persistChainSnapshot(sym, assembled.chain, assembled.source);
      return sourced(assembled.chain, {
        source: assembled.source,
        asOf: assembled.chain.timestamp,
        freshness: 'optionChain',
        marketOpen: status.isSessionActive,
      });
    }
  } catch (err) {
    assemblyError = err;
    logger.warn({ err, sym, expiry }, 'Option chain assembly failed');
  }

  /*
   * Distinguish the two ways this fails, because the fix differs.
   *
   * "No strikes listed" means the instrument sync has not run (or this expiry
   * does not exist). "Strikes listed but quotes failed" means the contract
   * master is fine and the provider rejected the price call — usually a
   * credential problem. Reporting the first when the second happened sends
   * the user to re-sync instruments that are already there.
   */
  const contractCount = (await instrumentsRepo.getOptionContracts(sym, expiry)).length;

  if (contractCount === 0) {
    return unavailable(
      'no_option_contracts',
      `Live option chain unavailable for ${sym} ${expiry}. No provider returned a chain, and the contract master lists no strikes for this expiry — run the instruments sync.`,
      attemptsFrom(assemblyError),
    );
  }

  return unavailable(
    'option_quotes_unavailable',
    `Live option chain unavailable for ${sym} ${expiry}. The contract master lists ${contractCount} strikes, but no configured provider could supply prices for them. Check Settings → Market Data Provider.`,
    attemptsFrom(assemblyError),
  );
}

/**
 * Build a chain from individual option contracts.
 *
 * One batched quote call covers the whole chain. Strikes whose quote is
 * missing are included with null legs rather than dropped, so the strike
 * ladder stays contiguous and the user can see which rows had no data.
 */
async function assembleChain(
  registry: ProviderRegistry,
  underlying: string,
  expiry: string,
): Promise<{ chain: NormalizedOptionChain; source: string } | null> {
  const contracts = await instrumentsRepo.getOptionContracts(underlying, expiry);
  if (contracts.length === 0) return null;

  const { value: quotes, provider } = await registry.run('quoteBatch', async (p) => {
    if (!p.getQuotes) throw new Error('quoteBatch not implemented');
    const reqs: QuoteRequest[] = contracts.map((c) => ({
      exchange: c.exchange,
      tradingsymbol: c.tradingsymbol,
      providerToken: instrumentsRepo.providerToken(c, p.manifest.id),
    }));
    return p.getQuotes(reqs);
  });

  const byTradingsymbol = new Map(quotes.map((q) => [q.tradingsymbol.toUpperCase(), q]));
  const byStrike = new Map<number, OptionStrike>();

  for (const c of contracts) {
    if (c.strike === null || !c.option_type) continue;
    const entry = byStrike.get(c.strike) ?? { strike: c.strike, call: null, put: null };
    const q = byTradingsymbol.get(c.tradingsymbol.toUpperCase());

    if (q) {
      const leg = {
        oi: q.oi,
        oiChange: q.oiChange,
        volume: q.volume,
        ltp: q.ltp,
        // Assembled chains carry no IV from the quote feed; it is solved
        // downstream from the price via Black-Scholes and marked 'derived'.
        iv: null,
        bid: q.bid,
        ask: q.ask,
        bidQty: q.bidQty,
        askQty: q.askQty,
        prevClose: q.prevClose,
      };
      if (c.option_type === 'CE') entry.call = leg;
      else entry.put = leg;
    }
    byStrike.set(c.strike, entry);
  }

  // Spot from the underlying index/stock.
  let spot: number | null = null;
  const underlyingRow = await resolveUnderlyingInstrument(underlying);
  if (underlyingRow) {
    const q = await getQuote(registry, underlyingRow);
    if (isAvailable(q)) spot = q.value.ltp;
  }

  // Futures price for the same expiry, if listed — a better forward for greeks.
  let futuresPrice: number | null = null;
  const futures = (await instrumentsRepo.getFutures(underlying)).find((f) => f.expiry === expiry);
  if (futures) {
    const fq = await getQuote(registry, futures);
    if (isAvailable(fq)) futuresPrice = fq.value.ltp;
  }

  const strikes = [...byStrike.values()].sort((a, b) => a.strike - b.strike);
  if (strikes.length === 0) return null;

  return {
    source: `${provider}+assembled`,
    chain: {
      underlying,
      expiry,
      spot,
      futuresPrice,
      strikes,
      timestamp: new Date().toISOString(),
      lotSize: contracts[0]?.lot_size ?? null,
    },
  };
}

async function resolveUnderlyingInstrument(underlying: string): Promise<InstrumentRow | null> {
  const meta = INDEX_UNDERLYINGS[underlying.toUpperCase()];
  return instrumentsRepo.resolveSymbol(meta?.displayName ?? underlying);
}

async function persistChainSnapshot(
  underlying: string,
  chain: NormalizedOptionChain,
  source: string,
): Promise<void> {
  try {
    const row = await resolveUnderlyingInstrument(underlying);
    if (!row) return;
    const pcr = calculatePcr(chain);
    const maxPain = calculateMaxPain(chain);
    const atm =
      chain.spot !== null && chain.strikes.length > 0
        ? chain.strikes.reduce((best, s) =>
            Math.abs(s.strike - chain.spot!) < Math.abs(best.strike - chain.spot!) ? s : best,
          ).strike
        : null;

    await query(
      `INSERT INTO option_chain_snapshots
         (underlying_id, expiry, captured_at, spot, atm_strike, total_ce_oi, total_pe_oi,
          pcr_oi, pcr_volume, max_pain, strikes, source)
       VALUES ($1,$2::date,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12)`,
      [
        row.id, chain.expiry, chain.timestamp, chain.spot, atm,
        pcr.totalCallOi, pcr.totalPutOi, pcr.pcrOi, pcr.pcrVolume, maxPain.maxPain,
        JSON.stringify(chain.strikes), source,
      ],
    );
  } catch (err) {
    logger.debug({ err }, 'Option chain snapshot not persisted');
  }
}

// ── analytics ───────────────────────────────────────────────────────────────

export interface OptionAnalyticsView {
  underlying: string;
  expiry: string;
  spot: number | null;
  futuresPrice: number | null;
  atmStrike: number | null;
  daysToExpiry: number;
  pcr: PcrResult;
  maxPain: MaxPainResult;
  oiLevels: OiLevels;
  oiShift: ChainOiShift;
  greeks: StrikeGreeks[];
  ivSkew: IvSkew;
  ivPercentile: IvPercentileResult;
  atmIv: number | null;
  strikeCount: number;
  interpretation: string;
}

export async function getOptionAnalytics(
  registry: ProviderRegistry,
  underlying: string,
  expiry: string,
): Promise<Sourced<OptionAnalyticsView>> {
  const chainSourced = await getOptionChain(registry, underlying, expiry);
  if (!isAvailable(chainSourced)) {
    return chainSourced as unknown as Sourced<OptionAnalyticsView>;
  }
  const chain = chainSourced.value;

  const pcr = calculatePcr(chain);
  const maxPain = calculateMaxPain(chain);
  const oiLevels = deriveOiLevels(chain);
  const oiShift = analyzeOiShift(chain);
  const { strikes: greeks, timeToExpiry } = computeChainGreeks(chain);
  const ivSkew = calculateIvSkew(chain, greeks);

  const historicalIvs = await loadIvHistory(underlying, expiry);
  const ivPercentile = calculateIvPercentile(ivSkew.atmIv, historicalIvs);

  const atmStrike =
    chain.spot !== null && chain.strikes.length > 0
      ? chain.strikes.reduce((best, s) =>
          Math.abs(s.strike - chain.spot!) < Math.abs(best.strike - chain.spot!) ? s : best,
        ).strike
      : null;

  const view: OptionAnalyticsView = {
    underlying: chain.underlying,
    expiry: chain.expiry,
    spot: chain.spot,
    futuresPrice: chain.futuresPrice,
    atmStrike,
    daysToExpiry: Math.round(timeToExpiry * 365),
    pcr,
    maxPain,
    oiLevels,
    oiShift,
    greeks,
    ivSkew,
    ivPercentile,
    atmIv: ivSkew.atmIv,
    strikeCount: chain.strikes.length,
    interpretation:
      'Every figure here is computed from the option chain captured at the timestamp shown. ' +
      'Max pain and OI-based levels describe where open interest currently sits; they are ' +
      'positioning statistics that shift as the chain changes, not levels the market is obliged to respect.',
  };

  return { ...chainSourced, value: view, kind: 'calculated' } as Sourced<OptionAnalyticsView>;
}

/** ATM IV history from stored snapshots, for the percentile calculation. */
async function loadIvHistory(underlying: string, expiry: string): Promise<number[]> {
  try {
    const row = await resolveUnderlyingInstrument(underlying);
    if (!row) return [];
    const rows = await queryRows<{ strikes: OptionStrike[]; spot: number | null }>(
      `SELECT strikes, spot FROM option_chain_snapshots
        WHERE underlying_id = $1 AND expiry = $2::date
        ORDER BY captured_at DESC LIMIT 120`,
      [row.id, expiry],
    );

    const ivs: number[] = [];
    for (const r of rows) {
      if (r.spot === null || !Array.isArray(r.strikes)) continue;
      const atm = r.strikes.reduce(
        (best, s) => (Math.abs(s.strike - r.spot!) < Math.abs(best.strike - r.spot!) ? s : best),
        r.strikes[0]!,
      );
      const iv = atm?.call?.iv ?? atm?.put?.iv;
      if (typeof iv === 'number' && iv > 0) ivs.push(iv);
    }
    return ivs;
  } catch {
    return [];
  }
}

// ── futures buildup ─────────────────────────────────────────────────────────

export interface FuturesView {
  symbol: string;
  expiry: string | null;
  ltp: number;
  prevClose: number | null;
  priceChange: number | null;
  oi: number | null;
  oiChange: number | null;
  volume: number | null;
  spot: number | null;
  /** Futures − spot. Positive is premium, negative is discount. */
  basis: number | null;
  basisPct: number | null;
  buildup: BuildupResult;
  lotSize: number;
}

export async function getFuturesAnalysis(
  registry: ProviderRegistry,
  underlying: string,
): Promise<Sourced<FuturesView[]>> {
  const contracts = await instrumentsRepo.getFutures(underlying);
  if (contracts.length === 0) {
    return unavailable(
      'no_futures_contracts',
      `No futures contracts are listed for ${underlying} in the instrument master. Run the instruments sync.`,
    );
  }

  const underlyingRow = await resolveUnderlyingInstrument(underlying);
  let spot: number | null = null;
  if (underlyingRow) {
    const q = await getQuote(registry, underlyingRow);
    if (isAvailable(q)) spot = q.value.ltp;
  }

  const views: FuturesView[] = [];
  let oldest: number | null = null;
  const sources = new Set<string>();

  for (const c of contracts.slice(0, 3)) {
    const q = await getQuote(registry, c);
    if (!isAvailable(q)) continue;
    sources.add(q.source);
    const t = new Date(q.asOf).getTime();
    if (oldest === null || t < oldest) oldest = t;

    const v = q.value;
    const priceChange = v.prevClose !== null ? v.ltp - v.prevClose : null;

    // Previous OI comes from the stored snapshot; without it, OI change is
    // unknown and the buildup is honestly reported as indeterminate.
    const prev = await queryRows<{ oi: number | null }>(
      `SELECT oi FROM futures_snapshots
        WHERE instrument_id = $1 AND captured_at < date_trunc('day', now())
        ORDER BY captured_at DESC LIMIT 1`,
      [c.id],
    );
    const prevOi = prev[0]?.oi ?? null;
    const oiChange = v.oi !== null && prevOi !== null ? v.oi - prevOi : v.oiChange;

    const buildup = classifyBuildup(priceChange, oiChange, {
      priceBase: v.prevClose,
      oiBase: prevOi,
    });

    void query(
      `INSERT INTO futures_snapshots
         (instrument_id, captured_at, ltp, price_change, oi, oi_change, volume, basis, buildup, source)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (instrument_id, captured_at) DO NOTHING`,
      [
        c.id, v.timestamp, v.ltp, priceChange, v.oi, oiChange, v.volume,
        spot !== null ? v.ltp - spot : null, buildup.type, q.source,
      ],
    ).catch(() => undefined);

    views.push({
      symbol: c.tradingsymbol,
      expiry: c.expiry,
      ltp: v.ltp,
      prevClose: v.prevClose,
      priceChange,
      oi: v.oi,
      oiChange,
      volume: v.volume,
      spot,
      basis: spot !== null ? v.ltp - spot : null,
      basisPct: spot !== null && spot > 0 ? ((v.ltp - spot) / spot) * 100 : null,
      buildup,
      lotSize: c.lot_size,
    });
  }

  if (views.length === 0) {
    return unavailable(
      'no_futures_quotes',
      `Live market data unavailable for ${underlying} futures contracts.`,
    );
  }

  const statusNow = await marketStatus();
  return sourced(views, {
    source: [...sources].join('+'),
    asOf: new Date(oldest ?? Date.now()).toISOString(),
    freshness: 'quote',
    kind: 'calculated',
    marketOpen: statusNow.isSessionActive,
  });
}
