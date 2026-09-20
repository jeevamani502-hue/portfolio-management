import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Search, AlertTriangle, ChevronDown, ChevronRight } from 'lucide-react';
import { api } from '@/services/api';
import {
  Card, CardHeader, CardTitle, CardContent, Skeleton, Badge, Button, Select, Alert, EmptyState, Tooltip,
} from '@/components/ui';
import { DataValue, SourceLine } from '@/components/market/DataValue';
import { inr, num, pct, count } from '@/lib/format';
import { isAvailable, type Sourced, type ScanResultDto, type TradeIdeaDto } from '@/types/api';

const SETUPS = [
  { id: '', label: 'All setups' },
  { id: 'BREAKOUT', label: 'Breakout' },
  { id: 'PULLBACK', label: 'Pullback' },
  { id: 'MOMENTUM', label: 'Momentum' },
  { id: 'REVERSAL', label: 'Reversal' },
  { id: 'BREAKDOWN', label: 'Breakdown' },
];

export function SwingScanner() {
  const [setup, setSetup] = useState('');
  const [tf, setTf] = useState('1d');
  const [universe, setUniverse] = useState('NIFTY50');
  const [minStrength, setMinStrength] = useState(50);
  const [submitted, setSubmitted] = useState(0);

  const scan = useQuery({
    queryKey: ['scanner', setup, tf, universe, minStrength, submitted],
    queryFn: () =>
      api.scanner.swing({
        ...(setup ? { setup } : {}),
        tf,
        universe,
        minStrength,
        limit: 30,
        maxSymbols: 200,
      }),
    // A scan is expensive; only run when the user asks.
    enabled: submitted > 0,
    staleTime: 120_000,
  });

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Swing trading scanner</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
            <div className="space-y-1">
              <label className="text-2xs uppercase tracking-wide text-muted-foreground">Setup</label>
              <Select value={setup} onChange={(e) => setSetup(e.target.value)}>
                {SETUPS.map((s) => (
                  <option key={s.id} value={s.id}>{s.label}</option>
                ))}
              </Select>
            </div>
            <div className="space-y-1">
              <label className="text-2xs uppercase tracking-wide text-muted-foreground">Timeframe</label>
              <Select value={tf} onChange={(e) => setTf(e.target.value)}>
                {['1h', '4h', '1d', '1w'].map((t) => (
                  <option key={t} value={t}>{t}</option>
                ))}
              </Select>
            </div>
            <div className="space-y-1">
              <label className="text-2xs uppercase tracking-wide text-muted-foreground">Universe</label>
              <Select value={universe} onChange={(e) => setUniverse(e.target.value)}>
                <option value="NIFTY50">NIFTY 50</option>
                <option value="NIFTYNEXT50">NIFTY Next 50</option>
                <option value="NIFTY100">NIFTY 100</option>
                <option value="NSE">All NSE equities</option>
              </Select>
            </div>
            <div className="space-y-1">
              <label className="text-2xs uppercase tracking-wide text-muted-foreground">
                Minimum confirmation ({minStrength})
              </label>
              <input
                type="range"
                min={30}
                max={90}
                step={5}
                value={minStrength}
                onChange={(e) => setMinStrength(Number(e.target.value))}
                className="h-9 w-full"
              />
            </div>
            <div className="flex items-end">
              <Button className="w-full" onClick={() => setSubmitted((s) => s + 1)} disabled={scan.isFetching}>
                <Search className="h-3.5 w-3.5" aria-hidden />
                {scan.isFetching ? 'Scanning…' : 'Run scan'}
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      {submitted === 0 && (
        <EmptyState
          title="Run a scan to see setups"
          description="Every instrument in the chosen universe is evaluated against the same rule set used on the stock-analysis page. A setup is reported only when all of its required rules pass, no disqualifying rule fires, and confirmation reaches your threshold."
        />
      )}

      {scan.isFetching && <Skeleton className="h-64" />}

      {scan.data && !scan.isFetching && (
        <DataValue data={scan.data}>
          {(result) => (
            <div className="w-full space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="text-xs text-muted-foreground">
                  {result.ideas.length} setup{result.ideas.length === 1 ? '' : 's'} from{' '}
                  {result.analyzed} analysed instruments
                  {result.skipped.length > 0 && ` · ${result.skipped.length} skipped`}
                </div>
                <ScanSource scan={scan.data} />
              </div>

              <Alert>{result.methodology}</Alert>

              {result.ideas.length === 0 ? (
                <EmptyState
                  title="No setup met the threshold"
                  description="That is a normal outcome, not an error. Lower the confirmation threshold or widen the universe to see weaker candidates."
                />
              ) : (
                <div className="space-y-3">
                  {result.ideas.map((idea) => (
                    <IdeaCard key={`${idea.symbol}-${idea.setup}`} idea={idea} />
                  ))}
                </div>
              )}

              {result.skipped.length > 0 && (
                <details className="text-2xs text-muted-foreground">
                  <summary className="cursor-pointer hover:text-foreground">
                    {result.skipped.length} instruments were skipped
                  </summary>
                  <ul className="mt-1 space-y-0.5 pl-3">
                    {result.skipped.map((s) => (
                      <li key={s.symbol}>• {s.symbol}: {s.reason}</li>
                    ))}
                  </ul>
                </details>
              )}
            </div>
          )}
        </DataValue>
      )}
    </div>
  );
}

/** Renders the provenance line only when the scan actually returned data. */
function ScanSource({ scan }: { scan: Sourced<ScanResultDto> }) {
  if (!isAvailable(scan)) return null;
  return <SourceLine source={scan.source} asOf={scan.asOf} status={scan.status} />;
}

