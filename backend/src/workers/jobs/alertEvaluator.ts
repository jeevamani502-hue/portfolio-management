import { logger } from '../../utils/logger.js';
import { query, queryRows } from '../../db/pool.js';
import type { ProviderRegistry } from '../../providers/registry.js';
import { registryForUser } from '../../providers/registry.js';
import { isAvailable } from '../../utils/sourced.js';
import * as instrumentsRepo from '../../db/repositories/instruments.js';
import { getQuote, getCandles } from '../../modules/market/marketData.service.js';
import { buildSnapshot } from '../../analysis/snapshot.js';
import { runSignalEngine } from '../../analysis/signals/engine.js';
import { meetsGrade, type Grade } from '../../analysis/options/decisionEngine.js';
import { evaluateUnderlying } from '../../modules/fno/fno.service.js';
import { notify } from '../../modules/notifications/notifications.service.js';

const log = logger.child({ job: 'alert-evaluator' });

interface AlertRow {
  id: string;
  user_id: string;
  instrument_id: number | null;
  name: string | null;
  kind: string;
  params: Record<string, number | string>;
  timeframe: string;
  channels: string[];
  repeat_mode: string;
  cooldown_sec: number;
  last_fired_at: Date | null;
  tradingsymbol: string | null;
  exchange: string | null;
}

/** The observation that satisfied a rule, or why it could not be evaluated. */
type Evaluation =
  | { fired: true; observed: Record<string, unknown>; message: string }
  | { fired: false }
  | { skipped: true; reason: string };

export async function evaluateAlerts(_registry: ProviderRegistry): Promise<void> {
  const alerts = await queryRows<AlertRow>(
    `SELECT a.id, a.user_id, a.instrument_id, a.name, a.kind, a.params, a.timeframe,
            a.channels, a.repeat_mode, a.cooldown_sec, a.last_fired_at,
            i.tradingsymbol, i.exchange
       FROM alerts a LEFT JOIN instruments i ON i.id = a.instrument_id
      WHERE a.is_active = TRUE`,
  );

  if (alerts.length === 0) return;

  let fired = 0;
  let skipped = 0;

  for (const alert of alerts) {
    // Cooldown and repeat-mode gating, before doing any work.
    if (alert.last_fired_at) {
      const sinceMs = Date.now() - alert.last_fired_at.getTime();
      if (sinceMs < alert.cooldown_sec * 1000) continue;
      if (alert.repeat_mode === 'ONCE') continue;
      if (alert.repeat_mode === 'DAILY') {
        const sameDay =
          alert.last_fired_at.toISOString().slice(0, 10) === new Date().toISOString().slice(0, 10);
        if (sameDay) continue;
      }
    }

    try {
      const result = await evaluateOne(alert);

      if ('skipped' in result) {
        skipped += 1;
        // An alert that cannot be evaluated is recorded, not silently ignored:
        // a price alert that quietly stops working is worse than a loud one.
        log.debug({ alertId: alert.id, reason: result.reason }, 'Alert skipped');
        continue;
      }

      if (!result.fired) continue;

      await recordFiring(alert, result.observed, result.message);
      fired += 1;
    } catch (err) {
      log.warn({ err, alertId: alert.id }, 'Alert evaluation failed');
    }
  }

  if (fired > 0 || skipped > 0) {
    log.info({ evaluated: alerts.length, fired, skipped }, 'Alert sweep complete');
  }
}

