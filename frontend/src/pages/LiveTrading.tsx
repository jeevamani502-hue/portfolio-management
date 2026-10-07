/**
 * Live trading — real orders at the broker, from the decision engine's plan.
 *
 * The page is built so that nothing surprising can happen: the mode and
 * every cap are explicit settings, arming is a separate daily step with the
 * capital typed in, each live position shows the plan it is being managed
 * against, and the kill switch is one click and never hidden.
 */
import { useEffect, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { ShieldAlert, Power, RefreshCw } from 'lucide-react';
import { api } from '@/services/api';
import {
  Card, CardHeader, CardTitle, CardContent, Skeleton, Badge, Alert, EmptyState,
  Button, Input, Label, Select, Tabs,
} from '@/components/ui';
import { Metric } from '@/components/market/DataValue';
import { useTick, useTicks } from '@/services/ws';
import { relativeTime, istTime } from '@/lib/format';
import { cn } from '@/lib/utils';
import type { LiveConfigDto, LiveStatusDto, LiveTradeDto, LiveMode } from '@/types/api';

const inr = (v: number | string | null | undefined, dp = 2) => {
  const n = typeof v === 'string' ? Number(v) : v;
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  return `₹${n.toLocaleString('en-IN', { maximumFractionDigits: dp, minimumFractionDigits: dp })}`;
};
const pnlClass = (n: number | null) => (n === null ? '' : n > 0 ? 'text-bull' : n < 0 ? 'text-bear' : '');
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

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold">Live trading</h1>
          <p className="text-sm text-muted-foreground">
            Real orders at {s.broker ?? 'your broker'}, placed from the F&amp;O engine's graded plan and
            managed by the exit rules. Every order and every broker reply is kept on the trade.
          </p>
        </div>
        <Button variant="outline" onClick={() => sync.mutate()} disabled={sync.isPending}>
          <RefreshCw className={cn('h-3.5 w-3.5', sync.isPending && 'animate-spin')} aria-hidden />
          Sync with broker
        </Button>
      </div>

      <Alert variant="warning" title="This page moves real money">
        Nothing is placed until you choose a mode, set your caps, and arm for the session with the
        capital typed in. Arming expires at 15:30 IST every day. The engine's grade counts agreeing
        conditions — it is not a probability of profit — and its measured track record is on the
        F&amp;O page. Run Paper mode first.
      </Alert>

      <ArmPanel status={s} onChanged={invalidate} />

      {(trades.data ?? []).length > 0 || tab === 'CLOSED' ? null : null}

      <PositionsCard
        tab={tab}
        onTab={setTab}
        trades={trades.data ?? []}
        loading={trades.isLoading}
        onClose={(id) => { if (window.confirm('Send a market exit for this position now?')) close.mutate(id); }}
        closing={close.isPending}
        openCount={s.openPositions}
      />

      {perf.data && (
        <Card>
          <CardHeader><CardTitle>Results</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
              <Metric label="Net P&L (after costs)" value={inr(perf.data.netPnl)} className={pnlClass(perf.data.netPnl)} />
              <Metric label="Today" value={inr(perf.data.todayNet)} className={pnlClass(perf.data.todayNet)} />
              <Metric label="Gross" value={inr(perf.data.grossPnl)} />
              <Metric label="Costs paid" value={inr(perf.data.costs)} />
              <Metric label="Closed" value={perf.data.closed} />
              <Metric label="Win rate" value={perf.data.winRate === null ? '—' : `${perf.data.winRate.toFixed(0)}% (${perf.data.wins}/${perf.data.closed})`} />
            </div>
            <Alert variant="default" title="What these numbers do and do not show">{perf.data.caveat}</Alert>
          </CardContent>
        </Card>
      )}

      <CapsCard config={s.config} onSaved={invalidate} />
    </div>
  );
}

// ── arm / mode / kill ───────────────────────────────────────────────────────

