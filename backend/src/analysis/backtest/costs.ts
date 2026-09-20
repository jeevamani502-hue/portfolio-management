/**
 * Indian transaction-cost model.
 *
 * Backtests that ignore costs are the single most common way a strategy looks
 * profitable and is not — in Indian equity intraday, STT plus brokerage plus
 * the exchange/SEBI/GST/stamp stack routinely exceeds the edge of a
 * high-frequency rule.
 *
 * Rates below reflect the published structure at the time of writing and are
 * CONFIGURABLE, not hardcoded into the engine. Verify them against current
 * SEBI/exchange circulars and your broker's schedule before drawing
 * conclusions from a backtest — they change, sometimes mid-year.
 */

export type Segment = 'EQ_DELIVERY' | 'EQ_INTRADAY' | 'FUT' | 'OPT';

export interface CostConfig {
  /** Flat fee per executed order, INR. Discount brokers commonly charge ₹20. */
  brokeragePerOrder: number;
  /** Brokerage as a percentage of turnover; the lower of the two applies. */
  brokeragePct: number;
  brokerageCapPerOrder: number;
  /** Securities Transaction Tax, percent of the taxed leg's turnover. */
  sttPct: number;
  /** True when STT applies only on the sell leg (intraday, F&O). */
  sttOnSellOnly: boolean;
  /** For options, STT is charged on premium; for futures, on turnover. */
  sttOnPremium: boolean;
  /** Exchange transaction charges, percent of turnover. */
  exchangeTxnPct: number;
  /** SEBI turnover fee, percent of turnover. */
  sebiPct: number;
  /** GST on (brokerage + exchange + SEBI), percent. */
  gstPct: number;
  /** Stamp duty, percent of BUY-side turnover only. */
  stampDutyPct: number;
  /** Slippage assumption, percent of price, applied against the trade. */
  slippagePct: number;
}

/**
 * Default rates. Sources: SEBI turnover fee and stamp-duty schedules, exchange
 * transaction-charge circulars, and the standard discount-broker fee model.
 * RE-VERIFY before relying on backtest economics.
 */
export const DEFAULT_COSTS: Record<Segment, CostConfig> = {
  EQ_DELIVERY: {
    brokeragePerOrder: 0, // most discount brokers: zero on delivery
    brokeragePct: 0,
    brokerageCapPerOrder: 0,
    sttPct: 0.1, // both legs
    sttOnSellOnly: false,
    sttOnPremium: false,
    exchangeTxnPct: 0.00297,
    sebiPct: 0.0001,
    gstPct: 18,
    stampDutyPct: 0.015,
    slippagePct: 0.05,
  },
  EQ_INTRADAY: {
    brokeragePerOrder: 20,
    brokeragePct: 0.03,
    brokerageCapPerOrder: 20,
    sttPct: 0.025, // sell side only
    sttOnSellOnly: true,
    sttOnPremium: false,
    exchangeTxnPct: 0.00297,
    sebiPct: 0.0001,
    gstPct: 18,
    stampDutyPct: 0.003,
    slippagePct: 0.05,
  },
  FUT: {
    brokeragePerOrder: 20,
    brokeragePct: 0.03,
    brokerageCapPerOrder: 20,
    sttPct: 0.02, // sell side, on turnover
    sttOnSellOnly: true,
    sttOnPremium: false,
    exchangeTxnPct: 0.00173,
    sebiPct: 0.0001,
    gstPct: 18,
    stampDutyPct: 0.002,
    slippagePct: 0.03,
  },
  OPT: {
    brokeragePerOrder: 20,
    brokeragePct: 0,
    brokerageCapPerOrder: 20,
    sttPct: 0.1, // sell side, on PREMIUM
    sttOnSellOnly: true,
    sttOnPremium: true,
    exchangeTxnPct: 0.03503, // on premium turnover
    sebiPct: 0.0001,
    gstPct: 18,
    stampDutyPct: 0.003,
    slippagePct: 0.5, // options spreads are wide; be pessimistic
  },
};

export interface CostBreakdown {
  brokerage: number;
  stt: number;
  exchangeTxn: number;
  sebi: number;
  gst: number;
  stampDuty: number;
  total: number;
  /** Itemised explanation, shown in the backtest report. */
  explain: string[];
}

export interface TradeLegInput {
  side: 'BUY' | 'SELL';
  price: number;
  quantity: number;
  segment: Segment;
  config?: CostConfig;
}

