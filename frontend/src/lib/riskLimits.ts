/**
 * Risk ceilings per module, mirrored from backend/src/config/riskLimits.ts.
 * Paper and the F&O page are simulated sizing; live is real money and is
 * bounded lower on purpose.
 */
export const RISK_LIMITS = {
  paper: { riskPerTradePct: { min: 0.1, max: 100 }, dailyLossPct: { min: 0.1, max: 100 } },
  fno: { riskPercent: { min: 0.1, max: 100 } },
  live: { riskPerTradePct: { min: 0.1, max: 50 }, dailyLossPct: { min: 0.1, max: 50 } },
} as const;
