/**
 * The five-axis score panel.
 *
 * Deliberately NOT a radar chart. A radar's area is meaningless (it changes
 * with axis order), and the numbers here are independent 0–100 readings, not a
 * shape. Five labelled magnitude bars compare far more accurately and let each
 * axis carry its own value as a direct label.
 *
 * Every score expands to the rules that produced it — the transparency
 * requirement is the whole point of the panel.
 */
import { useState } from 'react';
import { ChevronDown, ChevronRight, Check, X, Minus } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Badge, Tooltip, Alert } from '@/components/ui';
import type { SignalReportDto, RuleResultDto } from '@/types/api';

const AXIS_LABELS: Record<string, string> = {
  trend: 'Trend',
  momentum: 'Momentum',
  volume: 'Volume',
  volatility: 'Volatility',
  structure: 'Structure',
};

/**
 * Bars use a neutral single hue, not red/green: a score of 30 on the momentum
 * axis is not "bad", it is bearish-leaning, and the axis already says so.
 * Colour here would assert a judgement the number does not make.
 */
function ScoreBar({ label, value }: { label: string; value: number | null }) {
  if (value === null) {
    return (
      <div className="space-y-1">
        <div className="flex justify-between text-2xs">
          <span className="text-muted-foreground">{label}</span>
          <span className="text-muted-foreground">Not evaluable</span>
        </div>
        <div className="h-1.5 w-full rounded-full border border-dashed border-border" />
      </div>
    );
  }

  return (
    <div className="space-y-1">
      <div className="flex justify-between text-2xs">
        <span className="text-muted-foreground">{label}</span>
        <span className="tabular font-medium">{value}/100</span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
        <div
          className="h-full rounded-full bg-primary transition-all"
          style={{ width: `${Math.max(2, value)}%` }}
        />
      </div>
    </div>
  );
}

function RuleRow({ rule }: { rule: RuleResultDto }) {
  const Icon = !rule.evaluable ? Minus : rule.passed ? Check : X;
  return (
    <li className="flex items-start gap-2 py-1">
      <Icon
        className={cn(
          'mt-0.5 h-3 w-3 shrink-0',
          !rule.evaluable ? 'text-muted-foreground'
            : rule.passed ? 'text-up' : 'text-muted-foreground/60',
        )}
        aria-hidden
      />
      <div className="min-w-0">
        <div className={cn('text-2xs font-medium', !rule.passed && 'text-muted-foreground')}>
          {rule.label}
        </div>
        <div className="text-2xs leading-relaxed text-muted-foreground">{rule.detail}</div>
      </div>
    </li>
  );
}

export function ScorePanel({ report }: { report: SignalReportDto }) {
  const [expanded, setExpanded] = useState(false);
  const [category, setCategory] = useState<string | null>(null);

  const rulesByCategory = report.allRules.reduce<Record<string, RuleResultDto[]>>((acc, r) => {
    (acc[r.category] ??= []).push(r);
    return acc;
  }, {});

  const evaluable = report.allRules.filter((r) => r.evaluable);
  const passing = evaluable.filter((r) => r.passed);

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="text-2xs uppercase tracking-wide text-muted-foreground">
            Rule-confirmation score
          </div>
          <div className="tabular text-3xl font-semibold leading-tight">
            {report.overallScore ?? '—'}
            <span className="text-base font-normal text-muted-foreground">/100</span>
          </div>
          <div className="mt-0.5 text-2xs text-muted-foreground">
            {passing.length} of {evaluable.length} evaluable conditions currently agree
          </div>
        </div>
        <Badge variant="warning">Rule signal, not a forecast</Badge>
      </div>

      <div className="space-y-2.5">
        {(Object.keys(AXIS_LABELS) as Array<keyof typeof AXIS_LABELS>).map((key) => (
          <ScoreBar
            key={key}
            label={AXIS_LABELS[key]!}
            value={report.scores[key as keyof SignalReportDto['scores']]}
          />
        ))}
      </div>

      <Alert>{report.interpretation}</Alert>

      <div>
        <button
          onClick={() => setExpanded((e) => !e)}
          className="flex items-center gap-1 text-2xs font-medium text-primary hover:underline"
        >
          {expanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
          {expanded ? 'Hide' : 'Show'} the {report.allRules.length} rules behind these scores
        </button>

        {expanded && (
          <div className="mt-2 space-y-2">
            <div className="flex flex-wrap gap-1">
              <button
                onClick={() => setCategory(null)}
                className={cn(
                  'rounded px-2 py-0.5 text-2xs transition-colors',
                  category === null ? 'bg-primary text-primary-foreground' : 'bg-muted',
                )}
              >
                All
              </button>
              {Object.keys(rulesByCategory).map((c) => (
                <button
                  key={c}
                  onClick={() => setCategory(c)}
                  className={cn(
                    'rounded px-2 py-0.5 text-2xs capitalize transition-colors',
                    category === c ? 'bg-primary text-primary-foreground' : 'bg-muted',
                  )}
                >
                  {c}
                </button>
              ))}
            </div>

            <ul className="max-h-80 divide-y divide-border overflow-y-auto rounded-md border border-border p-2">
              {report.allRules
                .filter((r) => category === null || r.category === category)
                .sort((a, b) => Number(b.passed) - Number(a.passed))
                .map((r) => (
                  <RuleRow key={r.id} rule={r} />
                ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}

/** A matched setup, with its confirmations and what would invalidate it. */
export function SetupCard({ setup }: { setup: SignalReportDto['setups'][number] }) {
  const [open, setOpen] = useState(false);
  const confirmed = setup.confirmingRules.filter((r) => r.evaluable && r.passed);
  const missed = setup.confirmingRules.filter((r) => r.evaluable && !r.passed);

  return (
    <div className="rounded-md border border-border p-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium">{setup.label}</span>
            <Badge
              variant={
                setup.direction === 'BULLISH' ? 'up'
                : setup.direction === 'BEARISH' ? 'down'
                : 'muted'
              }
            >
              {setup.direction.toLowerCase()}
            </Badge>
          </div>
          <p className="mt-1 text-2xs leading-relaxed text-muted-foreground">
            {setup.description}
          </p>
        </div>
        <Tooltip content="The weighted share of this setup's confirming conditions that currently hold. It is not a probability that the setup will work.">
          <div className="shrink-0 text-right">
            <div className="tabular text-lg font-semibold">{setup.strength}</div>
            <div className="text-2xs text-muted-foreground">confirmation</div>
          </div>
        </Tooltip>
      </div>

      <div className="mt-2 flex gap-3 text-2xs">
        <span className="text-up">{confirmed.length} confirmed</span>
        <span className="text-muted-foreground">{missed.length} not firing</span>
      </div>

      <button
        onClick={() => setOpen((o) => !o)}
        className="mt-2 flex items-center gap-1 text-2xs text-primary hover:underline"
      >
        {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        {open ? 'Hide' : 'Show'} evidence
      </button>

      {open && (
        <ul className="mt-2 divide-y divide-border border-t border-border pt-1">
          {[...setup.requiredRules, ...confirmed, ...missed].map((r) => (
            <RuleRow key={r.id} rule={r} />
          ))}
        </ul>
      )}
    </div>
  );
}
