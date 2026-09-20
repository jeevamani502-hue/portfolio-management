/**
 * Provenance types — the single most load-bearing abstraction in this codebase.
 *
 * A market value is never a bare number. It is a `Sourced<T>` carrying where it
 * came from, when it was true, and whether it is safe to call "live". When a
 * value cannot be obtained, we return an `Unavailable` — never a substitute,
 * never a stale value silently relabelled as fresh.
 *
 * Rendering rules (frontend `<DataValue>`):
 *   live        → plain value, green dot
 *   delayed     → value + "Delayed" chip + age
 *   closed      → value + "At close" chip
 *   unavailable → the literal text "Live market data unavailable"
 */

export type DataStatus = 'live' | 'delayed' | 'closed' | 'unavailable';

/** Classification of what kind of thing a value is (Architecture doc, J.1). */
export type Provenance =
  | 'market_data' // straight from an exchange/broker feed
  | 'calculated' // deterministic computation over market data
  | 'rule_signal' // output of the rule engine
  | 'ai_interpretation' // narration by the LLM over an evidence bundle
  | 'user_input'; // supplied by the user (e.g. manual holding)

export interface Available<T> {
  status: Exclude<DataStatus, 'unavailable'>;
  value: T;
  /** Provider id, e.g. 'dhan', or 'computed' for derived values. */
  source: string;
  /** ISO timestamp for the instant this value was true at the source. */
  asOf: string;
  /** Age in milliseconds at serialization time. */
  staleMs: number;
  kind: Provenance;
}

export interface Unavailable {
  status: 'unavailable';
  value: null;
  /** Machine-readable cause, e.g. 'no_provider', 'insufficient_history'. */
  reason: string;
  /** Human-readable detail, safe to display. */
  detail?: string;
  /** Providers attempted, with why each failed. */
  attempted?: Array<{ provider: string; error: string }>;
  kind: Provenance;
}

export type Sourced<T> = Available<T> | Unavailable;

/** How long a value may be before it stops counting as "live", per data class. */
export const FRESHNESS_BUDGET_MS = {
  tick: 10_000, // a quote older than 10s during market hours is not live
  quote: 30_000,
  breadth: 120_000,
  optionChain: 300_000,
  fundamentals: 7 * 24 * 3600_000,
  news: 30 * 60_000,
} as const;

export type FreshnessClass = keyof typeof FRESHNESS_BUDGET_MS;

export interface SourcedOptions {
  source: string;
  asOf: Date | string | number;
  kind?: Provenance;
  /** Freshness budget class; decides live vs delayed. */
  freshness?: FreshnessClass;
  /** When the market is shut, values are labelled `closed`, not `delayed`. */
  marketOpen?: boolean;
  now?: Date;
}

function toIso(v: Date | string | number): string {
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'number') return new Date(v).toISOString();
  return new Date(v).toISOString();
}

/**
 * Wrap a real value with its provenance. The status is *derived* from age and
 * market state — a caller cannot simply assert that something is live.
 */
export function sourced<T>(value: T, opts: SourcedOptions): Available<T> {
  const now = opts.now ?? new Date();
  const asOfIso = toIso(opts.asOf);
  const staleMs = Math.max(0, now.getTime() - new Date(asOfIso).getTime());
  const budget = FRESHNESS_BUDGET_MS[opts.freshness ?? 'quote'];

  let status: Available<T>['status'];
  if (opts.marketOpen === false) {
    status = 'closed';
  } else if (staleMs <= budget) {
    status = 'live';
  } else {
    status = 'delayed';
  }

  return {
    status,
    value,
    source: opts.source,
    asOf: asOfIso,
    staleMs,
    kind: opts.kind ?? 'market_data',
  };
}

/** A value that was computed from other sourced values. */
export function computed<T>(
  value: T,
  opts: { asOf: Date | string | number; basedOn?: string[]; now?: Date },
): Available<T> {
  return sourced(value, {
    source: opts.basedOn?.length ? `computed(${opts.basedOn.join('+')})` : 'computed',
    asOf: opts.asOf,
    kind: 'calculated',
    // A calculation is exactly as fresh as its inputs; reuse the quote budget.
    freshness: 'quote',
    now: opts.now,
  });
}

export function unavailable(
  reason: string,
  detail?: string,
  attempted?: Array<{ provider: string; error: string }>,
  kind: Provenance = 'market_data',
): Unavailable {
  return { status: 'unavailable', value: null, reason, detail, attempted, kind };
}

export function isAvailable<T>(s: Sourced<T>): s is Available<T> {
  return s.status !== 'unavailable';
}

/** Extract the raw value, or undefined. Use sparingly — it discards provenance. */
export function valueOf<T>(s: Sourced<T> | undefined): T | undefined {
  return s && isAvailable(s) ? s.value : undefined;
}

/**
 * Map over a sourced value, preserving provenance. Returns the original
 * `Unavailable` untouched so the reason survives the transformation.
 */
export function mapSourced<T, U>(s: Sourced<T>, fn: (v: T) => U): Sourced<U> {
  if (!isAvailable(s)) return s;
  return { ...s, value: fn(s.value) };
}

/**
 * Combine several sourced values. The result takes the *worst* status of its
 * inputs and the *oldest* timestamp — an aggregate is only as trustworthy as
 * its weakest component.
 */
const STATUS_RANK: Record<DataStatus, number> = {
  live: 0,
  delayed: 1,
  closed: 2,
  unavailable: 3,
};

export function worstStatus(items: Array<{ status: DataStatus }>): DataStatus {
  return items.reduce<DataStatus>(
    (worst, i) => (STATUS_RANK[i.status] > STATUS_RANK[worst] ? i.status : worst),
    'live',
  );
}

export function oldestAsOf(items: Sourced<unknown>[]): string | undefined {
  const times = items
    .filter(isAvailable)
    .map((i) => new Date(i.asOf).getTime())
    .filter((t) => Number.isFinite(t));
  return times.length ? new Date(Math.min(...times)).toISOString() : undefined;
}

/** Distinct sources contributing to a response, for the `meta.sources` field. */
export function collectSources(items: Sourced<unknown>[]): string[] {
  return [...new Set(items.filter(isAvailable).map((i) => i.source))].sort();
}
