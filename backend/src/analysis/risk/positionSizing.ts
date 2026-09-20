/**
 * Position sizing and trade risk.
 *
 * Every number here is arithmetic the user can redo on paper — that is the
 * point. `explain` returns the actual formula with the actual inputs
 * substituted, so the UI can show the working rather than a black-box figure.
 */

export interface RiskConfig {
  /** Total trading capital, INR. */
  capital: number;
  /** Maximum percentage of capital risked on a single trade. */
  maxRiskPerTradePct: number;
  /** Maximum percentage of capital lost in a day before the user should stop. */
  maxDailyLossPct: number;
  maxOpenPositions: number;
}

export interface PositionSizeInput {
  entry: number;
  /** Invalidation level — where the trade idea is proven wrong. */
  stop: number;
  config: RiskConfig;
  /** Contract multiplier: 1 for cash equity, the lot size for F&O. */
  lotSize?: number;
  /** Cap position value at this fraction of capital (concentration guard). */
  maxPositionPctOfCapital?: number;
  /** Round down to whole lots. Always true for F&O. */
  wholeLotsOnly?: boolean;
}

export interface PositionSizeResult {
  direction: 'LONG' | 'SHORT';
  entry: number;
  stop: number;
  /** Absolute risk per single share/unit. */
  riskPerUnit: number;
  /** Rupees the user is willing to lose on this trade. */
  maxCapitalAtRisk: number;
  /** Units the risk budget allows, before any caps. */
  rawQuantity: number;
  /** Final quantity after lot rounding and the concentration cap. */
  quantity: number;
  lots: number | null;
  positionValue: number;
  /** Rupees actually at risk at the final quantity. */
  actualCapitalAtRisk: number;
  actualRiskPct: number;
  /** Which constraint decided the size. */
  limitedBy: 'risk_budget' | 'position_cap' | 'lot_rounding' | 'insufficient_capital';
  warnings: string[];
  /** The arithmetic, spelled out. */
  explain: string[];
}

export class InvalidRiskInput extends Error {}

export function calculatePositionSize(input: PositionSizeInput): PositionSizeResult {
  const {
    entry,
    stop,
    config,
    lotSize = 1,
    maxPositionPctOfCapital = 25,
    wholeLotsOnly = lotSize > 1,
  } = input;

  if (!Number.isFinite(entry) || entry <= 0) {
    throw new InvalidRiskInput('Entry price must be a positive number');
  }
  if (!Number.isFinite(stop) || stop <= 0) {
    throw new InvalidRiskInput('Stop price must be a positive number');
  }
  if (entry === stop) {
    throw new InvalidRiskInput('Stop cannot equal entry — risk per unit would be zero');
  }
  if (config.capital <= 0) {
    throw new InvalidRiskInput('Capital must be greater than zero');
  }

  const direction: 'LONG' | 'SHORT' = stop < entry ? 'LONG' : 'SHORT';
  const riskPerUnit = Math.abs(entry - stop);
  const maxCapitalAtRisk = (config.capital * config.maxRiskPerTradePct) / 100;

  const warnings: string[] = [];
  const explain: string[] = [];

  explain.push(
    `Risk budget = capital × max risk per trade = ₹${fmtInr(config.capital)} × ${config.maxRiskPerTradePct}% = ₹${fmtInr(maxCapitalAtRisk)}`,
  );
  explain.push(
    `Risk per unit = |entry − stop| = |${entry} − ${stop}| = ₹${riskPerUnit.toFixed(2)}`,
  );

  const rawQuantity = maxCapitalAtRisk / riskPerUnit;
  explain.push(
    `Raw quantity = risk budget ÷ risk per unit = ₹${fmtInr(maxCapitalAtRisk)} ÷ ₹${riskPerUnit.toFixed(2)} = ${rawQuantity.toFixed(2)} units`,
  );

  let quantity = rawQuantity;
  let limitedBy: PositionSizeResult['limitedBy'] = 'risk_budget';

  // Concentration cap: a wide stop can make the risk-derived size affordable
  // in risk terms but far too large as a share of the book.
  const maxPositionValue = (config.capital * maxPositionPctOfCapital) / 100;
  const valueAtRawQty = rawQuantity * entry;
  if (valueAtRawQty > maxPositionValue) {
    quantity = maxPositionValue / entry;
    limitedBy = 'position_cap';
    explain.push(
      `Position cap = ${maxPositionPctOfCapital}% of capital = ₹${fmtInr(maxPositionValue)}; risk-derived size would need ₹${fmtInr(valueAtRawQty)}, so quantity is capped at ${quantity.toFixed(2)}`,
    );
    warnings.push(
      `Size reduced by the ${maxPositionPctOfCapital}% single-position cap. The stop is wide relative to price, so the risk budget alone would have concentrated the book.`,
    );
  }

  let lots: number | null = null;
  if (wholeLotsOnly && lotSize > 1) {
    lots = Math.floor(quantity / lotSize);
    const rounded = lots * lotSize;
    if (rounded !== quantity) {
      explain.push(
        `Rounded down to whole lots: floor(${quantity.toFixed(2)} ÷ ${lotSize}) = ${lots} lot(s) = ${rounded} units`,
      );
      if (limitedBy === 'risk_budget') limitedBy = 'lot_rounding';
    }
    quantity = rounded;
  } else {
    quantity = Math.floor(quantity);
    if (lotSize > 1) lots = Math.floor(quantity / lotSize);
  }

  if (quantity <= 0) {
    limitedBy = 'insufficient_capital';
    warnings.push(
      lotSize > 1
        ? `Capital and risk limit do not permit even one lot of ${lotSize} units. One lot would risk ₹${fmtInr(lotSize * riskPerUnit)}, above the ₹${fmtInr(maxCapitalAtRisk)} budget.`
        : `Capital and risk limit do not permit a single unit at this stop distance.`,
    );
  }

  const positionValue = quantity * entry;
  const actualCapitalAtRisk = quantity * riskPerUnit;
  const actualRiskPct = (actualCapitalAtRisk / config.capital) * 100;

  if (positionValue > config.capital) {
    warnings.push(
      `Position value ₹${fmtInr(positionValue)} exceeds stated capital ₹${fmtInr(config.capital)} — this requires leverage or margin.`,
    );
  }

  explain.push(
    `Final quantity ${quantity} → position value ₹${fmtInr(positionValue)}, capital at risk ₹${fmtInr(actualCapitalAtRisk)} (${actualRiskPct.toFixed(2)}% of capital)`,
  );

  return {
    direction,
    entry,
    stop,
    riskPerUnit,
    maxCapitalAtRisk,
    rawQuantity,
    quantity,
    lots,
    positionValue,
    actualCapitalAtRisk,
    actualRiskPct,
    limitedBy,
    warnings,
    explain,
  };
}

