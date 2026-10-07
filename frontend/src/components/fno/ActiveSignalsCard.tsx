/**
 * Open F&O signals at a glance, for the dashboard.
 *
 * Each row is a plan the engine issued and the tracker is following: the
 * contract, its grade, and where the premium sits between the stop and
 * target 1. The full plan and the checklist behind it live on the F&O page.
 */
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ArrowRight, Layers } from 'lucide-react';
import { api } from '@/services/api';
import { Card, CardHeader, CardTitle, CardContent, Skeleton, Badge, EmptyState } from '@/components/ui';
import { relativeTime } from '@/lib/format';
import { cn } from '@/lib/utils';
import type { FnoSignalDto } from '@/types/api';

/** Where the last premium sits between the stop (0) and target 1 (1). */
function progress(s: FnoSignalDto): number | null {
  if (s.lastPremium === null) return null;
  const span = s.target1Premium - s.stopPremium;
  if (span <= 0) return null;
  return Math.max(0, Math.min(1, (s.lastPremium - s.stopPremium) / span));
}

export function ActiveSignalsCard() {
  const signals = useQuery({
    queryKey: ['fno', 'signals', 'ACTIVE', 'dashboard'],
    queryFn: () => api.fno.signals({ status: 'ACTIVE', limit: 8 }),
    refetchInterval: 60_000,
  });

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0">
        <CardTitle className="flex items-center gap-1.5">
          <Layers className="h-3.5 w-3.5" aria-hidden />
          Open F&amp;O signals
        </CardTitle>
        <Link to="/fno" className="inline-flex items-center gap-1 text-2xs text-primary hover:underline">
          F&amp;O engine <ArrowRight className="h-3 w-3" aria-hidden />
        </Link>
      </CardHeader>
      <CardContent>
        {signals.isLoading ? (
          <Skeleton className="h-24" />
        ) : (signals.data ?? []).length === 0 ? (
          <EmptyState
            title="No open signals"
            description="When the engine grades a NIFTY or BANKNIFTY option trade as Enter — from the F&O page, an alert, or the paper engine — it appears here and is tracked to its stop or target."
          />
        ) : (
          <ul className="divide-y divide-border">
            {(signals.data ?? []).map((s) => {
              const p = progress(s);
              const entryP = (s.entryPremium - s.stopPremium) / Math.max(1e-9, s.target1Premium - s.stopPremium);
              return (
                <li key={s.id} className="py-2 first:pt-0 last:pb-0">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-sm">{s.underlying} {s.strike} {s.optionType}</span>
                      <Badge variant={s.grade === 'A' ? 'up' : 'outline'}>Grade {s.grade}</Badge>
                    </div>
                    <span className="text-2xs text-muted-foreground">{relativeTime(s.generatedAt)}</span>
                  </div>
                  <div className="mt-1.5 flex items-center gap-2 text-2xs text-muted-foreground">
                    <span className="font-mono">₹{s.stopPremium.toFixed(0)}</span>
                    <div className="relative h-1.5 flex-1 overflow-hidden rounded bg-muted">
                      {p !== null && (
                        <div
                          className={cn('absolute inset-y-0 left-0 rounded', s.lastPremium! >= s.entryPremium ? 'bg-up' : 'bg-down')}
                          style={{ width: `${p * 100}%` }}
                        />
                      )}
                      <div
                        className="absolute inset-y-0 w-px bg-foreground/60"
                        style={{ left: `${Math.max(0, Math.min(100, entryP * 100))}%` }}
                        aria-hidden
                      />
                    </div>
                    <span className="font-mono">₹{s.target1Premium.toFixed(0)}</span>
                    <span className="w-16 text-right font-mono">
                      {s.lastPremium !== null ? `₹${s.lastPremium.toFixed(2)}` : '—'}
                    </span>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