function ArmPanel({ status: s, onChanged }: { status: LiveStatusDto; onChanged: () => void }) {
  const cfg = s.config;
  const [capital, setCapital] = useState(cfg?.capital ? String(Number(cfg.capital)) : '');
  const [mode, setMode] = useState<LiveMode>(cfg?.mode ?? 'OFF');
  useEffect(() => { if (cfg) setMode(cfg.mode); }, [cfg?.mode]); // eslint-disable-line react-hooks/exhaustive-deps

  const saveMode = useMutation({ mutationFn: (m: LiveMode) => api.live.saveConfig({ mode: m }), onSuccess: onChanged });
  const arm = useMutation({ mutationFn: (c: number) => api.live.arm(c), onSuccess: onChanged });
  const disarm = useMutation({ mutationFn: api.live.disarm, onSuccess: onChanged });
  const kill = useMutation({ mutationFn: api.live.kill, onSuccess: onChanged });
  const reset = useMutation({ mutationFn: api.live.resetKill, onSuccess: onChanged });

  const armedUntil = cfg?.armed_until ? istTime(cfg.armed_until, false) : null;
  const tone = cfg?.kill_switch || cfg?.halted_reason ? 'bg-destructive' : s.armed && s.blockers.length === 0 ? 'bg-bull animate-pulse-dot' : s.armed ? 'bg-delayed' : 'bg-muted-foreground';
  const err = (m: { error: unknown }) => (m.error instanceof Error ? m.error.message : null);

  return (
    <Card>
      <CardContent className="space-y-4 pt-5">
        <div className="flex items-start gap-2.5">
          <span className={cn('mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full', tone)} aria-hidden />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-base font-semibold">
                {cfg?.kill_switch ? 'Kill switch engaged' : s.armed ? `Armed · ${cfg?.mode}` : cfg?.mode && cfg.mode !== 'OFF' ? `${cfg.mode} · not armed` : 'Off'}
              </h2>
              <Badge variant="muted">{s.marketPhase}</Badge>
              {armedUntil && s.armed && <Badge variant="warning">until {armedUntil} IST</Badge>}
              {s.brokerReady ? <Badge variant="up">{s.broker}</Badge> : <Badge variant="warning">no broker</Badge>}
            </div>
            <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{s.headline}</p>
          </div>
          <dl className="flex gap-5 text-right">
            <div><dt className="text-2xs uppercase tracking-wide text-muted-foreground">Open</dt><dd className="font-mono text-sm">{s.openPositions}</dd></div>
            <div><dt className="text-2xs uppercase tracking-wide text-muted-foreground">Today</dt><dd className="font-mono text-sm">{s.tradesToday}</dd></div>
            <div><dt className="text-2xs uppercase tracking-wide text-muted-foreground">P&amp;L today</dt><dd className={cn('font-mono text-sm', pnlClass(s.netPnlToday))}>{inr(s.netPnlToday, 0)}</dd></div>
          </dl>
        </div>

        {s.blockers.length > 0 && (
          <ul className="space-y-1.5 rounded border border-border bg-muted/30 p-3">
            {s.blockers.map((b) => (
              <li key={b.code} className="text-sm leading-relaxed">
                {b.detail}{b.fix && <span className="text-muted-foreground"> {b.fix}</span>}
              </li>
            ))}
          </ul>
        )}

        <div className="grid gap-3 sm:grid-cols-[auto_auto_1fr] sm:items-end">
          <div className="space-y-1">
            <Label htmlFor="live-mode">Mode</Label>
            <Select id="live-mode" value={mode} onChange={(e) => { const m = e.target.value as LiveMode; setMode(m); saveMode.mutate(m); }}>
              <option value="OFF">Off — never place orders</option>
              <option value="CONFIRM">Confirm — I press Execute on each trade</option>
              <option value="AUTO">Auto — the worker places orders within my caps</option>
            </Select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="live-capital">Capital for today (₹)</Label>
            <Input id="live-capital" inputMode="numeric" placeholder="e.g. 40000" value={capital} onChange={(e) => setCapital(e.target.value)} className="w-40" />
          </div>
          <div className="flex flex-wrap gap-2">
            {!s.armed ? (
              <Button
                onClick={() => {
                  const c = Number(capital.replace(/[^0-9.]/g, ''));
                  if (!(c > 0)) return;
                  if (window.confirm(`Arm live trading in ${mode} mode with ₹${c.toLocaleString('en-IN')} as the capital base until 15:30 IST today? Real orders can then be placed within your caps.`)) arm.mutate(c);
                }}
                disabled={mode === 'OFF' || arm.isPending || !(Number(capital.replace(/[^0-9.]/g, '')) > 0)}
              >
                <Power className="h-3.5 w-3.5" aria-hidden /> Arm for today
              </Button>
            ) : (
              <Button variant="outline" onClick={() => disarm.mutate()} disabled={disarm.isPending}>Disarm</Button>
            )}
            {cfg?.kill_switch || cfg?.halted_reason ? (
              <Button variant="outline" onClick={() => { if (window.confirm('Reset the kill switch / halt? Nothing is placed until you arm again.')) reset.mutate(); }} disabled={reset.isPending}>
                Reset kill switch
              </Button>
            ) : (
              <Button
                variant="destructive"
                onClick={() => { if (window.confirm('KILL SWITCH: cancel every pending order and send every open position to market now?')) kill.mutate(); }}
                disabled={kill.isPending}
              >
                <ShieldAlert className="h-3.5 w-3.5" aria-hidden /> Kill switch
              </Button>
            )}
          </div>
        </div>
        {(err(arm) || err(saveMode) || err(kill)) && (
          <Alert variant="error">{err(arm) ?? err(saveMode) ?? err(kill)}</Alert>
        )}
        {kill.data && (
          <Alert variant="warning">{kill.data.cancelled} pending order(s) cancelled, {kill.data.exits} position(s) sent to market.</Alert>
        )}
        {cfg?.last_sweep_result && cfg.mode === 'AUTO' && (
          <p className="text-2xs leading-relaxed text-muted-foreground">
            Last auto sweep {cfg.last_sweep_at ? relativeTime(cfg.last_sweep_at) : '—'}: placed {cfg.last_sweep_result.placed ?? 0}.
            {(cfg.last_sweep_result.skipped ?? []).slice(0, 3).map((r) => <span key={r}> · {r}</span>)}
          </p>
        )}
        <p className="text-2xs leading-relaxed text-muted-foreground">
          Confirm mode: an &ldquo;Execute live&rdquo; button appears on an Enter-grade decision on the{' '}
          <Link to="/fno" className="text-primary hover:underline">F&amp;O page</Link>. Auto mode: the
          worker runs the checklist every minute on your underlyings. In both, exits are managed
          every 15 seconds: stop, invalidation, square-off, then targets.
        </p>
      </CardContent>
    </Card>
  );
}

