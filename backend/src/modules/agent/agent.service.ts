/**
 * The agent's own account of itself.
 *
 * Everything the engine does is already recorded somewhere — the journal,
 * the paper ledger, the live ledger, the notification feed. This module
 * assembles those into the two things a person wants from an agent they
 * have delegated to: a plan in the morning, a report at the close, and one
 * page that shows what it is doing right now and why.
 *
 * Nothing here decides anything. It reads and narrates.
 */
import { queryRows, queryOne } from '../../db/pool.js';
import { logger } from '../../utils/logger.js';
import { registryForUser } from '../../providers/registry.js';
import { marketStatus } from '../market/marketData.service.js';
import { getRegime } from '../market/market.service.js';
import { isAvailable } from '../../utils/sourced.js';
import { toIst } from '../../utils/time.js';
import { getConfig as getPaperConfig, getPerformance as paperPerformance } from '../paper/paper.service.js';
import { getPaperStatus, type PaperStatus } from '../paper/status.service.js';
import { getLiveStatus, livePerformance, type LiveStatus } from '../live/live.service.js';
import { evaluateUnderlying, listSignals, signalPerformance, type SignalView } from '../fno/fno.service.js';
import { listNotifications, notify, type NotificationView } from '../notifications/notifications.service.js';

const log = logger.child({ module: 'agent' });

// ── summary ─────────────────────────────────────────────────────────────────

export interface OpenPosition {
  kind: 'paper' | 'live';
  id: string;
  tradingsymbol: string;
  exchange: string;
  underlying: string | null;
  quantity: number;
  entryPremium: number;
  stopPremium: number | null;
  targetPremium: number | null;
  lastPremium: number | null;
  enteredAt: string;
  grade: string | null;
  status: string;
}

export interface AgentSummary {
  now: string;
  market: { phase: string; isOpen: boolean };
  regime: { label: string; composite: number | null; summary: string } | null;
  paper: PaperStatus;
  live: LiveStatus;
  positions: OpenPosition[];
  /** Calls issued today, newest first. */
  callsToday: SignalView[];
  /** What the agent did and said today, newest first. */
  activity: NotificationView[];
  performance: {
    signals: Awaited<ReturnType<typeof signalPerformance>>;
    paper: Awaited<ReturnType<typeof paperPerformance>>;
    live: Awaited<ReturnType<typeof livePerformance>>;
  };
  /** The latest morning plan and close report, if issued today. */
  briefs: { morning: NotificationView | null; close: NotificationView | null };
  /** One line on what happens next. */
  next: string;
}