async function evaluateOne(alert: AlertRow): Promise<Evaluation> {
  // Two kinds watch a whole universe rather than one instrument, so they are
  // handled before the "needs an instrument" guard below.
  if (alert.kind === 'SWING_SCAN') return evaluateSwingScan(alert);
  if (alert.kind === 'FNO_SETUP') return evaluateFnoSetup(alert);
  if (alert.kind === 'NEWS_FNO') return evaluateNewsFno(alert);

  if (alert.instrument_id === null) return { skipped: true, reason: 'no instrument attached' };

  const instrument = await instrumentsRepo.getById(alert.instrument_id);
  if (!instrument) return { skipped: true, reason: 'instrument not found' };

  // Each alert is evaluated with its owner's provider credentials.
  const registry = await registryForUser(alert.user_id);
  const threshold = Number(alert.params['threshold'] ?? 0);

  // Price-based kinds need only a quote.
  if (['PRICE_ABOVE', 'PRICE_BELOW', 'PCT_CHANGE'].includes(alert.kind)) {
    const quote = await getQuote(registry, instrument);
    if (!isAvailable(quote)) {
      return { skipped: true, reason: quote.detail ?? 'price unavailable' };
    }
    const q = quote.value;

    if (alert.kind === 'PRICE_ABOVE' && q.ltp > threshold) {
      return {
        fired: true,
        observed: { ltp: q.ltp, threshold, source: quote.source, asOf: quote.asOf },
        message: `${instrument.tradingsymbol} traded at ₹${q.ltp.toFixed(2)}, above ₹${threshold}.`,
      };
    }
    if (alert.kind === 'PRICE_BELOW' && q.ltp < threshold) {
      return {
        fired: true,
        observed: { ltp: q.ltp, threshold, source: quote.source, asOf: quote.asOf },
        message: `${instrument.tradingsymbol} traded at ₹${q.ltp.toFixed(2)}, below ₹${threshold}.`,
      };
    }
    if (alert.kind === 'PCT_CHANGE') {
      if (q.prevClose === null || q.prevClose <= 0) {
        return { skipped: true, reason: 'previous close unavailable' };
      }
      const changePct = ((q.ltp - q.prevClose) / q.prevClose) * 100;
      if (Math.abs(changePct) >= threshold) {
        return {
          fired: true,
          observed: { changePct, threshold, ltp: q.ltp, prevClose: q.prevClose, asOf: quote.asOf },
          message: `${instrument.tradingsymbol} moved ${changePct.toFixed(2)}% today, beyond the ${threshold}% threshold.`,
        };
      }
    }
    return { fired: false };
  }

  // Everything else needs an indicator snapshot.
  const candles = await getCandles(registry, instrument, alert.timeframe as never, { bars: 250 });
  if (candles.candles.length < 30) {
    return { skipped: true, reason: `only ${candles.candles.length} bars of history` };
  }

  const snapshot = buildSnapshot(instrument.tradingsymbol, alert.timeframe as never, candles.candles);
  const base = { source: candles.source, asOf: snapshot.asOf };

  switch (alert.kind) {
    case 'RSI_ABOVE': {
      const rsi = snapshot.momentum.rsi14;
      if (rsi === null) return { skipped: true, reason: 'RSI not computable' };
      return rsi > threshold
        ? { fired: true, observed: { rsi, threshold, ...base },
            message: `${instrument.tradingsymbol} RSI(14) is ${rsi.toFixed(1)}, above ${threshold}.` }
        : { fired: false };
    }

    case 'RSI_BELOW': {
      const rsi = snapshot.momentum.rsi14;
      if (rsi === null) return { skipped: true, reason: 'RSI not computable' };
      return rsi < threshold
        ? { fired: true, observed: { rsi, threshold, ...base },
            message: `${instrument.tradingsymbol} RSI(14) is ${rsi.toFixed(1)}, below ${threshold}.` }
        : { fired: false };
    }

    case 'VOLUME_MULTIPLE': {
      const rv = snapshot.volume.relativeVolume;
      if (rv === null) return { skipped: true, reason: 'relative volume not computable' };
      return rv >= threshold
        ? { fired: true, observed: { relativeVolume: rv, threshold, ...base },
            message: `${instrument.tradingsymbol} volume is ${rv.toFixed(2)}× its 20-period average.` }
        : { fired: false };
    }

    case 'BREAKOUT': {
      const lookback = Number(alert.params['lookback'] ?? 20);
      const window = candles.candles.slice(-lookback - 1, -1);
      if (window.length < 5) return { skipped: true, reason: 'not enough bars for the lookback' };
      const high = Math.max(...window.map((c) => c.high));
      return snapshot.price.close > high
        ? { fired: true, observed: { close: snapshot.price.close, priorHigh: high, lookback, ...base },
            message: `${instrument.tradingsymbol} closed at ₹${snapshot.price.close.toFixed(2)}, above its ${lookback}-bar high of ₹${high.toFixed(2)}.` }
        : { fired: false };
    }

    case 'SUPPORT_BROKEN': {
      const support = snapshot.structure.nearestSupport;
      if (!support) return { skipped: true, reason: 'no mapped support level' };
      return snapshot.price.close < support.price
        ? { fired: true, observed: { close: snapshot.price.close, support: support.price, touches: support.touches, ...base },
            message: `${instrument.tradingsymbol} closed below mapped support at ₹${support.price.toFixed(2)}.` }
        : { fired: false };
    }

    case 'SIGNAL': {
      const minStrength = Number(alert.params['minStrength'] ?? 60);
      const wanted = alert.params['setup'] as string | undefined;
      const report = runSignalEngine(snapshot);
      const match = report.setups.find(
        (s) => s.strength >= minStrength && (!wanted || s.kind === wanted),
      );
      return match
        ? { fired: true,
            observed: { setup: match.kind, direction: match.direction, strength: match.strength, ...base },
            message: `${instrument.tradingsymbol}: ${match.label} (${match.direction.toLowerCase()}) at ${match.strength}/100 confirmation.` }
        : { fired: false };
    }

    default:
      return { skipped: true, reason: `kind ${alert.kind} is not evaluated by this worker yet` };
  }
}