// ── positions ───────────────────────────────────────────────────────────────

const STATUS_BADGE: Record<LiveTradeDto['status'], { label: string; variant: 'up' | 'down' | 'warning' | 'outline' | 'muted' }> = {
  PENDING: { label: 'Order pending', variant: 'warning' },
  OPEN: { label: 'Open', variant: 'up' },
  EXITING: { label: 'Exiting', variant: 'warning' },
  CLOSED: { label: 'Closed', variant: 'outline' },
  FAILED: { label: 'Failed', variant: 'muted' },
};

function PositionRow({ t, onClose, closing }: { t: LiveTradeDto; onClose: (id: string) => void; closing: boolean }) {
  const tickKey = `${t.exchange}:${t.tradingsymbol}`;
  const tick = useTick(tickKey);
  const subscribe = useTicks((s) => s.subscribe);
  const unsubscribe = useTicks((s) => s.unsubscribe);
  // The gateway forwards ticks only for symbols this browser asked for.
  useEffect(() => {
    subscribe([tickKey]);
    return () => unsubscribe([tickKey]);
  }, [tickKey, subscribe, unsubscribe]);
  const entry = t.entry_price ? Number(t.entry_price) : null;
  const ltp = tick?.ltp ?? (t.last_premium ? Number(t.last_premium) : null);
  const live = entry !== null && ltp !== null && t.status === 'OPEN' ? (ltp - entry) * t.remaining_qty : null;
  const net = t.net_pnl ? Number(t.net_pnl) : null;
  const badge = STATUS_BADGE[t.status];
  const stop = t.t1_done ? Math.max(Number(t.stop_premium), entry ?? 0) : Number(t.stop_premium);
  return (
    <div className="rounded-md border border-border p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-sm font-medium">{t.tradingsymbol}</span>
          <Badge variant={badge.variant}>{badge.label}</Badge>
          <Badge variant="outline">Grade {t.grade}</Badge>
          <Badge variant="muted">{t.mode} · {t.product}</Badge>
          {t.t1_done && <Badge variant="up">T1 booked</Badge>}
        </div>
        <div className="text-right">
          {t.status === 'OPEN' && live !== null ? (
            <div className={cn('font-mono text-sm', pnlClass(live))}>{inr(live, 0)} <span className="text-2xs text-muted-foreground">unrealised</span></div>
          ) : net !== null ? (
            <div className={cn('font-mono text-sm', pnlClass(net))}>{inr(net, 0)} <span className="text-2xs text-muted-foreground">net</span></div>
          ) : null}
          <div className="text-2xs text-muted-foreground">{relativeTime(t.created_at)}</div>
        </div>
      </div>
      <div className="mt-2 grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-7">
        <Metric label="Qty" value={`${t.remaining_qty || t.quantity} (${t.lots}×${t.lot_size})`} />
        <Metric label={t.status === 'PENDING' ? 'Limit' : 'Entry'} value={inr(t.status === 'PENDING' ? t.entry_limit : t.entry_price)} />
        <Metric label="LTP" value={inr(ltp)} valueClassName={tick ? 'text-live' : undefined} />
        <Metric label="Stop" value={inr(stop)} sub={`${t.underlying} ${Number(t.underlying_stop).toFixed(0)}`} />
        <Metric label="Target 1" value={inr(t.target1_premium)} />
        <Metric label="Target 2" value={inr(t.target2_premium)} />
        <div className="flex items-end">
          {(t.status === 'OPEN' || t.status === 'PENDING') && (
            <Button variant="outline" className="h-7 text-xs" onClick={() => onClose(t.id)} disabled={closing}>
              {t.status === 'PENDING' ? 'Cancel order' : 'Close at market'}
            </Button>
          )}
        </div>
      </div>
      {(t.failure_reason || t.exit_code || t.exits.length > 0) && (
        <p className="mt-2 text-2xs leading-relaxed text-muted-foreground">
          {t.failure_reason && <>Failed: {t.failure_reason}. </>}
          {t.exits.map((e) => <span key={e.at}>{e.code.toLowerCase().replace(/_/g, ' ')}: {e.qty} @ {inr(e.price)} ({istTime(e.at, false)} IST). </span>)}
          {t.status === 'EXITING' && t.exit_code && <>Exit order sent ({t.exit_code.toLowerCase().replace(/_/g, ' ')}) — waiting for the fill. </>}
        </p>
      )}
    </div>
  );
}

