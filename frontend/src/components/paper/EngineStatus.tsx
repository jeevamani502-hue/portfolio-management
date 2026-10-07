/**
 * What the paper engine is doing, at a glance.
 *
 * The problem this solves: "Running" with an empty ledger looked identical
 * to broken. The switch said on, nothing traded, and there was nothing on
 * the page that distinguished "looked and declined" from "never looked" or
 * "cannot possibly trade with this capital".
 *
 * So the state is stated in one sentence at the top, and every reason it
 * cannot trade is listed underneath with the numbers and what to do. Written
 * for someone who has not traded options before: no abbreviations, and the
 * lot arithmetic spelled out, because that is the constraint nobody guesses.
 */
import { useQuery } from '@tanstack/react-query';
import { api } from '@/services/api';
import { Card, CardContent, Skeleton, Badge } from '@/components/ui';
import { cn } from '@/lib/utils';
import type { PaperStatusDto } from '@/types/api';

const STATE_STYLE: Record<
  PaperStatusDto['state'],
  { label: string; dot: string; badge: 'up' | 'warning' | 'outline' }
> = {
  WATCHING: { label: 'Watching the market', dot: 'bg-bull animate-pulse-dot', badge: 'up' },
  WAITING: { label: 'Running, but blocked', dot: 'bg-delayed', badge: 'warning' },
  HALTED: { label: 'Halted', dot: 'bg-destructive', badge: 'warning' },
  STOPPED: { label: 'Stopped', dot: 'bg-muted-foreground', badge: 'outline' },
  NOT_SET_UP: { label: 'Not set up', dot: 'bg-muted-foreground', badge: 'outline' },
};

const ago = (iso: string | null) => {
  if (!iso) return 'never';
  const secs = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.round(secs / 60)}m ago`;
  return `${Math.round(secs / 3600)}h ago`;
};

export function EngineStatus() {
  const status = useQuery({
    queryKey: ['paper', 'status'],
    queryFn: api.paper.status,
    // Often enough that the countdown and "last checked" stay honest.
    refetchInterval: 15_000,
  });

  if (status.isLoading) return <Skeleton className="h-40" />;
  if (!status.data) return null;

  const s = status.data;
  const style = STATE_STYLE[s.state];

  return (
    <Card>
      <CardContent className="space-y-4 pt-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex items-start gap-2.5">
            <span className={cn('mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full', style.dot)} aria-hidden />
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-base font-semibold">{style.label}</h2>
                <Badge variant={style.badge}>{s.marketPhase}</Badge>
                {s.feedConnected && <Badge variant="up">live prices</Badge>}
              </div>
              <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{s.headline}</p>
            </div>
          </div>

          <dl className="flex gap-5 text-right">
            <div>
              <dt className="text-2xs uppercase tracking-wide text-muted-foreground">Open</dt>
              <dd className="font-mono text-sm">{s.openPositions}</dd>
            </div>
            <div>
              <dt className="text-2xs uppercase tracking-wide text-muted-foreground">Today</dt>
              <dd className="font-mono text-sm">{s.tradesToday}</dd>
            </div>
            <div>
              <dt className="text-2xs uppercase tracking-wide text-muted-foreground">Checked</dt>
              <dd className="font-mono text-sm">{ago(s.lastSweepAt)}</dd>
            </div>
          </dl>
        </div>

        {s.blockers.length > 0 && (
          <div className="space-y-2 rounded border border-border bg-muted/30 p-3">
            <p className="text-2xs font-medium uppercase tracking-wide text-muted-foreground">
              {s.blockers.length === 1 ? 'Why it cannot trade' : 'Why it cannot trade'}
            </p>
            <ul className="space-y-2">
              {s.blockers.map((b) => (
                <li key={b.code} className="text-sm leading-relaxed">
                  <span>{b.detail}</span>
                  {b.fix && <span className="text-muted-foreground"> {b.fix}</span>}
                </li>
              ))}
            </ul>
          </div>
        )}

        {s.lastSweepSkipped.length > 0 && (
          <div className="space-y-1.5">
            <p className="text-2xs font-medium uppercase tracking-wide text-muted-foreground">
              What the last check found
            </p>
            <ul className="space-y-1">
              {s.lastSweepSkipped.map((r) => (
                <li key={r} className="text-sm leading-relaxed text-muted-foreground">
                  — {r}
                </li>
              ))}
            </ul>
          </div>
        )}

        {s.lotEconomics.length > 0 && (
          <div className="space-y-1.5">
            <p className="text-2xs font-medium uppercase tracking-wide text-muted-foreground">
              What your capital can buy
            </p>
            {s.lotEconomics.map((e) => (
              <p key={e.underlying} className="text-sm leading-relaxed text-muted-foreground">
                {e.note}
              </p>
            ))}
          </div>
        )}

        {s.nextSweepInSeconds !== null && s.blockers.length === 0 && (
          <p className="text-2xs text-muted-foreground">
            Next check in about {s.nextSweepInSeconds}s. It looks every few minutes while the
            market is open, and opens a position only when its rules agree.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
