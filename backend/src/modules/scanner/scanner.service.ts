/**
 * Swing-trading scanner and trade-idea construction.
 *
 * The scanner runs the same signal engine used on the stock-analysis page, so
 * a setup shown here and the same setup opened in detail cannot disagree.
 *
 * Trade ideas are built with levels derived from real structure:
 *   entry zone   — around the current price, widened by ATR
 *   invalidation — below the nearest support (long) / above resistance (short),
 *                  with an ATR buffer so ordinary noise does not trigger it
 *   targets      — the next structural level, then a measured move
 *
 * An idea cannot be constructed without an invalidation level and at least one
 * risk factor. That is enforced by the type and by a database CHECK constraint.
 */
import { query, queryRows } from '../../db/pool.js';
import { logger } from '../../utils/logger.js';
import { sourced, type Sourced } from '../../utils/sourced.js';
import type { ProviderRegistry } from '../../providers/registry.js';
import * as instrumentsRepo from '../../db/repositories/instruments.js';
import type { InstrumentRow } from '../../db/repositories/instruments.js';
import { getCandles, marketStatus } from '../market/marketData.service.js';
import { buildSnapshot, type TechnicalSnapshot } from '../../analysis/snapshot.js';
import { runSignalEngine, type SetupMatch, type SetupKind } from '../../analysis/signals/engine.js';
import { calculateRiskReward, calculatePositionSize, type RiskConfig } from '../../analysis/risk/positionSizing.js';
import type { Timeframe } from '../../utils/time.js';

export interface ScanRequest {
  setups?: SetupKind[];
  timeframe?: Timeframe;
  universe?: string;
  minStrength?: number;
  limit?: number;
  maxSymbols?: number;
}

export interface TradeIdeaView {
  symbol: string;
  tradingsymbol: string;
  name: string | null;
  sector: string | null;
  setup: SetupKind;
  setupLabel: string;
  direction: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  timeframe: Timeframe;
  currentPrice: number;

  entryLow: number;
  entryHigh: number;
  /** Where the idea is proven wrong. Mandatory. */
  invalidation: number;
  target1: number;
  target2: number | null;
  riskReward: number;
  riskRewardDisplay: string;
  breakEvenWinRatePct: number;

  /** Rule-confirmation strength, 0–100. Explicitly not a probability. */
  confidence: number;
  technicalReasons: string[];
  /** How each level was derived. */
  levelDerivation: string[];
  riskFactors: string[];

  scores: {
    trend: number | null;
    momentum: number | null;
    volume: number | null;
    volatility: number | null;
    structure: number | null;
  };
  atr: number | null;
  atrPct: number | null;

  /** Position sizing for this user's configured risk budget. */
  positionSizing: {
    quantity: number;
    positionValue: number;
    capitalAtRisk: number;
    riskPct: number;
    limitedBy: string;
    explain: string[];
    warnings: string[];
  } | null;

  dataAsOf: string;
  dataSource: string;
  disclaimer: string;
}

const DISCLAIMER =
  'This is a rule-based research observation, not a recommendation or a call. ' +
  'Confidence measures how many technical conditions currently agree — it says nothing about ' +
  'the likelihood of the trade working. Levels are derived from recent price structure and ' +
  'will change as new bars print.';

/**
 * Build a trade idea from a matched setup.
 *
 * Returns null when the structure does not support a coherent risk/reward —
 * for example when no support level exists below price to anchor a stop. An
 * idea without a defensible invalidation level is not worth publishing.
 */