// ── universe-wide kinds ─────────────────────────────────────────────────────

/**
 * Fire when the scanner has persisted a setup the user has not been told
 * about yet.
 *
 * It reads `trade_ideas` rather than re-running the sweep: the scanner job
 * already did that work for every user, and repeating it per alert would
 * multiply provider calls by the number of subscribers for an identical
 * answer.
 */
async function evaluateSwingScan(alert: AlertRow): Promise<Evaluation> {
  const minStrength = Number(alert.params['minStrength'] ?? 60);
  const wantedDirection = alert.params['direction'] as string | undefined;

  // Only ideas generated since the last firing, so the same setup is not
  // reported every cycle for as long as it remains valid.
  const since = alert.last_fired_at ?? new Date(Date.now() - 24 * 3600_000);

  const rows = await queryRows<{
    tradingsymbol: string; exchange: string; direction: string;
    setup: string; confidence: number; entry_low: string | null;
    invalidation: string | null; target1: string | null; generated_at: Date;
  }>(
    `SELECT i.tradingsymbol, i.exchange, t.direction, t.setup, t.confidence,
            t.entry_low, t.invalidation, t.target1, t.generated_at
       FROM trade_ideas t
       JOIN instruments i ON i.id = t.instrument_id
      WHERE t.generated_at > $1
        AND t.confidence >= $2
        AND ($3::text IS NULL OR t.direction = $3)
      ORDER BY t.confidence DESC
      LIMIT 5`,
    [since, minStrength, wantedDirection ?? null],
  );

  if (rows.length === 0) return { fired: false };

  const top = rows[0]!;
  const others = rows.length > 1 ? ` (+${rows.length - 1} more)` : '';
  return {
    fired: true,
    observed: {
      matches: rows.length,
      symbols: rows.map((r) => r.tradingsymbol),
      top: {
        symbol: top.tradingsymbol, setup: top.setup,
        direction: top.direction, confidence: top.confidence,
        entry: top.entry_low, invalidation: top.invalidation, target: top.target1,
      },
      source: 'scanner-sweep',
      asOf: top.generated_at.toISOString(),
    },
    message:
      `${top.tradingsymbol}: ${top.setup} ${top.direction.toLowerCase()} at ` +
      `${top.confidence}/100 confirmation${others}. ` +
      `Entry ${top.entry_low ?? '—'}, invalidation ${top.invalidation ?? '—'}. ` +
      'Confirmation counts agreeing rules, not a chance of profit.',
  };
}

/**
 * Fire when the F&O decision engine grades an option trade as ENTER.
 *
 * Capital is read from the alert's own params because the engine refuses to
 * size a position without it — there is no sensible default for how much of
 * someone's money is at stake.
 *
 * The decision is journaled under this user, and the alert fires only when
 * that journal entry is new. Cooldown alone would re-announce the same
 * contract every few minutes for as long as the checklist kept agreeing;
 * the journal turns "still valid" into silence and "new setup" into a ping.
 */
