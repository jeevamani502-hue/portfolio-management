/**
 * Live trading — the Paper Trading screen, with real orders behind it.
 *
 * Same layout on purpose: status card, settings, results, Open/Closed table
 * with streaming LTP and P&L. The differences are the ones that matter when
 * money is real — arming for the day with the capital typed in, hard caps
 * that halt the system, a kill switch that is never hidden, and every broker
 * exchange kept on the trade.
 */
import { useEffect, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { ShieldAlert, Power, RefreshCw, Zap, Check, X, Minus } from 'lucide-react';
import { api } from '@/services/api';
import {
  Card, CardHeader, CardTitle, CardContent, Skeleton, Badge, Alert, EmptyState,
  Button, Input, Label, Select, Tabs,
} from '@/components/ui';
import { Metric } from '@/components/market/DataValue';
import { useTicks } from '@/services/ws';
import { relativeTime, istTime } from '@/lib/format';
import { cn } from '@/lib/utils';
import { RISK_LIMITS } from '@/lib/riskLimits';
import type { LiveConfigDto, LiveStatusDto, LiveTradeDto, LiveMode, LiveFundsDto, HeroZeroDecisionDto } from '@/types/api';

const inr = (v: number | string | null | undefined, dp = 0) => {
  const n = typeof v === 'string' ? Number(v) : v;
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  return `₹${n.toLocaleString('en-IN', { maximumFractionDigits: dp, minimumFractionDigits: dp })}`;
};
const pnlClass = (n: number | null) => (n === null ? '' : n > 0 ? 'text-bull' : n < 0 ? 'text-bear' : '');
const rowTone = (n: number | null) =>
  n === null ? 'border-l-transparent' : n > 0 ? 'border-l-up bg-up/5' : n < 0 ? 'border-l-down bg-down/5' : 'border-l-flat';
const toHHMM = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const fromHHMM = (s: string) => { const [h, m] = s.split(':').map(Number); return (h ?? 0) * 60 + (m ?? 0); };

export function LiveTrading() {
  const qc = useQueryClient();
  const [tab, setTab] = useState<'ACTIVE' | 'CLOSED'>('ACTIVE');

  const status = useQuery({ queryKey: ['live', 'status'], queryFn: api.live.status, refetchInterval: 10_000 });
  const perf = useQuery({ queryKey: ['live', 'performance'], queryFn: api.live.performance, refetchInterval: 30_000 });
  const trades = useQuery({
    queryKey: ['live', 'trades', tab],
    queryFn: () => api.live.trades({ status: tab, limit: 200 }),
    refetchInterval: tab === 'ACTIVE' ? 5_000 : 60_000,
  });

  const invalidate = () => void qc.invalidateQueries({ queryKey: ['live'] });
  const sync = useMutation({ mutationFn: api.live.sync, onSuccess: invalidate });
  const close = useMutation({ mutationFn: api.live.close, onSuccess: invalidate });

  if (status.isLoading) return <Skeleton className="h-96" />;
  const s = status.data;
  if (!s) return null;
  const active = (trades.data ?? []).filter((t) => t.status !== 'CLOSED' && t.status !== 'FAILED');

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold">Real money trading</h1>
          <p className="text-sm text-muted-foreground">
            Works exactly like Paper Trading, but the orders are real and go to {s.broker ?? 'your broker'}. It only trades
            inside the limits you set below, and it keeps a record of every order it sends and every reply it gets back.
          </p>
        </div>
        <Button variant="outline" onClick={() => sync.mutate()} disabled={sync.isPending}>
          <RefreshCw className={cn('h-3.5 w-3.5', sync.isPending && 'animate-spin')} aria-hidden />
          {sync.isPending ? 'Refreshing…' : 'Refresh from broker'}
        </Button>
      </div>

      <LiveEngineStatus status={s} onChanged={invalidate} />

      {tab === 'ACTIVE' && active.length > 0 && (
        <>
          <SubscribeTicks trades={active} />
          <OpenPnlStrip trades={active} />
        </>
      )}

      <SettingsCard status={s} onSaved={invalidate} />

      <HeroZeroCard status={s} onChanged={invalidate} />

      {perf.data && (
        <Card>
          <CardHeader><CardTitle>Results</CardTitle></CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
              <Metric label="Profit / loss after charges" value={inr(perf.data.netPnl, 2)} className={pnlClass(perf.data.netPnl)} />
              <Metric label="Today" value={inr(perf.data.todayNet, 2)} className={pnlClass(perf.data.todayNet)} />
              <Metric label="Before charges" value={inr(perf.data.grossPnl, 2)} />
              <Metric label="Charges paid" value={inr(perf.data.costs, 2)} />
              <Metric label="Holding now" value={s.openPositions} />
              <Metric label="Finished" value={perf.data.closed} />
            </div>
            {perf.data.closed > 0 && (
              <div className="grid grid-cols-2 gap-4 border-t border-border pt-4 sm:grid-cols-3 lg:grid-cols-6">
                <Metric label="Trades won" value={perf.data.winRate === null ? '—' : `${perf.data.winRate.toFixed(0)}%`} />
                <Metric label="Won / lost" value={`${perf.data.wins} / ${perf.data.losses}`} />
                <Metric label="Best trade" value={inr(perf.data.best, 2)} />
                <Metric label="Worst trade" value={inr(perf.data.worst, 2)} />
                <Metric label="₹ won for every ₹ lost" value={perf.data.profitFactor === null ? '—' : perf.data.profitFactor.toFixed(2)} />
              </div>
            )}
            <Alert variant="default" title="What these numbers mean">{perf.data.caveat}</Alert>
          </CardContent>
        </Card>
      )}

      <div>
        <Tabs
          active={tab}
          onChange={(id) => setTab(id as 'ACTIVE' | 'CLOSED')}
          tabs={[
            { id: 'ACTIVE', label: `Holding now (${s.openPositions})` },
            { id: 'CLOSED', label: `Finished (${perf.data?.closed ?? 0})` },
          ]}
        />
        <Card>
          <CardContent className="px-0 pt-4">
            {trades.isLoading ? (
              <Skeleton className="mx-4 h-48" />
            ) : (trades.data ?? []).length === 0 ? (
              <EmptyState
                title={tab === 'ACTIVE' ? 'Nothing is being held right now' : 'No finished trades yet'}
                description={
                  tab === 'ACTIVE'
                    ? 'A trade shows up here the moment its order is sent — when you click "Execute live" on the F&O page, or when Automatic mode places one for you.'
                    : 'Finished trades show what was sold, at what price, why, and the profit or loss after all charges.'
                }
              />
            ) : (
              <TradeTable
                trades={trades.data!}
                onClose={(id, pending) => {
                  if (window.confirm(pending ? 'Cancel this waiting order?' : 'Sell this trade right now at the current market price?')) close.mutate(id);
                }}
                closing={close.isPending}
              />
            )}
          </CardContent>
        </Card>
        {close.isError && <Alert variant="error" className="mt-2">{close.error instanceof Error ? close.error.message : 'Could not sell.'}</Alert>}
      </div>
    </div>
  );
}