export function buildTradeIdea(
  instrument: InstrumentRow,
  snapshot: TechnicalSnapshot,
  setup: SetupMatch,
  scores: TradeIdeaView['scores'],
  dataSource: string,
  riskConfig?: RiskConfig,
): TradeIdeaView | null {
  const price = snapshot.price.close;
  const atr = snapshot.volatility.atr14;
  if (atr === null || atr <= 0 || price <= 0) return null;
  if (setup.direction === 'NEUTRAL') return null;

  const isLong = setup.direction === 'BULLISH';
  const derivation: string[] = [];

  // Entry zone: half an ATR either side of the close.
  const entryLow = isLong ? price - atr * 0.25 : price - atr * 0.25;
  const entryHigh = isLong ? price + atr * 0.25 : price + atr * 0.25;
  derivation.push(
    `Entry zone ${entryLow.toFixed(2)}–${entryHigh.toFixed(2)}: last close ${price.toFixed(2)} ± 0.25 × ATR(14) of ${atr.toFixed(2)}.`,
  );

  // Invalidation: beyond the nearest structural level, buffered by ATR.
  let invalidation: number;
  if (isLong) {
    const support = snapshot.structure.nearestSupport;
    if (support && support.price < price) {
      invalidation = support.price - atr * 0.5;
      derivation.push(
        `Invalidation ${invalidation.toFixed(2)}: 0.5 × ATR below the nearest mapped support at ${support.price.toFixed(2)} (${support.touches} touches, strength ${support.strength}/100).`,
      );
    } else {
      invalidation = price - atr * 1.5;
      derivation.push(
        `Invalidation ${invalidation.toFixed(2)}: no mapped support below price, so 1.5 × ATR(14) below the close is used instead.`,
      );
    }
  } else {
    const resistance = snapshot.structure.nearestResistance;
    if (resistance && resistance.price > price) {
      invalidation = resistance.price + atr * 0.5;
      derivation.push(
        `Invalidation ${invalidation.toFixed(2)}: 0.5 × ATR above the nearest mapped resistance at ${resistance.price.toFixed(2)} (${resistance.touches} touches, strength ${resistance.strength}/100).`,
      );
    } else {
      invalidation = price + atr * 1.5;
      derivation.push(
        `Invalidation ${invalidation.toFixed(2)}: no mapped resistance above price, so 1.5 × ATR(14) above the close is used instead.`,
      );
    }
  }

  const risk = Math.abs(price - invalidation);
  if (risk <= 0) return null;

  // Target 1: the next structural level in the direction of the idea, if it
  // sits at least 1R away; otherwise a 1.5R measured move.
  let target1: number;
  const nextLevel = isLong
    ? snapshot.structure.resistances.find((r) => r.price > price + risk)
    : snapshot.structure.supports.find((s) => s.price < price - risk);

  if (nextLevel) {
    target1 = nextLevel.price;
    derivation.push(
      `Target 1 ${target1.toFixed(2)}: the next mapped ${isLong ? 'resistance' : 'support'} level (${nextLevel.touches} touches), which sits beyond 1R.`,
    );
  } else {
    target1 = isLong ? price + risk * 1.5 : price - risk * 1.5;
    derivation.push(
      `Target 1 ${target1.toFixed(2)}: no mapped level beyond 1R, so a 1.5R measured move from entry is used.`,
    );
  }

  // Target 2: the level beyond target 1, or 2.5R.
  const beyond = isLong
    ? snapshot.structure.resistances.find((r) => r.price > target1 * 1.001)
    : snapshot.structure.supports.find((s) => s.price < target1 * 0.999);
  const target2 = beyond
    ? beyond.price
    : isLong
      ? price + risk * 2.5
      : price - risk * 2.5;
  derivation.push(
    beyond
      ? `Target 2 ${target2.toFixed(2)}: the next mapped level beyond target 1.`
      : `Target 2 ${target2.toFixed(2)}: a 2.5R measured move, as no further mapped level exists.`,
  );

  const rr = calculateRiskReward({ entry: price, stop: invalidation, target1, target2 });
  if (!rr.valid || rr.riskReward1 < 1) return null;

  const riskFactors = buildRiskFactors(snapshot, setup, invalidation, isLong);

  let positionSizing: TradeIdeaView['positionSizing'] = null;
  if (riskConfig) {
    try {
      const sizing = calculatePositionSize({
        entry: price,
        stop: invalidation,
        config: riskConfig,
        lotSize: instrument.lot_size,
      });
      positionSizing = {
        quantity: sizing.quantity,
        positionValue: sizing.positionValue,
        capitalAtRisk: sizing.actualCapitalAtRisk,
        riskPct: sizing.actualRiskPct,
        limitedBy: sizing.limitedBy,
        explain: sizing.explain,
        warnings: sizing.warnings,
      };
    } catch (err) {
      logger.debug({ err }, 'Position sizing skipped for idea');
    }
  }

  return {
    symbol: `${instrument.exchange}:${instrument.tradingsymbol}`,
    tradingsymbol: instrument.tradingsymbol,
    name: instrument.name,
    sector: instrument.sector,
    setup: setup.kind,
    setupLabel: setup.label,
    direction: setup.direction,
    timeframe: snapshot.timeframe as Timeframe,
    currentPrice: price,
    entryLow,
    entryHigh,
    invalidation,
    target1,
    target2,
    riskReward: rr.riskReward1,
    riskRewardDisplay: rr.display1,
    breakEvenWinRatePct: rr.breakEvenWinRatePct,
    confidence: setup.strength,
    technicalReasons: setup.reasons,
    levelDerivation: derivation,
    riskFactors,
    scores,
    atr,
    atrPct: snapshot.volatility.atrPct,
    positionSizing,
    dataAsOf: snapshot.asOf,
    dataSource,
    disclaimer: DISCLAIMER,
  };
}

