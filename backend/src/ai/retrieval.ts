/**
 * Retrieval: turn an intent + symbols into an evidence bundle.
 *
 * Everything here reuses the same services the REST API uses, so a number the
 * AI quotes is byte-identical to the number on the corresponding page. There
 * is no separate "AI data path" that could drift.
 */
import type { ProviderRegistry } from '../providers/registry.js';
import * as instrumentsRepo from '../db/repositories/instruments.js';
import { getQuote, getCandles, marketStatus } from '../modules/market/marketData.service.js';
import { getBreadth, getRegime } from '../modules/market/market.service.js';
import { getFundamentals } from '../modules/fundamentals/fundamentals.service.js';
import { getNewsForInstrument, getNews } from '../modules/news/news.service.js';
import { getOptionAnalytics, getExpiries } from '../modules/options/options.service.js';
import { analyzePortfolio, getDefaultPortfolio } from '../modules/portfolio/portfolio.service.js';
import { runScan } from '../modules/scanner/scanner.service.js';
import { buildSnapshot } from '../analysis/snapshot.js';
import { runSignalEngine } from '../analysis/signals/engine.js';
import { isAvailable } from '../utils/sourced.js';
import { EvidenceBuilder, type EvidenceBundle } from './evidence.js';
import type { Intent, RetrievalPlan } from './intent.js';
import type { Timeframe } from '../utils/time.js';
import { logger } from '../utils/logger.js';

export interface RetrievalContext {
  registry: ProviderRegistry;
  userId: string;
  intent: Intent;
  symbols: string[];
  timeframe: Timeframe;
  plan: RetrievalPlan;
  question: string;
}

export async function gatherEvidence(ctx: RetrievalContext): Promise<EvidenceBundle> {
  const status = await marketStatus();
  const subject = ctx.symbols.length > 0 ? ctx.symbols.join(', ') : 'Indian market';
  const b = new EvidenceBuilder(ctx.intent, subject, status.phase);

  b.addContext(
    'market.phase',
    'Market session state',
    `The NSE equity session is currently ${status.phase} (${status.nowIst}). ` +
      (status.isOpen
        ? 'Continuous trading is in progress, so quotes reflect live prices.'
        : 'Continuous trading is not in progress, so the latest prices are from the most recent session.'),
  );

  // Run the independent fetches concurrently.
  await Promise.all([
    ctx.plan.needsQuote || ctx.plan.needsTechnicals || ctx.plan.needsFundamentals || ctx.plan.needsNews
      ? gatherPerSymbol(ctx, b)
      : Promise.resolve(),
    ctx.plan.needsBreadth ? gatherBreadth(ctx, b) : Promise.resolve(),
    ctx.plan.needsRegime ? gatherRegime(ctx, b) : Promise.resolve(),
    ctx.plan.needsOptionChain ? gatherOptions(ctx, b) : Promise.resolve(),
    ctx.plan.needsPortfolio ? gatherPortfolio(ctx, b) : Promise.resolve(),
    ctx.plan.needsScan ? gatherScan(ctx, b) : Promise.resolve(),
    ctx.plan.needsNews && ctx.symbols.length === 0 ? gatherMarketNews(b) : Promise.resolve(),
  ]);

  // Index context is useful for almost every market question.
  if (ctx.plan.needsBreadth || ctx.plan.needsRegime || ctx.intent === 'market_why') {
    await gatherIndices(ctx, b);
  }

  return b.build();
}

// ── per-symbol ──────────────────────────────────────────────────────────────

