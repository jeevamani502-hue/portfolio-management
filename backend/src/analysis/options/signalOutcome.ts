/**
 * Resolving a graded signal against what the market did next.
 *
 * The decision engine says what to buy and where the plan is proven wrong.
 * This says what happened — the only measure of how good those calls were
 * that does not depend on anyone's opinion. Every signal the engine grades
 * is tracked from the moment it is issued until the plan resolves, and the
 * hit rate by grade is reported from these records rather than claimed.
 *
 * Rules, in priority order, mirroring the paper ledger's own pessimism:
 *
 *   1. premium at or below the stop          → STOPPED
 *   2. underlying through its invalidation   → INVALIDATED (a nominal stop
 *                                              on the premium does not save
 *                                              a thesis that has failed)
 *   3. premium at or above target 2          → TARGET2_HIT
 *   4. premium at or above target 1          → TARGET1_HIT
 *   5. past expiry                           → EXPIRED
 *   6. older than the plan's time stop       → TIMED_OUT
 *
 * A stop and a target inside the same observation resolve as the stop. One
 * quote cannot say which came first, and assuming the kind one is how a
 * track record flatters itself.
 *
 * Pure. The clock is an argument.
 */
import { expiryInstant } from './decisionEngine.js';

export type SignalStatus =
  | 'ACTIVE'
  | 'TARGET1_HIT'
  | 'TARGET2_HIT'
  | 'STOPPED'
  | 'INVALIDATED'
  | 'EXPIRED'
  | 'TIMED_OUT';

export interface TrackedSignal {
  action: 'BUY_CALL' | 'BUY_PUT';
  expiry: string;
  generatedAt: string;
  entryPremium: number;
  stopPremium: number;
  target1Premium: number;
  target2Premium: number | null;
  underlyingStop: number;
  /** Best and worst premium seen so far, carried between observations. */
  maxFavourablePremium: number | null;
  maxAdversePremium: number | null;
}

export interface Observation {
  premium: number;
  /** Spot of the underlying; null when it could not be priced. */
  spot: number | null;
  now: Date;
}

export interface OutcomeUpdate {
  status: SignalStatus;
  /** Result in multiples of the premium risked to the stop; null while active. */
  rMultiple: number | null;
  maxFavourablePremium: number;
  maxAdversePremium: number;
  /** How far from entry toward the stop the premium has travelled, 0–1+. */
  stopProximity: number;
  /** Plain statement of what was observed. */
  note: string;
}

/** Calendar days an ACTIVE signal may stay open before the plan's time stop. */
export const TIME_STOP_DAYS = 3;

const round = (v: number, dp = 3): number => Number(v.toFixed(dp));

export function resolveSignalOutcome(signal: TrackedSignal, obs: Observation): OutcomeUpdate {
  const { premium, spot, now } = obs;
  const riskPerUnit = signal.entryPremium - signal.stopPremium;
  const r = (exit: number): number | null =>
    riskPerUnit > 0 ? round((exit - signal.entryPremium) / riskPerUnit) : null;

  const maxFavourablePremium = Math.max(signal.maxFavourablePremium ?? premium, premium);
  const maxAdversePremium = Math.min(signal.maxAdversePremium ?? premium, premium);
  const stopProximity = riskPerUnit > 0
    ? round(Math.max(0, (signal.entryPremium - premium) / riskPerUnit))
    : 0;

  const base = { maxFavourablePremium, maxAdversePremium, stopProximity };
  const bull = signal.action === 'BUY_CALL';

  if (premium <= signal.stopPremium) {
    return {
      ...base, status: 'STOPPED', rMultiple: r(premium),
      note: `Premium ₹${premium.toFixed(2)} reached the ₹${signal.stopPremium.toFixed(2)} stop.`,
    };
  }

  if (spot !== null && (bull ? spot <= signal.underlyingStop : spot >= signal.underlyingStop)) {
    return {
      ...base, status: 'INVALIDATED', rMultiple: r(premium),
      note: `The underlying traded through ${signal.underlyingStop.toFixed(0)} (spot ${spot.toFixed(2)}); the thesis is invalid regardless of the premium.`,
    };
  }

  if (signal.target2Premium !== null && premium >= signal.target2Premium) {
    return {
      ...base, status: 'TARGET2_HIT', rMultiple: r(premium),
      note: `Premium ₹${premium.toFixed(2)} reached target 2 at ₹${signal.target2Premium.toFixed(2)}.`,
    };
  }

  if (premium >= signal.target1Premium) {
    return {
      ...base, status: 'TARGET1_HIT', rMultiple: r(premium),
      note: `Premium ₹${premium.toFixed(2)} reached target 1 at ₹${signal.target1Premium.toFixed(2)}.`,
    };
  }

  if (now.getTime() >= expiryInstant(signal.expiry).getTime()) {
    return {
      ...base, status: 'EXPIRED', rMultiple: r(premium),
      note: `The contract expired with the premium at ₹${premium.toFixed(2)} and neither level hit.`,
    };
  }

  const ageDays = (now.getTime() - new Date(signal.generatedAt).getTime()) / 864e5;
  if (ageDays >= TIME_STOP_DAYS) {
    return {
      ...base, status: 'TIMED_OUT', rMultiple: r(premium),
      note: `${TIME_STOP_DAYS} days without either level being hit; the plan's time stop closes it at ₹${premium.toFixed(2)}.`,
    };
  }

  return {
    ...base, status: 'ACTIVE', rMultiple: null,
    note: `Premium ₹${premium.toFixed(2)}, ${(stopProximity * 100).toFixed(0)}% of the way to the stop.`,
  };
}