// ── status / arm / kill ─────────────────────────────────────────────────────

function LiveEngineStatus({ status: s, onChanged }: { status: LiveStatusDto; onChanged: () => void }) {
  const cfg = s.config;
  const kill = useMutation({ mutationFn: api.live.kill, onSuccess: onChanged });
  const reset = useMutation({ mutationFn: api.live.resetKill, onSuccess: onChanged });
  const disarm = useMutation({ mutationFn: api.live.disarm, onSuccess: onChanged });

  const label =
    cfg?.kill_switch ? 'Emergency stop is on'
    : cfg?.halted_reason ? 'Stopped for today'
    : !cfg || cfg.mode === 'OFF' ? 'Switched off'
    : s.armed && s.blockers.length === 0 ? (cfg.mode === 'AUTO' ? 'Trading on its own — watching the market' : 'Ready — waiting for you to click Execute')
    : s.armed ? 'Switched on, but cannot trade right now'
    : 'Not switched on for today';
  const dot =
    cfg?.kill_switch || cfg?.halted_reason ? 'bg-destructive'
    : s.armed && s.blockers.length === 0 ? 'bg-bull animate-pulse-dot'
    : s.armed ? 'bg-delayed' : 'bg-muted-foreground';
  const armedUntil = cfg?.armed_until && s.armed ? istTime(cfg.armed_until, false) : null;

  return (
    <Card>
      <CardContent className="space-y-4 pt-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex items-start gap-2.5">
            <span className={cn('mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full', dot)} aria-hidden />
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-base font-semibold">{label}</h2>
                <Badge variant="muted">{s.marketPhase}</Badge>
                {armedUntil && <Badge variant="warning">until {armedUntil} IST</Badge>}
                {s.brokerReady ? <Badge variant="up">{s.broker}</Badge> : <Badge variant="warning">broker not connected</Badge>}
              </div>
              <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{s.headline}</p>
            </div>
          </div>
          <dl className="flex gap-5 text-right">
            <div><dt className="text-2xs uppercase tracking-wide text-muted-foreground">Holding</dt><dd className="font-mono text-sm">{s.openPositions}</dd></div>
            <div><dt className="text-2xs uppercase tracking-wide text-muted-foreground">Trades today</dt><dd className="font-mono text-sm">{s.tradesToday}</dd></div>
            <div><dt className="text-2xs uppercase tracking-wide text-muted-foreground">Profit / loss today</dt><dd className={cn('font-mono text-sm', pnlClass(s.netPnlToday))}>{inr(s.netPnlToday)}</dd></div>
          </dl>
        </div>

        {s.blockers.length > 0 && (
          <div className="space-y-2 rounded border border-border bg-muted/30 p-3">
            <p className="text-2xs font-medium uppercase tracking-wide text-muted-foreground">Why it is not trading right now</p>
            <ul className="space-y-2">
              {s.blockers.map((b) => (
                <li key={b.code} className="text-sm leading-relaxed">
                  <span>{b.detail}</span>{b.fix && <span className="text-muted-foreground"> {b.fix}</span>}
                </li>
              ))}
            </ul>
          </div>
        )}

        {cfg?.last_sweep_result && cfg.mode === 'AUTO' && (
          <div className="space-y-1.5">
            <p className="text-2xs font-medium uppercase tracking-wide text-muted-foreground">What it found on its last look at the market</p>
            <p className="text-sm text-muted-foreground">
              {cfg.last_sweep_at ? relativeTime(cfg.last_sweep_at) : '—'}: {cfg.last_sweep_result.placed ?? 0} trade(s) placed.
            </p>
            <ul className="space-y-1">
              {(cfg.last_sweep_result.skipped ?? []).map((r) => <li key={r} className="text-sm leading-relaxed text-muted-foreground">— {r}</li>)}
            </ul>
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2">
          {s.armed && (
            <Button variant="outline" onClick={() => disarm.mutate()} disabled={disarm.isPending}>Switch off for today</Button>
          )}
          {cfg?.kill_switch || cfg?.halted_reason ? (
            <Button variant="outline" onClick={() => { if (window.confirm('Clear the emergency stop? Nothing will be traded until you switch on again.')) reset.mutate(); }} disabled={reset.isPending}>
              Clear emergency stop
            </Button>
          ) : (
            <Button
              variant="destructive"
              onClick={() => { if (window.confirm('EMERGENCY STOP: cancel every waiting order and sell every open trade right now?')) kill.mutate(); }}
              disabled={kill.isPending}
            >
              <ShieldAlert className="h-3.5 w-3.5" aria-hidden /> Emergency stop — sell everything
            </Button>
          )}
          <span className="text-2xs text-muted-foreground">
            &ldquo;Ask me first&rdquo;: an &ldquo;Execute live&rdquo; button appears on a good trade on the{' '}
            <Link to="/fno" className="text-primary hover:underline">F&amp;O page</Link>. &ldquo;Automatic&rdquo;: it places the trade itself. Either way it checks every open trade every 15 seconds and sells by the plan.
          </span>
        </div>
        {kill.data && <Alert variant="warning">{kill.data.cancelled} waiting order(s) cancelled, {kill.data.exits} open trade(s) being sold now.</Alert>}
      </CardContent>
    </Card>
  );
}

// ── live marks ──────────────────────────────────────────────────────────────

function SubscribeTicks({ trades }: { trades: LiveTradeDto[] }) {
  const subscribe = useTicks((s) => s.subscribe);
  const unsubscribe = useTicks((s) => s.unsubscribe);
  const key = trades.map((t) => `${t.exchange}:${t.tradingsymbol}`).sort().join(',');
  useEffect(() => {
    const symbols = key ? key.split(',') : [];
    if (symbols.length === 0) return;
    subscribe(symbols);
    return () => unsubscribe(symbols);
  }, [key, subscribe, unsubscribe]);
  return null;
}

/** Streaming tick first, then the exit manager's last mark (≤ 15 s old). */
function useLiveMark() {
  const ticks = useTicks((s) => s.ticks);
  const feedState = useTicks((s) => s.feedState);
  return (t: LiveTradeDto): { ltp: number | null; live: boolean } => {
    const tick = feedState === 'connected' ? ticks[`${t.exchange}:${t.tradingsymbol}`] : undefined;
    if (tick) return { ltp: tick.ltp, live: true };
    if (t.last_premium !== null) return { ltp: Number(t.last_premium), live: false };
    return { ltp: null, live: false };
  };
}

function OpenPnlStrip({ trades }: { trades: LiveTradeDto[] }) {
  const mark = useLiveMark();
  let gross = 0;
  let outlay = 0;
  let marked = 0;
  for (const t of trades) {
    if (t.status !== 'OPEN' || t.entry_price === null) continue;
    const m = mark(t);
    const entry = Number(t.entry_price);
    outlay += entry * t.remaining_qty;
    if (m.ltp === null) continue;
    marked += 1;
    gross += (m.ltp - entry) * t.remaining_qty;
  }
  const pct = outlay > 0 ? (gross / outlay) * 100 : null;
  return (
    <Card>
      <CardContent className="flex flex-wrap items-center justify-between gap-4 pt-4">
        <div>
          <div className="text-2xs uppercase tracking-wide text-muted-foreground">Profit / loss on open trades, live</div>
          <div className={cn('tabular text-2xl font-semibold', pnlClass(gross))}>
            {marked === 0 ? '—' : `${gross >= 0 ? '+' : ''}${inr(gross)}`}
            {pct !== null && marked > 0 && <span className="ml-2 text-sm font-normal">({pct >= 0 ? '+' : ''}{pct.toFixed(1)}%)</span>}
          </div>
        </div>
        <div className="flex gap-5">
          <Metric label="Open trades" value={trades.length} />
          <Metric label="Money in trades" value={inr(outlay)} />
          <Metric label="With a live price" value={`${marked}/${trades.filter((t) => t.status === 'OPEN').length}`} />
        </div>
        <p className="w-full text-2xs leading-relaxed text-muted-foreground">
          Before selling charges. Finished trades show the final figure after all charges.
        </p>
      </CardContent>
    </Card>
  );
}

// ── table ───────────────────────────────────────────────────────────────────

const STATUS_BADGE: Record<LiveTradeDto['status'], { label: string; variant: 'up' | 'down' | 'warning' | 'outline' | 'muted' }> = {
  PENDING: { label: 'Order placed, waiting to buy', variant: 'warning' },
  OPEN: { label: 'Holding', variant: 'up' },
  EXITING: { label: 'Selling', variant: 'warning' },
  CLOSED: { label: 'Finished', variant: 'outline' },
  FAILED: { label: 'Did not go through', variant: 'muted' },
};

function TradeTable({ trades, onClose, closing }: {
  trades: LiveTradeDto[]; onClose: (id: string, pending: boolean) => void; closing: boolean;
}) {
  const isOpen = trades[0]?.status !== 'CLOSED' && trades[0]?.status !== 'FAILED';
  const mark = useLiveMark();
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border text-2xs uppercase tracking-wide text-muted-foreground">
            <th className="px-4 py-2 text-left font-medium">Option bought</th>
            <th className="px-4 py-2 text-right font-medium">Qty</th>
            <th className="px-4 py-2 text-right font-medium">Bought at</th>
            {isOpen && <th className="px-4 py-2 text-right font-medium">Price now</th>}
            {isOpen && <th className="px-4 py-2 text-right font-medium">Profit / loss</th>}
            <th className="px-4 py-2 text-right font-medium">Sell if it drops to</th>
            <th className="px-4 py-2 text-right font-medium">Aiming for</th>
            {isOpen ? (
              <>
                <th className="px-4 py-2 text-left font-medium">How close to the aim</th>
                <th className="px-4 py-2 text-right font-medium" />
              </>
            ) : (
              <>
                <th className="px-4 py-2 text-right font-medium">Sold at</th>
                <th className="px-4 py-2 text-left font-medium">Reason</th>
                <th className="px-4 py-2 text-right font-medium">Charges</th>
                <th className="px-4 py-2 text-right font-medium">Final profit / loss</th>
              </>
            )}
          </tr>
        </thead>
        <tbody>
          {trades.map((t) => {
            const entry = t.entry_price === null ? null : Number(t.entry_price);
            const stop = t.t1_done && entry !== null ? Math.max(Number(t.stop_premium), entry) : Number(t.stop_premium);
            const target = t.t1_done ? Number(t.target2_premium) : Number(t.target1_premium);
            const m = isOpen && t.status === 'OPEN' ? mark(t) : { ltp: null, live: false };
            const gross = m.ltp === null || entry === null ? null : (m.ltp - entry) * t.remaining_qty;
            const pct = m.ltp === null || entry === null ? null : ((m.ltp - entry) / entry) * 100;
            const pos = m.ltp !== null && target > stop ? Math.max(0, Math.min(1, (m.ltp - stop) / (target - stop))) : null;
            const entryPos = entry !== null && target > stop ? (entry - stop) / (target - stop) : null;
            const net = t.net_pnl === null ? null : Number(t.net_pnl);
            const lastExit = t.exits[t.exits.length - 1];
            const badge = STATUS_BADGE[t.status];
            return (
              <tr key={t.id} className={cn('border-b border-border/50 last:border-0 border-l-4', rowTone(isOpen ? gross : net))}>
                <td className="px-4 py-2">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="font-mono">{t.tradingsymbol}</span>
                    <Badge variant={badge.variant}>{badge.label}</Badge>
                    {t.strategy === 'HERO_ZERO' && <Badge variant="warning"><Zap className="mr-0.5 inline h-3 w-3" aria-hidden />Hero Zero</Badge>}
                    {t.t1_done && <Badge variant="up">Half profit taken</Badge>}
                  </div>
                  <div className="text-2xs text-muted-foreground">
                    {new Date(t.created_at).toLocaleString('en-IN')} · {t.strategy === 'HERO_ZERO' ? `${t.score} conditions agreed` : `grade ${t.grade}`} · {t.mode} · {t.product}
                    {t.failure_reason && <> · {t.failure_reason}</>}
                  </div>
                </td>
                <td className="px-4 py-2 text-right font-mono">{t.status === 'OPEN' ? t.remaining_qty : t.quantity}</td>
                <td className="px-4 py-2 text-right font-mono">{t.status === 'PENDING' ? <>{inr(t.entry_limit, 2)}<div className="text-2xs text-muted-foreground">will pay up to</div></> : inr(t.entry_price, 2)}</td>
                {isOpen && (
                  <td className="px-4 py-2 text-right font-mono">
                    {m.ltp === null ? <span className="text-muted-foreground">{t.status === 'OPEN' ? 'no price yet' : '—'}</span>
                      : <span className={cn(m.live && 'text-live')} title={m.live ? 'Live price' : 'Last checked price, up to 15 seconds old'}>{inr(m.ltp, 2)}</span>}
                  </td>
                )}
                {isOpen && (
                  <td className={cn('px-4 py-2 text-right font-mono', pnlClass(gross))}>
                    {gross === null ? '—' : <>{gross >= 0 ? '+' : ''}{inr(gross)}<div className="text-2xs">{pct !== null && `${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%`}</div></>}
                  </td>
                )}
                <td className="px-4 py-2 text-right font-mono">{inr(stop, 2)}<div className="text-2xs text-muted-foreground">or if {t.underlying} crosses {Number(t.underlying_stop).toFixed(0)}</div></td>
                <td className="px-4 py-2 text-right font-mono">{inr(target, 2)}<div className="text-2xs text-muted-foreground">{t.t1_done ? 'second aim' : `first aim · then ${inr(t.target2_premium, 2)}`}</div></td>
                {isOpen ? (
                  <>
                    <td className="px-4 py-2">
                      <div className="relative h-1.5 w-32 overflow-hidden rounded bg-muted">
                        {pos !== null && <div className={cn('absolute inset-y-0 left-0 rounded', gross !== null && gross >= 0 ? 'bg-bull' : 'bg-bear')} style={{ width: `${pos * 100}%` }} />}
                        {entryPos !== null && <div className="absolute inset-y-0 w-px bg-foreground/60" style={{ left: `${Math.max(0, Math.min(100, entryPos * 100))}%` }} aria-hidden />}
                      </div>
                      <div className="mt-0.5 text-2xs text-muted-foreground">
                        {t.status === 'EXITING' ? `selling now (${(t.exit_code ?? '').toLowerCase().replace(/_/g, ' ')})` : pos === null ? '—' : `${(pos * 100).toFixed(0)}% of the way from the sell point to the aim`}
                      </div>
                    </td>
                    <td className="px-4 py-2 text-right">
                      {(t.status === 'OPEN' || t.status === 'PENDING') && (
                        <Button variant="ghost" onClick={() => onClose(t.id, t.status === 'PENDING')} disabled={closing} className="h-7 text-xs">
                          {t.status === 'PENDING' ? 'Cancel order' : 'Sell now'}
                        </Button>
                      )}
                    </td>
                  </>
                ) : (
                  <>
                    <td className="px-4 py-2 text-right font-mono">{lastExit ? inr(lastExit.price, 2) : '—'}</td>
                    <td className="px-4 py-2">
                      <Badge variant={t.exit_code === 'TARGET1' || t.exit_code === 'TARGET2' ? 'up' : 'outline'}>
                        {(lastExit?.code ?? t.exit_code ?? t.status).toLowerCase().replace(/_/g, ' ')}
                      </Badge>
                      {t.exits.length > 1 && <div className="text-2xs text-muted-foreground">sold in {t.exits.length} parts</div>}
                    </td>
                    <td className="px-4 py-2 text-right font-mono text-muted-foreground">{inr(t.costs, 2)}</td>
                    <td className={cn('px-4 py-2 text-right font-mono', pnlClass(net))}>{inr(net, 2)}</td>
                  </>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ── settings ────────────────────────────────────────────────────────────────

/**
 * Top-level on purpose. Defined inside the card it would be a new component
 * type on every render, so React would unmount and remount the input on
 * each keystroke and the cursor would leave the field.
 */
function Field({ label, value, onChange, type = 'text', placeholder, help }: {
  label: string; value: string; onChange: (v: string) => void; type?: string; placeholder?: string; help?: string;
}) {
  const id = `live-${label.replace(/\W+/g, '-').toLowerCase()}`;
  return (
    <div className="space-y-1">
      <Label htmlFor={id}>{label}</Label>
      <Input id={id} type={type} inputMode={type === 'text' ? 'decimal' : undefined} value={value} onChange={(e) => onChange(e.target.value)} {...(placeholder ? { placeholder } : {})} />
      {help && <p className="text-2xs leading-relaxed text-muted-foreground">{help}</p>}
    </div>
  );
}

/**
 * The real account balance, read-only. Every figure is the broker's own
 * number; nothing is typed in and nothing is remembered between reads.
 */
function BrokerBalance({ funds, loading, error, onRefresh, refreshing }: {
  funds: LiveFundsDto | null; loading: boolean; error: unknown; onRefresh: () => void; refreshing: boolean;
}) {
  return (
    <div className="rounded border border-border bg-muted/30 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <div className="text-2xs uppercase tracking-wide text-muted-foreground">
            Money in your {funds?.broker ?? 'broker'} account{funds ? ` · read ${relativeTime(funds.fetchedAt)}` : ''}
          </div>
          {loading ? (
            <Skeleton className="mt-1 h-8 w-40" />
          ) : funds ? (
            <div className="tabular text-2xl font-semibold">{inr(funds.availableCash)} <span className="text-sm font-normal text-muted-foreground">available to trade</span></div>
          ) : (
            <div className="mt-1 text-sm text-destructive">{error instanceof Error ? error.message : 'Could not read your balance from the broker.'}</div>
          )}
        </div>
        <Button variant="outline" onClick={onRefresh} disabled={refreshing} className="h-8 text-xs">
          <RefreshCw className={cn('h-3.5 w-3.5', refreshing && 'animate-spin')} aria-hidden /> Read again
        </Button>
      </div>
      {funds && (
        <div className="mt-3 flex flex-wrap gap-5">
          <Metric label="Account total" value={inr(funds.net)} />
          <Metric label="Blocked in open trades" value={inr(funds.utilised)} />
          <Metric label="Collateral" value={inr(funds.collateral)} />
          <Metric label="Today, unrealised" value={inr(funds.m2mUnrealised)} className={pnlClass(funds.m2mUnrealised)} />
          <Metric label="Today, realised" value={inr(funds.m2mRealised)} className={pnlClass(funds.m2mRealised)} />
        </div>
      )}
      <p className="mt-2 text-2xs leading-relaxed text-muted-foreground">
        This is read from your broker and cannot be edited here. Trades are sized from the available amount, refreshed every 30 seconds and again just before each order.
      </p>
    </div>
  );
}

function SettingsCard({ status: s, onSaved }: { status: LiveStatusDto; onSaved: () => void }) {
  const c: LiveConfigDto | null = s.config;
  const [mode, setMode] = useState<LiveMode>(c?.mode ?? 'OFF');
  const [risk, setRisk] = useState(c ? String(Number(c.risk_per_trade_pct)) : '1');
  const [maxLots, setMaxLots] = useState(String(c?.max_lots_per_trade ?? 1));
  const [maxOpen, setMaxOpen] = useState(String(c?.max_open_positions ?? 1));
  const [maxDay, setMaxDay] = useState(String(c?.max_trades_per_day ?? 3));
  const [lossCap, setLossCap] = useState(c ? String(Number(c.max_daily_loss_pct)) : '2');
  const [timeout, setTimeoutSec] = useState(String(c?.entry_timeout_sec ?? 90));
  const [windowStart, setWindowStart] = useState(toHHMM(c?.window_start_min ?? 570));
  const [windowEnd, setWindowEnd] = useState(toHHMM(c?.window_end_min ?? 900));
  const [squareOff, setSquareOff] = useState(toHHMM(c?.square_off_min ?? 915));
  const [minGrade, setMinGrade] = useState<'A' | 'B' | 'C'>(c?.min_grade ?? 'B');
  const [product, setProduct] = useState<'INTRADAY' | 'CARRYFORWARD'>(c?.product ?? 'INTRADAY');
  const [underlyings, setUnderlyings] = useState((c?.underlyings ?? ['NIFTY']).join(', '));
  const [scaleOut, setScaleOut] = useState(c?.scale_out ?? true);
  const [allowExpiry, setAllowExpiry] = useState(c?.allow_expiry_day ?? false);
  const [horizon, setHorizon] = useState<'intraday' | 'swing'>(c?.horizon ?? 'intraday');
  const [guard, setGuard] = useState(c?.direction_guard ?? true);
  const [timingGates, setTimingGates] = useState(c?.require_timing_agreement ?? true);
  const [namedSetup, setNamedSetup] = useState(c?.require_named_setup ?? false);
  const [cooldown, setCooldown] = useState(String(c?.reentry_cooldown_min ?? 30));
  const [cutLoser, setCutLoser] = useState(c ? String(Number(c.cut_loser_at_r)) : '0.5');
  const [stopAtr, setStopAtr] = useState(c ? String(Number(c.stop_atr_multiple)) : '1');
  const [t1, setT1] = useState(c ? String(Number(c.target1_r)) : '1');
  const [t2, setT2] = useState(c ? String(Number(c.target2_r)) : '1.5');

  const save = useMutation({
    mutationFn: () => api.live.saveConfig({
      mode, riskPerTradePct: Number(risk), maxLotsPerTrade: Number(maxLots), maxOpenPositions: Number(maxOpen),
      maxTradesPerDay: Number(maxDay), maxDailyLossPct: Number(lossCap), entryTimeoutSec: Number(timeout),
      windowStartMin: fromHHMM(windowStart), windowEndMin: fromHHMM(windowEnd), squareOffMin: fromHHMM(squareOff),
      minGrade, product, scaleOut, allowExpiryDay: allowExpiry, horizon, directionGuard: guard,
      requireTimingAgreement: timingGates, requireNamedSetup: namedSetup, reentryCooldownMin: Number(cooldown),
      cutLoserAtR: Number(cutLoser), stopAtrMultiple: Number(stopAtr), target1R: Number(t1), target2R: Number(t2),
      underlyings: underlyings.split(',').map((u) => u.trim().toUpperCase()).filter(Boolean),
    }),
    onSuccess: onSaved,
  });
  const arm = useMutation({
    mutationFn: async () => { await save.mutateAsync(); return api.live.arm(); },
    onSuccess: onSaved,
  });
  const funds = useQuery({ queryKey: ['live', 'funds'], queryFn: api.live.funds, refetchInterval: 30_000, retry: 1 });
  const available = funds.data?.availableCash ?? null;
  const canArm = mode !== 'OFF' && available !== null && available > 0;
  const err = arm.error ?? save.error;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          My limits and settings
          <Badge variant={s.armed ? 'up' : 'outline'}>{s.armed ? (c?.mode === 'AUTO' ? 'On · Automatic' : 'On · Ask me first') : c?.mode && c.mode !== 'OFF' ? 'Not switched on today' : 'Off'}</Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <BrokerBalance funds={funds.data ?? null} loading={funds.isLoading} error={funds.error} onRefresh={() => void funds.refetch()} refreshing={funds.isFetching} />
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
          <div className="space-y-1">
            <Label htmlFor="live-mode">How should it trade?</Label>
            <Select id="live-mode" value={mode} onChange={(e) => setMode(e.target.value as LiveMode)}>
              <option value="OFF">Off — never place real orders</option>
              <option value="CONFIRM">Ask me first — show me the trade, I click to place it</option>
              <option value="AUTO">Automatic — place trades for me within my limits</option>
            </Select>
          </div>
          <Field label="Most I can lose on one trade (%)" value={risk} onChange={setRisk} help={`As a share of the money above. Real money: up to ${RISK_LIMITS.live.riskPerTradePct.max}%.`} />
          <Field label="Most lots in one trade" value={maxLots} onChange={setMaxLots} />
          <Field label="Most trades held at once" value={maxOpen} onChange={setMaxOpen} />
          <Field label="Most trades in a day" value={maxDay} onChange={setMaxDay} />
          <Field label="Stop for the day after losing (%)" value={lossCap} onChange={setLossCap} help={`Counted on finished trades, after charges. Once reached, no more trades today. Up to ${RISK_LIMITS.live.dailyLossPct.max}%.`} />
          <Field label="Cancel a buy if not filled within (seconds)" value={timeout} onChange={setTimeoutSec} help="So it never buys at a worse price than the plan." />
          <Field label="Only start new trades after" type="time" value={windowStart} onChange={setWindowStart} />
          <Field label="No new trades after" type="time" value={windowEnd} onChange={setWindowEnd} />
          <Field label="Sell everything by (same-day trades)" type="time" value={squareOff} onChange={setSquareOff} />
          <div className="space-y-1">
            <Label htmlFor="live-grade">Only take trades graded</Label>
            <Select id="live-grade" value={minGrade} onChange={(e) => setMinGrade(e.target.value as 'A' | 'B' | 'C')}>
              <option value="A">A — only the very best setups</option><option value="B">A or B</option><option value="C">A, B or C (not advised)</option>
            </Select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="live-product">How long can it hold a trade?</Label>
            <Select id="live-product" value={product} onChange={(e) => setProduct(e.target.value as 'INTRADAY' | 'CARRYFORWARD')}>
              <option value="INTRADAY">Same day only — everything sold before the close</option>
              <option value="CARRYFORWARD">Can hold overnight</option>
            </Select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="live-horizon">Which charts decide</Label>
            <Select id="live-horizon" value={horizon} onChange={(e) => setHorizon(e.target.value as 'intraday' | 'swing')}>
              <option value="intraday">Intraday — hourly direction, 15-minute timing, flat by close</option>
              <option value="swing">Swing — daily direction, can hold for days</option>
            </Select>
          </div>
          <div className="col-span-2 space-y-1">
            <Label htmlFor="live-underlyings">Which indices to trade</Label>
            <Input id="live-underlyings" value={underlyings} onChange={(e) => setUnderlyings(e.target.value)} placeholder="NIFTY, BANKNIFTY" />
          </div>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={scaleOut} onChange={(e) => setScaleOut(e.target.checked)} /> Take half the profit at the first aim and let the rest run to the second (needs 2 or more lots)</label>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={allowExpiry} onChange={(e) => setAllowExpiry(e.target.checked)} /> Allow new trades on expiry day (risky)</label>
          <label className="col-span-2 flex items-center gap-2 text-sm"><input type="checkbox" checked={guard} onChange={(e) => setGuard(e.target.checked)} /> Sell on its own when the chart turns against the trade, and move the stop to breakeven halfway to the aim (direction guard)</label>
          <Field label="Cooldown after an exit (minutes)" value={cooldown} onChange={setCooldown} help="No re-entry on that index for this long. 0 = off." />
          <Field label="Cut a loser at (× risk)" value={cutLoser} onChange={setCutLoser} help="Sell once down this much and one reading has turned. 0 = off." />
          <Field label="Stop distance (× hourly range)" value={stopAtr} onChange={setStopAtr} help="1.0 keeps lots sized to real risk." />
          <Field label="First aim (× risk)" value={t1} onChange={setT1} />
          <Field label="Second aim (× risk)" value={t2} onChange={setT2} />
          <label className="col-span-2 flex items-center gap-2 text-sm"><input type="checkbox" checked={timingGates} onChange={(e) => setTimingGates(e.target.checked)} /> Require the 15-minute chart to agree before entering (score, supertrend, VWAP)</label>
          <label className="col-span-2 flex items-center gap-2 text-sm"><input type="checkbox" checked={namedSetup} onChange={(e) => setNamedSetup(e.target.checked)} /> Require a named chart pattern on the direction chart (blocks most trades)</label>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <Button
            onClick={() => {
              if (window.confirm(`Switch on real money trading until 3:30 pm today? Your ${funds.data?.broker ?? 'broker'} account shows ₹${(available ?? 0).toLocaleString('en-IN')} available, and trades will be sized from that inside these limits. Real orders will be placed.`)) arm.mutate();
            }}
            disabled={!canArm || arm.isPending}
          >
            <Power className="h-3.5 w-3.5" aria-hidden /> {s.armed ? 'Save and keep trading' : 'Save and switch on for today'}
          </Button>
          <Button variant="outline" onClick={() => save.mutate()} disabled={save.isPending}>Save settings only</Button>
          {!canArm && <span className="text-sm text-muted-foreground">{mode === 'OFF' ? 'Choose “Ask me first” or “Automatic” to switch on.' : funds.isLoading ? 'Reading your account balance…' : 'Cannot switch on without an available balance from your broker.'}</span>}
          {save.isSuccess && !arm.isPending && <span className="text-sm text-muted-foreground">Saved.</span>}
          {err && <span className="text-sm text-destructive">{err instanceof Error ? err.message : 'Could not save.'}</span>}
        </div>

        <p className="text-2xs leading-relaxed text-muted-foreground">
          The money to trade with is never typed in: it is your broker's available cash, read when you switch on and again before
          every trade. It switches itself off at 3:30 pm every day, so you decide fresh each morning. It buys at the planned price or not at all,
          and checks every open trade every 15 seconds: it sells if the price drops to the sell point, if the market turns against
          the idea, at the sell-everything time, or when the aim is reached. The daily loss limit stops it for the day; the
          emergency stop sells everything at once.
        </p>
      </CardContent>
    </Card>
  );
}

// ── hero zero ───────────────────────────────────────────────────────────────

const STANCE_BADGE: Record<HeroZeroDecisionDto['stance'], { label: string; variant: 'up' | 'warning' | 'muted' }> = {
  ENTER: { label: 'Conditions met', variant: 'up' },
  WAIT: { label: 'Watching', variant: 'warning' },
  AVOID: { label: 'Not today', variant: 'muted' },
};

function FactorIcon({ status }: { status: 'AGREE' | 'AGAINST' | 'UNREADABLE' }) {
  if (status === 'AGREE') return <Check className="h-3.5 w-3.5 shrink-0 text-bull" aria-label="agrees" />;
  if (status === 'AGAINST') return <X className="h-3.5 w-3.5 shrink-0 text-bear" aria-label="against" />;
  return <Minus className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-label="unreadable" />;
}

function HeroZeroDecision({ d, canPlace, mode, onPlace, placing }: {
  d: HeroZeroDecisionDto; canPlace: boolean; mode: LiveMode; onPlace: () => void; placing: boolean;
}) {
  const st = STANCE_BADGE[d.stance];
  const c = d.candidate;
  return (
    <div className={cn('rounded border border-border border-l-4 p-3', d.stance === 'ENTER' ? 'border-l-up bg-up/5' : d.stance === 'WAIT' ? 'border-l-delayed' : 'border-l-border')}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-sm font-medium">{d.underlying}</span>
          <Badge variant={st.variant}>{st.label}</Badge>
          {d.side && <Badge variant="outline">{d.side === 'BUY_CALL' ? 'Calls' : 'Puts'}</Badge>}
          <span className="text-2xs text-muted-foreground">expiry {d.expiry}{d.daysToExpiry === 0 ? ' (today)' : ` · in ${d.daysToExpiry} day(s)`} · {d.agreeing} of {d.readable} conditions agree</span>
        </div>
        {d.stance === 'ENTER' && c && (
          mode === 'AUTO' && canPlace ? (
            <span className="text-2xs text-muted-foreground">Automatic mode places this itself on its next check.</span>
          ) : (
            <Button onClick={onPlace} disabled={!canPlace || placing} className="h-8 text-xs">
              <Zap className="h-3.5 w-3.5" aria-hidden /> {placing ? 'Placing…' : `Place Hero Zero: ${c.lots} lot(s) ${c.strike} ${c.optionType}`}
            </Button>
          )
        )}
      </div>
      <p className="mt-1 text-sm leading-relaxed">{d.summary}</p>

      {c && (
        <div className="mt-2 grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-8">
          <Metric label="Option" value={`${c.strike} ${c.optionType}`} />
          <Metric label="Price now" value={inr(c.premium, 2)} />
          <Metric label="Will pay up to" value={inr(c.limit, 2)} />
          <Metric label="Lots" value={`${c.lots} × ${c.lotSize}`} />
          <Metric label="Money at risk" value={inr(c.outlay)} />
          <Metric label="Give up at" value={inr(c.stopPremium, 2)} />
          <Metric label="First aim" value={inr(c.target1Premium, 2)} />
          <Metric label="Second aim" value={inr(c.target2Premium, 2)} />
        </div>
      )}
      {!c && d.side && d.candidateNote && <p className="mt-1 text-2xs text-muted-foreground">{d.candidateNote}</p>}

      <details className="mt-2">
        <summary className="cursor-pointer text-2xs uppercase tracking-wide text-muted-foreground">What it checked</summary>
        <ul className="mt-1.5 space-y-1">
          {d.gates.map((g) => (
            <li key={g.code} className="flex items-start gap-1.5 text-xs">
              <FactorIcon status={g.ok ? 'AGREE' : 'AGAINST'} /><span className="text-muted-foreground">{g.detail}</span>
            </li>
          ))}
          {d.factors.map((f) => (
            <li key={f.code} className="flex items-start gap-1.5 text-xs">
              <FactorIcon status={f.status} />
              <span><span className="font-medium">{f.label}.</span> <span className="text-muted-foreground">{f.detail}</span></span>
            </li>
          ))}
        </ul>
      </details>
    </div>
  );
}

/**
 * Hero Zero — the expiry-day cheap-option trade, as its own section with its
 * own budget and rules. Kept apart from the main settings on purpose: this
 * money is expected to go to zero most of the time, and the card says so.
 */
function HeroZeroCard({ status: s, onChanged }: { status: LiveStatusDto; onChanged: () => void }) {
  const c = s.config;
  const [enabled, setEnabled] = useState(c?.hero_zero_enabled ?? false);
  const [budget, setBudget] = useState(c ? String(Number(c.hero_zero_budget)) : '2000');
  const [minPrem, setMinPrem] = useState(c ? String(Number(c.hero_zero_min_premium)) : '3');
  const [maxPrem, setMaxPrem] = useState(c ? String(Number(c.hero_zero_max_premium)) : '25');
  const [maxLots, setMaxLots] = useState(String(c?.hero_zero_max_lots ?? 2));
  const [maxDay, setMaxDay] = useState(String(c?.hero_zero_max_trades_per_day ?? 1));
  const [wStart, setWStart] = useState(toHHMM(c?.hero_zero_window_start_min ?? 750));
  const [wEnd, setWEnd] = useState(toHHMM(c?.hero_zero_window_end_min ?? 900));
  const [sqOff, setSqOff] = useState(toHHMM(c?.hero_zero_square_off_min ?? 920));
  const [stopPct, setStopPct] = useState(c ? String(Number(c.hero_zero_stop_pct)) : '50');
  const [mult, setMult] = useState(c ? String(Number(c.hero_zero_target_multiple)) : '3');
  const [minAgree, setMinAgree] = useState(String(c?.hero_zero_min_agree ?? 5));

  const scan = useQuery({ queryKey: ['live', 'hero-zero'], queryFn: api.live.heroZero, refetchInterval: 60_000, enabled: c !== null, retry: 1 });
  const refresh = () => { onChanged(); void scan.refetch(); };
  const save = useMutation({
    mutationFn: () => api.live.saveConfig({
      heroZeroEnabled: enabled, heroZeroBudget: Number(budget), heroZeroMinPremium: Number(minPrem), heroZeroMaxPremium: Number(maxPrem),
      heroZeroMaxLots: Number(maxLots), heroZeroMaxTradesPerDay: Number(maxDay),
      heroZeroWindowStartMin: fromHHMM(wStart), heroZeroWindowEndMin: fromHHMM(wEnd), heroZeroSquareOffMin: fromHHMM(sqOff),
      heroZeroStopPct: Number(stopPct), heroZeroTargetMultiple: Number(mult), heroZeroMinAgree: Number(minAgree),
    }),
    onSuccess: refresh,
  });
  const exec = useMutation({ mutationFn: (underlying: string) => api.live.executeHeroZero(underlying), onSuccess: refresh });

  const live = c?.hero_zero_enabled ?? false;
  const canPlace = live && s.armed && s.blockers.length === 0 && (scan.data?.attemptsToday ?? 0) < (c?.hero_zero_max_trades_per_day ?? 1);
  const err = save.error ?? exec.error;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          <Zap className="h-4 w-4" aria-hidden /> Hero Zero — expiry-day trade
          <Badge variant={live ? (s.armed ? 'warning' : 'outline') : 'muted'}>{live ? (s.armed ? 'On' : 'On, but not switched on for today') : 'Off'}</Badge>
          {scan.data && <Badge variant="outline">{scan.data.attemptsToday} of {c?.hero_zero_max_trades_per_day ?? 1} attempt(s) used today</Badge>}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <Alert variant="warning" title="What this trade is">
          On the afternoon of expiry day, when the market is already moving one way, it buys a very cheap out-of-the-money option for a
          fixed budget. If the move keeps going the price can multiply; if not, the option goes to zero. Most attempts go to zero. The
          budget below is the amount you are prepared to lose in full on one attempt. The conditions describe the day; they do not predict it.
        </Alert>

        <label className="flex items-center gap-2 text-sm font-medium">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /> Allow Hero Zero trades
        </label>

        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
          <Field label="Budget per attempt (₹)" value={budget} onChange={setBudget} help="All of it is at risk. Lots are sized from it." />
          <Field label="Attempts per day" value={maxDay} onChange={setMaxDay} />
          <Field label="Most lots per attempt" value={maxLots} onChange={setMaxLots} />
          <Field label="Cheapest option to buy (₹)" value={minPrem} onChange={setMinPrem} help="Below this the option is usually dead." />
          <Field label="Dearest option to buy (₹)" value={maxPrem} onChange={setMaxPrem} help="Above this it is no longer a cheap lottery." />
          <Field label="Look for it after" type="time" value={wStart} onChange={setWStart} />
          <Field label="Stop looking after" type="time" value={wEnd} onChange={setWEnd} />
          <Field label="Sell by" type="time" value={sqOff} onChange={setSqOff} help="Whatever is left is sold at this time." />
          <Field label="Give up if the price falls (%)" value={stopPct} onChange={setStopPct} help="0 means hold it to the end, even to zero." />
          <Field label="Aim: multiply the price by" value={mult} onChange={setMult} help="Half is sold halfway there, the rest here." />
          <Field label="Conditions that must agree (of 7)" value={minAgree} onChange={setMinAgree} help="Lower means more attempts, more zeros." />
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <Button variant="outline" onClick={() => save.mutate()} disabled={save.isPending}>Save Hero Zero settings</Button>
          {save.isSuccess && <span className="text-sm text-muted-foreground">Saved.</span>}
          {err && <span className="text-sm text-destructive">{err instanceof Error ? err.message : 'Could not save.'}</span>}
          {exec.data?.placed && <span className="text-sm text-bull">Order placed (trade #{exec.data.tradeId}). It appears in the table below.</span>}
        </div>

        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <p className="text-2xs font-medium uppercase tracking-wide text-muted-foreground">Today's read, per index</p>
            <Button variant="ghost" onClick={() => void scan.refetch()} disabled={scan.isFetching} className="h-7 text-xs">
              <RefreshCw className={cn('h-3 w-3', scan.isFetching && 'animate-spin')} aria-hidden /> Check again
            </Button>
          </div>
          {!c ? (
            <p className="text-sm text-muted-foreground">Save the main settings above first.</p>
          ) : scan.isLoading ? (
            <Skeleton className="h-24" />
          ) : scan.error ? (
            <Alert variant="error">{scan.error instanceof Error ? scan.error.message : 'Could not read the market.'}</Alert>
          ) : (
            (scan.data?.results ?? []).map((r) =>
              r.decision ? (
                <HeroZeroDecision
                  key={r.underlying} d={r.decision} canPlace={canPlace} mode={c.mode} placing={exec.isPending}
                  onPlace={() => {
                    const cand = r.decision!.candidate!;
                    if (window.confirm(`Place a REAL Hero Zero order: buy ${cand.lots} lot(s) ${r.underlying} ${cand.strike} ${cand.optionType} for about ₹${cand.outlay.toFixed(0)}? Expect to lose all of it if the move stalls.`)) exec.mutate(r.underlying);
                  }}
                />
              ) : (
                <div key={r.underlying} className="rounded border border-border p-3 text-sm text-muted-foreground"><span className="font-mono">{r.underlying}</span>: {r.error}</div>
              ),
            )
          )}
          {c && live && !s.armed && <p className="text-2xs text-muted-foreground">Hero Zero only places orders while real money trading is switched on for the day (above).</p>}
        </div>
      </CardContent>
    </Card>
  );
}