async function gatherPerSymbol(ctx: RetrievalContext, b: EvidenceBuilder): Promise<void> {
  if (ctx.symbols.length === 0) return;

  await Promise.all(
    ctx.symbols.slice(0, 3).map(async (symbol) => {
      const prefix = ctx.symbols.length > 1 ? `${symbol.toLowerCase()}.` : '';
      const instrument = await instrumentsRepo.resolveSymbol(symbol);
      if (!instrument) {
        b.markMissing(`${prefix}instrument`, symbol, 'not found in the instrument master');
        return;
      }

      b.addText(`${prefix}name`, `${symbol} company name`, instrument.name, {
        source: 'instrument-master', asOf: new Date().toISOString(),
      });
      if (instrument.sector) {
        b.addText(`${prefix}sector`, `${symbol} sector`, instrument.sector, {
          source: 'instrument-master', asOf: new Date().toISOString(),
        });
      }

      // ── quote ──
      if (ctx.plan.needsQuote) {
        const quote = await getQuote(ctx.registry, instrument);
        if (isAvailable(quote)) {
          const q = quote.value;
          const meta = { source: quote.source, asOf: quote.asOf };
          b.addNumber(`${prefix}price.ltp`, `${symbol} last traded price`, q.ltp, { unit: 'INR', ...meta });
          b.addNumber(`${prefix}price.prevClose`, `${symbol} previous close`, q.prevClose, { unit: 'INR', ...meta });
          b.addNumber(`${prefix}price.open`, `${symbol} open`, q.open, { unit: 'INR', ...meta });
          b.addNumber(`${prefix}price.high`, `${symbol} day high`, q.high, { unit: 'INR', ...meta });
          b.addNumber(`${prefix}price.low`, `${symbol} day low`, q.low, { unit: 'INR', ...meta });
          b.addNumber(`${prefix}price.volume`, `${symbol} volume`, q.volume, { unit: 'shares', ...meta });
          b.addNumber(`${prefix}price.avgPrice`, `${symbol} exchange average price (VWAP)`, q.avgPrice, {
            unit: 'INR', ...meta,
            note: 'Exchange-reported average traded price for the session',
          });
          b.addNumber(`${prefix}price.week52High`, `${symbol} 52-week high`, q.week52High, { unit: 'INR', ...meta });
          b.addNumber(`${prefix}price.week52Low`, `${symbol} 52-week low`, q.week52Low, { unit: 'INR', ...meta });
          if (q.prevClose !== null && q.prevClose > 0) {
            b.addNumber(`${prefix}price.change`, `${symbol} change`, q.ltp - q.prevClose, {
              unit: 'INR', ...meta, kind: 'calculated',
              note: 'last traded price minus previous close',
            });
            b.addNumber(
              `${prefix}price.changePct`, `${symbol} change percent`,
              ((q.ltp - q.prevClose) / q.prevClose) * 100,
              { unit: '%', ...meta, kind: 'calculated' },
            );
          }
          b.addText(`${prefix}price.status`, `${symbol} data status`, quote.status, {
            source: quote.source, asOf: quote.asOf,
          });
        } else {
          b.markMissing(`${prefix}price.ltp`, `${symbol} price`, quote.detail ?? quote.reason);
        }
      }

      // ── technicals ──
      if (ctx.plan.needsTechnicals) {
        try {
          const candles = await getCandles(ctx.registry, instrument, ctx.timeframe, { bars: 300 });
          if (candles.candles.length < 30) {
            b.markMissing(
              `${prefix}technicals`, `${symbol} technical indicators`,
              `only ${candles.candles.length} ${ctx.timeframe} bars available; at least 30 are required`,
            );
          } else {
            const snap = buildSnapshot(symbol, ctx.timeframe, candles.candles);
            const meta = { source: `computed(${candles.source})`, asOf: snap.asOf, kind: 'calculated' as const };

            b.addNumber(`${prefix}tech.rsi14`, `${symbol} RSI(14)`, snap.momentum.rsi14, { ...meta });
            b.addNumber(`${prefix}tech.macd`, `${symbol} MACD line`, snap.momentum.macd, { ...meta });
            b.addNumber(`${prefix}tech.macdSignal`, `${symbol} MACD signal`, snap.momentum.macdSignal, { ...meta });
            b.addNumber(`${prefix}tech.sma20`, `${symbol} SMA 20`, snap.movingAverages.sma20, { unit: 'INR', ...meta });
            b.addNumber(`${prefix}tech.sma50`, `${symbol} SMA 50`, snap.movingAverages.sma50, { unit: 'INR', ...meta });
            b.addNumber(`${prefix}tech.sma200`, `${symbol} SMA 200`, snap.movingAverages.sma200, { unit: 'INR', ...meta });
            b.addNumber(`${prefix}tech.ema20`, `${symbol} EMA 20`, snap.movingAverages.ema20, { unit: 'INR', ...meta });
            b.addNumber(`${prefix}tech.atr14`, `${symbol} ATR(14)`, snap.volatility.atr14, { unit: 'INR', ...meta });
            b.addNumber(`${prefix}tech.atrPct`, `${symbol} ATR as percent of price`, snap.volatility.atrPct, { unit: '%', ...meta });
            b.addNumber(`${prefix}tech.adx14`, `${symbol} ADX(14)`, snap.trend.adx14, { ...meta });
            b.addNumber(`${prefix}tech.relVolume`, `${symbol} volume vs 20-period average`, snap.volume.relativeVolume, { unit: 'x', ...meta });
            if (snap.vwap !== null) {
              b.addNumber(`${prefix}tech.vwap`, `${symbol} session VWAP`, snap.vwap, { unit: 'INR', ...meta });
            }
            b.addText(`${prefix}tech.trend`, `${symbol} trend classification`, snap.trend.assessment.label, {
              source: 'rule-engine-v1', asOf: snap.asOf, kind: 'rule_signal',
            });
            b.addNumber(`${prefix}tech.supertrend`, `${symbol} Supertrend level`, snap.trend.supertrend, { unit: 'INR', ...meta });

            if (snap.structure.nearestSupport) {
              b.addNumber(
                `${prefix}tech.support`, `${symbol} nearest mapped support`,
                snap.structure.nearestSupport.price,
                { unit: 'INR', ...meta,
                  note: `${snap.structure.nearestSupport.touches} prior touches, strength ${snap.structure.nearestSupport.strength}/100` },
              );
            }
            if (snap.structure.nearestResistance) {
              b.addNumber(
                `${prefix}tech.resistance`, `${symbol} nearest mapped resistance`,
                snap.structure.nearestResistance.price,
                { unit: 'INR', ...meta,
                  note: `${snap.structure.nearestResistance.touches} prior touches, strength ${snap.structure.nearestResistance.strength}/100` },
              );
            }

            const signals = runSignalEngine(snap);
            b.addNumber(`${prefix}score.overall`, `${symbol} overall rule-confirmation score`, signals.overallScore, {
              source: 'rule-engine-v1', asOf: snap.asOf, kind: 'rule_signal',
              note: 'weighted agreement of rule-based conditions, 0-100; not a probability',
            });
            for (const [key, val] of Object.entries(signals.scores)) {
              b.addNumber(`${prefix}score.${key}`, `${symbol} ${key} score`, val, {
                source: 'rule-engine-v1', asOf: snap.asOf, kind: 'rule_signal',
              });
            }

            if (signals.setups.length > 0) {
              b.addContext(
                `${prefix}setups`, `${symbol} matched rule-based setups`,
                signals.setups
                  .map((s) =>
                    `${s.label} (${s.direction}, confirmation strength ${s.strength}/100): ${s.reasons.slice(0, 5).join('; ')}`)
                  .join('\n'),
              );
            } else {
              b.addContext(`${prefix}setups`, `${symbol} matched setups`,
                'No rule-based setup currently matches for this symbol and timeframe.');
            }

            b.addContext(
              `${prefix}rules`, `${symbol} rule evaluation detail`,
              signals.allRules
                .filter((r) => r.evaluable)
                .map((r) => `${r.passed ? 'PASS' : 'fail'} — ${r.label}: ${r.detail}`)
                .join('\n'),
            );

            b.addContext(`${prefix}structure`, `${symbol} trend reasoning`,
              snap.trend.assessment.reasons.join('; '));

            if (snap.structure.divergence) {
              b.addContext(`${prefix}divergence`, `${symbol} momentum divergence`,
                snap.structure.divergence.detail);
            }

            if (snap.insufficient.length > 0) {
              for (const i of snap.insufficient) {
                b.markMissing(`${prefix}tech.${i.field}`, `${symbol} ${i.field}`,
                  `needs ${i.required} bars, only ${i.available} available`);
              }
            }
          }
        } catch (err) {
          logger.debug({ err, symbol }, 'AI retrieval: technicals unavailable');
          b.markMissing(`${prefix}technicals`, `${symbol} technical indicators`,
            err instanceof Error ? err.message.slice(0, 160) : 'price history unavailable');
        }
      }

      // ── fundamentals ──
      if (ctx.plan.needsFundamentals) {
        const f = await getFundamentals(instrument);
        if (isAvailable(f)) {
          const meta = { source: f.source, asOf: f.asOf };
          const m = f.value.metrics;
          b.addNumber(`${prefix}fund.pe`, `${symbol} P/E ratio`, m['pe'], { unit: 'x', ...meta });
          b.addNumber(`${prefix}fund.pb`, `${symbol} P/B ratio`, m['pb'], { unit: 'x', ...meta });
          b.addNumber(`${prefix}fund.roe`, `${symbol} return on equity`, m['roe'], { unit: '%', ...meta });
          b.addNumber(`${prefix}fund.roce`, `${symbol} return on capital employed`, m['roce'], { unit: '%', ...meta });
          b.addNumber(`${prefix}fund.eps`, `${symbol} EPS (TTM)`, m['epsTtm'], { unit: 'INR', ...meta });
          b.addNumber(`${prefix}fund.revenue`, `${symbol} revenue (TTM)`, m['revenueTtm'], { unit: 'INR', ...meta });
          b.addNumber(`${prefix}fund.revenueGrowth`, `${symbol} revenue growth YoY`, m['revenueGrowthYoy'], { unit: '%', ...meta });
          b.addNumber(`${prefix}fund.debtEquity`, `${symbol} debt to equity`, m['debtToEquity'], { unit: 'ratio', ...meta });
          b.addNumber(`${prefix}fund.marketCap`, `${symbol} market capitalisation`, m['marketCap'], { unit: 'INR', ...meta });
          b.addNumber(`${prefix}fund.promoterHolding`, `${symbol} promoter holding`, m['promoterHolding'], { unit: '%', ...meta });

          b.addContext(
            `${prefix}fund.summary`, `${symbol} fundamental assessment`,
            f.value.summary
              .map((s) => `${s.category}: ${s.verdict} — ${s.headline}`)
              .join('\n'),
          );
        } else {
          b.markMissing(`${prefix}fundamentals`, `${symbol} fundamentals`, f.detail ?? f.reason);
        }
      }

      // ── news ──
      if (ctx.plan.needsNews) {
        const news = await getNewsForInstrument(instrument.id, 6);
        if (isAvailable(news)) {
          b.addContext(
            `${prefix}news`, `${symbol} recent news`,
            news.value
              .map((n) =>
                `[${n.publishedAt}] ${n.publisher}: ${n.headline}` +
                (n.sentiment.label
                  ? ` (automated sentiment: ${n.sentiment.label}, confidence ${n.sentiment.confidence?.toFixed(2)})`
                  : ''))
              .join('\n'),
          );
        } else {
          b.markMissing(`${prefix}news`, `${symbol} news`, news.detail ?? news.reason);
        }
      }
    }),
  );
}