export interface RiskRewardInput {
  entry: number;
  stop: number;
  target1: number;
  target2?: number | null;
}

export interface RiskRewardResult {
  riskPerUnit: number;
  reward1PerUnit: number;
  reward2PerUnit: number | null;
  riskReward1: number;
  riskReward2: number | null;
  /** Formatted as "1:2.4" for display. */
  display1: string;
  display2: string | null;
  /**
   * Break-even hit rate implied by R:R alone, ignoring costs.
   * This is arithmetic about the payoff structure, not a claim about
   * how often the setup actually works.
   */
  breakEvenWinRatePct: number;
  valid: boolean;
  issues: string[];
}

export function calculateRiskReward(input: RiskRewardInput): RiskRewardResult {
  const { entry, stop, target1, target2 } = input;
  const issues: string[] = [];

  const isLong = stop < entry;
  const riskPerUnit = Math.abs(entry - stop);
  const reward1PerUnit = isLong ? target1 - entry : entry - target1;
  const reward2PerUnit =
    target2 === null || target2 === undefined
      ? null
      : isLong
        ? target2 - entry
        : entry - target2;

  if (riskPerUnit <= 0) issues.push('Stop equals entry; risk is undefined');
  if (reward1PerUnit <= 0) {
    issues.push(
      isLong
        ? 'Target 1 is not above entry for a long idea'
        : 'Target 1 is not below entry for a short idea',
    );
  }
  if (reward2PerUnit !== null && reward2PerUnit <= reward1PerUnit) {
    issues.push('Target 2 is not further from entry than target 1');
  }

  const riskReward1 = riskPerUnit > 0 ? reward1PerUnit / riskPerUnit : 0;
  const riskReward2 =
    reward2PerUnit !== null && riskPerUnit > 0 ? reward2PerUnit / riskPerUnit : null;

  // With payoff R and no costs, break-even win rate = 1 / (1 + R).
  const breakEvenWinRatePct = riskReward1 > 0 ? (1 / (1 + riskReward1)) * 100 : 100;

  return {
    riskPerUnit,
    reward1PerUnit,
    reward2PerUnit,
    riskReward1,
    riskReward2,
    display1: `1:${riskReward1.toFixed(2)}`,
    display2: riskReward2 !== null ? `1:${riskReward2.toFixed(2)}` : null,
    breakEvenWinRatePct,
    valid: issues.length === 0,
    issues,
  };
}

export interface DailyLossCheck {
  limit: number;
  used: number;
  remaining: number;
  breached: boolean;
  message: string;
}

/** Whether the user's configured daily loss limit has been reached. */
export function checkDailyLoss(config: RiskConfig, realizedLossToday: number): DailyLossCheck {
  const limit = (config.capital * config.maxDailyLossPct) / 100;
  const used = Math.max(0, realizedLossToday);
  const remaining = Math.max(0, limit - used);
  const breached = used >= limit;
  return {
    limit,
    used,
    remaining,
    breached,
    message: breached
      ? `Daily loss limit reached: ₹${fmtInr(used)} of the ₹${fmtInr(limit)} (${config.maxDailyLossPct}% of capital) budget.`
      : `₹${fmtInr(remaining)} of the ₹${fmtInr(limit)} daily loss budget remains.`,
  };
}

/**
 * Suggest a stop from ATR, which keeps the invalidation level tied to the
 * instrument's own volatility rather than an arbitrary percentage.
 */
export function atrStop(
  entry: number,
  atr: number,
  direction: 'LONG' | 'SHORT',
  multiple = 1.5,
): { stop: number; explain: string } {
  const distance = atr * multiple;
  const stop = direction === 'LONG' ? entry - distance : entry + distance;
  return {
    stop,
    explain: `${multiple}× ATR(14) = ${multiple} × ₹${atr.toFixed(2)} = ₹${distance.toFixed(2)} from entry ₹${entry.toFixed(2)} → stop ₹${stop.toFixed(2)}`,
  };
}

function fmtInr(n: number): string {
  return n.toLocaleString('en-IN', { maximumFractionDigits: 2 });
}