function IdeaCard({ idea }: { idea: TradeIdeaDto }) {
  const [open, setOpen] = useState(false);
  const isLong = idea.direction === 'BULLISH';

  return (
    <Card>
      <CardContent className="pt-4">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <Link
                to={`/stocks/${encodeURIComponent(idea.symbol)}`}
                className="text-base font-semibold hover:text-primary"
              >
                {idea.tradingsymbol}
              </Link>
              <Badge variant={isLong ? 'up' : 'down'}>{idea.setupLabel}</Badge>
              <Badge variant="muted">{idea.timeframe}</Badge>
              {idea.sector && <span className="text-2xs text-muted-foreground">{idea.sector}</span>}
            </div>
            {idea.name && (
              <div className="mt-0.5 truncate text-2xs text-muted-foreground">{idea.name}</div>
            )}
          </div>

          <Tooltip content="The weighted share of this setup's confirming conditions that currently hold. It is not a probability that the idea will work.">
            <div className="text-right">
              <div className="tabular text-xl font-semibold">{idea.confidence}</div>
              <div className="text-2xs text-muted-foreground">confirmation /100</div>
            </div>
          </Tooltip>
        </div>

        {/* Levels */}
        <div className="mt-4 grid grid-cols-2 gap-3 border-t border-border pt-3 sm:grid-cols-6">
          <div>
            <div className="text-2xs uppercase tracking-wide text-muted-foreground">Last price</div>
            <div className="tabular text-sm font-medium">{inr(idea.currentPrice)}</div>
          </div>
          <div>
            <div className="text-2xs uppercase tracking-wide text-muted-foreground">Entry zone</div>
            <div className="tabular text-sm font-medium">
              {num(idea.entryLow)}–{num(idea.entryHigh)}
            </div>
          </div>
          <div>
            <div className="text-2xs uppercase tracking-wide text-destructive">Invalidation</div>
            <div className="tabular text-sm font-medium text-destructive">
              {inr(idea.invalidation)}
            </div>
          </div>
          <div>
            <div className="text-2xs uppercase tracking-wide text-muted-foreground">Target 1</div>
            <div className="tabular text-sm font-medium">{inr(idea.target1)}</div>
          </div>
          <div>
            <div className="text-2xs uppercase tracking-wide text-muted-foreground">Target 2</div>
            <div className="tabular text-sm font-medium">{inr(idea.target2)}</div>
          </div>
          <div>
            <div className="text-2xs uppercase tracking-wide text-muted-foreground">Risk / reward</div>
            <div className="tabular text-sm font-medium">{idea.riskRewardDisplay}</div>
            <div className="text-2xs text-muted-foreground">
              break-even {pct(idea.breakEvenWinRatePct, 0)}
            </div>
          </div>
        </div>

        {/* Position sizing */}
        {idea.positionSizing && (
          <div className="mt-3 rounded-md bg-muted/40 p-2.5">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-2xs">
              <span className="font-medium">Sized to your risk settings:</span>
              <span className="tabular">{count(idea.positionSizing.quantity)} units</span>
              <span className="tabular">{inr(idea.positionSizing.positionValue)} position</span>
              <span className="tabular">
                {inr(idea.positionSizing.capitalAtRisk)} at risk (
                {pct(idea.positionSizing.riskPct)})
              </span>
              <span className="text-muted-foreground">
                limited by {idea.positionSizing.limitedBy.replace(/_/g, ' ')}
              </span>
            </div>
            {idea.positionSizing.warnings.length > 0 && (
              <ul className="mt-1.5 space-y-0.5">
                {idea.positionSizing.warnings.map((w, i) => (
                  <li key={i} className="flex items-start gap-1 text-2xs text-delayed">
                    <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" aria-hidden />
                    {w}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        <button
          onClick={() => setOpen((o) => !o)}
          className="mt-3 flex items-center gap-1 text-2xs text-primary hover:underline"
        >
          {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
          {open ? 'Hide' : 'Show'} reasoning, level derivation and risks
        </button>

        {open && (
          <div className="mt-3 grid gap-4 border-t border-border pt-3 md:grid-cols-3">
            <div>
              <div className="mb-1 text-2xs font-semibold uppercase tracking-wide text-muted-foreground">
                Why it matched
              </div>
              <ul className="space-y-1">
                {idea.technicalReasons.map((r, i) => (
                  <li key={i} className="text-2xs leading-relaxed">• {r}</li>
                ))}
              </ul>
            </div>
            <div>
              <div className="mb-1 text-2xs font-semibold uppercase tracking-wide text-muted-foreground">
                How the levels were derived
              </div>
              <ul className="space-y-1">
                {idea.levelDerivation.map((r, i) => (
                  <li key={i} className="text-2xs leading-relaxed">• {r}</li>
                ))}
              </ul>
            </div>
            <div>
              <div className="mb-1 text-2xs font-semibold uppercase tracking-wide text-destructive">
                Risk factors
              </div>
              <ul className="space-y-1">
                {idea.riskFactors.map((r, i) => (
                  <li key={i} className="text-2xs leading-relaxed">• {r}</li>
                ))}
              </ul>
            </div>

            {idea.positionSizing && (
              <div className="md:col-span-3">
                <div className="mb-1 text-2xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Position-size calculation
                </div>
                <ol className="space-y-0.5">
                  {idea.positionSizing.explain.map((e, i) => (
                    <li key={i} className="tabular text-2xs text-muted-foreground">{e}</li>
                  ))}
                </ol>
              </div>
            )}

            <div className="md:col-span-3">
              <Alert variant="warning">{idea.disclaimer}</Alert>
              <div className="mt-1.5 text-2xs text-muted-foreground">
                Data source: {idea.dataSource} · as of {idea.dataAsOf}
              </div>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
