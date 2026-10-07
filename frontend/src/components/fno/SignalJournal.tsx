/**
 * The track record.
 *
 * Every graded signal the engine issued, and how it resolved. This is the
 * only place the platform answers "how often does this work", and it does
 * so from records: hit rate and average R by grade, computed from resolved
 * journal entries, with the sample-size caveat as a permanent fixture.
 */
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/services/api';
import {
  Card, CardHeader, CardTitle, CardContent, Skeleton, Badge, Alert, EmptyState, Tabs,
} from '@/components/ui';
import { Metric } from '@/components/market/DataValue';
import { istDateTime, relativeTime } from '@/lib/format';
import { cn } from '@/lib/utils';
import type { FnoSignalDto, GradeStatsDto } from '@/types/api';

const STATUS_STYLE: Record<FnoSignalDto['status'], { label: string; variant: 'up' | 'down' | 'warning' | 'outline' | 'muted' }> = {
  ACTIVE: { label: 'Active', variant: 'outline' },
  TARGET1_HIT: { label: 'Target 1', variant: 'up' },
  TARGET2_HIT: { label: 'Target 2', variant: 'up' },
  STOPPED: { label: 'Stopped', variant: 'down' },
  INVALIDATED: { label: 'Invalidated', variant: 'down' },
  EXPIRED: { label: 'Expired', variant: 'muted' },
  TIMED_OUT: { label: 'Time stop', variant: 'warning' },
};

const inr = (n: number | null | undefined, dp = 2) =>
  n === null || n === undefined ? '—' : `₹${n.toLocaleString('en-IN', { minimumFractionDigits: dp, maximumFractionDigits: dp })}`;

const fmtR = (r: number | null) =>
  r === null ? '—' : `${r >= 0 ? '+' : ''}${r.toFixed(2)}R`;

const rClass = (r: number | null) =>
  r === null ? '' : r > 0 ? 'text-up' : r < 0 ? 'text-down' : '';

