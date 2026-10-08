/**
 * The agent, in one page: what it is doing, what it called today, what it
 * holds and how that is going, what it said, and what it will do next.
 *
 * Every number here comes from the same records the rest of the app uses —
 * the journal, the two ledgers, the notification feed. The page narrates;
 * it does not decide.
 */
import { useEffect } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Bot, ArrowRight, Sunrise, Sunset } from 'lucide-react';
import { api } from '@/services/api';
import { Card, CardHeader, CardTitle, CardContent, Skeleton, Badge, Alert, EmptyState, Button } from '@/components/ui';
import { Metric } from '@/components/market/DataValue';
import { useTicks } from '@/services/ws';
import { relativeTime, istTime, humanise } from '@/lib/format';
import { cn } from '@/lib/utils';
import type { AgentPositionDto, NotificationDto } from '@/types/api';

const inr = (n: number | null | undefined, dp = 0) =>
  n === null || n === undefined || Number.isNaN(n) ? '—' : `₹${n.toLocaleString('en-IN', { maximumFractionDigits: dp, minimumFractionDigits: dp })}`;
const pnlClass = (n: number | null) => (n === null ? '' : n > 0 ? 'text-bull' : n < 0 ? 'text-bear' : '');

export function Agent() {
  const qc = useQueryClient();
  const summary = useQuery({ queryKey: ['agent', 'summary'], queryFn: api.agent.summary, refetchInterval: 15_000 });
  const brief = useMutation({
    mutationFn: (which: 'morning' | 'close') => (which === 'morning' ? api.agent.briefMorning() : api.agent.briefClose()),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['agent'] }),
  });

  if (summary.isLoading) return <Skeleton className="h-96" />;
  const s = summary.data;
  if (!s) return null;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-lg font-semibold"><Bot className="h-5 w-5" aria-hidden /> Your F&amp;O agent</h1>
          <p className="text-sm text-muted-foreground">
            Scans, grades, journals, paper-trades, manages exits, re-checks on news — and executes at the broker only when you arm it.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={s.market.isOpen ? 'up' : 'muted'}>{humanise(s.market.phase)}</Badge>
          {s.regime && <Badge variant="outline">Regime: {humanise(s.regime.label)}</Badge>}
        </div>
      </div>

      <Card>
        <CardContent className="pt-4">
          <div className="text-2xs uppercase tracking-wide text-muted-foreground">What happens next</div>
          <p className="mt-1 text-sm leading-relaxed">{s.next}</p>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <StatusLine label="Paper engine" headline={s.paper.headline} tone={s.paper.state === 'WATCHING' ? 'up' : s.paper.state === 'WAITING' ? 'warning' : 'muted'} to="/paper" />
            <StatusLine label="Live trading" headline={s.live.headline} tone={s.live.armed && s.live.blockers.length === 0 ? 'up' : s.live.armed ? 'warning' : 'muted'} to="/live" />
          </div>
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <BriefCard icon={<Sunrise className="h-4 w-4" aria-hidden />} title="Morning plan" brief={s.briefs.morning} onIssue={() => brief.mutate('morning')} pending={brief.isPending} fallback="Issued around 09:20 IST on trading days: the regime and what the checklist reads on each underlying before the window opens." />
        <BriefCard icon={<Sunset className="h-4 w-4" aria-hidden />} title="Close report" brief={s.briefs.close} onIssue={() => brief.mutate('close')} pending={brief.isPending} fallback="Issued around 15:35 IST: every call made today and how it resolved, paper and live P&L, and the running track record." />
      </div>

      <PositionsCard positions={s.positions} />

      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <CardTitle>Calls today ({s.callsToday.length})</CardTitle>
          <Link to="/fno" className="inline-flex items-center gap-1 text-2xs text-primary hover:underline">Track record <ArrowRight className="h-3 w-3" aria-hidden /></Link>
        </CardHeader>
        <CardContent>
          {s.callsToday.length === 0 ? (
            <EmptyState title="No calls yet today" description="A call is journaled the moment the checklist grades a trade Enter — from the paper engine, an alert, the F&O page, or live auto mode." />
          ) : (
            <ul className="divide-y divide-border">
              {s.callsToday.map((c) => (
                <li key={c.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-sm">{c.underlying} {c.strike} {c.optionType}</span>
                    <Badge variant={c.grade === 'A' ? 'up' : 'outline'}>Grade {c.grade}</Badge>
                    <Badge variant="muted">{c.origin}</Badge>
                    <Badge variant={c.status === 'ACTIVE' ? 'outline' : c.rMultiple !== null && c.rMultiple > 0 ? 'up' : 'down'}>{humanise(c.status)}</Badge>
                  </div>
                  <div className="text-right text-2xs text-muted-foreground">
                    entry ₹{c.entryPremium.toFixed(2)} · stop ₹{c.stopPremium.toFixed(2)} · T1 ₹{c.target1Premium.toFixed(2)}
                    {c.rMultiple !== null && <span className={cn('ml-2 font-mono', pnlClass(c.rMultiple))}>{c.rMultiple >= 0 ? '+' : ''}{c.rMultiple.toFixed(2)}R</span>}
                    <div>{istTime(c.generatedAt, false)} IST</div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card>
          <CardHeader><CardTitle>Calls — 90 days</CardTitle></CardHeader>
          <CardContent>
            {(() => { const all = s.performance.signals.byGrade.find((g) => g.grade === 'ALL'); return (
              <div className="grid grid-cols-2 gap-3">
                <Metric label="Issued" value={s.performance.signals.issued} />
                <Metric label="Resolved" value={s.performance.signals.resolved} />
                <Metric label="Hit rate" value={all?.hitRatePct === null || all?.hitRatePct === undefined ? '—' : `${all.hitRatePct.toFixed(0)}%`} />
                <Metric label="Avg R" value={all?.avgR === null || all?.avgR === undefined ? '—' : `${all.avgR >= 0 ? '+' : ''}${all.avgR.toFixed(2)}R`} className={pnlClass(all?.avgR ?? null)} />
              </div>
            ); })()}
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle>Paper</CardTitle></CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 gap-3">
              <Metric label="Net P&L" value={inr(s.performance.paper.netPnl)} className={pnlClass(s.performance.paper.netPnl)} />
              <Metric label="Closed" value={s.performance.paper.closedTrades} />
              <Metric label="Win rate" value={s.performance.paper.winRate === null ? '—' : `${s.performance.paper.winRate.toFixed(0)}%`} />
              <Metric label="Open" value={s.performance.paper.openTrades} />
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle>Live</CardTitle></CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 gap-3">
              <Metric label="Net P&L" value={inr(s.performance.live.netPnl)} className={pnlClass(s.performance.live.netPnl)} />
              <Metric label="Today" value={inr(s.performance.live.todayNet)} className={pnlClass(s.performance.live.todayNet)} />
              <Metric label="Closed" value={s.performance.live.closed} />
              <Metric label="Win rate" value={s.performance.live.winRate === null ? '—' : `${s.performance.live.winRate.toFixed(0)}%`} />
            </div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader><CardTitle>Activity today ({s.activity.length})</CardTitle></CardHeader>
        <CardContent>
          {s.activity.length === 0 ? (
            <EmptyState title="Quiet so far" description="Every call, fill, exit, news reaction and briefing is logged here as it happens." />
          ) : (
            <ol className="relative space-y-3 border-l border-border pl-4">
              {s.activity.map((n) => <ActivityItem key={n.id} n={n} />)}
            </ol>
          )}
        </CardContent>
      </Card>

      <Alert variant="default">
        The agent's grades count agreeing conditions and its record is measured from the journal — neither is a probability of
        profit. Paper results before live size; live only when armed, within the caps you set.
      </Alert>
    </div>
  );
}

function StatusLine({ label, headline, tone, to }: { label: string; headline: string; tone: 'up' | 'warning' | 'muted'; to: string }) {
  return (
    <Link to={to} className="flex items-start gap-2 rounded border border-border p-3 transition-colors hover:bg-accent/40">
      <span className={cn('mt-1.5 h-2 w-2 shrink-0 rounded-full', tone === 'up' ? 'bg-bull animate-pulse-dot' : tone === 'warning' ? 'bg-delayed' : 'bg-muted-foreground')} aria-hidden />
      <span className="min-w-0">
        <span className="block text-2xs uppercase tracking-wide text-muted-foreground">{label}</span>
        <span className="block text-sm leading-relaxed">{headline}</span>
      </span>
    </Link>
  );
}

function BriefCard({ icon, title, brief, onIssue, pending, fallback }: {
  icon: React.ReactNode; title: string; brief: NotificationDto | null; onIssue: () => void; pending: boolean; fallback: string;
}) {
  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0">
        <CardTitle className="flex items-center gap-1.5">{icon} {title}</CardTitle>
        {brief ? <span className="text-2xs text-muted-foreground">{istTime(brief.createdAt, false)} IST</span> : (
          <Button variant="outline" size="sm" onClick={onIssue} disabled={pending}>Issue now</Button>
        )}
      </CardHeader>
      <CardContent>
        {brief ? (
          <ul className="space-y-1.5">
            {brief.message.split('\n').map((line, i) => <li key={i} className="text-sm leading-relaxed">{line}</li>)}
          </ul>
        ) : <p className="text-sm leading-relaxed text-muted-foreground">{fallback}</p>}
      </CardContent>
    </Card>
  );
}

function PositionsCard({ positions }: { positions: AgentPositionDto[] }) {
  const ticks = useTicks((s) => s.ticks);
  const feedState = useTicks((s) => s.feedState);
  const subscribe = useTicks((s) => s.subscribe);
  const unsubscribe = useTicks((s) => s.unsubscribe);
  const key = positions.map((p) => `${p.exchange}:${p.tradingsymbol}`).sort().join(',');
  useEffect(() => {
    const symbols = key ? key.split(',') : [];
    if (symbols.length === 0) return;
    subscribe(symbols);
    return () => unsubscribe(symbols);
  }, [key, subscribe, unsubscribe]);

  let total = 0;
  let marked = 0;
  const rows = positions.map((p) => {
    const tick = feedState === 'connected' ? ticks[`${p.exchange}:${p.tradingsymbol}`] : undefined;
    const ltp = tick?.ltp ?? p.lastPremium;
    const pnl = ltp === null ? null : (ltp - p.entryPremium) * p.quantity;
    if (pnl !== null) { total += pnl; marked += 1; }
    return { p, ltp, pnl, live: Boolean(tick) };
  });

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0">
        <CardTitle>Holding now ({positions.length})</CardTitle>
        {marked > 0 && (
          <span className={cn('font-mono text-sm', pnlClass(total))}>{total >= 0 ? '+' : ''}{inr(total)} <span className="text-2xs text-muted-foreground">unrealised, gross</span></span>
        )}
      </CardHeader>
      <CardContent>
        {positions.length === 0 ? (
          <EmptyState title="Flat" description="Nothing is held in paper or live right now." />
        ) : (
          <ul className="divide-y divide-border">
            {rows.map(({ p, ltp, pnl, live }) => (
              <li
                key={`${p.kind}-${p.id}`}
                className={cn(
                  'flex flex-wrap items-center justify-between gap-2 border-l-4 py-2 pl-3',
                  pnl === null ? 'border-l-transparent' : pnl > 0 ? 'border-l-up bg-up/5' : pnl < 0 ? 'border-l-down bg-down/5' : 'border-l-flat',
                )}
              >
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant={p.kind === 'live' ? 'warning' : 'outline'}>{p.kind === 'live' ? 'LIVE' : 'paper'}</Badge>
                  <span className="font-mono text-sm">{p.tradingsymbol}</span>
                  <span className="text-2xs text-muted-foreground">× {p.quantity} · {humanise(p.status)} · {relativeTime(p.enteredAt)}</span>
                </div>
                <div className="flex items-center gap-4 text-sm">
                  <span className="font-mono text-muted-foreground">in {p.entryPremium.toFixed(2)}</span>
                  <span className={cn('font-mono', live && 'text-live')}>{ltp === null ? 'no price' : ltp.toFixed(2)}</span>
                  <span className={cn('w-24 text-right font-mono', pnlClass(pnl))}>{pnl === null ? '—' : `${pnl >= 0 ? '+' : ''}${inr(pnl)}`}</span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

const DOT: Record<NotificationDto['severity'], string> = { info: 'bg-primary', action: 'bg-up', warning: 'bg-delayed' };

function ActivityItem({ n }: { n: NotificationDto }) {
  return (
    <li>
      <span className={cn('absolute -left-[5px] mt-1.5 h-2 w-2 rounded-full', DOT[n.severity])} aria-hidden />
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="text-sm font-medium">{n.title}</span>
        <span className="text-2xs text-muted-foreground">{istTime(n.createdAt, false)} IST · {n.kind.replace(/_/g, ' ')}</span>
      </div>
      <p className="mt-0.5 whitespace-pre-line text-2xs leading-relaxed text-muted-foreground">{n.message}</p>
    </li>
  );
}