/** Risk factors are mandatory; this always returns at least one. */
function buildRiskFactors(
  snapshot: TechnicalSnapshot,
  setup: SetupMatch,
  invalidation: number,
  isLong: boolean,
): string[] {
  const factors: string[] = [];

  factors.push(
    isLong
      ? `The setup fails if price closes below ${invalidation.toFixed(2)}.`
      : `The setup fails if price closes above ${invalidation.toFixed(2)}.`,
  );

  if (setup.kind === 'BREAKOUT' || setup.kind === 'BREAKDOWN') {
    factors.push(
      'Breakouts fail frequently. A close back inside the prior range would invalidate the premise regardless of the stop level.',
    );
  }
  if (setup.kind === 'REVERSAL') {
    factors.push(
      'This is a counter-trend setup. Oversold and overbought conditions can persist far longer than the indicator suggests.',
    );
  }

  const atrPct = snapshot.volatility.atrPct;
  if (atrPct !== null && atrPct > 3) {
    factors.push(
      `Daily range is wide — ATR is ${atrPct.toFixed(2)}% of price — so the stop is proportionally far and position size will be small.`,
    );
  }

  const relVol = snapshot.volume.relativeVolume;
  if (relVol !== null && relVol < 0.8) {
    factors.push(
      `Volume is only ${relVol.toFixed(2)}× its 20-period average, so the move is not yet confirmed by participation.`,
    );
  }

  if (snapshot.insufficient.length > 0) {
    factors.push(
      `Some indicators could not be computed on the available history (${snapshot.insufficient.map((i) => i.field).join(', ')}), so the picture is incomplete.`,
    );
  }

  const failedConfirmations = setup.confirmingRules.filter((r) => r.evaluable && !r.passed);
  if (failedConfirmations.length > 0) {
    factors.push(
      `${failedConfirmations.length} of the setup's confirming conditions did not fire: ${failedConfirmations
        .slice(0, 3)
        .map((r) => r.label)
        .join(', ')}.`,
    );
  }

  factors.push(
    'Levels are computed from historical bars and do not account for scheduled events (earnings, policy announcements, index rebalancing) that may gap price through the stop.',
  );

  return factors;
}

// ── the scan ────────────────────────────────────────────────────────────────

export interface ScanResult {
  ideas: TradeIdeaView[];
  scanned: number;
  analyzed: number;
  skipped: Array<{ symbol: string; reason: string }>;
  universe: string;
  timeframe: Timeframe;
  methodology: string;
}