/** Whether a resolved status counts as a win for the track record. */
export const isWin = (status: SignalStatus, rMultiple: number | null): boolean =>
  status === 'TARGET1_HIT' || status === 'TARGET2_HIT' || (rMultiple !== null && rMultiple > 0);

export const isResolved = (status: SignalStatus): boolean => status !== 'ACTIVE';

export interface GradeStats {
  grade: string;
  issued: number;
  resolved: number;
  active: number;
  wins: number;
  losses: number;
  /** Share of resolved signals that ended with a positive result, 0–100. */
  hitRatePct: number | null;
  avgR: number | null;
  /** Sum of positive R divided by the sum of negative R. */
  profitFactor: number | null;
  /** Average of the best excursion, in R, across resolved signals. */
  avgMaxFavourableR: number | null;
}

export interface SignalRecordLike {
  grade: string;
  status: SignalStatus;
  rMultiple: number | null;
  entryPremium: number;
  stopPremium: number;
  maxFavourablePremium: number | null;
}

/** Aggregate a set of signal records into per-grade statistics. */
export function summariseByGrade(records: readonly SignalRecordLike[]): GradeStats[] {
  const groups = new Map<string, SignalRecordLike[]>();
  for (const r of records) {
    const list = groups.get(r.grade) ?? [];
    list.push(r);
    groups.set(r.grade, list);
  }

  const stats = (grade: string, list: SignalRecordLike[]): GradeStats => {
    const resolved = list.filter((r) => isResolved(r.status));
    const wins = resolved.filter((r) => isWin(r.status, r.rMultiple));
    const rs = resolved.map((r) => r.rMultiple).filter((v): v is number => v !== null);
    const posR = rs.filter((v) => v > 0).reduce((s, v) => s + v, 0);
    const negR = Math.abs(rs.filter((v) => v < 0).reduce((s, v) => s + v, 0));
    const mfeR = resolved
      .map((r) => {
        const risk = r.entryPremium - r.stopPremium;
        return risk > 0 && r.maxFavourablePremium !== null
          ? (r.maxFavourablePremium - r.entryPremium) / risk
          : null;
      })
      .filter((v): v is number => v !== null);

    return {
      grade,
      issued: list.length,
      resolved: resolved.length,
      active: list.length - resolved.length,
      wins: wins.length,
      losses: resolved.length - wins.length,
      hitRatePct: resolved.length > 0 ? round((wins.length / resolved.length) * 100, 1) : null,
      avgR: rs.length > 0 ? round(rs.reduce((s, v) => s + v, 0) / rs.length) : null,
      profitFactor: negR > 0 ? round(posR / negR) : null,
      avgMaxFavourableR: mfeR.length > 0 ? round(mfeR.reduce((s, v) => s + v, 0) / mfeR.length) : null,
    };
  };

  const order = ['A', 'B', 'C'];
  const out = order
    .filter((g) => groups.has(g))
    .map((g) => stats(g, groups.get(g)!));
  out.push(stats('ALL', records.slice()));
  return out;
}
