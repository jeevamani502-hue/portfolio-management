import { useState } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip as RTooltip, ResponsiveContainer, ReferenceLine,
} from 'recharts';
import { Play, AlertTriangle } from 'lucide-react';
import { api } from '@/services/api';
import {
  Card, CardHeader, CardTitle, CardDescription, CardContent, Skeleton, Badge, Button,
  Input, Label, Select, Alert, EmptyState,
} from '@/components/ui';
import { Metric } from '@/components/market/DataValue';
import { inr, num, pct, signedPct, signed, istDate, count } from '@/lib/format';
import { cn } from '@/lib/utils';

export function Backtesting() {
  const [symbol, setSymbol] = useState('RELIANCE');
  const [strategy, setStrategy] = useState('ema_crossover');
  const [timeframe, setTimeframe] = useState('1d');
  const [segment, setSegment] = useState('EQ_DELIVERY');
  const [capital, setCapital] = useState(500000);
  const [params, setParams] = useState<Record<string, number>>({});

  const strategies = useQuery({
    queryKey: ['backtest', 'strategies'],
    queryFn: () => api.backtest.strategies(),
  });

  const run = useMutation({
    mutationFn: () =>
      api.backtest.run({
        symbol, strategy, timeframe, segment,
        initialCapital: capital,
        params,
        bars: 750,
      }),
  });

  const selected = strategies.data?.data.find((s) => s.key === strategy);

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Strategy backtest</CardTitle>
          <CardDescription>
            Signals are computed on bars up to the current bar and fill at the next bar's open, so
            the engine cannot see the future. The full Indian cost stack is deducted on both legs.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
            <div className="space-y-1">
              <Label htmlFor="bt-symbol">Symbol</Label>
              <Input id="bt-symbol" value={symbol} onChange={(e) => setSymbol(e.target.value.toUpperCase())} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="bt-strategy">Strategy</Label>
              <Select
                id="bt-strategy"
                value={strategy}
                onChange={(e) => { setStrategy(e.target.value); setParams({}); }}
              >
                {(strategies.data?.data ?? []).map((s) => (
                  <option key={s.key} value={s.key}>{s.name}</option>
                ))}
              </Select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="bt-tf">Timeframe</Label>
              <Select id="bt-tf" value={timeframe} onChange={(e) => setTimeframe(e.target.value)}>
                {['15m', '1h', '1d', '1w'].map((t) => <option key={t} value={t}>{t}</option>)}
              </Select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="bt-seg">Cost segment</Label>
              <Select id="bt-seg" value={segment} onChange={(e) => setSegment(e.target.value)}>
                <option value="EQ_DELIVERY">Equity delivery</option>
                <option value="EQ_INTRADAY">Equity intraday</option>
                <option value="FUT">Futures</option>
                <option value="OPT">Options</option>
              </Select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="bt-capital">Initial capital (₹)</Label>
              <Input
                id="bt-capital" type="number" min={1000} step={10000}
                value={capital} onChange={(e) => setCapital(Number(e.target.value))}
              />
            </div>
          </div>

          {selected && (
            <>
              <p className="text-2xs leading-relaxed text-muted-foreground">
                {selected.description}
              </p>
              <div className="grid gap-3 sm:grid-cols-4">
                {Object.entries(selected.params).map(([key, spec]) => (
                  <div key={key} className="space-y-1">
                    <Label htmlFor={`p-${key}`}>{spec.label}</Label>
                    <Input
                      id={`p-${key}`}
                      type="number"
                      min={spec.min}
                      max={spec.max}
                      step="any"
                      value={params[key] ?? spec.default}
                      onChange={(e) => setParams((p) => ({ ...p, [key]: Number(e.target.value) }))}
                    />
                  </div>
                ))}
              </div>
            </>
          )}

          <Button onClick={() => run.mutate()} disabled={run.isPending || !symbol}>
            <Play className="h-3.5 w-3.5" aria-hidden />
            {run.isPending ? 'Running…' : 'Run backtest'}
          </Button>
        </CardContent>
      </Card>

      {run.isError && <Alert variant="error">{(run.error as Error).message}</Alert>}
      {run.isPending && <Skeleton className="h-96" />}

      {run.data && (
        <>
          <Alert variant="warning" title="Historical simulation">
            {run.data.disclaimer}
          </Alert>

          <Card>
            <CardHeader>
              <CardTitle>
                {run.data.symbol} · {run.data.strategy} · {run.data.timeframe}
              </CardTitle>
              <CardDescription>
                {run.data.period.bars} bars from {istDate(run.data.period.from)} to{' '}
                {istDate(run.data.period.to)}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-2 gap-4 sm:grid-cols-4 lg:grid-cols-6">
                <Metric
                  label="Total return"
                  value={signedPct(run.data.result.totalReturnPct)}
                  valueClassName={run.data.result.totalReturnPct >= 0 ? 'text-up' : 'text-down'}
                />
                <Metric label="CAGR" value={run.data.result.cagr !== null ? pct(run.data.result.cagr) : '—'} />
                <Metric label="Max drawdown" value={pct(run.data.result.maxDrawdownPct)} />
                <Metric label="Win rate" value={pct(run.data.result.winRate)} />
                <Metric label="Profit factor" value={num(run.data.result.profitFactor)} />
                <Metric label="Sharpe" value={num(run.data.result.sharpe)} />
                <Metric label="Trades" value={String(run.data.result.tradeCount)} />
                <Metric label="Avg win" value={inr(run.data.result.avgWin)} />
                <Metric label="Avg loss" value={inr(run.data.result.avgLoss)} />
                <Metric label="Expectancy" value={inr(run.data.result.expectancy)} />
                <Metric
                  label="Total charges"
                  value={inr(run.data.result.totalCharges)}
                  method="Brokerage, STT, exchange transaction charges, SEBI fee, GST and stamp duty on both legs of every trade."
                />
                <Metric
                  label="Cost drag"
                  value={pct(run.data.result.costDragPct)}
                  sub={`gross ${signedPct(run.data.result.grossReturnPct)}`}
                  method="The difference between the return before costs and the return after them."
                />
              </div>
            </CardContent>
          </Card>

          {run.data.result.warnings.length > 0 && (
            <Alert variant="warning">
              <ul className="space-y-0.5">
                {run.data.result.warnings.map((w, i) => (
                  <li key={i} className="flex items-start gap-1">
                    <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" aria-hidden />
                    {w}
                  </li>
                ))}
              </ul>
            </Alert>
          )}

          <Card>
            <CardHeader>
              <CardTitle>Equity curve</CardTitle>
            </CardHeader>
            <CardContent>
              <ResponsiveContainer width="100%" height={280}>
                <LineChart
                  data={run.data.result.equityCurve.map((p) => ({
                    ts: p.ts.slice(0, 10),
                    equity: Math.round(p.equity),
                  }))}
                  margin={{ top: 4, right: 8, bottom: 4, left: 8 }}
                >
                  <CartesianGrid
                    strokeDasharray="3 3"
                    stroke="hsl(var(--border))"
                    vertical={false}
                  />
                  <XAxis
                    dataKey="ts"
                    tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }}
                    stroke="hsl(var(--border))"
                    minTickGap={40}
                  />
                  <YAxis
                    tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }}
                    stroke="hsl(var(--border))"
                    tickFormatter={(v: number) => `${(v / 100000).toFixed(1)}L`}
                    width={48}
                  />
                  {/* Starting capital is the reference the curve is judged against. */}
                  <ReferenceLine
                    y={run.data.result.initialCapital}
                    stroke="hsl(var(--muted-foreground))"
                    strokeDasharray="4 4"
                    label={{
                      value: 'Start',
                      position: 'insideTopLeft',
                      fontSize: 10,
                      fill: 'hsl(var(--muted-foreground))',
                    }}
                  />
                  <RTooltip
                    contentStyle={{
                      background: 'hsl(var(--card))',
                      border: '1px solid hsl(var(--border))',
                      borderRadius: 6,
                      fontSize: 11,
                    }}
                    formatter={(v: number) => [inr(v), 'Equity']}
                  />
                  <Line
                    type="monotone"
                    dataKey="equity"
                    stroke="hsl(var(--primary))"
                    strokeWidth={2}
                    dot={false}
                  />
                </LineChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Trades ({run.data.result.trades.length})</CardTitle>
            </CardHeader>
            <CardContent className="px-0">
              {run.data.result.trades.length === 0 ? (
                <EmptyState
                  title="No trades were taken"
                  description="The strategy produced no entry signal over this period. Try a different parameter set, timeframe or symbol."
                />
              ) : (
                <div className="max-h-96 overflow-auto">
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>Entry</th>
                        <th className="text-right">Price</th>
                        <th>Exit</th>
                        <th className="text-right">Price</th>
                        <th className="text-right">Qty</th>
                        <th className="text-right">Bars</th>
                        <th className="text-right">Gross</th>
                        <th className="text-right">Charges</th>
                        <th className="text-right">Net</th>
                        <th>Reason</th>
                      </tr>
                    </thead>
                    <tbody>
                      {run.data.result.trades.map((t, i) => (
                        <tr key={i}>
                          <td className="text-2xs">{istDate(t.entryTs)}</td>
                          <td className="num">{num(t.entryPrice)}</td>
                          <td className="text-2xs">{istDate(t.exitTs)}</td>
                          <td className="num">{num(t.exitPrice)}</td>
                          <td className="num">{count(t.quantity)}</td>
                          <td className="num">{t.barsHeld}</td>
                          <td className="num">{signed(t.grossPnl, 0)}</td>
                          <td className="num text-muted-foreground">{num(t.charges, 0)}</td>
                          <td className={cn('num', t.netPnl >= 0 ? 'text-up' : 'text-down')}>
                            {signed(t.netPnl, 0)}
                          </td>
                          <td>
                            <Badge variant="muted">{t.exitReason.replace(/_/g, ' ')}</Badge>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>

          <Alert>{run.data.result.methodology}</Alert>
        </>
      )}
    </div>
  );
}