function PositionsCard({ tab, onTab, trades, loading, onClose, closing, openCount }: {
  tab: 'ACTIVE' | 'CLOSED'; onTab: (t: 'ACTIVE' | 'CLOSED') => void; trades: LiveTradeDto[];
  loading: boolean; onClose: (id: string) => void; closing: boolean; openCount: number;
}) {
  return (
    <div>
      <Tabs active={tab} onChange={(id) => onTab(id as 'ACTIVE' | 'CLOSED')} tabs={[{ id: 'ACTIVE', label: `Active (${openCount})` }, { id: 'CLOSED', label: 'Closed' }]} />
      <div className="mt-3 space-y-2">
        {loading ? <Skeleton className="h-32" /> : trades.length === 0 ? (
          <Card><CardContent><EmptyState title={tab === 'ACTIVE' ? 'No live positions' : 'Nothing closed yet'} description={tab === 'ACTIVE' ? 'Orders appear here the moment they are sent, with the plan they are managed against.' : 'Closed trades show every exit leg and the result net of costs.'} /></CardContent></Card>
        ) : trades.map((t) => <PositionRow key={t.id} t={t} onClose={onClose} closing={closing} />)}
      </div>
    </div>
  );
}

// ── caps ────────────────────────────────────────────────────────────────────