// ── market-wide ─────────────────────────────────────────────────────────────

async function gatherIndices(ctx: RetrievalContext, b: EvidenceBuilder): Promise<void> {
  for (const [key, name] of [['nifty', 'NIFTY 50'], ['banknifty', 'NIFTY BANK'], ['vix', 'INDIA VIX']] as const) {
    const row = await instrumentsRepo.resolveSymbol(name);
    if (!row) {
      b.markMissing(`index.${key}.ltp`, name, 'not in the instrument master');
      continue;
    }
    const q = await getQuote(ctx.registry, row);
    if (!isAvailable(q)) {
      b.markMissing(`index.${key}.ltp`, name, q.detail ?? q.reason);
      continue;
    }
    const meta = { source: q.source, asOf: q.asOf };
    b.addNumber(`index.${key}.ltp`, `${name} level`, q.value.ltp, { ...meta });
    b.addNumber(`index.${key}.prevClose`, `${name} previous close`, q.value.prevClose, { ...meta });
    if (q.value.prevClose !== null && q.value.prevClose > 0) {
      b.addNumber(
        `index.${key}.changePct`, `${name} change percent`,
        ((q.value.ltp - q.value.prevClose) / q.value.prevClose) * 100,
        { unit: '%', ...meta, kind: 'calculated' },
      );
    }
  }
}