export async function runScan(
  registry: ProviderRegistry,
  req: ScanRequest,
  riskConfig?: RiskConfig,
): Promise<Sourced<ScanResult>> {
  const {
    setups,
    timeframe = '1d',
    universe = 'NIFTY50',
    minStrength = 50,
    limit = 25,
    maxSymbols = 200,
  } = req;

  const instruments = await instrumentsRepo.getUniverse({
    index: universe === 'NSE' ? undefined : universe,
    limit: maxSymbols,
  });

  const ideas: TradeIdeaView[] = [];
  const skipped: Array<{ symbol: string; reason: string }> = [];
  let analyzed = 0;
  let oldest: number | null = null;
  const sources = new Set<string>();

  // Sequential with a small concurrency window: the point of the scan is to
  // read stored candles, and hammering the DB with 200 parallel queries is
  // slower than a controlled pipeline.
  const CONCURRENCY = 8;
  for (let i = 0; i < instruments.length; i += CONCURRENCY) {
    const batch = instruments.slice(i, i + CONCURRENCY);
    await Promise.all(
      batch.map(async (inst) => {
        try {
          const candles = await getCandles(registry, inst, timeframe, { bars: 250 });
          if (candles.candles.length < 50) {
            skipped.push({
              symbol: inst.tradingsymbol,
              reason: `only ${candles.candles.length} bars of history`,
            });
            return;
          }

          sources.add(candles.source);
          const asOfMs = candles.asOf ? new Date(candles.asOf).getTime() : Date.now();
          if (oldest === null || asOfMs < oldest) oldest = asOfMs;

          const snapshot = buildSnapshot(inst.tradingsymbol, timeframe, candles.candles);
          const report = runSignalEngine(snapshot);
          analyzed += 1;

          for (const setup of report.setups) {
            if (setups && !setups.includes(setup.kind)) continue;
            if (setup.strength < minStrength) continue;

            const idea = buildTradeIdea(
              inst, snapshot, setup, report.scores, candles.source, riskConfig,
            );
            if (idea) ideas.push(idea);
          }
        } catch (err) {
          skipped.push({
            symbol: inst.tradingsymbol,
            reason: err instanceof Error ? err.message.slice(0, 120) : 'analysis failed',
          });
        }
      }),
    );
  }

  ideas.sort((a, b) => b.confidence - a.confidence || b.riskReward - a.riskReward);

  const status = await marketStatus();
  const result: ScanResult = {
    ideas: ideas.slice(0, limit),
    scanned: instruments.length,
    analyzed,
    skipped: skipped.slice(0, 20),
    universe,
    timeframe,
    methodology:
      `Every instrument in the ${universe} universe was evaluated against the same rule set used on the ` +
      `stock-analysis page, on ${timeframe} bars. A setup is reported only when all of its required rules pass, ` +
      `no disqualifying rule fires, and confirmation strength reaches ${minStrength}. ` +
      `${analyzed} of ${instruments.length} instruments had enough history to analyse.`,
  };

  return sourced(result, {
    source: [...sources].join('+') || 'computed',
    asOf: new Date(oldest ?? Date.now()).toISOString(),
    freshness: 'breadth',
    kind: 'rule_signal',
    marketOpen: status.isSessionActive,
  });
}

/** Persist ideas so the dashboard and alert engine can reference them. */
export async function persistIdeas(ideas: TradeIdeaView[]): Promise<number> {
  let saved = 0;
  for (const idea of ideas) {
    try {
      const inst = await instrumentsRepo.resolveSymbol(idea.symbol);
      if (!inst) continue;
      await query(
        `INSERT INTO trade_ideas
           (instrument_id, direction, setup, timeframe, entry_low, entry_high, invalidation,
            target1, target2, risk_reward, confidence, technical_reasons, risk_factors,
            data_sources, data_as_of)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15)`,
        [
          inst.id, idea.direction, idea.setup, idea.timeframe, idea.entryLow, idea.entryHigh,
          idea.invalidation, idea.target1, idea.target2, idea.riskReward, idea.confidence,
          idea.technicalReasons, idea.riskFactors,
          JSON.stringify([{ source: idea.dataSource, asOf: idea.dataAsOf }]),
          idea.dataAsOf,
        ],
      );
      saved += 1;
    } catch (err) {
      logger.debug({ err, symbol: idea.symbol }, 'Trade idea not persisted');
    }
  }
  return saved;
}

export async function getRecentIdeas(limit = 20): Promise<Array<Record<string, unknown>>> {
  return queryRows(
    `SELECT t.id, t.direction, t.setup, t.timeframe, t.entry_low, t.entry_high,
            t.invalidation, t.target1, t.target2, t.risk_reward, t.confidence,
            t.technical_reasons, t.risk_factors, t.data_as_of, t.generated_at, t.status,
            i.tradingsymbol, i.exchange, i.name, i.sector
       FROM trade_ideas t JOIN instruments i ON i.id = t.instrument_id
      WHERE t.status = 'ACTIVE' AND t.generated_at > now() - interval '3 days'
      ORDER BY t.confidence DESC, t.generated_at DESC
      LIMIT $1`,
    [limit],
  );
}