export async function agentSummary(userId: string): Promise<AgentSummary> {
  const registry = await registryForUser(userId);
  const todayKey = toIst().dateKey;

  const [market, regime, paper, live, signals, feed, sigPerf, papPerf, livPerf] = await Promise.all([
    marketStatus(),
    getRegime(registry).catch(() => null),
    getPaperStatus(userId),
    getLiveStatus(userId),
    listSignals(userId, { limit: 60 }),
    listNotifications(userId, { limit: 200 }),
    signalPerformance(userId),
    paperPerformance(userId),
    livePerformance(userId),
  ]);

  const paperOpen = await queryRows<{
    id: string; tradingsymbol: string; exchange: string; underlying: string | null; quantity: number;
    entry_price: string; stop_price: string | null; target_price: string | null; entry_at: Date; confirmation: number | null;
  }>(`SELECT id, tradingsymbol, exchange, underlying, quantity, entry_price, stop_price, target_price, entry_at, confirmation
        FROM paper_trades WHERE user_id = $1 AND status = 'OPEN' ORDER BY entry_at DESC`, [userId]);
  const liveOpen = await queryRows<{
    id: string; tradingsymbol: string; exchange: string; underlying: string; remaining_qty: number; quantity: number;
    entry_price: string | null; entry_limit: string | null; stop_premium: string; target1_premium: string; last_premium: string | null;
    created_at: Date; grade: string; status: string;
  }>(`SELECT id, tradingsymbol, exchange, underlying, remaining_qty, quantity, entry_price, entry_limit, stop_premium,
             target1_premium, last_premium, created_at, grade, status
        FROM live_trades WHERE user_id = $1 AND status IN ('PENDING','OPEN','EXITING') ORDER BY created_at DESC`, [userId]);

  const positions: OpenPosition[] = [
    ...liveOpen.map<OpenPosition>((l) => ({
      kind: 'live', id: l.id, tradingsymbol: l.tradingsymbol, exchange: l.exchange, underlying: l.underlying,
      quantity: l.remaining_qty || l.quantity, entryPremium: Number(l.entry_price ?? l.entry_limit ?? 0),
      stopPremium: Number(l.stop_premium), targetPremium: Number(l.target1_premium),
      lastPremium: l.last_premium === null ? null : Number(l.last_premium),
      enteredAt: l.created_at.toISOString(), grade: l.grade, status: l.status,
    })),
    ...paperOpen.map<OpenPosition>((p) => ({
      kind: 'paper', id: p.id, tradingsymbol: p.tradingsymbol, exchange: p.exchange, underlying: p.underlying,
      quantity: p.quantity, entryPremium: Number(p.entry_price),
      stopPremium: p.stop_price === null ? null : Number(p.stop_price),
      targetPremium: p.target_price === null ? null : Number(p.target_price),
      lastPremium: null, enteredAt: p.entry_at.toISOString(),
      grade: p.confirmation === null ? null : String(p.confirmation), status: 'OPEN',
    })),
  ];

  const isToday = (iso: string) => toIst(new Date(iso)).dateKey === todayKey;
  const callsToday = signals.filter((s) => isToday(s.generatedAt));
  const activity = feed.items.filter((n) => isToday(n.createdAt));
  const morning = activity.find((n) => n.kind === 'system' && n.title.startsWith('Morning plan')) ?? null;
  const close = activity.find((n) => n.kind === 'system' && n.title.startsWith('Close report')) ?? null;

  let next: string;
  if (!market.isOpen) {
    next = market.phase === 'PRE_OPEN'
      ? 'Session opens at 09:15. The paper engine starts evaluating at 09:30; the morning plan is issued around 09:20.'
      : 'Market closed. The close report is issued around 15:35; the next evaluation is at 09:30 on the next trading day.';
  } else {
    const parts: string[] = [];
    if (paper.state === 'WATCHING') parts.push(`paper engine checks ${paper.watching.join(', ')} in ${paper.nextSweepInSeconds ?? '—'}s`);
    else parts.push(`paper engine: ${paper.headline}`);
    if (live.armed && live.blockers.length === 0) parts.push(`live is armed in ${live.config?.mode} mode`);
    else if (live.config && live.config.mode !== 'OFF') parts.push(`live: ${live.blockers[0]?.detail ?? 'not armed'}`);
    parts.push(`${positions.length} open position(s) managed every 15 s–3 min; news re-check every 2 min`);
    next = parts.join(' · ');
  }

  return {
    now: new Date().toISOString(),
    market: { phase: market.phase, isOpen: market.isOpen },
    regime: regime && isAvailable(regime)
      ? { label: regime.value.regime, composite: regime.value.compositeScore, summary: regime.value.summary }
      : null,
    paper, live, positions, callsToday, activity,
    performance: { signals: sigPerf, paper: papPerf, live: livPerf },
    briefs: { morning, close },
    next,
  };
}

// ── briefings ───────────────────────────────────────────────────────────────