async function gatherBreadth(ctx: RetrievalContext, b: EvidenceBuilder): Promise<void> {
  const breadth = await getBreadth(ctx.registry, 'NIFTY50');
  if (!isAvailable(breadth)) {
    b.markMissing('breadth', 'Market breadth', breadth.detail ?? breadth.reason);
    return;
  }
  const meta = { source: breadth.source, asOf: breadth.asOf, kind: 'calculated' as const };
  b.addNumber('breadth.advances', 'Advancing stocks', breadth.value.advances, meta);
  b.addNumber('breadth.declines', 'Declining stocks', breadth.value.declines, meta);
  b.addNumber('breadth.unchanged', 'Unchanged stocks', breadth.value.unchanged, meta);
  b.addNumber('breadth.total', 'Stocks scanned', breadth.value.totalScanned, meta);
  b.addNumber('breadth.pct', 'Percent advancing', breadth.value.breadthPct, { unit: '%', ...meta });
  b.addContext('breadth.method', 'How breadth was computed', breadth.value.method);
}

async function gatherRegime(ctx: RetrievalContext, b: EvidenceBuilder): Promise<void> {
  const regime = await getRegime(ctx.registry);
  if (!isAvailable(regime)) {
    b.markMissing('regime.label', 'Market regime', regime.detail ?? regime.reason);
    return;
  }
  const r = regime.value;
  const meta = { source: regime.source, asOf: regime.asOf, kind: 'rule_signal' as const };
  b.addText('regime.label', 'Market regime', r.regime, meta);
  b.addNumber('regime.composite', 'Regime composite score', r.compositeScore, {
    ...meta, note: 'scale from -100 (maximally bearish) to +100 (maximally bullish)',
  });
  b.addNumber('regime.confidence', 'Regime evidence coverage', r.confidence, { unit: '%', ...meta });
  b.addContext('regime.summary', 'Regime summary', r.summary);
  b.addContext('regime.components', 'Regime components',
    r.components.filter((c) => c.available).map((c) => `${c.name}: ${c.observed}`).join('\n'));
  b.addContext('regime.caveats', 'Regime caveats', r.caveats.join(' '));
}

