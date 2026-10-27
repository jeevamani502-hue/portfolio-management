/**
 * Profit and loss report — paper and live side by side, with charges and
 * taxes shown separately from what the market gave. Every figure comes from
 * the ledger through the same cost model the engines use to close a trade.
 */
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/services/api';
import {
  Card, CardHeader, CardTitle, CardContent, Skeleton, Badge, Alert, Button, Input, Label, EmptyState,
} from '@/components/ui';
import { Metric } from '@/components/market/DataValue';
import { cn } from '@/lib/utils';
import type { AccountReportDto } from '@/types/api';

const inr = (n: number | null | undefined, dp = 0) =>
  n === null || n === undefined ? '—' : `${n < 0 ? '−' : ''}₹${Math.abs(n).toLocaleString('en-IN', { minimumFractionDigits: dp, maximumFractionDigits: dp })}`;
const signed = (n: number, dp = 0) => `${n > 0 ? '+' : n < 0 ? '−' : ''}₹${Math.abs(n).toLocaleString('en-IN', { minimumFractionDigits: dp, maximumFractionDigits: dp })}`;
const pnlClass = (n: number) => (n > 0 ? 'text-bull' : n < 0 ? 'text-bear' : '');

const istToday = () => new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);
const daysAgo = (n: number) => new Date(Date.now() + 5.5 * 3600_000 - n * 86_400_000).toISOString().slice(0, 10);

const PRESETS: Array<{ id: string; label: string; from: () => string; to: () => string }> = [
  { id: 'today', label: 'Today', from: istToday, to: istToday },
  { id: '7d', label: 'Last 7 days', from: () => daysAgo(6), to: istToday },
  { id: 'month', label: 'This month', from: () => istToday().slice(0, 8) + '01', to: istToday },
  { id: '30d', label: 'Last 30 days', from: () => daysAgo(29), to: istToday },
  { id: '90d', label: 'Last 90 days', from: () => daysAgo(89), to: istToday },
];

const REASON: Record<string, string> = {
  TARGET: 'Target', STOP: 'Stop', EOD: 'Day end', THESIS: 'Direction changed', GIVEBACK: 'Profit protected',
  NEWS: 'News', MANUAL: 'Closed by you', EXPIRY: 'Expiry', TARGET1: 'Target 1', TARGET2: 'Target 2',
  INVALIDATED: 'Invalidated', SQUARE_OFF: 'Square-off', DIRECTION: 'Direction changed', SCORE: 'Score faded', CLOSED_AT_BROKER: 'Closed at broker',
};