async function alreadyBriefed(userId: string, prefix: string): Promise<boolean> {
  const row = await queryOne<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM user_notifications
      WHERE user_id = $1 AND kind = 'system' AND title LIKE $2 AND created_at > (now() AT TIME ZONE 'Asia/Kolkata')::date AT TIME ZONE 'Asia/Kolkata'`,
    [userId, `${prefix}%`],
  );
  return Number(row?.n ?? 0) > 0;
}

/**
 * The morning plan: regime, and for each underlying the agent watches, what
 * the checklist reads before the entry window opens. Issued once per day.
 */
export async function morningPlan(userId: string): Promise<boolean> {
  if (await alreadyBriefed(userId, 'Morning plan')) return false;
  const registry = await registryForUser(userId);
  const cfg = await getPaperConfig(userId);
  const underlyings = cfg?.underlyings?.length ? cfg.underlyings : ['NIFTY'];
  const capital = cfg ? Number(cfg.capital) : 100_000;
  const riskPct = cfg ? Number(cfg.risk_per_trade_pct) : 1;

  const regime = await getRegime(registry).catch(() => null);
  const lines: string[] = [];
  if (regime && isAvailable(regime)) {
    lines.push(`Regime: ${regime.value.regime.replace(/_/g, ' ').toLowerCase()} (composite ${regime.value.compositeScore?.toFixed(0) ?? '—'}).`);
  }
  for (const u of underlyings) {
    try {
      const ev = await evaluateUnderlying(registry, u, { capital, riskPercent: riskPct, record: null });
      if (!isAvailable(ev.result)) { lines.push(`${u}: no read — ${ev.result.detail ?? ev.result.reason}.`); continue; }
      const d = ev.result.value;
      const plan = d.plan;
      lines.push(
        `${u}: ${d.bias.toLowerCase()} read, grade ${d.grade} (${d.score}/100 of ${d.coverage}% readable) → ${d.stance}.` +
        (plan ? ` If it holds after 09:30: ${d.setup.strike} ${d.setup.optionType} near ₹${plan.entryPremium.toFixed(2)}, stop ${u} ${plan.underlyingStop.toFixed(0)}, targets ₹${plan.target1Premium.toFixed(2)} / ₹${plan.target2Premium.toFixed(2)}, ${plan.lots} lot(s).` : '') +
        (d.holdBecause[0] ? ` ${d.holdBecause[0]}` : ''),
      );
    } catch (err) {
      lines.push(`${u}: read failed (${err instanceof Error ? err.message.slice(0, 80) : 'error'}).`);
    }
  }
  const paper = await getPaperStatus(userId);
  const live = await getLiveStatus(userId);
  lines.push(`Paper engine: ${paper.headline}`);
  lines.push(`Live: ${live.headline}`);
  lines.push('Reads before the open are built from the previous close; the engine re-checks every 3 minutes from 09:30. Grades count agreeing conditions, not odds.');

  await notify(userId, {
    kind: 'system', severity: 'info',
    title: `Morning plan — ${toIst().dateKey}`,
    message: lines.join('\n'),
    payload: { underlyings }, link: '/agent',
  });
  log.info({ userId }, 'Morning plan issued');
  return true;
}

/** The close report: what was called, what was done, what it made. Once per day. */
export async function closeReport(userId: string): Promise<boolean> {
  if (await alreadyBriefed(userId, 'Close report')) return false;
  const todayKey = toIst().dateKey;
  const isToday = (iso: string) => toIst(new Date(iso)).dateKey === todayKey;

  const signals = (await listSignals(userId, { limit: 100 })).filter((s) => isToday(s.generatedAt));
  const paperClosed = await queryRows<{ tradingsymbol: string; exit_reason: string | null; net_pnl: string | null }>(
    `SELECT tradingsymbol, exit_reason, net_pnl FROM paper_trades
      WHERE user_id = $1 AND status = 'CLOSED' AND (exit_at AT TIME ZONE 'Asia/Kolkata')::date = (now() AT TIME ZONE 'Asia/Kolkata')::date`,
    [userId],
  );
  const paperOpen = await queryOne<{ n: string }>(`SELECT COUNT(*)::text AS n FROM paper_trades WHERE user_id = $1 AND status = 'OPEN'`, [userId]);
  const liveToday = await queryOne<{ n: string; net: string }>(
    `SELECT COUNT(*)::text AS n, COALESCE(SUM(net_pnl), 0)::text AS net FROM live_trades
      WHERE user_id = $1 AND status = 'CLOSED' AND (closed_at AT TIME ZONE 'Asia/Kolkata')::date = (now() AT TIME ZONE 'Asia/Kolkata')::date`,
    [userId],
  );

  const lines: string[] = [];
  lines.push(`Calls issued: ${signals.length}` + (signals.length
    ? ` — ${signals.map((s) => `${s.underlying} ${s.strike} ${s.optionType} (${s.grade}, ${s.status.toLowerCase().replace(/_/g, ' ')}${s.rMultiple !== null ? `, ${s.rMultiple >= 0 ? '+' : ''}${s.rMultiple.toFixed(2)}R` : ''})`).join('; ')}.`
    : '.'));
  const paperNet = paperClosed.reduce((s, t) => s + Number(t.net_pnl ?? 0), 0);
  lines.push(`Paper: ${paperClosed.length} closed today, net ₹${paperNet.toFixed(0)}` +
    (paperClosed.length ? ` (${paperClosed.map((t) => `${t.tradingsymbol} ${t.exit_reason?.toLowerCase() ?? ''} ₹${Number(t.net_pnl ?? 0).toFixed(0)}`).join('; ')})` : '') +
    `; ${paperOpen?.n ?? 0} still open.`);
  lines.push(`Live: ${liveToday?.n ?? 0} closed today, net ₹${Number(liveToday?.net ?? 0).toFixed(0)}.`);
  const perf = await signalPerformance(userId);
  const all = perf.byGrade.find((g) => g.grade === 'ALL');
  lines.push(`Track record (90 days): ${perf.issued} calls, ${perf.resolved} resolved` +
    (all && all.hitRatePct !== null ? `, hit rate ${all.hitRatePct.toFixed(0)}%, avg ${all.avgR !== null ? `${all.avgR >= 0 ? '+' : ''}${all.avgR.toFixed(2)}R` : '—'}.` : '.'));
  lines.push(perf.caveat);

  await notify(userId, {
    kind: 'system', severity: 'info',
    title: `Close report — ${todayKey}`,
    message: lines.join('\n'),
    link: '/agent',
  });
  log.info({ userId }, 'Close report issued');
  return true;
}

/** Users the agent works for: anyone with a paper or live configuration. */
export async function agentUsers(): Promise<string[]> {
  const rows = await queryRows<{ user_id: string }>(
    `SELECT user_id FROM paper_trade_config UNION SELECT user_id FROM live_trade_config`,
  );
  return rows.map((r) => r.user_id);
}