async function gatherMarketNews(b: EvidenceBuilder): Promise<void> {
  const news = await getNews({ limit: 12, sinceHours: 24 });
  if (!isAvailable(news)) {
    b.markMissing('news.market', 'Market news', news.detail ?? news.reason);
    return;
  }
  b.addContext(
    'news.market', 'Recent market news (last 24 hours)',
    news.value
      .map((n) => `[${n.publishedAt}] ${n.publisher}: ${n.headline}` +
        (n.relatedInstruments.length ? ` — mentions ${n.relatedInstruments.map((e) => e.symbol).join(', ')}` : ''))
      .join('\n'),
  );
}

async function gatherOptions(ctx: RetrievalContext, b: EvidenceBuilder): Promise<void> {
  const underlying = ctx.symbols[0] ?? 'NIFTY';
  // Map an index instrument name back to its F&O underlying code.
  const code = /BANK/i.test(underlying) ? 'BANKNIFTY'
    : /FIN/i.test(underlying) ? 'FINNIFTY'
    : /NIFTY/i.test(underlying) ? 'NIFTY'
    : underlying;

  const expiries = await getExpiries(ctx.registry, code);
  if (!isAvailable(expiries) || expiries.value.length === 0) {
    b.markMissing('options.chain', `${code} option chain`,
      isAvailable(expiries) ? 'no expiries listed' : (expiries.detail ?? expiries.reason));
    return;
  }

  const expiry = expiries.value[0]!;
  const analytics = await getOptionAnalytics(ctx.registry, code, expiry);
  if (!isAvailable(analytics)) {
    b.markMissing('options.chain', `${code} option chain`, analytics.detail ?? analytics.reason);
    return;
  }

  const a = analytics.value;
  const meta = { source: analytics.source, asOf: analytics.asOf, kind: 'calculated' as const };

  b.addText('options.underlying', 'Option chain underlying', a.underlying, meta);
  b.addText('options.expiry', 'Option chain expiry', a.expiry, meta);
  b.addNumber('options.spot', `${code} spot`, a.spot, { unit: 'INR', ...meta });
  b.addNumber('options.atmStrike', 'ATM strike', a.atmStrike, meta);
  b.addNumber('options.daysToExpiry', 'Days to expiry', a.daysToExpiry, { unit: 'days', ...meta });
  b.addNumber('options.pcr_oi', 'Put/Call ratio by OI', a.pcr.pcrOi, meta);
  b.addNumber('options.pcr_volume', 'Put/Call ratio by volume', a.pcr.pcrVolume, meta);
  b.addNumber('options.totalCallOi', 'Total call open interest', a.pcr.totalCallOi, meta);
  b.addNumber('options.totalPutOi', 'Total put open interest', a.pcr.totalPutOi, meta);
  b.addNumber('options.maxPain', 'Max pain strike', a.maxPain.maxPain, meta);
  b.addNumber('options.atmIv', 'ATM implied volatility', a.atmIv, { unit: '%', ...meta });
  b.addNumber('options.callOiChange', 'Net call OI change', a.oiShift.callOiChange, meta);
  b.addNumber('options.putOiChange', 'Net put OI change', a.oiShift.putOiChange, meta);

  b.addContext('options.pcrNote', 'PCR interpretation note', a.pcr.note);
  b.addContext('options.maxPainNote', 'Max pain note', a.maxPain.note);
  b.addContext(
    'options.levels', 'OI-derived levels',
    `Highest put OI strikes (commonly read as support): ${a.oiLevels.supports.map((l) => `${l.strike} (OI ${l.oi.toLocaleString('en-IN')})`).join(', ')}\n` +
    `Highest call OI strikes (commonly read as resistance): ${a.oiLevels.resistances.map((l) => `${l.strike} (OI ${l.oi.toLocaleString('en-IN')})`).join(', ')}\n` +
    a.oiLevels.note,
  );
  b.addContext('options.ivSkew', 'IV skew', a.ivSkew.note);
  b.addContext('options.ivPercentile', 'IV percentile', a.ivPercentile.note);
  b.addContext('options.interpretation', 'Option analytics caveat', a.interpretation);
}