export function Reports() {
  const [preset, setPreset] = useState('month');
  const [from, setFrom] = useState(PRESETS[2]!.from());
  const [to, setTo] = useState(istToday());
  const [showRows, setShowRows] = useState<'paper' | 'live' | null>(null);

  const report = useQuery({
    queryKey: ['reports', 'pnl', from, to],
    queryFn: () => api.reports.pnl(from, to),
    refetchInterval: 60_000,
  });

  const choose = (p: (typeof PRESETS)[number]) => { setPreset(p.id); setFrom(p.from()); setTo(p.to()); };
  const r = report.data;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold">Profit and loss report</h1>
          <p className="text-sm text-muted-foreground">Paper and real money kept apart. Charges and taxes shown separately from what the market gave.</p>
        </div>
        <div className="flex flex-wrap items-end gap-2">
          {PRESETS.map((p) => (
            <Button key={p.id} variant={preset === p.id ? 'default' : 'outline'} className="h-8 text-xs" onClick={() => choose(p)}>{p.label}</Button>
          ))}
          <div className="space-y-1">
            <Label htmlFor="from" className="text-2xs">From</Label>
            <Input id="from" type="date" value={from} onChange={(e) => { setPreset('custom'); setFrom(e.target.value); }} className="h-8 w-36 text-xs" />
          </div>
          <div className="space-y-1">
            <Label htmlFor="to" className="text-2xs">To</Label>
            <Input id="to" type="date" value={to} onChange={(e) => { setPreset('custom'); setTo(e.target.value); }} className="h-8 w-36 text-xs" />
          </div>
        </div>
      </div>

      {report.isLoading ? (
        <Skeleton className="h-64" />
      ) : report.error ? (
        <Alert variant="error">{report.error instanceof Error ? report.error.message : 'Could not load the report.'}</Alert>
      ) : r ? (
        <>
          <Card>
            <CardContent className="pt-4">
              <div className="grid grid-cols-2 gap-4 sm:grid-cols-5">
                <Metric label="Net, both accounts" value={signed(r.combined.net)} className={pnlClass(r.combined.net)} />
                <Metric label="Before charges" value={signed(r.combined.gross)} className={pnlClass(r.combined.gross)} />
                <Metric label="Charges" value={inr(r.combined.charges)} />
                <Metric label="Taxes" value={inr(r.combined.taxes)} />
                <Metric label="Trades closed" value={r.combined.trades} />
              </div>
              <p className="mt-3 text-2xs text-muted-foreground">
                {r.from} to {r.to}, IST days, closed trades only. Charges = brokerage + exchange transaction charge + SEBI fee + stamp duty.
                Taxes = STT + GST. Open positions are not included until they close.
              </p>
            </CardContent>
          </Card>

          <div className="grid gap-4 lg:grid-cols-2">
            <AccountCard a={r.paper} title="Paper trading" badge="Simulated" onRows={() => setShowRows(showRows === 'paper' ? null : 'paper')} open={showRows === 'paper'} />
            <AccountCard a={r.live} title="Live trading" badge="Real money" onRows={() => setShowRows(showRows === 'live' ? null : 'live')} open={showRows === 'live'} />
          </div>

          {showRows && <TradeRows a={showRows === 'paper' ? r.paper : r.live} />}
        </>
      ) : null}
    </div>
  );
}

