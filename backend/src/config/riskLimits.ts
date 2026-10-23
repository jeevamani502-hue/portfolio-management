/**
 * Risk ceilings, one set per module. They are deliberately different:
 *
 *   paper  simulated money, so the user may push sizing anywhere up to the
 *          whole notional account to see what happens;
 *   fno    the analysis page and alerts size a hypothetical position, same
 *          freedom as paper;
 *   live   real money. Still the user's choice, but bounded, because one
 *          ordinary adverse move against a position sized at half the
 *          account ends the account.
 *
 * The database constraints in migration 014 mirror these numbers; change
 * both together. The frontend copy lives in frontend/src/lib/riskLimits.ts.
 */
export const RISK_LIMITS = {
  paper: {
    riskPerTradePct: { min: 0.1, max: 100 },
    dailyLossPct: { min: 0.1, max: 100 },
  },
  fno: {
    riskPercent: { min: 0.1, max: 100 },
  },
  live: {
    riskPerTradePct: { min: 0.1, max: 50 },
    dailyLossPct: { min: 0.1, max: 50 },
  },
} as const;
