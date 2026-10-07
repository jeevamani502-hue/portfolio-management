/**
 * The F&O trade decision: a graded checklist, and the plan that goes with it.
 *
 * Capital starts blank on purpose. The server refuses a request without it,
 * and pre-filling a number would be this app deciding how much of someone's
 * money is at stake. The user types it; everything else is computed.
 *
 * The panel never shows a verdict without the checklist beneath it. A grade
 * on its own is an instruction; a grade with every factor and its observed
 * value is something the user can check and disagree with.
 */
import { useEffect, useRef, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/services/api';
import {
  Card, CardHeader, CardTitle, CardContent, Skeleton, Badge, Alert, EmptyState,
  Button, Input, Label, Tooltip,
} from '@/components/ui';
import { DataValue, Metric, SourceLine } from '@/components/market/DataValue';
import { cn } from '@/lib/utils';
import type { FnoDecisionDto, OptionSetupDto } from '@/types/api';
import { TradingChart } from '@/components/chart/TradingChart';
import { DecisionChecklist } from '@/components/fno/DecisionChecklist';

/**
 * Index options are written on the index, which this platform stores under a
 * different symbol from the F&O root: BANKNIFTY options track "NIFTY BANK".
 * Mirrors `underlyingInstrumentFor` on the server.
 */
const UNDERLYING_INSTRUMENT: Record<string, string> = {
  NIFTY: 'INDICES:NIFTY 50',
  BANKNIFTY: 'INDICES:NIFTY BANK',
  FINNIFTY: 'INDICES:NIFTY FIN SERVICE',
  MIDCPNIFTY: 'INDICES:NIFTY MIDCAP SELECT',
};

const inr = (n: number | null | undefined, dp = 2) =>
  n === null || n === undefined
    ? '—'
    : `₹${n.toLocaleString('en-IN', { minimumFractionDigits: dp, maximumFractionDigits: dp })}`;

const STANCE_STYLE: Record<FnoDecisionDto['stance'], { label: string; variant: 'up' | 'warning' | 'muted'; bar: string }> = {
  ENTER: { label: 'Enter', variant: 'up', bar: 'bg-up' },
  WAIT: { label: 'Wait', variant: 'warning', bar: 'bg-delayed' },
  AVOID: { label: 'No trade', variant: 'muted', bar: 'bg-muted-foreground/50' },
};

export function TradeSetupPanel({ underlying, expiry }: { underlying: string; expiry: string }) {
  const [capitalText, setCapitalText] = useState('');
  const [riskText, setRiskText] = useState('1');
  const [submitted, setSubmitted] = useState<{ capital: number; riskPercent: number } | null>(null);
  const [prefilledFrom, setPrefilledFrom] = useState<string | null>(null);
  const prefilled = useRef(false);

  // Capital is still never invented — but the user has usually stated it
  // already, on the Paper Trading page or in Settings. Reusing that number
  // and running the checklist straight away is the difference between a
  // page that shows the decision and a page that shows an empty form.
  const paperConfig = useQuery({ queryKey: ['paper', 'config'], queryFn: api.paper.config });
  const settings = useQuery({ queryKey: ['settings'], queryFn: api.settings.get });

  useEffect(() => {
    if (prefilled.current || submitted !== null || capitalText !== '') return;
    if (paperConfig.isLoading || settings.isLoading) return;
    const fromPaper = paperConfig.data && Number(paperConfig.data.capital) > 0
      ? { capital: Number(paperConfig.data.capital), risk: Number(paperConfig.data.risk_per_trade_pct), label: 'your Paper Trading settings' }
      : null;
    const fromSettings = settings.data && settings.data.risk.capital > 0
      ? { capital: settings.data.risk.capital, risk: settings.data.risk.maxRiskPerTradePct, label: 'your risk settings' }
      : null;
    const pick = fromPaper ?? fromSettings;
    prefilled.current = true;
    if (!pick) return;
    const risk = Math.min(10, Math.max(0.1, pick.risk));
    setCapitalText(String(pick.capital));
    setRiskText(String(risk));
    setPrefilledFrom(pick.label);
    setSubmitted({ capital: pick.capital, riskPercent: risk });
  }, [paperConfig.data, paperConfig.isLoading, settings.data, settings.isLoading, submitted, capitalText]);

  const capital = Number(capitalText.replace(/[^0-9.]/g, ''));
  const riskPercent = Number(riskText);
  const inputsValid = capital > 0 && riskPercent >= 0.1 && riskPercent <= 10;

  const decision = useQuery({
    queryKey: ['fno', underlying, 'decision', expiry, submitted?.capital, submitted?.riskPercent],
    queryFn: () =>
      api.fno.decision(underlying, {
        capital: submitted!.capital,
        riskPercent: submitted!.riskPercent,
        ...(expiry ? { expiry } : {}),
      }),
    enabled: submitted !== null,
    // The chain refreshes every minute; the decision should not be older.
    refetchInterval: 60_000,
  });

  const sourced = decision.data?.data;
  const value = sourced && sourced.status !== 'unavailable' ? sourced.value : null;
  const plan = value?.plan ?? null;

  // The plan's own levels on the underlying, so it is visible against the
  // price it depends on rather than only in a table.
  const chartLines = plan
    ? [
        { price: plan.underlyingStop, label: 'Invalidation', color: 'hsl(0 72% 51%)', dashed: true },
        { price: plan.underlyingTarget1, label: 'Target 1', color: 'hsl(160 84% 39%)', dashed: true },
        { price: plan.underlyingTarget2, label: 'Target 2', color: 'hsl(160 60% 50%)', dashed: true },
      ]
    : [];

  return (
    <div className="space-y-4">
      <TradingChart
        symbol={UNDERLYING_INSTRUMENT[underlying] ?? `NSE:${underlying}`}
        title={`${underlying} — underlying`}
        priceLines={chartLines}
      />

      <Card>
        <CardHeader>
          <CardTitle>Run the checklist</CardTitle>
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
              {submitted ? 'Re-run' : 'Run the checklist'}
            </Button>
            {submitted && sourced && sourced.status !== 'unavailable' && (
              <SourceLine source={sourced.source} asOf={sourced.asOf} status={sourced.status} className="ml-auto" />
            )}
          </form>
          <p className="mt-3 text-2xs leading-relaxed text-muted-foreground">
            {prefilledFrom && (
              <>Capital and risk are prefilled from {prefilledFrom} — change them and re-run if this trade is sized differently. </>
            )}
            Direction from the daily bars, timing from the 15-minute bars, positioning from the
            option chain, volatility from IV and India VIX, sizing from the amount you enter. Every
            factor is shown with the number that decided it. The grade counts agreeing conditions —
            it is not a probability of profit.
          </p>
        </CardContent>
      </Card>

      {submitted === null ? (
        <EmptyState
          title="Enter your capital to run the checklist"
          description="The engine grades the trade A, B or C, tells you to enter, wait or stay out, and lays out the entry zone, stop, both targets, the time stop and the order in which to apply the exits."
        />
      ) : decision.isLoading ? (
        <Skeleton className="h-96" />
      ) : (
        <DataValue data={sourced}>
          {(d) => (
            <DecisionResult d={d} underlying={underlying} capital={submitted.capital} riskPercent={submitted.riskPercent} />
          )}
        </DataValue>
      )}
    </div>
  );
}

function DecisionResult({
  d, underlying, capital, riskPercent,
}: { d: FnoDecisionDto; underlying: string; capital: number; riskPercent: number }) {
  const stance = STANCE_STYLE[d.stance];
  const evaluable = d.factors.filter((f) => f.verdict !== 'na');
  const passing = evaluable.filter((f) => f.verdict === 'pass').length;
  const isCall = d.action === 'BUY_CALL' || (d.action === 'NO_TRADE' && d.bias === 'BULLISH');
  const contract = d.setup.strike !== null && d.setup.optionType
    ? `${d.underlying} ${d.setup.strike} ${d.setup.optionType}`
    : d.underlying;

  return (
    <div className="space-y-4">
      {/* Verdict */}
      <Card>
        <CardHeader>
          <CardTitle className="flex flex-wrap items-center gap-2">
            <Badge variant={stance.variant}>{stance.label}</Badge>
            {d.grade !== 'NONE' && <Badge variant="outline">Grade {d.grade}</Badge>}
            {d.bias !== 'NEUTRAL' && (
              <span className={isCall ? 'text-up' : 'text-down'}>
                {d.bias === 'BULLISH' ? 'Buy call' : 'Buy put'}
              </span>
            )}
            <span className="font-mono">{contract}</span>
            <Badge variant="muted">{d.expiry} · {d.daysToExpiry}d</Badge>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <div className="mb-1 flex items-baseline justify-between">
              <span className="text-2xs uppercase tracking-wide text-muted-foreground">
                Readable conditions agreeing
              </span>
              <span className="font-mono text-sm">
                {d.score} / 100
                <span className="ml-1.5 text-2xs text-muted-foreground">({passing} of {evaluable.length})</span>
              </span>
            </div>
            <div className="h-1.5 w-full overflow-hidden rounded bg-muted">
              <div className={cn('h-full rounded', stance.bar)} style={{ width: `${d.score}%` }} />
            </div>
            <p className="mt-1.5 text-2xs text-muted-foreground">
              {d.coverage}% of the checklist could be read. A count of agreeing conditions — not a
              probability of profit.
            </p>
          </div>

          <p className="text-sm leading-relaxed">{d.summary}</p>

          {!d.entryWindowOpen && <Alert variant="info">{d.sessionNote}</Alert>}

          {d.stance !== 'ENTER' && d.holdBecause.length > 0 && (
            <div>
              <div className="mb-1 text-2xs uppercase tracking-wide text-muted-foreground">
                {d.stance === 'WAIT' ? 'Why wait' : 'Why no trade'}
              </div>
              <ul className="space-y-1.5">
                {d.holdBecause.map((r) => (
                  <li key={r} className="text-sm leading-relaxed">— {r}</li>
                ))}
              </ul>
            </div>
          )}
        </CardContent>
      </Card>

      {/* The plan */}
      {d.plan && (
        <Card>
          <CardHeader>
            <CardTitle>
              The plan{d.stance !== 'ENTER' && <span className="ml-2 text-sm font-normal text-muted-foreground">— what the trade would look like</span>}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
              <Metric
                label="Entry zone"
                value={`${inr(d.plan.entryZone.low)} – ${inr(d.plan.entryZone.high)}`}
                method="Inside the quoted spread. A limit order here is a reasonable fill; chasing above it changes the risk:reward."
              />
              <Metric label="Stop (nominal)" value={inr(d.plan.stopPremium)} sub={`${underlying} ${d.plan.underlyingStop.toFixed(0)}`} />
              <Metric label="Target 1" value={inr(d.plan.target1Premium)} sub={`${underlying} ${d.plan.underlyingTarget1.toFixed(0)}${d.plan.rewardRisk1 !== null ? ` · ${d.plan.rewardRisk1.toFixed(2)}R` : ''}`} />
              <Metric label="Target 2" value={inr(d.plan.target2Premium)} sub={`${underlying} ${d.plan.underlyingTarget2.toFixed(0)}${d.plan.rewardRisk2 !== null ? ` · ${d.plan.rewardRisk2.toFixed(2)}R` : ''}`} />
              <Metric label="Lots" value={`${d.plan.lots} × ${d.setup.lotSize ?? '—'}`} sub={`${d.plan.quantity} contracts`} />
              <Metric label="Premium outlay" value={inr(d.plan.premiumOutlay, 0)} sub="the most that can be lost" />
              <Metric label="Risk at stop" value={inr(d.plan.riskAtStop, 0)} sub={`${riskPercent}% of ${inr(capital, 0)}`} />
              <Metric label="Delta" value={d.setup.delta?.toFixed(3) ?? '—'} method="First-order sensitivity of the premium to a one-point move in the underlying. Used to map the underlying's levels onto the premium; it understates gains and overstates losses on a large move." />
            </div>

            <div>
              <div className="mb-1.5 text-2xs uppercase tracking-wide text-muted-foreground">Exits, in order</div>
              <ol className="space-y-1.5">
                {d.plan.exitRules.map((rule, i) => (
                  <li key={rule} className="flex gap-2 text-sm leading-relaxed">
                    <span className="shrink-0 font-mono text-muted-foreground">{i + 1}.</span>
                    <span>{rule}</span>
                  </li>
                ))}
              </ol>
            </div>

            <Alert variant="default" title="Time stop">{d.plan.timeStop}</Alert>

            {d.stance === 'ENTER' ? (
              <>
                <TakeTradeButton underlying={underlying} setup={d.setup} />
                <ExecuteLiveButton underlying={underlying} setup={d.setup} lots={d.plan.lots} outlay={d.plan.premiumOutlay} />
              </>
            ) : (
              <p className="text-2xs leading-relaxed text-muted-foreground">
                The paper-trade button appears when the stance is Enter. The tracker still journals
                Enter-grade decisions and follows them to resolution.
              </p>
            )}

            <AlertMeButton underlying={underlying} capital={capital} riskPercent={riskPercent} />
          </CardContent>
        </Card>
      )}

      {/* Checklist */}
      <Card>
        <CardHeader>
          <CardTitle>The checklist</CardTitle>
        </CardHeader>
        <CardContent>
          <DecisionChecklist factors={d.factors} />
          {d.gatesFailed.length > 0 && (
            <Alert variant="warning" title="Gates failed" className="mt-4">
              <ul className="space-y-1">
                {d.gatesFailed.map((g) => <li key={g}>— {g}</li>)}
              </ul>
            </Alert>
          )}
        </CardContent>
      </Card>

      {d.whatChangesMyMind.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>What would change this read</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="space-y-1.5">
              {d.whatChangesMyMind.map((w) => (
                <li key={w} className="text-sm leading-relaxed">— {w}</li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      {d.setup.warnings.length > 0 && (
        <Alert variant="warning" title="Against this trade">
          <ul className="space-y-1.5">
            {d.setup.warnings.map((w) => (
              <li key={w} className="text-sm leading-relaxed">— {w}</li>
            ))}
          </ul>
        </Alert>
      )}

      {d.setup.evidence.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Every number behind the pricing</CardTitle>
          </CardHeader>
          <CardContent>
            <EvidenceGrid items={d.setup.evidence} />
          </CardContent>
        </Card>
      )}
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
 * One-click entry into the plan shown above.
 *
 * It records the trade in the paper ledger — no order reaches a broker. The
 * button is explicit about that, because a control that looks like it might
 * place a real order is the last place to be ambiguous.
 */
function TakeTradeButton({ underlying, setup }: { underlying: string; setup: OptionSetupDto }) {
  const qc = useQueryClient();
  const take = useMutation({
    mutationFn: () => api.paper.take(underlying),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['paper'] }),
  });

  if (take.isSuccess) {
    return (
      <Alert variant="info" title="Recorded in your paper ledger">
        {setup.underlying} {setup.strike} {setup.optionType} is now an open paper position. The
        advisor checks it every few minutes and tells you when to close it. Track it on the Paper
        Trading page.
      </Alert>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-3 rounded border border-border bg-muted/30 p-3">
      <Button onClick={() => take.mutate()} disabled={take.isPending}>
        {take.isPending ? 'Recording…' : 'Take this trade (paper)'}
      </Button>
      <span className="text-sm text-muted-foreground">
        Records {setup.sizing?.lots} lot(s) at about ₹{setup.entryPremium?.toFixed(2)} in your paper
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

/**
 * Send the plan to the broker as a real order — Confirm mode only.
 *
 * Shown only when live trading is armed in CONFIRM or AUTO mode, and it
 * still asks once more with the rupee amount before anything is sent. The
 * server re-runs every guard at the moment of the order.
 */
function ExecuteLiveButton({ underlying, setup, lots, outlay }: { underlying: string; setup: OptionSetupDto; lots: number; outlay: number }) {
  const qc = useQueryClient();
  const status = useQuery({ queryKey: ['live', 'status'], queryFn: api.live.status, refetchInterval: 15_000 });
  const exec = useMutation({
    mutationFn: () => api.live.execute(underlying),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['live'] }),
  });
  const s = status.data;
  if (!s || !s.config || s.config.mode === 'OFF' || !s.armed) return null;

  if (exec.isSuccess) {
    return (
      <Alert variant="warning" title="Live order sent">
        Order {exec.data.orderId} placed for {setup.underlying} {setup.strike} {setup.optionType}. The
        exit manager now holds the plan. Watch it on the Live Trading page.
      </Alert>
    );
  }
  const blocked = s.blockers[0]?.detail ?? null;
  return (
    <div className="flex flex-wrap items-center gap-3 rounded border border-delayed/40 bg-delayed/10 p-3">
      <Button
        variant="destructive"
        disabled={exec.isPending || blocked !== null}
        onClick={() => {
          if (window.confirm(`Place a REAL order at ${s.broker}: buy ${lots} lot(s) ${setup.underlying} ${setup.strike} ${setup.optionType}, about ₹${outlay.toFixed(0)} of premium at risk?`)) exec.mutate();
        }}
      >
        {exec.isPending ? 'Sending…' : 'Execute live'}
      </Button>
      <span className="text-sm text-muted-foreground">
        {blocked ?? `Armed in ${s.config.mode} mode. Sends a limit order inside the entry zone to ${s.broker}; cancelled if unfilled in ${s.config.entry_timeout_sec}s.`}
      </span>
      {exec.isError && <span className="w-full text-sm text-destructive">{exec.error instanceof Error ? exec.error.message : 'Order not placed.'}</span>}
    </div>
  );
}

/**
 * Create the standing alert for this underlying in one click.
 *
 * The alert re-runs this same checklist every thirty seconds while the
 * market is open and notifies on a new Enter-grade decision — and the
 * tracker then notifies again at each exit. Capital and risk are copied
 * from what was just typed, so the alert sizes exactly as the page did.
 */
function AlertMeButton({ underlying, capital, riskPercent }: { underlying: string; capital: number; riskPercent: number }) {
  const qc = useQueryClient();
  const create = useMutation({
    mutationFn: () =>
      api.alerts.create({
        kind: 'FNO_SETUP',
        name: `${underlying} F&O engine`,
        params: { underlying, capital, riskPercent, minGrade: 'B', minConfirmation: 50 },
        timeframe: '1d',
        channels: ['browser'],
        repeatMode: 'ALWAYS',
        cooldownSec: 300,
      }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['alerts'] }),
  });

  if (create.isSuccess) {
    return (
      <Alert variant="info" title={`Watching ${underlying}`}>
        You will be notified — here and, if enabled, on your desktop — when the engine grades a new
        {' '}{underlying} trade B or better, and again when its stop, targets or time stop are hit.
        Manage it on the Alerts page.
      </Alert>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-3">
      <Tooltip content="Creates an F&O engine alert with this capital and risk. It runs every 30 seconds during the session and notifies on a new grade-B-or-better decision, then at every exit.">
        <Button variant="outline" onClick={() => create.mutate()} disabled={create.isPending}>
          {create.isPending ? 'Creating…' : `Alert me on ${underlying} setups`}
        </Button>
      </Tooltip>
      {create.isError && (
        <span className="text-sm text-destructive">
          {create.error instanceof Error ? create.error.message : 'Could not create the alert.'}
        </span>
      )}
    </div>
  );
}
