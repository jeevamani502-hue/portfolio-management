/**
 * The decision checklist, grouped the way the engine thinks about it.
 *
 * Every factor shows its verdict and the measured observation behind it.
 * A factor that could not be read is shown as exactly that — it neither
 * helps nor hurts the score, and hiding it would make the checklist look
 * more complete than it was.
 */
import { Check, X, Minus, ShieldAlert } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Tooltip } from '@/components/ui';
import type { DecisionFactorDto } from '@/types/api';

const GROUPS: Array<{ id: DecisionFactorDto['group']; label: string; blurb: string }> = [
  { id: 'direction', label: 'Direction', blurb: 'The higher timeframe sets the bias; structure, a named setup and the regime must agree with it.' },
  { id: 'timing', label: 'Timing', blurb: 'The lower timeframe has to have turned the same way, and the entry has to be inside the session window.' },
  { id: 'chain', label: 'Chain flow', blurb: 'Where open interest sits and where it is being added should not read against the direction.' },
  { id: 'volatility', label: 'Volatility & expiry', blurb: 'A rich premium and a near expiry both make a directional buy harder to win.' },
  { id: 'risk', label: 'Risk', blurb: 'The contract must survive to its stop, be sized from your capital, and be liquid enough to exit.' },
];

function FactorRow({ f }: { f: DecisionFactorDto }) {
  const Icon = f.verdict === 'na' ? Minus : f.verdict === 'pass' ? Check : X;
  return (
    <li className="flex items-start gap-2 py-1.5">
      <Icon
        className={cn(
          'mt-0.5 h-3.5 w-3.5 shrink-0',
          f.verdict === 'na' ? 'text-muted-foreground/60'
            : f.verdict === 'pass' ? 'text-up' : 'text-down',
        )}
        aria-hidden
      />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className={cn('text-xs font-medium', f.verdict === 'na' && 'text-muted-foreground')}>
            {f.label}
          </span>
          {f.gate && (
            <Tooltip content="A gate: if this fails there is no trade, whatever the rest of the checklist says.">
              <span className="inline-flex items-center gap-0.5 rounded bg-muted px-1 text-[10px] uppercase tracking-wide text-muted-foreground">
                <ShieldAlert className="h-2.5 w-2.5" aria-hidden /> gate
              </span>
            </Tooltip>
          )}
          <span className="text-[10px] text-muted-foreground/70">weight {f.weight}</span>
        </div>
        <div className="text-2xs leading-relaxed text-muted-foreground">{f.observed}</div>
      </div>
    </li>
  );
}

export function DecisionChecklist({ factors }: { factors: DecisionFactorDto[] }) {
  return (
    <div className="grid gap-4 md:grid-cols-2">
      {GROUPS.map((g) => {
        const rows = factors.filter((f) => f.group === g.id);
        if (rows.length === 0) return null;
        const readable = rows.filter((f) => f.verdict !== 'na');
        const passing = readable.filter((f) => f.verdict === 'pass');
        return (
          <section key={g.id} className="rounded-md border border-border p-3">
            <header className="flex items-baseline justify-between gap-2">
              <div>
                <h3 className="text-sm font-semibold">{g.label}</h3>
                <p className="text-2xs leading-relaxed text-muted-foreground">{g.blurb}</p>
              </div>
              <span className="shrink-0 font-mono text-xs text-muted-foreground">
                {passing.length}/{readable.length}
                {readable.length < rows.length && (
                  <span className="text-muted-foreground/60"> · {rows.length - readable.length} unread</span>
                )}
              </span>
            </header>
            <ul className="mt-2 divide-y divide-border/60">
              {rows.map((f) => <FactorRow key={f.id} f={f} />)}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