async function evaluateFnoSetup(alert: AlertRow): Promise<Evaluation> {
  const underlying = String(alert.params['underlying'] ?? 'NIFTY').toUpperCase();
  const capital = Number(alert.params['capital'] ?? 0);
  const riskPercent = Number(alert.params['riskPercent'] ?? 1);
  const minConfirmation = Number(alert.params['minConfirmation'] ?? 50);
  const minGradeRaw = String(alert.params['minGrade'] ?? 'B').toUpperCase();
  const minGrade: Grade = minGradeRaw === 'A' || minGradeRaw === 'C' ? minGradeRaw : 'B';

  if (!(capital > 0)) {
    return { skipped: true, reason: 'no capital set on this alert, so no position can be sized' };
  }

  const registry = await registryForUser(alert.user_id);
  const evaluation = await evaluateUnderlying(registry, underlying, {
    capital,
    riskPercent,
    biasTimeframe: alert.timeframe === '1h' ? '1h' : '1d',
    record: { userId: alert.user_id, origin: 'alert' },
  });

  if (!isAvailable(evaluation.result)) {
    return { skipped: true, reason: evaluation.result.detail ?? evaluation.result.reason };
  }
  const d = evaluation.result.value;

  // A refusal, a wait, or a closed entry window is the engine working; none
  // of them is something to wake someone for.
  if (d.stance !== 'ENTER' || !d.plan) return { fired: false };
  if (!d.entryWindowOpen) return { fired: false };
  if (!meetsGrade(d.grade, minGrade)) return { fired: false };
  if (d.score < minConfirmation) return { fired: false };
  if (!evaluation.isNewSignal) return { fired: false };

  const plan = d.plan;
  const evaluable = d.factors.filter((f) => f.verdict !== 'na');
  const passing = evaluable.filter((f) => f.verdict === 'pass').length;
  const against = evaluable.filter((f) => f.verdict === 'fail').map((f) => f.label.toLowerCase());

  return {
    fired: true,
    observed: {
      action: d.action, grade: d.grade, score: d.score, coverage: d.coverage,
      strike: d.setup.strike, optionType: d.setup.optionType, expiry: d.expiry,
      entryPremium: plan.entryPremium, entryZone: plan.entryZone,
      stopPremium: plan.stopPremium, target1Premium: plan.target1Premium,
      target2Premium: plan.target2Premium, lots: plan.lots, premiumOutlay: plan.premiumOutlay,
      underlyingStop: plan.underlyingStop, underlyingTarget1: plan.underlyingTarget1,
      underlyingTarget2: plan.underlyingTarget2, timeStop: plan.timeStop,
      against, warnings: d.setup.warnings, signalId: evaluation.signalId,
      source: evaluation.result.source, asOf: evaluation.result.asOf,
    },
    message:
      `${underlying} ${d.setup.strike} ${d.setup.optionType} (${d.expiry}) — grade ${d.grade}, ` +
      `${d.action === 'BUY_CALL' ? 'buy call' : 'buy put'}: ${plan.lots} lot(s) between ` +
      `₹${plan.entryZone.low.toFixed(2)} and ₹${plan.entryZone.high.toFixed(2)}. ` +
      `Stop ₹${plan.stopPremium.toFixed(2)} or ${underlying} through ${plan.underlyingStop.toFixed(0)}; ` +
      `targets ₹${plan.target1Premium.toFixed(2)} then ₹${plan.target2Premium.toFixed(2)}. ` +
      `${passing} of ${evaluable.length} readable conditions agree — a count, not a chance of profit. ` +
      `₹${plan.premiumOutlay.toFixed(0)} of premium can be lost.` +
      (against.length > 0 ? ` Against it: ${against.slice(0, 3).join(', ')}.` : ''),
  };
}


/**
 * Fresh news on an F&O underlying, paired with what the rule engine makes of it.
 *
 * The division of labour matters and is the whole design of this alert:
 *
 *   · News decides WHEN to look. Something happened, so the picture may have
 *     changed and it is worth re-checking.
 *   · Price and the option chain decide WHICH WAY, if any. News does not.
 *
 * That split is not caution for its own sake. Headline sentiment is a poor
 * predictor of direction — markets routinely fall on good news that was
 * already priced in, and rally on bad news that came in less bad than feared.
 * The sentiment label attached to each article here comes from a keyword
 * classifier that is wrong often enough that trading on it directly would be
 * closer to a coin flip than to an edge.
 *
 * So when news breaks and the rules do not agree on a direction, this alert
 * says exactly that. Being told "something happened and there is still no
 * trade" is the more useful message most of the time: it is the moment people
 * are most tempted to act on a headline alone.
 */
