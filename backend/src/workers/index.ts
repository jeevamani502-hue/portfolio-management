/**
 * Background worker process.
 *
 * Runs the scheduled jobs described in the architecture doc (C.4). Kept in a
 * separate process from the API so a long scanner sweep cannot block request
 * handling, and so the realtime ingest worker can be leader-elected to exactly
 * one instance regardless of how many API pods are running.
 *
 *   npm run dev:worker    (development)
 *   npm run start:worker  (production)
 */
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';
import { pingDb, closeDb, query } from '../db/pool.js';
import { pingRedis, closeRedis, acquireLock, renewLock, releaseLock } from '../cache/redis.js';
import { K } from '../cache/keys.js';
import { getWorkerRegistry } from '../providers/registry.js';
import { getMarketStatus, toIst, formatIstDateTime } from '../utils/time.js';
import { randomUUID } from 'node:crypto';

import { syncInstruments } from './jobs/instrumentsSync.js';
import { sweepScanner } from './jobs/scannerSweep.js';
import { pollNews } from './jobs/newsPoller.js';
import { pollOptionChains } from './jobs/optionChainPoller.js';
import { evaluateAlerts } from './jobs/alertEvaluator.js';
import { snapshotPortfolios } from './jobs/portfolioValuation.js';
import { refreshBreadth } from './jobs/breadthRefresh.js';
import { sweepPaperTrading } from './jobs/paperSweep.js';

const log = logger.child({ process: 'worker' });

interface Job {
  name: string;
  /** Interval in milliseconds. */
  everyMs: number;
  /** Run only while the market session is active. */
  marketHoursOnly?: boolean;
  /** Run immediately on boot as well as on the interval. */
  runOnStart?: boolean;
  run: () => Promise<void>;
}

const JOBS: Job[] = [
  {
    name: 'instruments-sync',
    everyMs: 12 * 3600_000,
    runOnStart: true,
    run: async () => { await syncInstruments(await getWorkerRegistry()); },
  },
  {
    // Paper trading needs to react while the session is open; every few
    // minutes is enough for daily-timeframe setups and keeps provider calls
    // proportionate to the number of open positions.
    name: 'paper-sweep',
    everyMs: 180_000,
    marketHoursOnly: true,
    runOnStart: true,
    run: async () => { await sweepPaperTrading(); },
  },
  {
    name: 'breadth-refresh',
    everyMs: 60_000,
    marketHoursOnly: true,
    runOnStart: true,
    run: async () => { await refreshBreadth(await getWorkerRegistry()); },
  },
  {
    name: 'option-chain-poller',
    everyMs: 180_000,
    marketHoursOnly: true,
    run: async () => { await pollOptionChains(await getWorkerRegistry()); },
  },
  {
    name: 'scanner-sweep',
    everyMs: 300_000,
    marketHoursOnly: true,
    runOnStart: true,
    run: async () => { await sweepScanner(await getWorkerRegistry()); },
  },
  {
    name: 'alert-evaluator',
    everyMs: 30_000,
    marketHoursOnly: true,
    run: async () => { await evaluateAlerts(await getWorkerRegistry()); },
  },
  {
    name: 'news-poller',
    everyMs: 600_000,
    runOnStart: true,
    run: async () => { await pollNews(); },
  },
  {
    name: 'portfolio-valuation',
    everyMs: 3600_000,
    run: async () => { await snapshotPortfolios(await getWorkerRegistry()); },
  },
];

/** Prevents a slow run from overlapping with its own next tick. */
const running = new Set<string>();
/** Market-hours jobs that have had their single closed-market pass. */
const ranWhileClosed = new Set<string>();

async function runJob(job: Job): Promise<void> {
  if (running.has(job.name)) {
    log.warn({ job: job.name }, 'Previous run still in progress; skipping this tick');
    return;
  }

  if (job.marketHoursOnly) {
    const status = getMarketStatus();
    if (!status.isSessionActive) {
      // Skipping outright meant that over a weekend — or any evening — the
      // breadth, scanner and movers panels had nothing to show and the whole
      // app looked broken, even with a healthy provider. Prices do not move
      // while the market is shut, so one pass is enough: it fills the panels
      // from the last close and then stops until the session reopens.
      if (ranWhileClosed.has(job.name)) return;
      ranWhileClosed.add(job.name);
      log.info({ job: job.name }, 'Market closed — running once so panels reflect the last close');
    } else {
      ranWhileClosed.delete(job.name);
    }
  }

  running.add(job.name);
  const started = Date.now();
  try {
    await job.run();
    log.info({ job: job.name, ms: Date.now() - started }, 'Job completed');
  } catch (err) {
    log.error({ err, job: job.name, ms: Date.now() - started }, 'Job failed');
  } finally {
    running.delete(job.name);
  }
}