function AccountCard({ a, title, badge, onRows, open }: { a: AccountReportDto; title: string; badge: string; onRows: () => void; open: boolean }) {
  const c = a.costs;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          {title} <Badge variant={a.account === 'live' ? 'warning' : 'outline'}>{badge}</Badge>
          <span className="ml-auto text-2xs font-normal text-muted-foreground">{a.trades} trade(s) · {a.wins} won · {a.losses} lost</span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {a.trades === 0 ? (
          <EmptyState title="No closed trades in this period" description={a.note} />
        ) : (
          <>
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
              <Metric label="Net profit / loss" value={signed(a.net)} className={cn('text-lg', pnlClass(a.net))} />
              <Metric label="Before charges" value={signed(a.gross)} className={pnlClass(a.gross)} />
              <Metric label="Charges" value={inr(c.charges, 2)} />
              <Metric label="Taxes" value={inr(c.taxes, 2)} />
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="rounded border border-border p-3">
                <div className="mb-1.5 text-2xs font-medium uppercase tracking-wide text-muted-foreground">Charges — broker and exchanges</div>
                <Row label="Brokerage" value={c.brokerage} />
                <Row label="Exchange transaction charge" value={c.exchangeTxn} />
                <Row label="SEBI turnover fee" value={c.sebi} />
                <Row label="Stamp duty" value={c.stampDuty} />
                <Row label="Total charges" value={c.charges} strong />
              </div>
              <div className="rounded border border-border p-3">
                <div className="mb-1.5 text-2xs font-medium uppercase tracking-wide text-muted-foreground">Taxes — government</div>
                <Row label="STT (securities transaction tax)" value={c.stt} />
                <Row label="GST on brokerage and charges" value={c.gst} />
                <Row label="Total taxes" value={c.taxes} strong />
                <div className="mt-2 border-t border-border pt-2">
                  <Row label="Charges + taxes" value={c.total} strong />
                </div>
              </div>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-2xs uppercase tracking-wide text-muted-foreground">
                    <th className="px-2 py-1.5 text-left font-medium">Day</th>
                    <th className="px-2 py-1.5 text-right font-medium">Trades</th>
                    <th className="px-2 py-1.5 text-right font-medium">Before charges</th>
                    <th className="px-2 py-1.5 text-right font-medium">Charges</th>
                    <th className="px-2 py-1.5 text-right font-medium">Taxes</th>
                    <th className="px-2 py-1.5 text-right font-medium">Net</th>
                  </tr>
                </thead>
                <tbody>
                  {a.byDay.map((d) => (
                    <tr key={d.day} className="border-b border-border/50 last:border-0">
                      <td className="px-2 py-1.5 font-mono">{d.day}</td>
                      <td className="px-2 py-1.5 text-right font-mono">{d.trades}</td>
                      <td className={cn('px-2 py-1.5 text-right font-mono', pnlClass(d.gross))}>{signed(d.gross)}</td>
                      <td className="px-2 py-1.5 text-right font-mono text-muted-foreground">{inr(d.charges)}</td>
                      <td className="px-2 py-1.5 text-right font-mono text-muted-foreground">{inr(d.taxes)}</td>
                      <td className={cn('px-2 py-1.5 text-right font-mono font-medium', pnlClass(d.net))}>{signed(d.net)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="flex items-center justify-between">
              <p className="text-2xs text-muted-foreground">{a.note}</p>
              <Button variant="ghost" className="h-7 text-xs" onClick={onRows}>{open ? 'Hide trades' : 'Show every trade'}</Button>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function Row({ label, value, strong }: { label: string; value: number; strong?: boolean }) {
  return (
    <div className={cn('flex items-center justify-between py-0.5 text-sm', strong && 'font-medium')}>
      <span className={cn(!strong && 'text-muted-foreground')}>{label}</span>
      <span className="font-mono">{inr(value, 2)}</span>
    </div>
  );
}

function TradeRows({ a }: { a: AccountReportDto }) {
  return (
    <Card>
      <CardHeader><CardTitle>{a.account === 'paper' ? 'Paper' : 'Live'} trades in this period</CardTitle></CardHeader>
      <CardContent className="px-0">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-2xs uppercase tracking-wide text-muted-foreground">
                <th className="px-4 py-2 text-left font-medium">Closed</th>
                <th className="px-4 py-2 text-left font-medium">Contract</th>
                <th className="px-4 py-2 text-right font-medium">Qty</th>
                <th className="px-4 py-2 text-right font-medium">Bought</th>
                <th className="px-4 py-2 text-right font-medium">Sold</th>
                <th className="px-4 py-2 text-left font-medium">Why</th>
                <th className="px-4 py-2 text-right font-medium">Before charges</th>
                <th className="px-4 py-2 text-right font-medium">Charges</th>
                <th className="px-4 py-2 text-right font-medium">Taxes</th>
                <th className="px-4 py-2 text-right font-medium">Net</th>
              </tr>
            </thead>
            <tbody>
              {a.rows.map((t) => (
                <tr key={t.id} className={cn('border-b border-border/50 last:border-0 border-l-4', t.net > 0 ? 'border-l-up bg-up/5' : t.net < 0 ? 'border-l-down bg-down/5' : 'border-l-flat')}>
                  <td className="px-4 py-2 font-mono text-xs">{new Date(t.exitedAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}</td>
                  <td className="px-4 py-2 font-mono">{t.symbol}</td>
                  <td className="px-4 py-2 text-right font-mono">{t.quantity}</td>
                  <td className="px-4 py-2 text-right font-mono">{inr(t.entryPrice, 2)}</td>
                  <td className="px-4 py-2 text-right font-mono">{inr(t.exitPrice, 2)}</td>
                  <td className="px-4 py-2"><Badge variant="outline">{t.reason ? (REASON[t.reason] ?? t.reason.toLowerCase().replace(/_/g, ' ')) : '—'}</Badge></td>
                  <td className={cn('px-4 py-2 text-right font-mono', pnlClass(t.gross))}>{signed(t.gross)}</td>
                  <td className="px-4 py-2 text-right font-mono text-muted-foreground">{inr(t.costs.charges, 2)}</td>
                  <td className="px-4 py-2 text-right font-mono text-muted-foreground">{inr(t.costs.taxes, 2)}</td>
                  <td className={cn('px-4 py-2 text-right font-mono font-medium', pnlClass(t.net))}>{signed(t.net)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}
