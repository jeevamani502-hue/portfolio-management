/**
 * IST time helpers and the market-hours state machine.
 *
 * India observes no DST, so IST is a fixed UTC+05:30 offset. That lets us do
 * exact arithmetic rather than depending on the host's timezone database.
 *
 * The state machine is what stops the platform from ever labelling a value
 * "Live" outside trading hours.
 */

export const IST_OFFSET_MIN = 330; // UTC+05:30
const MS_PER_MIN = 60_000;

export interface IstParts {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number; // 0-23
  minute: number;
  second: number;
  weekday: number; // 0 = Sunday
  /** Minutes since IST midnight. */
  minutesOfDay: number;
  /** YYYY-MM-DD in IST. */
  dateKey: string;
}

export function toIst(date: Date = new Date()): IstParts {
  const shifted = new Date(date.getTime() + IST_OFFSET_MIN * MS_PER_MIN);
  const year = shifted.getUTCFullYear();
  const month = shifted.getUTCMonth() + 1;
  const day = shifted.getUTCDate();
  const hour = shifted.getUTCHours();
  const minute = shifted.getUTCMinutes();
  const second = shifted.getUTCSeconds();
  return {
    year,
    month,
    day,
    hour,
    minute,
    second,
    weekday: shifted.getUTCDay(),
    minutesOfDay: hour * 60 + minute,
    dateKey: `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
  };
}

/** Build a UTC Date from an IST wall-clock date and time. */
export function fromIst(dateKey: string, hour: number, minute = 0, second = 0): Date {
  const [y, m, d] = dateKey.split('-').map(Number);
  const utcMs = Date.UTC(y!, (m ?? 1) - 1, d ?? 1, hour, minute, second);
  return new Date(utcMs - IST_OFFSET_MIN * MS_PER_MIN);
}

/** Format an instant as an IST clock string, e.g. "09:42:13 IST". */
export function formatIstTime(date: Date = new Date()): string {
  const p = toIst(date);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)} IST`;
}

export function formatIstDateTime(date: Date = new Date()): string {
  const p = toIst(date);
  return `${p.dateKey} ${formatIstTime(date)}`;
}

// ── market sessions ─────────────────────────────────────────────────────────

export type MarketPhase =
  | 'PRE_OPEN' // 09:00–09:15 order collection + matching
  | 'OPEN' // 09:15–15:30 continuous trading
  | 'CLOSING' // 15:30–15:40 closing session
  | 'POST' // 15:40–16:00 post-close
  | 'CLOSED' // outside all of the above on a trading day
  | 'WEEKEND'
  | 'HOLIDAY';

export interface MarketSegmentHours {
  preOpenStart: number; // minutes of day, IST
  open: number;
  close: number;
  postEnd: number;
}

/** NSE/BSE equity + equity-derivatives hours. */
export const EQUITY_HOURS: MarketSegmentHours = {
  preOpenStart: 9 * 60, // 09:00
  open: 9 * 60 + 15, // 09:15
  close: 15 * 60 + 30, // 15:30
  postEnd: 16 * 60, // 16:00
};

export interface MarketStatus {
  phase: MarketPhase;
  /** True only during continuous trading. Drives the "Live" label. */
  isOpen: boolean;
  /** True during pre-open/closing/post — data moves but is not continuous. */
  isSessionActive: boolean;
  nowIst: string;
  dateKey: string;
  nextTransition: { phase: MarketPhase; at: string } | null;
}

export interface MarketStatusOptions {
  /** IST date keys (YYYY-MM-DD) on which the exchange is shut. */
  holidays?: ReadonlySet<string>;
  hours?: MarketSegmentHours;
  now?: Date;
}

export function getMarketStatus(opts: MarketStatusOptions = {}): MarketStatus {
  const now = opts.now ?? new Date();
  const hours = opts.hours ?? EQUITY_HOURS;
  const p = toIst(now);

  const base = {
    nowIst: formatIstDateTime(now),
    dateKey: p.dateKey,
  };

  if (p.weekday === 0 || p.weekday === 6) {
    return {
      ...base,
      phase: 'WEEKEND',
      isOpen: false,
      isSessionActive: false,
      nextTransition: null,
    };
  }
  if (opts.holidays?.has(p.dateKey)) {
    return {
      ...base,
      phase: 'HOLIDAY',
      isOpen: false,
      isSessionActive: false,
      nextTransition: null,
    };
  }

  const m = p.minutesOfDay;
  let phase: MarketPhase;
  let next: { phase: MarketPhase; minute: number } | null;

  if (m < hours.preOpenStart) {
    phase = 'CLOSED';
    next = { phase: 'PRE_OPEN', minute: hours.preOpenStart };
  } else if (m < hours.open) {
    phase = 'PRE_OPEN';
    next = { phase: 'OPEN', minute: hours.open };
  } else if (m < hours.close) {
    phase = 'OPEN';
    next = { phase: 'CLOSING', minute: hours.close };
  } else if (m < hours.close + 10) {
    phase = 'CLOSING';
    next = { phase: 'POST', minute: hours.close + 10 };
  } else if (m < hours.postEnd) {
    phase = 'POST';
    next = { phase: 'CLOSED', minute: hours.postEnd };
  } else {
    phase = 'CLOSED';
    next = null;
  }

  return {
    ...base,
    phase,
    isOpen: phase === 'OPEN',
    isSessionActive: phase === 'OPEN' || phase === 'PRE_OPEN' || phase === 'CLOSING',
    nextTransition: next
      ? {
          phase: next.phase,
          at: fromIst(p.dateKey, Math.floor(next.minute / 60), next.minute % 60).toISOString(),
        }
      : null,
  };
}

// ── candle bucketing ────────────────────────────────────────────────────────

export type Timeframe = '1m' | '5m' | '15m' | '30m' | '1h' | '4h' | '1d' | '1w' | '1M';

export const TIMEFRAME_MINUTES: Record<Timeframe, number> = {
  '1m': 1,
  '5m': 5,
  '15m': 15,
  '30m': 30,
  '1h': 60,
  '4h': 240,
  '1d': 375, // one NSE equity session (09:15–15:30)
  '1w': 375 * 5,
  '1M': 375 * 21,
};

export const isIntraday = (tf: Timeframe): boolean =>
  tf === '1m' || tf === '5m' || tf === '15m' || tf === '30m' || tf === '1h' || tf === '4h';

/**
 * Floor an instant to the start of its candle bucket.
 * Intraday buckets are anchored to the 09:15 open so that, for example, the
 * first 15m candle covers 09:15–09:30 rather than 09:00–09:15.
 */
export function bucketStart(ts: Date, tf: Timeframe, hours = EQUITY_HOURS): Date {
  const p = toIst(ts);
  if (!isIntraday(tf)) {
    // Daily and above are keyed to the IST session date.
    return fromIst(p.dateKey, Math.floor(hours.open / 60), hours.open % 60);
  }
  const size = TIMEFRAME_MINUTES[tf];
  const sinceOpen = p.minutesOfDay - hours.open;
  const bucketIndex = Math.floor(sinceOpen / size);
  const bucketMinute = hours.open + bucketIndex * size;
  return fromIst(p.dateKey, Math.floor(bucketMinute / 60), bucketMinute % 60);
}

/** Milliseconds a value of this timeframe stays current. */
export function timeframeStalenessMs(tf: Timeframe): number {
  return TIMEFRAME_MINUTES[tf] * MS_PER_MIN;
}