async function gatherPortfolio(ctx: RetrievalContext, b: EvidenceBuilder): Promise<void> {
  const portfolio = await getDefaultPortfolio(ctx.userId);
  const analysis = await analyzePortfolio(ctx.registry, ctx.userId, portfolio.id);

  if (!isAvailable(analysis)) {
    b.markMissing('portfolio.currentValue', 'Portfolio', analysis.detail ?? analysis.reason);
    return;
  }

  const a = analysis.value;
  const meta = { source: analysis.source, asOf: analysis.asOf, kind: 'calculated' as const };

  b.addNumber('portfolio.invested', 'Total invested', a.valuation.totalInvested, { unit: 'INR', ...meta });
  b.addNumber('portfolio.currentValue', 'Current market value', a.valuation.currentValue, { unit: 'INR', ...meta });
  b.addNumber('portfolio.unrealizedPnl', 'Unrealized P&L', a.valuation.unrealizedPnl, { unit: 'INR', ...meta });
  b.addNumber('portfolio.realizedPnl', 'Realized P&L', a.valuation.realizedPnl, { unit: 'INR', ...meta });
  b.addNumber('portfolio.dayPnl', "Today's P&L", a.valuation.dayPnl, { unit: 'INR', ...meta });
  b.addNumber('portfolio.totalReturnPct', 'Overall return', a.valuation.totalReturnPct, { unit: '%', ...meta });
  b.addNumber('portfolio.holdingsCount', 'Number of holdings', a.valuation.holdings.length, meta);
  b.addNumber('portfolio.xirr', 'XIRR', a.xirr.xirrPct, { unit: '%', ...meta });
  b.addNumber('portfolio.hhi', 'Concentration (HHI)', a.concentration.hhi, meta);
  b.addNumber('portfolio.effectivePositions', 'Effective positions', a.concentration.effectivePositions, meta);
  b.addNumber('portfolio.topHoldingPct', 'Largest position weight', a.concentration.topHoldingPct, { unit: '%', ...meta });
  b.addNumber('portfolio.topSectorPct', 'Largest sector weight', a.concentration.topSectorPct, { unit: '%', ...meta });
  b.addText('portfolio.topSector', 'Largest sector', a.concentration.topSector, meta);
  b.addNumber('portfolio.volatility', 'Annualised volatility', a.risk.volatilityPct, { unit: '%', ...meta });
  b.addNumber('portfolio.maxDrawdown', 'Maximum drawdown', a.risk.maxDrawdownPct, { unit: '%', ...meta });
  b.addNumber('portfolio.beta', 'Beta to NIFTY 50', a.risk.beta, meta);
  b.addNumber('portfolio.sharpe', 'Sharpe ratio', a.risk.sharpe, meta);

  b.addContext(
    'portfolio.holdings', 'Holdings detail',
    a.valuation.holdings
      .map((h) =>
        `${h.symbol}: ${h.quantity} @ avg ${h.avgPrice.toFixed(2)}, ` +
        (h.currentValue !== null
          ? `LTP ${h.ltp?.toFixed(2)}, value ${h.currentValue.toFixed(2)}, P&L ${h.unrealizedPnl?.toFixed(2)} (${h.unrealizedPnlPct?.toFixed(2)}%), weight ${h.weightPct?.toFixed(2)}%`
          : 'price unavailable — excluded from totals') +
        (h.sector ? `, sector ${h.sector}` : ''))
      .join('\n'),
  );

  b.addContext(
    'portfolio.allocation', 'Sector allocation',
    a.allocation.bySector.map((s) => `${s.key}: ${s.weightPct.toFixed(2)}% across ${s.count} holding(s)`).join('\n'),
  );

  b.addContext(
    'portfolio.observations', 'Computed observations',
    a.observations.map((o) => `[${o.severity}] ${o.title}: ${o.detail}`).join('\n'),
  );

  b.addContext('portfolio.methods', 'Calculation methods',
    `${a.valuation.method}\n${a.xirr.method}\n${a.risk.method}\n${a.concentration.method}`);

  if (a.valuation.unvaluedSymbols.length > 0) {
    b.markMissing('portfolio.unvalued', 'Prices for some holdings',
      `no live price for ${a.valuation.unvaluedSymbols.join(', ')}; these are excluded from all totals`);
  }
}

