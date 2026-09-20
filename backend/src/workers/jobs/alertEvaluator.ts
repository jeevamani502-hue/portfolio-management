import { logger } from '../../utils/logger.js';
import { query, queryRows } from '../../db/pool.js';
import type { ProviderRegistry } from '../../providers/registry.js';
import { registryForUser } from '../../providers/registry.js';
import { isAvailable } from '../../utils/sourced.js';
import * as instrumentsRepo from '../../db/repositories/instruments.js';
import { getQuote, getCandles } from '../../modules/market/marketData.service.js';
import { buildSnapshot } from '../../analysis/snapshot.js';
import { runSignalEngine } from '../../analysis/signals/engine.js';
import { pushToUser } from '../../websocket/server.js';

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

  // Browser delivery is a websocket push to every session this user has open.
  const delivered = pushToUser(alert.user_id, {
    op: 'alert',
    alertId: alert.id,
    name: alert.name,
    symbol: alert.tradingsymbol ? `${alert.exchange}:${alert.tradingsymbol}` : null,
    kind: alert.kind,
    message,
    observed,
    dataAsOf,
    source,
    ts: Date.now(),
  });

  log.info({ alertId: alert.id, sessions: delivered, message }, 'Alert fired');
}