function GradeTable({ rows }: { rows: GradeStatsDto[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border text-2xs uppercase tracking-wide text-muted-foreground">
            <th className="px-3 py-2 text-left font-medium">Grade</th>
            <th className="px-3 py-2 text-right font-medium">Issued</th>
            <th className="px-3 py-2 text-right font-medium">Resolved</th>
            <th className="px-3 py-2 text-right font-medium">Hit rate</th>
            <th className="px-3 py-2 text-right font-medium">Avg R</th>
            <th className="px-3 py-2 text-right font-medium">Profit factor</th>
            <th className="px-3 py-2 text-right font-medium">Avg best excursion</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((g) => (
            <tr key={g.grade} className={cn('border-b border-border/50 last:border-0', g.grade === 'ALL' && 'font-medium')}>
              <td className="px-3 py-2">{g.grade === 'ALL' ? 'All grades' : `Grade ${g.grade}`}</td>
              <td className="px-3 py-2 text-right font-mono">{g.issued}</td>
              <td className="px-3 py-2 text-right font-mono">
                {g.resolved}
                {g.active > 0 && <span className="text-2xs text-muted-foreground"> (+{g.active} open)</span>}
              </td>
              <td className="px-3 py-2 text-right font-mono">
                {g.hitRatePct === null ? '—' : `${g.hitRatePct.toFixed(0)}%`}
                {g.resolved > 0 && <span className="text-2xs text-muted-foreground"> {g.wins}/{g.resolved}</span>}
              </td>
              <td className={cn('px-3 py-2 text-right font-mono', rClass(g.avgR))}>{fmtR(g.avgR)}</td>
              <td className="px-3 py-2 text-right font-mono">{g.profitFactor === null ? '—' : g.profitFactor.toFixed(2)}</td>
              <td className="px-3 py-2 text-right font-mono">{fmtR(g.avgMaxFavourableR)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SignalRow({ s }: { s: FnoSignalDto }) {
  const style = STATUS_STYLE[s.status];
  return (
    <div className="rounded-md border border-border p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-sm font-medium">
            {s.underlying} {s.strike} {s.optionType}
          </span>
          <Badge variant={s.grade === 'A' ? 'up' : s.grade === 'B' ? 'default' : 'muted'}>Grade {s.grade}</Badge>
          <Badge variant={style.variant}>{style.label}</Badge>
          <span className="text-2xs text-muted-foreground">{s.expiry} · {s.origin}</span>
        </div>
        <div className="text-right">
          <div className={cn('font-mono text-sm', rClass(s.rMultiple))}>{fmtR(s.rMultiple)}</div>
          <div className="text-2xs text-muted-foreground">{relativeTime(s.generatedAt)}</div>
        </div>
      </div>
      <div className="mt-2 grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-6">
        <Metric label="Entry" value={inr(s.entryPremium)} />
        <Metric label="Stop" value={inr(s.stopPremium)} />
        <Metric label="Target 1" value={inr(s.target1Premium)} />
        <Metric label="Target 2" value={inr(s.target2Premium)} />
        <Metric label={s.status === 'ACTIVE' ? 'Last' : 'Exit'} value={inr(s.lastPremium)} />
        <Metric
          label="Best / worst"
          value={`${inr(s.maxFavourablePremium)} / ${inr(s.maxAdversePremium)}`}
          valueClassName="text-xs"
        />
      </div>
      <p className="mt-2 text-2xs leading-relaxed text-muted-foreground">
        Issued {istDateTime(s.generatedAt)} IST with {s.underlying} at {s.spot.toFixed(2)}; invalidation {s.underlyingStop.toFixed(0)}, score {s.score}/100.
        {s.notes ? ` ${s.notes}` : ''}
        {s.lastCheckedAt ? ` Last checked ${relativeTime(s.lastCheckedAt)}.` : ' Not checked yet — the tracker runs every minute while the market is open.'}
      </p>
    </div>
  );
}

export function SignalJournal({ underlying }: { underlying?: string }) {
  const [tab, setTab] = useState<'ACTIVE' | 'RESOLVED'>('ACTIVE');

  const perf = useQuery({
    queryKey: ['fno', 'signals', 'performance'],
    queryFn: () => api.fno.performance(90),
    refetchInterval: 120_000,
  });
  const signals = useQuery({
    queryKey: ['fno', 'signals', tab, underlying ?? 'all'],
    queryFn: () => api.fno.signals({ status: tab, ...(underlying ? { underlying } : {}), limit: 100 }),
    refetchInterval: 60_000,
  });

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Track record — last 90 days, all underlyings</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {perf.isLoading ? (
            <Skeleton className="h-32" />
          ) : perf.data ? (
            <>
              {perf.data.issued === 0 ? (
                <EmptyState
                  title="No signals journaled yet"
                  description="Every ENTER-grade decision — from this page, an F&O alert, or the paper engine — is recorded here with its plan and tracked to resolution."
                />
              ) : (
                <GradeTable rows={perf.data.byGrade} />
              )}
              <Alert variant={perf.data.resolved < 30 ? 'warning' : 'default'} title="What this does and does not show">
                {perf.data.caveat}
              </Alert>
              <p className="text-2xs leading-relaxed text-muted-foreground">{perf.data.method}</p>
            </>
          ) : null}
        </CardContent>
      </Card>

      <div>
        <Tabs
          active={tab}
          onChange={(id) => setTab(id as 'ACTIVE' | 'RESOLVED')}
          tabs={[
            { id: 'ACTIVE', label: `Open${underlying ? ` · ${underlying}` : ''}` },
            { id: 'RESOLVED', label: 'Resolved' },
          ]}
        />
        <div className="mt-3 space-y-2">
          {signals.isLoading ? (
            <Skeleton className="h-40" />
          ) : (signals.data ?? []).length === 0 ? (
            <Card>
              <CardContent>
                <EmptyState
                  title={tab === 'ACTIVE' ? 'No open signals' : 'Nothing resolved yet'}
                  description={
                    tab === 'ACTIVE'
                      ? 'A signal is journaled the moment the engine grades a trade as ENTER. Until then there is nothing to track.'
                      : 'Resolved signals appear here with the level that closed them and the result in R.'
                  }
                />
              </CardContent>
            </Card>
          ) : (
            (signals.data ?? []).map((s) => <SignalRow key={s.id} s={s} />)
          )}
        </div>
      </div>
    </div>
  );
}