/** Charges for one leg (one order) of a trade. */
export function calculateLegCosts(leg: TradeLegInput): CostBreakdown {
  const c = leg.config ?? DEFAULT_COSTS[leg.segment];
  const turnover = leg.price * leg.quantity;
  const explain: string[] = [];

  // Brokerage: lower of flat fee and percentage, capped.
  const pctBrokerage = (turnover * c.brokeragePct) / 100;
  let brokerage =
    c.brokeragePct > 0
      ? Math.min(c.brokeragePerOrder || Number.POSITIVE_INFINITY, pctBrokerage)
      : c.brokeragePerOrder;
  if (c.brokerageCapPerOrder > 0) brokerage = Math.min(brokerage, c.brokerageCapPerOrder);
  if (!Number.isFinite(brokerage)) brokerage = 0;
  explain.push(
    `Brokerage ₹${brokerage.toFixed(2)} (lower of ₹${c.brokeragePerOrder} flat and ${c.brokeragePct}% of ₹${turnover.toFixed(2)}, capped at ₹${c.brokerageCapPerOrder})`,
  );

  // STT.
  const sttApplies = !c.sttOnSellOnly || leg.side === 'SELL';
  const sttBase = turnover; // for options the caller passes premium as `price`
  const stt = sttApplies ? (sttBase * c.sttPct) / 100 : 0;
  explain.push(
    sttApplies
      ? `STT ₹${stt.toFixed(2)} (${c.sttPct}% of ${c.sttOnPremium ? 'premium' : 'turnover'} ₹${sttBase.toFixed(2)})`
      : `STT ₹0.00 (charged on the sell leg only)`,
  );

  const exchangeTxn = (turnover * c.exchangeTxnPct) / 100;
  explain.push(`Exchange transaction charge ₹${exchangeTxn.toFixed(2)} (${c.exchangeTxnPct}% of turnover)`);

  const sebi = (turnover * c.sebiPct) / 100;
  explain.push(`SEBI turnover fee ₹${sebi.toFixed(2)} (${c.sebiPct}% of turnover)`);

  const gst = ((brokerage + exchangeTxn + sebi) * c.gstPct) / 100;
  explain.push(`GST ₹${gst.toFixed(2)} (${c.gstPct}% of brokerage + exchange + SEBI)`);

  const stampDuty = leg.side === 'BUY' ? (turnover * c.stampDutyPct) / 100 : 0;
  explain.push(
    leg.side === 'BUY'
      ? `Stamp duty ₹${stampDuty.toFixed(2)} (${c.stampDutyPct}% of buy turnover)`
      : 'Stamp duty ₹0.00 (buy side only)',
  );

  const total = brokerage + stt + exchangeTxn + sebi + gst + stampDuty;
  explain.push(`Total ₹${total.toFixed(2)} on turnover ₹${turnover.toFixed(2)} (${((total / turnover) * 100).toFixed(4)}%)`);

  return { brokerage, stt, exchangeTxn, sebi, gst, stampDuty, total, explain };
}

/** Round-trip charges for a complete trade. */
export function calculateRoundTripCosts(
  entryPrice: number,
  exitPrice: number,
  quantity: number,
  segment: Segment,
  direction: 'LONG' | 'SHORT',
  config?: CostConfig,
): { entry: CostBreakdown; exit: CostBreakdown; total: number } {
  const entrySide = direction === 'LONG' ? 'BUY' : 'SELL';
  const exitSide = direction === 'LONG' ? 'SELL' : 'BUY';

  const entry = calculateLegCosts({
    side: entrySide, price: entryPrice, quantity, segment,
    ...(config ? { config } : {}),
  });
  const exit = calculateLegCosts({
    side: exitSide, price: exitPrice, quantity, segment,
    ...(config ? { config } : {}),
  });

  return { entry, exit, total: entry.total + exit.total };
}

/**
 * Apply slippage to a fill price, always against the trader.
 * A backtest that fills at the exact signal price is fiction.
 */
export function applySlippage(
  price: number,
  side: 'BUY' | 'SELL',
  segment: Segment,
  config?: CostConfig,
): number {
  const pct = (config ?? DEFAULT_COSTS[segment]).slippagePct;
  return side === 'BUY' ? price * (1 + pct / 100) : price * (1 - pct / 100);
}
