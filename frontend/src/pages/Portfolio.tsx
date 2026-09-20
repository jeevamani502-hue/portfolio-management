import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2, AlertTriangle, Info } from 'lucide-react';
import { api } from '@/services/api';
import { isAvailable } from '@/types/api';
import {
  Card, CardHeader, CardTitle, CardContent, Skeleton, Badge, Button, Input, Label,
  Alert, EmptyState, Tabs, Tooltip,
} from '@/components/ui';
import { DataValue, Metric, MethodNote } from '@/components/market/DataValue';
import { AllocationBars } from '@/components/portfolio/AllocationBars';
import { inr, num, pct, signed, signedPct, count, directionClass, arrow } from '@/lib/format';
import { cn } from '@/lib/utils';

export function Portfolio() {
  const [tab, setTab] = useState('holdings');
  const [adding, setAdding] = useState(false);
  const qc = useQueryClient();

  const portfolios = useQuery({ queryKey: ['portfolio', 'list'], queryFn: () => api.portfolio.list() });
  const portfolioId = portfolios.data?.[0]?.id;

  const detail = useQuery({
    queryKey: ['portfolio', portfolioId, 'detail'],
    queryFn: () => api.portfolio.detail(portfolioId!),
    enabled: Boolean(portfolioId),
  });

  const analysis = useQuery({
    queryKey: ['portfolio', portfolioId, 'analysis'],
    queryFn: () => api.portfolio.analysis(portfolioId!),
    enabled: Boolean(portfolioId),
    refetchInterval: 60_000,
  });

  const removeHolding = useMutation({
    mutationFn: (holdingId: string) => api.portfolio.deleteHolding(portfolioId!, holdingId),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['portfolio'] });
    },
  });

  if (portfolios.isLoading) return <Skeleton className="h-64" />;

  if (!portfolioId) {
    return <EmptyState title="No portfolio found" description="A default portfolio is created at sign-up." />;
  }

  return (
    <div className="space-y-4">
      {/* Summary */}
      {analysis.isLoading ? (
        <Skeleton className="h-28" />
      ) : (
        <DataValue
          data={analysis.data}
          fallback={<Skeleton className="h-28" />}
        >
          {(a) => (
            <Card className="w-full">
              <CardContent className="pt-4">
                <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
                  <Metric
                    label="Current value"
                    value={inr(a.valuation.currentValue)}
                    valueClassName="text-lg"
                  />
                  <Metric label="Invested" value={inr(a.valuation.totalInvested)} />
                  <Metric
                    label="Unrealized P&L"
                    value={signed(a.valuation.unrealizedPnl)}
                    sub={a.valuation.totalReturnPct !== null ? signedPct(a.valuation.totalReturnPct) : undefined}
                    valueClassName={directionClass(a.valuation.unrealizedPnl)}
                  />
                  <Metric
                    label="Today's P&L"
                    value={signed(a.valuation.dayPnl)}
                    sub={a.valuation.dayReturnPct !== null ? signedPct(a.valuation.dayReturnPct) : undefined}
                    valueClassName={directionClass(a.valuation.dayPnl)}
                  />
                  <Metric
                    label="Realized P&L"
                    value={signed(a.valuation.realizedPnl)}
                    valueClassName={directionClass(a.valuation.realizedPnl)}
                  />
                  <Metric
                    label="XIRR"
                    value={a.xirr.xirrPct !== null ? signedPct(a.xirr.xirrPct) : 'Unavailable'}
                    sub={a.xirr.xirrPct === null ? a.xirr.reason?.replace(/_/g, ' ') : undefined}
                    method={a.xirr.method}
                    valueClassName={a.xirr.xirrPct !== null ? directionClass(a.xirr.xirrPct) : ''}
                  />
                </div>

                {a.valuation.unvaluedSymbols.length > 0 && (
                  <Alert variant="warning" className="mt-3">
                    {a.valuation.unvaluedSymbols.length} holding
                    {a.valuation.unvaluedSymbols.length === 1 ? '' : 's'} could not be priced
                    ({a.valuation.unvaluedSymbols.join(', ')}). They are excluded from the totals
                    above rather than valued at cost, so portfolio value is understated by their
                    market worth. {pct(a.valuation.valuationCoveragePct, 1)} of invested capital
                    could be priced.
                  </Alert>
                )}

                <div className="mt-2 flex items-center gap-1 text-2xs text-muted-foreground">
                  <span>How these are calculated</span>
                  <MethodNote>{a.valuation.method}</MethodNote>
                </div>
              </CardContent>
            </Card>
          )}
        </DataValue>
      )}

      <div className="flex items-center justify-between">
        <Tabs
          active={tab}
          onChange={setTab}
          tabs={[
            { id: 'holdings', label: 'Holdings' },
            { id: 'allocation', label: 'Allocation' },
            { id: 'risk', label: 'Risk' },
            { id: 'observations', label: 'Observations', badge: analysis.data && isAvailable(analysis.data) ? analysis.data.value.observations.length : undefined },
          ]}
          className="flex-1"
        />
        <Button size="sm" onClick={() => setAdding((a) => !a)}>
          <Plus className="h-3.5 w-3.5" aria-hidden />
          Add holding
        </Button>
      </div>

      {adding && <AddHoldingForm portfolioId={portfolioId} onDone={() => setAdding(false)} />}

      {tab === 'holdings' && (
        <Card>
          <CardContent className="px-0 pt-4">
            <DataValue data={analysis.data}>
              {(a) =>
                a.valuation.holdings.length === 0 ? (
                  <EmptyState
                    title="No holdings yet"
                    description="Add a holding to see valuation, allocation, concentration and risk."
                  />
                ) : (
                  <div className="w-full overflow-x-auto">
                    <table className="data-table">
                      <thead>
                        <tr>
                          <th>Symbol</th>
                          <th className="text-right">Qty</th>
                          <th className="text-right">Avg price</th>
                          <th className="text-right">LTP</th>
                          <th className="text-right">Invested</th>
                          <th className="text-right">Value</th>
                          <th className="text-right">P&amp;L</th>
                          <th className="text-right">Day P&amp;L</th>
                          <th className="text-right">Weight</th>
                          <th />
                        </tr>
                      </thead>
                      <tbody>
                        {a.valuation.holdings.map((h) => {
                          const row = detail.data?.holdings.find((d) => d.symbol === h.symbol);
                          return (
                            <tr key={h.symbol}>
                              <td>
                                <Link
                                  to={`/stocks/${encodeURIComponent(h.symbol)}`}
                                  className="font-medium hover:text-primary"
                                >
                                  {h.symbol.split(':')[1] ?? h.symbol}
                                </Link>
                                {h.sector && (
                                  <div className="text-2xs text-muted-foreground">{h.sector}</div>
                                )}
                              </td>
                              <td className="num">{count(h.quantity)}</td>
                              <td className="num">{inr(h.avgPrice)}</td>
                              <td className="num">
                                {h.priceUnavailable ? (
                                  <Tooltip content="No live price could be sourced for this instrument, so it is excluded from the portfolio totals.">
                                    <span className="text-2xs text-delayed">Unavailable</span>
                                  </Tooltip>
                                ) : (
                                  inr(h.ltp)
                                )}
                              </td>
                              <td className="num">{inr(h.invested)}</td>
                              <td className="num">{h.currentValue !== null ? inr(h.currentValue) : '—'}</td>
                              <td className={cn('num', directionClass(h.unrealizedPnl))}>
                                {h.unrealizedPnl !== null ? (
                                  <>
                                    <span aria-hidden>{arrow(h.unrealizedPnl)}</span>{' '}
                                    {signed(h.unrealizedPnl)}
                                    <div className="text-2xs">{signedPct(h.unrealizedPnlPct)}</div>
                                  </>
                                ) : '—'}
                              </td>
                              <td className={cn('num', directionClass(h.dayPnl))}>
                                {h.dayPnl !== null ? signed(h.dayPnl) : '—'}
                              </td>
                              <td className="num">{pct(h.weightPct, 1)}</td>
                              <td className="text-right">
                                {row && (
                                  <button
                                    onClick={() => removeHolding.mutate(row.id)}
                                    aria-label={`Remove ${h.symbol}`}
                                    className="text-muted-foreground transition-colors hover:text-destructive"
                                  >
                                    <Trash2 className="h-3.5 w-3.5" />
                                  </button>
                                )}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )
              }
            </DataValue>
          </CardContent>
        </Card>
      )}

      {tab === 'allocation' && (
        <DataValue data={analysis.data}>
          {(a) => (
            <div className="grid w-full gap-4 lg:grid-cols-2">
              <Card>
                <CardHeader><CardTitle>By sector</CardTitle></CardHeader>
                <CardContent>
                  <AllocationBars slices={a.allocation.bySector} />
                </CardContent>
              </Card>
              <Card>
                <CardHeader><CardTitle>By holding</CardTitle></CardHeader>
                <CardContent>
                  <AllocationBars slices={a.allocation.byInstrument} />
                </CardContent>
              </Card>
              <Card className="lg:col-span-2">
                <CardHeader><CardTitle>Concentration</CardTitle></CardHeader>
                <CardContent>
                  <div className="grid grid-cols-2 gap-4 sm:grid-cols-4 lg:grid-cols-6">
                    <Metric label="Holdings" value={String(a.concentration.positionCount)} />
                    <Metric
                      label="Effective positions"
                      value={num(a.concentration.effectivePositions, 1)}
                      method={a.concentration.method}
                    />
                    <Metric label="HHI" value={num(a.concentration.hhi, 0)} />
                    <Metric label="Largest position" value={pct(a.concentration.topHoldingPct, 1)} />
                    <Metric label="Top 3" value={pct(a.concentration.top3Pct, 1)} />
                    <Metric
                      label="Largest sector"
                      value={pct(a.concentration.topSectorPct, 1)}
                      sub={a.concentration.topSector ?? undefined}
                    />
                  </div>
                </CardContent>
              </Card>
            </div>
          )}
        </DataValue>
      )}

      {tab === 'risk' && (
        <DataValue data={analysis.data}>
          {(a) => (
            <div className="w-full space-y-4">
              <Card>
                <CardHeader><CardTitle>Risk metrics</CardTitle></CardHeader>
                <CardContent>
                  {a.risk.observations === 0 ? (
                    <Alert variant="info">
                      Risk metrics are computed from a daily portfolio-value series. The valuation
                      worker records one snapshot per trading day; volatility, drawdown, Sharpe and
                      beta will populate once at least 20 days of history exist.
                    </Alert>
                  ) : (
                    <>
                      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
                        <Metric label="Volatility (annualised)" value={pct(a.risk.volatilityPct)} />
                        <Metric label="Max drawdown" value={pct(a.risk.maxDrawdownPct)} />
                        <Metric label="Current drawdown" value={pct(a.risk.currentDrawdownPct)} />
                        <Metric label="Sharpe" value={num(a.risk.sharpe)} />
                        <Metric label="Sortino" value={num(a.risk.sortino)} />
                        <Metric label="Beta vs NIFTY 50" value={num(a.risk.beta)} />
                        <Metric label="Alpha" value={pct(a.risk.alpha)} />
                        <Metric label="Correlation" value={num(a.risk.correlation)} />
                      </div>
                      <p className="mt-3 border-t border-border pt-2 text-2xs leading-relaxed text-muted-foreground">
                        {a.risk.method}
                      </p>
                    </>
                  )}
                </CardContent>
              </Card>

              {a.correlations.length > 0 && (
                <Card>
                  <CardHeader>
                    <CardTitle>Most correlated holdings</CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-1.5">
                    {a.correlations.slice(0, 8).map((c) => (
                      <div key={`${c.a}-${c.b}`} className="flex items-center gap-3">
                        <span className="w-40 shrink-0 truncate text-2xs">
                          {c.a} · {c.b}
                        </span>
                        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
                          <div
                            className="h-full rounded-full bg-primary"
                            style={{ width: `${Math.max(2, Math.abs(c.correlation) * 100)}%` }}
                          />
                        </div>
                        <span className="tabular w-12 text-right text-2xs">
                          {num(c.correlation)}
                        </span>
                      </div>
                    ))}
                    <p className="pt-2 text-2xs text-muted-foreground">
                      Pearson correlation of daily returns over the last 120 trading days. Pairs
                      above 0.80 provide less diversification than their separate line items suggest.
                    </p>
                  </CardContent>
                </Card>
              )}
            </div>
          )}
        </DataValue>
      )}

      {tab === 'observations' && (
        <DataValue data={analysis.data}>
          {(a) => (
            <div className="w-full space-y-3">
              {a.observations.length === 0 ? (
                <EmptyState title="No observations" description="Nothing in the portfolio's structure stands out." />
              ) : (
                a.observations.map((o, i) => (
                  <Card key={i}>
                    <CardContent className="pt-4">
                      <div className="flex items-start gap-2">
                        {o.severity === 'high' ? (
                          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" aria-hidden />
                        ) : o.severity === 'attention' ? (
                          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-delayed" aria-hidden />
                        ) : (
                          <Info className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                        )}
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="text-sm font-medium">{o.title}</span>
                            <Badge variant="muted">{o.category}</Badge>
                          </div>
                          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                            {o.detail}
                          </p>
                          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 border-t border-border pt-2">
                            {Object.entries(o.evidence).map(([k, v]) => (
                              <span key={k} className="text-2xs text-muted-foreground">
                                <span className="uppercase tracking-wide">{k}:</span>{' '}
                                <span className="tabular text-foreground">
                                  {typeof v === 'number' ? num(v) : String(v ?? '—')}
                                </span>
                              </span>
                            ))}
                          </div>
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                ))
              )}
              <Alert>
                These are descriptions of what the data shows about this portfolio's structure. They
                are not recommendations, and the platform does not suggest what to buy or sell.
              </Alert>
            </div>
          )}
        </DataValue>
      )}
    </div>
  );
}

function AddHoldingForm({ portfolioId, onDone }: { portfolioId: string; onDone: () => void }) {
  const [symbol, setSymbol] = useState('');
  const [quantity, setQuantity] = useState('');
  const [avgPrice, setAvgPrice] = useState('');
  const qc = useQueryClient();

  const add = useMutation({
    mutationFn: () =>
      api.portfolio.addHolding(portfolioId, {
        symbol: symbol.trim().toUpperCase(),
        quantity: Number(quantity),
        avgPrice: Number(avgPrice),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['portfolio'] });
      setSymbol(''); setQuantity(''); setAvgPrice('');
      onDone();
    },
  });

  const valid = symbol.trim() && Number(quantity) > 0 && Number(avgPrice) >= 0;

  return (
    <Card>
      <CardContent className="pt-4">
        <form
          onSubmit={(e) => { e.preventDefault(); if (valid) add.mutate(); }}
          className="grid gap-3 sm:grid-cols-4"
        >
          <div className="space-y-1">
            <Label htmlFor="symbol">Symbol</Label>
            <Input
              id="symbol"
              value={symbol}
              onChange={(e) => setSymbol(e.target.value)}
              placeholder="RELIANCE"
              required
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="qty">Quantity</Label>
            <Input
              id="qty" type="number" step="any" min="0.0001"
              value={quantity} onChange={(e) => setQuantity(e.target.value)} required
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="avg">Average price (₹)</Label>
            <Input
              id="avg" type="number" step="any" min="0"
              value={avgPrice} onChange={(e) => setAvgPrice(e.target.value)} required
            />
          </div>
          <div className="flex items-end gap-2">
            <Button type="submit" disabled={!valid || add.isPending} className="flex-1">
              {add.isPending ? 'Adding…' : 'Add'}
            </Button>
            <Button type="button" variant="ghost" onClick={onDone}>Cancel</Button>
          </div>
        </form>
        {add.isError && (
          <Alert variant="error" className="mt-2">{(add.error as Error).message}</Alert>
        )}
        <p className="mt-2 text-2xs text-muted-foreground">
          Adding to an existing position merges by weighted average. To track XIRR and realized
          P&amp;L accurately, record dated transactions instead.
        </p>
      </CardContent>
    </Card>
  );
}