function CapsCard({ config, onSaved }: { config: LiveConfigDto | null; onSaved: () => void }) {
  const c = config;
  const [f, setF] = useState({
    riskPerTradePct: c ? String(Number(c.risk_per_trade_pct)) : '1',
    maxOpenPositions: String(c?.max_open_positions ?? 1),
    maxLotsPerTrade: String(c?.max_lots_per_trade ?? 1),
    maxTradesPerDay: String(c?.max_trades_per_day ?? 3),
    maxDailyLossPct: c ? String(Number(c.max_daily_loss_pct)) : '2',
    underlyings: (c?.underlyings ?? ['NIFTY']).join(', '),
    minGrade: c?.min_grade ?? 'B',
    allowExpiryDay: c?.allow_expiry_day ?? false,
    windowStart: toHHMM(c?.window_start_min ?? 570),
    windowEnd: toHHMM(c?.window_end_min ?? 900),
    squareOff: toHHMM(c?.square_off_min ?? 915),
    product: c?.product ?? 'INTRADAY',
    scaleOut: c?.scale_out ?? true,
    entryTimeoutSec: String(c?.entry_timeout_sec ?? 90),
  });
  const set = (k: keyof typeof f) => (v: string | boolean) => setF((x) => ({ ...x, [k]: v }));
  const save = useMutation({
    mutationFn: () => api.live.saveConfig({
      riskPerTradePct: Number(f.riskPerTradePct), maxOpenPositions: Number(f.maxOpenPositions),
      maxLotsPerTrade: Number(f.maxLotsPerTrade), maxTradesPerDay: Number(f.maxTradesPerDay),
      maxDailyLossPct: Number(f.maxDailyLossPct),
      underlyings: f.underlyings.split(',').map((u) => u.trim().toUpperCase()).filter(Boolean),
      minGrade: f.minGrade as 'A' | 'B' | 'C', allowExpiryDay: f.allowExpiryDay,
      windowStartMin: fromHHMM(f.windowStart), windowEndMin: fromHHMM(f.windowEnd), squareOffMin: fromHHMM(f.squareOff),
      product: f.product as 'INTRADAY' | 'CARRYFORWARD', scaleOut: f.scaleOut, entryTimeoutSec: Number(f.entryTimeoutSec),
    }),
    onSuccess: onSaved,
  });
  const F = ({ k, label, type = 'text', help }: { k: keyof typeof f; label: string; type?: string; help?: string }) => (
    <div className="space-y-1">
      <Label htmlFor={`cap-${k}`}>{label}</Label>
      <Input id={`cap-${k}`} type={type} value={String(f[k])} onChange={(e) => set(k)(e.target.value)} />
      {help && <p className="text-2xs leading-relaxed text-muted-foreground">{help}</p>}
    </div>
  );
  return (
    <Card>
      <CardHeader><CardTitle>Hard limits</CardTitle></CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">These halt the system when breached. They are checked before every order and after every close.</p>
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
          <F k="riskPerTradePct" label="Risk per trade (%)" help="Of the capital you arm with. Sizes the lots." />
          <F k="maxLotsPerTrade" label="Max lots per trade" />
          <F k="maxOpenPositions" label="Max open positions" />
          <F k="maxTradesPerDay" label="Max trades per day" />
          <F k="maxDailyLossPct" label="Daily loss cap (%)" help="Realised, net of costs. Breaching it halts the day." />
          <F k="entryTimeoutSec" label="Entry timeout (s)" help="Unfilled limit orders are cancelled after this." />
          <F k="windowStart" label="Entry window from" type="time" />
          <F k="windowEnd" label="Entry window to" type="time" />
          <F k="squareOff" label="Square-off (intraday)" type="time" help="Flattens intraday positions, ahead of the broker's own." />
          <div className="space-y-1">
            <Label htmlFor="cap-grade">Minimum grade</Label>
            <Select id="cap-grade" value={f.minGrade} onChange={(e) => set('minGrade')(e.target.value)}>
              <option value="A">A only</option><option value="B">B or better</option><option value="C">C or better (not recommended)</option>
            </Select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="cap-product">Product</Label>
            <Select id="cap-product" value={f.product} onChange={(e) => set('product')(e.target.value)}>
              <option value="INTRADAY">Intraday (MIS) — squared off daily</option>
              <option value="CARRYFORWARD">Carry forward (NRML) — can hold overnight</option>
            </Select>
          </div>
          <div className="col-span-2 space-y-1">
            <Label htmlFor="cap-und">Underlyings (Auto mode)</Label>
            <Input id="cap-und" value={f.underlyings} onChange={(e) => set('underlyings')(e.target.value)} placeholder="NIFTY, BANKNIFTY" />
          </div>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={f.scaleOut} onChange={(e) => set('scaleOut')(e.target.checked)} /> Book half at target 1, run the rest to target 2 (needs 2+ lots)</label>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={f.allowExpiryDay} onChange={(e) => set('allowExpiryDay')(e.target.checked)} /> Allow fresh buys on expiry day</label>
        </div>
        <div className="flex items-center gap-3">
          <Button onClick={() => save.mutate()} disabled={save.isPending}>{save.isPending ? 'Saving…' : 'Save limits'}</Button>
          {save.isSuccess && <span className="text-sm text-muted-foreground">Saved.</span>}
          {save.isError && <span className="text-sm text-destructive">{save.error instanceof Error ? save.error.message : 'Could not save.'}</span>}
        </div>
      </CardContent>
    </Card>
  );
}