// ── realtime leader election ────────────────────────────────────────────────

/**
 * Only one process may hold the upstream broker websocket. A Redis lock with a
 * short TTL plus a heartbeat gives us that without a coordination service: if
 * this process dies, the lock expires and another instance takes over.
 */
const LEADER_TTL_MS = 15_000;
const leaderToken = randomUUID();
let isLeader = false;
let leaderTimer: NodeJS.Timeout | null = null;

async function maintainLeadership(): Promise<void> {
  if (isLeader) {
    const renewed = await renewLock(K.realtimeLeader, leaderToken, LEADER_TTL_MS);
    if (!renewed) {
      isLeader = false;
      log.warn('Lost realtime leadership');
    }
    return;
  }

  const acquired = await acquireLock(K.realtimeLeader, leaderToken, LEADER_TTL_MS);
  if (acquired) {
    isLeader = true;
    log.info('Acquired realtime leadership — this process would hold the upstream feed');
    // The tick-ingest stream itself is provider-specific and only starts when
    // a provider with `streamTicks` is configured. None of the shipped
    // adapters implement the binary socket yet (see README, Roadmap phase 3),
    // so we hold the lock and log rather than pretending to stream.
    const streamCapable = (await getWorkerRegistry())
      .all()
      .filter((p) => p.isConfigured() && p.manifest.capabilities.includes('streamTicks'));
    if (streamCapable.length === 0) {
      log.info(
        'No configured provider implements streamTicks. Quotes will be served on request via REST rather than streamed; the websocket gateway reports the feed as unavailable so the UI never shows a stale price as live.',
      );
    }
  }
}

// ── main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  log.info({ env: env.NODE_ENV, ist: formatIstDateTime() }, 'Worker starting');

  const [dbOk, redisOk] = await Promise.all([pingDb(), pingRedis()]);
  if (!dbOk || !redisOk) {
    log.fatal(
      { dbOk, redisOk },
      'Cannot reach PostgreSQL and/or Redis. Start them with `npm run infra:up`.',
    );
    process.exit(1);
  }

  const configured = (await getWorkerRegistry()).all().filter((p) => p.isConfigured());
  if (configured.length === 0) {
    log.warn(
      'No market-data provider is configured. Scheduled market jobs will run and report honestly that no data could be sourced.',
    );
  }

  const timers: NodeJS.Timeout[] = [];

  for (const job of JOBS) {
    if (job.runOnStart) void runJob(job);
    const timer = setInterval(() => void runJob(job), job.everyMs);
    timers.push(timer);
    log.info(
      { job: job.name, everyMs: job.everyMs, marketHoursOnly: job.marketHoursOnly ?? false },
      'Scheduled job registered',
    );
  }

  void maintainLeadership();
  leaderTimer = setInterval(() => void maintainLeadership(), LEADER_TTL_MS / 3);

  const shutdown = async (signal: string): Promise<void> => {
    log.info({ signal }, 'Worker shutting down');
    for (const t of timers) clearInterval(t);
    if (leaderTimer) clearInterval(leaderTimer);
    if (isLeader) await releaseLock(K.realtimeLeader, leaderToken).catch(() => undefined);
    await Promise.allSettled([closeDb(), closeRedis()]);
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  process.on('unhandledRejection', (reason) => {
    log.error({ reason }, 'Unhandled rejection in worker');
  });
}

void main();

/** Exposed for the EOD job: is today a trading day? */
export async function isTradingDay(): Promise<boolean> {
  const p = toIst();
  if (p.weekday === 0 || p.weekday === 6) return false;
  const rows = await query<{ c: number }>(
    `SELECT count(*)::int AS c FROM trading_holidays WHERE holiday_date = $1::date`,
    [p.dateKey],
  );
  return (rows.rows[0]?.c ?? 0) === 0;
}