async function gatherScan(ctx: RetrievalContext, b: EvidenceBuilder): Promise<void> {
  const scan = await runScan(ctx.registry, {
    timeframe: ctx.timeframe,
    universe: 'NIFTY50',
    minStrength: 55,
    limit: 8,
    maxSymbols: 60,
  });

  if (!isAvailable(scan)) {
    b.markMissing('scan.results', 'Scanner results', scan.detail ?? scan.reason);
    return;
  }

  const s = scan.value;
  b.addNumber('scan.analyzed', 'Instruments analysed', s.analyzed, {
    source: scan.source, asOf: scan.asOf, kind: 'rule_signal',
  });
  b.addNumber('scan.ideaCount', 'Setups found', s.ideas.length, {
    source: scan.source, asOf: scan.asOf, kind: 'rule_signal',
  });

  if (s.ideas.length === 0) {
    b.addContext('scan.results', 'Scanner results',
      `No setup met the confirmation threshold across the ${s.scanned} instruments scanned.`);
    return;
  }

  b.addContext(
    'scan.results', 'Scanner results',
    s.ideas
      .map((i) =>
        `${i.tradingsymbol} — ${i.setupLabel} (${i.direction}), confirmation ${i.confidence}/100. ` +
        `Entry ${i.entryLow.toFixed(2)}–${i.entryHigh.toFixed(2)}, invalidation ${i.invalidation.toFixed(2)}, ` +
        `target1 ${i.target1.toFixed(2)}${i.target2 ? `, target2 ${i.target2.toFixed(2)}` : ''}, R:R ${i.riskRewardDisplay}. ` +
        `Reasons: ${i.technicalReasons.slice(0, 3).join('; ')}. ` +
        `Risks: ${i.riskFactors.slice(0, 2).join(' ')}`)
      .join('\n\n'),
  );
  b.addContext('scan.method', 'Scan methodology', s.methodology);
}
