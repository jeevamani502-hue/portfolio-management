/**
 * Turns the live option chain into one concrete, fully-sized trade.
 *
 * Capital starts blank on purpose. The server refuses a request without it,
 * and pre-filling a number would be this app deciding how much of someone's
 * money is at stake. The user types it; everything else is computed.
 */
import { useState } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { api } from '@/services/api';
import {
  Card, CardHeader, CardTitle, CardContent, Skeleton, Badge, Alert, EmptyState,
  Button, Input, Label,
} from '@/components/ui';
import { DataValue, Metric } from '@/components/market/DataValue';
import { cn } from '@/lib/utils';
import type { OptionSetupDto } from '@/types/api';

const inr = (n: number | null | undefined) =>
  n === null || n === undefined
    ? '—'
    : `₹${n.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;

export function TradeSetupPanel({ underlying, expiry }: { underlying: string; expiry: string }) {
  const [capitalText, setCapitalText] = useState('');
  const [riskText, setRiskText] = useState('1');
  const [submitted, setSubmitted] = useState<{ capital: number; riskPercent: number } | null>(null);

  const capital = Number(capitalText.replace(/[^0-9.]/g, ''));
  const riskPercent = Number(riskText);
  const inputsValid = capital > 0 && riskPercent >= 0.1 && riskPercent <= 10;

  const setup = useQuery({
    queryKey: ['options', underlying, 'setup', expiry, submitted?.capital, submitted?.riskPercent],
    queryFn: () =>
      api.options.setup(underlying, {
        capital: submitted!.capital,
        riskPercent: submitted!.riskPercent,
        ...(expiry ? { expiry } : {}),
      }),
    enabled: submitted !== null,
  });

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Generate a trade</CardTitle>
        </CardHeader>
        <CardContent>
          <form
            className="flex flex-wrap items-end gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              if (inputsValid) setSubmitted({ capital, riskPercent });
            }}
          >
            <div className="space-y-1">
              <Label htmlFor="capital">Your capital (₹)</Label>
              <Input
                id="capital"
                inputMode="numeric"
                placeholder="e.g. 500000"
                value={capitalText}
                onChange={(e) => setCapitalText(e.target.value)}
                className="w-44"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="risk">Risk per trade (%)</Label>
              <Input
                id="risk"
                inputMode="decimal"
                value={riskText}
                onChange={(e) => setRiskText(e.target.value)}
                className="w-28"
              />
            </div>
            <Button type="submit" disabled={!inputsValid}>
              Generate setup
            </Button>
          </form>
          <p className="mt-3 text-2xs text-muted-foreground">
            Nothing is assumed about your account size — you enter the amount, and the position is
            sized in whole lots from it.
          </p>
        </CardContent>
      </Card>

      {submitted === null ? (
        <EmptyState
          title="Enter your capital to generate a setup"
          description="Strike, entry, invalidation and lot count are all computed from the live chain and the amount you enter."
        />
      ) : setup.isLoading ? (
        <Skeleton className="h-64" />
      ) : (
        <DataValue data={setup.data?.data}>
          {(s) => <SetupResult setup={s} underlying={underlying} />}
        </DataValue>
      )}
    </div>
  );
}

function SetupResult({ setup: s, underlying }: { setup: OptionSetupDto; underlying: string }) {
  if (s.action === 'NO_TRADE') {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            No trade
            <Badge variant="warning">{s.bias}</Badge>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-muted-foreground">{s.interpretation}</p>
          <ul className="space-y-1.5">
            {s.rejectedBecause.map((r) => (
              <li key={r} className="text-sm leading-relaxed">
                — {r}
              </li>
            ))}
          </ul>
          {s.evidence.length > 0 && <EvidenceGrid items={s.evidence} />}
          <p className="text-2xs leading-relaxed text-muted-foreground">
            When the rules do agree and the payoff clears your reward-to-risk floor, a
            &ldquo;Take this trade&rdquo; button appears here and records the position in your
            paper ledger in one click.
          </p>
        </CardContent>
      </Card>
    );
  }

  const isCall = s.action === 'BUY_CALL';
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="flex flex-wrap items-center gap-2">
            <span className={isCall ? 'text-bull' : 'text-bear'}>
              {isCall ? 'Buy call' : 'Buy put'}
            </span>
            <span className="font-mono">
              {s.underlying} {s.strike} {s.optionType}
            </span>
            <Badge variant="outline">{s.expiry}</Badge>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            <Metric label="Entry premium" value={inr(s.entryPremium)} />
            <Metric label="Target" value={inr(s.targetPremium)} />
            <Metric label="Stop (nominal)" value={inr(s.stopPremium)} />
            <Metric
              label="Reward : risk"
              value={s.rewardRisk ? `${s.rewardRisk.toFixed(2)} : 1` : '—'}
            />
            <Metric label="Lots" value={s.sizing?.lots ?? '—'} />
            <Metric label="Quantity" value={s.sizing?.quantity ?? '—'} />
            <Metric label="Premium outlay" value={inr(s.totalPremiumAtRisk)} />
            <Metric label="Risk at stop" value={inr(s.sizing?.actualCapitalAtRisk)} />
          </div>

          <TakeTradeButton underlying={underlying} setup={s} />

          <Alert
            variant="info"
            title={`Exit if ${s.underlying} trades through ${s.underlyingStop?.toFixed(0)}`}
          >
            Spot {s.spot?.toFixed(2)} · target {s.underlyingTarget?.toFixed(0)} · delta{' '}
            {s.delta?.toFixed(3)}. Buying an option risks the whole premium:{' '}
            {inr(s.totalPremiumAtRisk)} can be lost if the move does not come.
          </Alert>

          <div>
            <div className="mb-1 flex items-baseline justify-between">
              <span className="text-2xs uppercase tracking-wide text-muted-foreground">
                Conditions agreeing
              </span>
              <span className="font-mono text-sm">{s.confirmation} / 100</span>
            </div>
            <div className="h-1.5 w-full overflow-hidden rounded bg-muted">
              <div
                className={cn('h-full rounded', isCall ? 'bg-bull' : 'bg-bear')}
                style={{ width: `${s.confirmation}%` }}
              />
            </div>
            <p className="mt-1.5 text-2xs text-muted-foreground">
              A count of rules that currently agree — not a probability of profit.
            </p>
          </div>

          <p className="text-sm leading-relaxed">{s.interpretation}</p>
        </CardContent>
      </Card>

      {s.warnings.length > 0 && (
        <Alert variant="warning" title="Against this trade">
          <ul className="space-y-1.5">
            {s.warnings.map((w) => (
              <li key={w} className="text-sm leading-relaxed">
                — {w}
              </li>
            ))}
          </ul>
        </Alert>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Every number behind this</CardTitle>
        </CardHeader>
        <CardContent>
          <EvidenceGrid items={s.evidence} />
        </CardContent>
      </Card>
    </div>
  );
}

const SOURCE_LABEL: Record<string, string> = {
  chain: 'option chain',
  signal_engine: 'rule engine',
  calculated: 'calculated',
  user_input: 'you entered',
};

function EvidenceGrid({ items }: { items: OptionSetupDto['evidence'] }) {
  return (
    <dl className="grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-2 lg:grid-cols-3">
      {items.map((e) => (
        <div
          key={e.label}
          className="flex items-baseline justify-between gap-3 border-b border-border/50 pb-1.5"
        >
          <dt className="text-sm text-muted-foreground">{e.label}</dt>
          <dd className="flex items-baseline gap-2">
            <span className="font-mono text-sm">{e.value}</span>
            <span className="text-2xs text-muted-foreground">
              {SOURCE_LABEL[e.source] ?? e.source}
            </span>
          </dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * One-click entry into the setup shown above.
 *
 * It records the trade in the paper ledger — no order reaches a broker. The
 * button is explicit about that, because a control that looks like it might
 * place a real order is the last place to be ambiguous.
 */
function TakeTradeButton({ underlying, setup }: { underlying: string; setup: OptionSetupDto }) {
  const take = useMutation({ mutationFn: () => api.paper.take(underlying) });

  if (take.isSuccess) {
    return (
      <Alert variant="info" title="Recorded in your paper ledger">
        {setup.underlying} {setup.strike} {setup.optionType} is now an open paper position. The
        advisor will tell you when to close it. Track it on the Paper Trading page.
      </Alert>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-3 rounded border border-border bg-muted/30 p-3">
      <Button onClick={() => take.mutate()} disabled={take.isPending}>
        {take.isPending ? 'Recording…' : 'Take this trade (paper)'}
      </Button>
      <span className="text-sm text-muted-foreground">
        Records {setup.sizing?.lots} lot(s) at ₹{setup.entryPremium?.toFixed(2)} in your paper
        ledger. No order is sent to your broker.
      </span>
      {take.isError && (
        <span className="w-full text-sm text-destructive">
          {take.error instanceof Error ? take.error.message : 'Could not record the trade.'}
        </span>
      )}
    </div>
  );
}
