/**
 * Profit and loss report — paper and live, side by side, with the cost stack
 * itemised so the user can see what the market gave and what the charges and
 * taxes took.
 *
 * Every number is recomputed from the ledger rows with the same cost model
 * the engines use at close time, so the report always agrees with the trade
 * tables. "Charges" are what the broker and exchanges charge (brokerage,
 * exchange transaction charge, SEBI turnover fee, stamp duty). "Taxes" are
 * what the government takes (STT and GST). For live trades the broker's
 * contract note is the final word; this is the modelled stack.
 */
import { queryRows } from '../../db/pool.js';
import { calculateLegCosts, type CostBreakdown, type Segment } from '../../analysis/backtest/costs.js';
import { toIst, fromIst } from '../../utils/time.js';

export interface CostSplit {
  brokerage: number;
  exchangeTxn: number;
  sebi: number;
  stampDuty: number;
  stt: number;
  gst: number;
  /** brokerage + exchangeTxn + sebi + stampDuty */
  charges: number;
  /** stt + gst */
  taxes: number;
  total: number;
}

export interface ReportTrade {
  id: string;
  symbol: string;
  quantity: number;
  entryPrice: number;
  exitPrice: number | null;
  exitedAt: string;
  day: string;
  reason: string | null;
  gross: number;
  costs: CostSplit;
  net: number;
}

export interface DayRow {
  day: string;
  trades: number;
  gross: number;
  charges: number;
  taxes: number;
  net: number;
}

export interface AccountReport {
  account: 'paper' | 'live';
  trades: number;
  wins: number;
  losses: number;
  gross: number;
  costs: CostSplit;
  net: number;
  byDay: DayRow[];
  rows: ReportTrade[];
  note: string;
}

export interface PnlReport {
  from: string;
  to: string;
  paper: AccountReport;
  live: AccountReport;
  combined: { gross: number; charges: number; taxes: number; net: number; trades: number };
}

const zeroSplit = (): CostSplit => ({ brokerage: 0, exchangeTxn: 0, sebi: 0, stampDuty: 0, stt: 0, gst: 0, charges: 0, taxes: 0, total: 0 });

const addLeg = (s: CostSplit, b: CostBreakdown): void => {
  s.brokerage += b.brokerage; s.exchangeTxn += b.exchangeTxn; s.sebi += b.sebi; s.stampDuty += b.stampDuty;
  s.stt += b.stt; s.gst += b.gst;
};
const finish = (s: CostSplit): CostSplit => {
  s.charges = s.brokerage + s.exchangeTxn + s.sebi + s.stampDuty;
  s.taxes = s.stt + s.gst;
  s.total = s.charges + s.taxes;
  for (const k of Object.keys(s) as Array<keyof CostSplit>) s[k] = Number(s[k].toFixed(2));
  return s;
};
const addSplit = (a: CostSplit, b: CostSplit): void => {
  a.brokerage += b.brokerage; a.exchangeTxn += b.exchangeTxn; a.sebi += b.sebi; a.stampDuty += b.stampDuty; a.stt += b.stt; a.gst += b.gst;
};

/** One bought leg plus one or more sold legs, costed with the engine's model. */
function costTrade(entryPrice: number, entryQty: number, exits: Array<{ price: number; qty: number }>, segment: Segment): CostSplit {
  const s = zeroSplit();
  addLeg(s, calculateLegCosts({ side: 'BUY', price: entryPrice, quantity: entryQty, segment }));
  for (const e of exits) addLeg(s, calculateLegCosts({ side: 'SELL', price: e.price, quantity: e.qty, segment }));
  return finish(s);
}

function summarise(account: 'paper' | 'live', rows: ReportTrade[], note: string): AccountReport {
  const costs = zeroSplit();
  let gross = 0;
  const days = new Map<string, DayRow>();
  for (const r of rows) {
    gross += r.gross;
    addSplit(costs, r.costs);
    const d = days.get(r.day) ?? { day: r.day, trades: 0, gross: 0, charges: 0, taxes: 0, net: 0 };
    d.trades += 1; d.gross += r.gross; d.charges += r.costs.charges; d.taxes += r.costs.taxes; d.net += r.net;
    days.set(r.day, d);
  }
  finish(costs);
  const byDay = [...days.values()].sort((a, b) => (a.day < b.day ? 1 : -1))
    .map((d) => ({ ...d, gross: +d.gross.toFixed(2), charges: +d.charges.toFixed(2), taxes: +d.taxes.toFixed(2), net: +d.net.toFixed(2) }));
  return {
    account, trades: rows.length,
    wins: rows.filter((r) => r.net > 0).length, losses: rows.filter((r) => r.net <= 0).length,
    gross: +gross.toFixed(2), costs, net: +(gross - costs.total).toFixed(2), byDay, rows, note,
  };
}