async function evaluateNewsFno(alert: AlertRow): Promise<Evaluation> {
  const underlying = String(alert.params['underlying'] ?? 'NIFTY').toUpperCase();
  const capital = Number(alert.params['capital'] ?? 0);
  const riskPercent = Number(alert.params['riskPercent'] ?? 1);
  const minRelevance = Number(alert.params['minRelevance'] ?? 0.7);

  if (!(capital > 0)) {
    return { skipped: true, reason: 'no capital set, so no position could be sized' };
  }

  // Only news since the last firing, so one story is not reported repeatedly.
  const since = alert.last_fired_at ?? new Date(Date.now() - 6 * 3600_000);

  const articles = await queryRows<{
    id: string; headline: string; source: string | null;
    sentiment: string | null; sentiment_score: string | null;
    published_at: Date; relevance: string; url: string | null;
  }>(
    `SELECT DISTINCT ON (n.id)
            n.id, n.headline, n.source, n.sentiment, n.sentiment_score,
            n.published_at, e.relevance::text AS relevance, n.url
       FROM news_articles n
       JOIN news_entities e ON e.article_id = n.id
       JOIN instruments i ON i.id = e.instrument_id
      WHERE n.published_at > $1
        AND e.relevance >= $2
        AND (i.tradingsymbol = $3 OR i.underlying = $3)
      ORDER BY n.id, n.published_at DESC
      LIMIT 5`,
    [since, minRelevance, underlying],
  );

  if (articles.length === 0) return { fired: false };

  const top = articles[0]!;
  const others = articles.length > 1 ? ` (+${articles.length - 1} more)` : '';

  // Something happened. Now ask price and the chain whether it is tradeable.
  const setupEval = await evaluateFnoSetup({
    ...alert,
    params: { ...alert.params, minConfirmation: Number(alert.params['minConfirmation'] ?? 50) },
  });

  const newsLine =
    `${underlying}: "${top.headline.slice(0, 140)}"${others} — ${top.source ?? 'unknown source'}.`;

  const article = {
    id: top.id, headline: top.headline, url: top.url, publishedAt: top.published_at,
  };

  if ('fired' in setupEval && setupEval.fired) {
    return {
      fired: true,
      observed: { trigger: 'news', article, articles: articles.length, ...setupEval.observed },
      message:
        `${newsLine} The rules independently support a trade: ${setupEval.message} ` +
        'The direction comes from price and open interest, not from the headline.',
    };
  }

  const why =
    'skipped' in setupEval ? setupEval.reason : 'the rules do not agree on a direction';

  return {
    fired: true,
    observed: {
      trigger: 'news', article, articles: articles.length, setup: 'none', reason: why,
    },
    message:
      `${newsLine} No trade — ${why}. A headline on its own is not a direction.`,
  };
}

async function recordFiring(
  alert: AlertRow,
  observed: Record<string, unknown>,
  message: string,
): Promise<void> {
  const dataAsOf = (observed['asOf'] as string | undefined) ?? new Date().toISOString();
  const source = (observed['source'] as string | undefined) ?? 'computed';

  await query(
    `INSERT INTO alert_events (alert_id, observed, source, data_as_of, delivered)
     VALUES ($1, $2::jsonb, $3, $4, $5::jsonb)`,
    [alert.id, JSON.stringify(observed), source, dataAsOf, JSON.stringify({ browser: true })],
  );

  await query(
    `UPDATE alerts SET last_fired_at = now(), fire_count = fire_count + 1 WHERE id = $1`,
    [alert.id],
  );

  // Persisted first, then pushed to every open session. Pushing alone meant
  // an alert that fired with no browser open was never seen by anyone.
  const symbol = alert.tradingsymbol ? `${alert.exchange}:${alert.tradingsymbol}` : null;
  const isEntry = alert.kind === 'FNO_SETUP' || alert.kind === 'NEWS_FNO';
  const { sessions } = await notify(alert.user_id, {
    kind: isEntry && observed['action'] ? 'fno_entry' : 'alert',
    severity: isEntry ? 'action' : 'info',
    title: alert.name
      ?? (symbol ? `${symbol.split(':')[1] ?? symbol}: ${alert.kind.replace(/_/g, ' ').toLowerCase()}` : alert.kind.replace(/_/g, ' ').toLowerCase()),
    message,
    payload: { alertId: alert.id, kind: alert.kind, symbol, observed, dataAsOf, source },
    link: isEntry ? '/fno' : symbol ? `/stocks/${encodeURIComponent(symbol)}` : '/alerts',
  });

  log.info({ alertId: alert.id, sessions, message }, 'Alert fired');
}