interface PaperRow {
  id: string; tradingsymbol: string; kind: 'EQUITY' | 'OPTION'; quantity: number;
  entry_price: string; exit_price: string | null; exit_at: Date; exit_reason: string | null;
}
interface LiveRow {
  id: string; tradingsymbol: string; quantity: number; entry_price: string | null; closed_at: Date; exit_code: string | null;
  exits: Array<{ qty: number; price: number; at: string; code: string }>;
}

export async function pnlReport(userId: string, fromDay: string, toDay: string): Promise<PnlReport> {
  const from = fromIst(fromDay, 0, 0);
  const to = new Date(fromIst(toDay, 23, 59).getTime() + 59_000);

  const paperRows = await queryRows<PaperRow>(
    `SELECT id, tradingsymbol, kind, quantity, entry_price, exit_price, exit_at, exit_reason
       FROM paper_trades WHERE user_id = $1 AND status = 'CLOSED' AND exit_at BETWEEN $2 AND $3
      ORDER BY exit_at DESC`,
    [userId, from, to],
  );
  const paper: ReportTrade[] = paperRows.map((r) => {
    const entry = Number(r.entry_price);
    const exit = r.exit_price === null ? null : Number(r.exit_price);
    const segment: Segment = r.kind === 'OPTION' ? 'OPT' : 'EQ_INTRADAY';
    const costs = exit === null ? zeroSplit() : costTrade(entry, r.quantity, [{ price: exit, qty: r.quantity }], segment);
    const gross = exit === null ? 0 : +((exit - entry) * r.quantity).toFixed(2);
    return {
      id: r.id, symbol: r.tradingsymbol, quantity: r.quantity, entryPrice: entry, exitPrice: exit,
      exitedAt: r.exit_at.toISOString(), day: toIst(r.exit_at).dateKey, reason: r.exit_reason,
      gross, costs, net: +(gross - costs.total).toFixed(2),
    };
  });

  const liveRows = await queryRows<LiveRow>(
    `SELECT id, tradingsymbol, quantity, entry_price, closed_at, exit_code, exits
       FROM live_trades WHERE user_id = $1 AND status = 'CLOSED' AND closed_at BETWEEN $2 AND $3
      ORDER BY closed_at DESC`,
    [userId, from, to],
  );
  const live: ReportTrade[] = liveRows.map((r) => {
    const entry = Number(r.entry_price ?? 0);
    const legs = (r.exits ?? []).map((e) => ({ price: Number(e.price), qty: Number(e.qty) }));
    const soldQty = legs.reduce((a, l) => a + l.qty, 0);
    const avgExit = soldQty > 0 ? legs.reduce((a, l) => a + l.price * l.qty, 0) / soldQty : null;
    const costs = costTrade(entry, r.quantity, legs, 'OPT');
    const gross = +legs.reduce((a, l) => a + (l.price - entry) * l.qty, 0).toFixed(2);
    return {
      id: r.id, symbol: r.tradingsymbol, quantity: r.quantity, entryPrice: entry,
      exitPrice: avgExit === null ? null : +avgExit.toFixed(2),
      exitedAt: r.closed_at.toISOString(), day: toIst(r.closed_at).dateKey, reason: r.exit_code,
      gross, costs, net: +(gross - costs.total).toFixed(2),
    };
  });

  const p = summarise('paper', paper,
    'Simulated fills: sold at the bid less 15 basis points of slippage, charged on both legs with the modelled Indian cost stack.');
  const l = summarise('live', live,
    'Real fills from the broker. Charges and taxes are the modelled stack; your broker\'s contract note is the final figure.');
  return {
    from: fromDay, to: toDay, paper: p, live: l,
    combined: {
      gross: +(p.gross + l.gross).toFixed(2), charges: +(p.costs.charges + l.costs.charges).toFixed(2),
      taxes: +(p.costs.taxes + l.costs.taxes).toFixed(2), net: +(p.net + l.net).toFixed(2), trades: p.trades + l.trades,
    },
  };
}
