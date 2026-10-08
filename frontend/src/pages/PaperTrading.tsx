/**
 * Paper trading — run the strategy on real prices with no money.
 *
 * The page is built around one question: does this strategy make money? So
 * net P&L after costs is the headline, gross is shown beside it, and the
 * sample-size caveat is a permanent fixture rather than fine print — a
 * handful of trades says almost nothing, and the page should not let a good
 * first week read as proof.
 */
import { useEffect, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/services/api';
import {
  Card, CardHeader, CardTitle, CardContent, Skeleton, Badge, Alert, EmptyState,
  Button, Input, Label, Tabs,
} from '@/components/ui';
import { Metric } from '@/components/market/DataValue';
import { useTicks } from '@/services/ws';
import { cn } from '@/lib/utils';
import type { PaperConfigDto, PaperTradeDto, PositionAdviceDto } from '@/types/api';
import { EngineStatus } from '@/components/paper/EngineStatus';

const inr = (v: number | string | null | undefined, dp = 0) => {
  const n = typeof v === 'string' ? Number(v) : v;
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  return `₹${n.toLocaleString('en-IN', { maximumFractionDigits: dp, minimumFractionDigits: dp })}`;
};

const pnlClass = (n: number | null) =>
  n === null ? '' : n > 0 ? 'text-bull' : n < 0 ? 'text-bear' : '';

export function PaperTrading() {
  const qc = useQueryClient();
  const [tab, setTab] = useState('open');

  const config = useQuery({ queryKey: ['paper', 'config'], queryFn: api.paper.config });
  const perf = useQuery({ queryKey: ['paper', 'performance'], queryFn: api.paper.performance });
  const advice = useQuery({
    queryKey: ['paper', 'advice'],
    queryFn: api.paper.advice,
    // The advisor prices every open position, so this is not free.
    refetchInterval: 60_000,
  });
  const trades = useQuery({
    queryKey: ['paper', 'trades', tab],
    queryFn: () => api.paper.trades({ status: tab === 'open' ? 'OPEN' : 'CLOSED', limit: 200 }),
  });

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ['paper'] });
  };

  const sweep = useMutation({ mutationFn: api.paper.sweep, onSuccess: invalidate });
  const close = useMutation({ mutationFn: api.paper.close, onSuccess: invalidate });

  if (config.isLoading) return <Skeleton className="h-96" />;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold">Paper trading</h1>
          <p className="text-sm text-muted-foreground">
            The strategy runs on live prices and records what it would have done. No order ever
            reaches a broker.
          </p>
        </div>
        <Button
          variant="outline"
          onClick={() => sweep.mutate()}
          disabled={sweep.isPending || !config.data?.is_enabled}
        >
          {sweep.isPending ? 'Running…' : 'Run a sweep now'}
        </Button>
      </div>

      <EngineStatus />

      {sweep.data && (
        <Alert
          variant={sweep.data.entries.opened > 0 ? 'info' : 'default'}
          title={`Sweep: ${sweep.data.entries.opened} opened, ${sweep.data.exits.closed} closed`}
        >
          {sweep.data.entries.skipped.length > 0 && (
            <ul className="space-y-1">
              {sweep.data.entries.skipped.map((s) => (
                <li key={s} className="text-sm leading-relaxed">— {s}</li>
              ))}
            </ul>
          )}
        </Alert>
      )}

      {(advice.data ?? []).length > 0 ? (
        <AdvicePanel
          advice={advice.data!}
          onClose={(id) => close.mutate(id)}
          closing={close.isPending}
        />
      ) : (
        <Card>
          <CardHeader>
            <CardTitle>What I would do</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm leading-relaxed text-muted-foreground">
              Nothing open to advise on. Once a position exists — from a sweep, or from
              &ldquo;Take this trade&rdquo; on the F&amp;O page — this panel checks it every minute
              and says whether to hold, watch, or close, with the numbers behind the call.
            </p>
          </CardContent>
        </Card>
      )}

      <ConfigCard config={config.data ?? null} onSaved={invalidate} />

      {perf.data && (
        <Card>
          <CardHeader>
            <CardTitle>Results</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
              <Metric
                label="Net P&L (after costs)"
                value={inr(perf.data.netPnl, 2)}
                className={pnlClass(perf.data.netPnl)}
              />
              <Metric label="Gross P&L" value={inr(perf.data.grossPnl, 2)} />
              <Metric label="Costs paid" value={inr(perf.data.totalCosts, 2)} />
              <Metric
                label="Return on capital"
                value={perf.data.returnPct === null ? '—' : `${perf.data.returnPct.toFixed(2)}%`}
                className={pnlClass(perf.data.returnPct)}
              />
              <Metric label="Open" value={perf.data.openTrades} />
              <Metric label="Closed" value={perf.data.closedTrades} />
            </div>

            {perf.data.closedTrades > 0 && (
              <div className="grid grid-cols-2 gap-4 border-t border-border pt-4 sm:grid-cols-3 lg:grid-cols-6">
                <Metric
                  label="Win rate"
                  value={perf.data.winRate === null ? '—' : `${perf.data.winRate.toFixed(0)}%`}
                />
                <Metric label="Wins / losses" value={`${perf.data.wins} / ${perf.data.losses}`} />
                <Metric label="Best" value={inr(perf.data.bestTrade, 2)} />
                <Metric label="Worst" value={inr(perf.data.worstTrade, 2)} />
                <Metric label="Avg win" value={inr(perf.data.avgWin, 2)} />
                <Metric
                  label="Profit factor"
                  value={perf.data.profitFactor === null ? '—' : perf.data.profitFactor.toFixed(2)}
                />
              </div>
            )}

            <Alert variant="default" title="What these numbers do and do not show">
              {perf.data.caveat}
            </Alert>
          </CardContent>
        </Card>
      )}

      {tab === 'open' && (trades.data ?? []).length > 0 && (
        <>
          <SubscribeTicks trades={trades.data!} />
          <OpenPnlStrip trades={trades.data!} advice={advice.data ?? []} />
        </>
      )}

      <div>
        <Tabs
          active={tab}
          onChange={setTab}
          tabs={[
            { id: 'open', label: `Open (${perf.data?.openTrades ?? 0})` },
            { id: 'closed', label: `Closed (${perf.data?.closedTrades ?? 0})` },
          ]}
        />
        <Card>
          <CardContent className="px-0 pt-4">
            {trades.isLoading ? (
              <Skeleton className="mx-4 h-48" />
            ) : (trades.data ?? []).length === 0 ? (
              <EmptyState
                title={tab === 'open' ? 'No open positions' : 'Nothing closed yet'}
                description={
                  tab === 'open'
                    ? 'The engine opens a position only when its rules agree on a direction and the payoff clears your reward-to-risk floor.'
                    : 'Closed trades appear here with P&L net of the full Indian cost stack.'
                }
              />
            ) : (
              <TradeTable
                trades={trades.data!}
                advice={advice.data ?? []}
                onClose={(id) => close.mutate(id)}
                closing={close.isPending}
              />
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

/**
 * The live mark for an open paper position.
 *
 * Streaming tick first (the ingest subscribes every open paper contract),
 * then the advisor's last price (refreshed each minute), then nothing. The
 * source is shown beside the number so a stale mark is never mistaken for a
 * live one.
 */
function useLiveMark(advice: PositionAdviceDto[]) {
  const ticks = useTicks((s) => s.ticks);
  const feedState = useTicks((s) => s.feedState);
  const adviceById = new Map(advice.map((a) => [a.tradeId, a]));
  return (t: PaperTradeDto): { ltp: number | null; source: 'live' | 'advisor' | null; net: number | null } => {
    const tick = feedState === 'connected' ? ticks[`${t.exchange}:${t.tradingsymbol}`] : undefined;
    const a = adviceById.get(t.id);
    if (tick) return { ltp: tick.ltp, source: 'live', net: a?.unrealizedNet ?? null };
    if (a?.currentPrice !== null && a?.currentPrice !== undefined) return { ltp: a.currentPrice, source: 'advisor', net: a.unrealizedNet };
    return { ltp: null, source: null, net: null };
  };
}

/**
 * The gateway forwards ticks only for symbols this browser asked for. Ask
 * for every open contract while the Open tab is showing; the server side
 * already streams them, so the first tick arrives within a second.
 */
function SubscribeTicks({ trades }: { trades: PaperTradeDto[] }) {
  const subscribe = useTicks((s) => s.subscribe);
  const unsubscribe = useTicks((s) => s.unsubscribe);
  const key = trades.map((t) => `${t.exchange}:${t.tradingsymbol}`).sort().join(',');
  useEffect(() => {
    const symbols = key ? key.split(',') : [];
    if (symbols.length === 0) return;
    subscribe(symbols);
    return () => unsubscribe(symbols);
  }, [key, subscribe, unsubscribe]);
  return null;
}

/** Running total across every open paper position, from the same marks as the rows. */
function OpenPnlStrip({ trades, advice }: { trades: PaperTradeDto[]; advice: PositionAdviceDto[] }) {
  const mark = useLiveMark(advice);
  let gross = 0;
  let outlay = 0;
  let marked = 0;
  let live = 0;
  for (const t of trades) {
    const m = mark(t);
    const entry = Number(t.entry_price);
    outlay += entry * t.quantity;
    if (m.ltp === null) continue;
    marked += 1;
    if (m.source === 'live') live += 1;
    gross += (m.ltp - entry) * t.quantity;
  }
  const pct = outlay > 0 ? (gross / outlay) * 100 : null;
  return (
    <Card>
      <CardContent className="flex flex-wrap items-center justify-between gap-4 pt-4">
        <div>
          <div className="text-2xs uppercase tracking-wide text-muted-foreground">Open P&amp;L, live</div>
          <div className={cn('tabular text-2xl font-semibold', pnlClass(gross))}>
            {marked === 0 ? '—' : `${gross >= 0 ? '+' : ''}${inr(gross, 0)}`}
            {pct !== null && marked > 0 && (
              <span className="ml-2 text-sm font-normal">({pct >= 0 ? '+' : ''}{pct.toFixed(1)}%)</span>
            )}
          </div>
        </div>
        <div className="flex gap-5">
          <Metric label="Positions" value={trades.length} />
          <Metric label="Premium out" value={inr(outlay, 0)} />
          <Metric
            label="Marked"
            value={`${marked}/${trades.length}`}
            sub={live === marked && marked > 0 ? 'all streaming' : live > 0 ? `${live} streaming` : marked > 0 ? 'advisor price (≤ 1 min old)' : 'no price yet'}
          />
        </div>
        <p className="w-full text-2xs leading-relaxed text-muted-foreground">
          Gross, before exit costs. The advisor panel above shows each position net of the full
          round-trip cost stack. A position with no price is shown as unmarked, never as zero.
        </p>
      </CardContent>
    </Card>
  );
}

function TradeTable({
  trades, advice, onClose, closing,
}: { trades: PaperTradeDto[]; advice: PositionAdviceDto[]; onClose: (id: string) => void; closing: boolean }) {
  const isOpen = trades[0]?.status === 'OPEN';
  const mark = useLiveMark(advice);
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border text-2xs uppercase tracking-wide text-muted-foreground">
            <th className="px-4 py-2 text-left font-medium">Contract</th>
            <th className="px-4 py-2 text-right font-medium">Qty</th>
            <th className="px-4 py-2 text-right font-medium">Entry</th>
            {isOpen && <th className="px-4 py-2 text-right font-medium">LTP</th>}
            {isOpen && <th className="px-4 py-2 text-right font-medium">P&amp;L</th>}
            <th className="px-4 py-2 text-right font-medium">Stop</th>
            <th className="px-4 py-2 text-right font-medium">Target</th>
            {isOpen ? (
              <>
                <th className="px-4 py-2 text-left font-medium">Stop ← · → target</th>
                <th className="px-4 py-2 text-right font-medium" />
              </>
            ) : (
              <>
                <th className="px-4 py-2 text-right font-medium">Exit</th>
                <th className="px-4 py-2 text-left font-medium">Why</th>
                <th className="px-4 py-2 text-right font-medium">Costs</th>
                <th className="px-4 py-2 text-right font-medium">Net P&amp;L</th>
              </>
            )}
          </tr>
        </thead>
        <tbody>
          {trades.map((t) => {
            const net = t.net_pnl === null ? null : Number(t.net_pnl);
            const entry = Number(t.entry_price);
            const stop = t.stop_price === null ? null : Number(t.stop_price);
            const target = t.target_price === null ? null : Number(t.target_price);
            const m = isOpen ? mark(t) : { ltp: null, source: null, net: null };
            const gross = m.ltp === null ? null : (m.ltp - entry) * t.quantity;
            const pct = m.ltp === null ? null : ((m.ltp - entry) / entry) * 100;
            // Where the price sits between the stop (0) and the target (1).
            const pos =
              m.ltp !== null && stop !== null && target !== null && target > stop
                ? Math.max(0, Math.min(1, (m.ltp - stop) / (target - stop)))
                : null;
            const entryPos =
              stop !== null && target !== null && target > stop ? (entry - stop) / (target - stop) : null;
            // Profit and loss are segregated by colour at row level, not only
            // in the P&L cell: green tint for a gain, red for a loss, neutral
            // until a position has a price.
            const rowPnl = isOpen ? gross : net;
            return (
              <tr
                key={t.id}
                className={cn(
                  'border-b border-border/50 last:border-0 border-l-4',
                  rowPnl === null ? 'border-l-transparent'
                    : rowPnl > 0 ? 'border-l-up bg-up/5'
                    : rowPnl < 0 ? 'border-l-down bg-down/5'
                    : 'border-l-flat',
                )}
              >
                <td className="px-4 py-2">
                  <div className="font-mono">{t.tradingsymbol}</div>
                  <div className="text-2xs text-muted-foreground">
                    {new Date(t.entry_at).toLocaleString('en-IN')}
                    {isOpen && t.confirmation !== null && ` · score ${t.confirmation}`}
                  </div>
                </td>
                <td className="px-4 py-2 text-right font-mono">{t.quantity}</td>
                <td className="px-4 py-2 text-right font-mono">{inr(t.entry_price, 2)}</td>
                {isOpen && (
                  <td className="px-4 py-2 text-right font-mono">
                    {m.ltp === null ? (
                      <span className="text-muted-foreground">no price</span>
                    ) : (
                      <span className={cn(m.source === 'live' && 'text-live')} title={m.source === 'live' ? 'Streaming' : 'Advisor price, up to a minute old'}>
                        {inr(m.ltp, 2)}
                      </span>
                    )}
                  </td>
                )}
                {isOpen && (
                  <td className={cn('px-4 py-2 text-right font-mono', pnlClass(gross))}>
                    {gross === null ? '—' : (
                      <>
                        {gross >= 0 ? '+' : ''}{inr(gross, 0)}
                        <div className="text-2xs">{pct !== null && `${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%`}{m.net !== null && ` · net ${inr(m.net, 0)}`}</div>
                      </>
                    )}
                  </td>
                )}
                <td className="px-4 py-2 text-right font-mono">{inr(t.stop_price, 2)}</td>
                <td className="px-4 py-2 text-right font-mono">{inr(t.target_price, 2)}</td>
                {isOpen ? (
                  <>
                    <td className="px-4 py-2">
                      <div className="relative h-1.5 w-32 overflow-hidden rounded bg-muted">
                        {pos !== null && (
                          <div className={cn('absolute inset-y-0 left-0 rounded', gross !== null && gross >= 0 ? 'bg-bull' : 'bg-bear')} style={{ width: `${pos * 100}%` }} />
                        )}
                        {entryPos !== null && (
                          <div className="absolute inset-y-0 w-px bg-foreground/60" style={{ left: `${Math.max(0, Math.min(100, entryPos * 100))}%` }} aria-hidden />
                        )}
                      </div>
                      <div className="mt-0.5 text-2xs text-muted-foreground">
                        {pos === null ? '—' : `${(pos * 100).toFixed(0)}% of the way from stop to target`}
                      </div>
                    </td>
                    <td className="px-4 py-2 text-right">
                      <Button
                        variant="ghost"
                        onClick={() => onClose(t.id)}
                        disabled={closing}
                        className="h-7 text-xs"
                      >
                        Close
                      </Button>
                    </td>
                  </>
                ) : (
                  <>
                    <td className="px-4 py-2 text-right font-mono">{inr(t.exit_price, 2)}</td>
                    <td className="px-4 py-2">
                      <Badge variant={t.exit_reason === 'TARGET' ? 'up' : 'outline'}>
                        {t.exit_reason ?? '—'}
                      </Badge>
                    </td>
                    <td className="px-4 py-2 text-right font-mono text-muted-foreground">
                      {inr(t.costs, 2)}
                    </td>
                    <td className={cn('px-4 py-2 text-right font-mono', pnlClass(net))}>
                      {inr(net, 2)}
                    </td>
                  </>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function ConfigCard({ config, onSaved }: { config: PaperConfigDto | null; onSaved: () => void }) {
  const [capital, setCapital] = useState(config ? String(Number(config.capital)) : '');
  const [risk, setRisk] = useState(config ? String(Number(config.risk_per_trade_pct)) : '1');
  const [maxOpen, setMaxOpen] = useState(String(config?.max_open_positions ?? 3));
  const [maxDay, setMaxDay] = useState(String(config?.max_trades_per_day ?? 5));
  const [lossCap, setLossCap] = useState(
    config ? String(Number(config.max_daily_loss_pct)) : '3',
  );
  const [minConf, setMinConf] = useState(String(config?.min_confirmation ?? 60));
  const [underlyings, setUnderlyings] = useState((config?.underlyings ?? ['NIFTY']).join(', '));

  const save = useMutation({
    mutationFn: (isEnabled: boolean) =>
      api.paper.saveConfig({
        isEnabled,
        capital: Number(capital),
        riskPerTradePct: Number(risk),
        maxOpenPositions: Number(maxOpen),
        maxTradesPerDay: Number(maxDay),
        maxDailyLossPct: Number(lossCap),
        minConfirmation: Number(minConf),
        underlyings: underlyings.split(',').map((u) => u.trim().toUpperCase()).filter(Boolean),
      }),
    onSuccess: onSaved,
  });

  const valid = Number(capital) > 0;
  const enabled = config?.is_enabled ?? false;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          Settings
          <Badge variant={enabled ? 'up' : 'outline'}>{enabled ? 'Running' : 'Stopped'}</Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
          <Field label="Capital (₹)" value={capital} onChange={setCapital} placeholder="500000" />
          <Field label="Risk per trade (%)" value={risk} onChange={setRisk} />
          <Field label="Max open positions" value={maxOpen} onChange={setMaxOpen} />
          <Field label="Max trades per day" value={maxDay} onChange={setMaxDay} />
          <Field label="Daily loss cap (%)" value={lossCap} onChange={setLossCap} />
          <Field label="Min confirmation" value={minConf} onChange={setMinConf} />
          <div className="col-span-2 space-y-1">
            <Label htmlFor="underlyings">Underlyings</Label>
            <Input
              id="underlyings"
              value={underlyings}
              onChange={(e) => setUnderlyings(e.target.value)}
              placeholder="NIFTY, BANKNIFTY"
            />
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <Button onClick={() => save.mutate(true)} disabled={!valid || save.isPending}>
            {enabled ? 'Save and keep running' : 'Start paper trading'}
          </Button>
          {enabled && (
            <Button variant="outline" onClick={() => save.mutate(false)} disabled={save.isPending}>
              Stop
            </Button>
          )}
          {!valid && (
            <span className="text-sm text-muted-foreground">
              Enter the capital the strategy may use.
            </span>
          )}
        </div>

        <p className="text-2xs leading-relaxed text-muted-foreground">
          Capital is notional and never read from your broker account. The daily loss cap halts new
          entries for the rest of the day once breached; open positions still close. Fills cross the
          spread and pay 15bps slippage, and both legs are charged the full Indian cost stack — so
          the P&amp;L here is deliberately worse than a perfect-fill simulation would show.
        </p>
      </CardContent>
    </Card>
  );
}

function Field({
  label, value, onChange, placeholder,
}: { label: string; value: string; onChange: (v: string) => void; placeholder?: string }) {
  const id = label.replace(/\W+/g, '-').toLowerCase();
  return (
    <div className="space-y-1">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        inputMode="decimal"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        {...(placeholder ? { placeholder } : {})}
      />
    </div>
  );
}

const ADVICE_STYLE: Record<string, { variant: 'warning' | 'info' | 'default'; label: string }> = {
  CLOSE: { variant: 'warning', label: 'Close now' },
  CONSIDER_CLOSING: { variant: 'info', label: 'Consider closing' },
  WATCH: { variant: 'default', label: 'Watch' },
  HOLD: { variant: 'default', label: 'Hold' },
  CANNOT_ASSESS: { variant: 'default', label: 'Cannot assess' },
};

/**
 * What to do about each open position.
 *
 * The recommendation never appears without the measured reasons underneath
 * it — a bare "close this" is an instruction, and the point is to let you
 * check the reasoning and disagree.
 */
function AdvicePanel({
  advice, onClose, closing,
}: { advice: PositionAdviceDto[]; onClose: (id: string) => void; closing: boolean }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>What I would do</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {advice.map((a) => {
          const style = ADVICE_STYLE[a.action] ?? ADVICE_STYLE['HOLD']!;
          const actionable = a.action === 'CLOSE' || a.action === 'CONSIDER_CLOSING';
          return (
            <div key={a.tradeId} className="rounded border border-border p-3">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant={style.variant === 'warning' ? 'warning' : 'outline'}>
                    {style.label}
                  </Badge>
                  <span className="font-mono text-sm">{a.tradingsymbol}</span>
                  {a.daysToExpiry !== null && (
                    <span className="text-2xs text-muted-foreground">
                      {a.daysToExpiry}d to expiry
                    </span>
                  )}
                </div>
                <span className={cn('font-mono text-sm', pnlClass(a.unrealizedNet))}>
                  {inr(a.unrealizedNet, 2)}
                  {a.unrealizedPct !== null && (
                    <span className="ml-1 text-2xs">
                      ({a.unrealizedPct >= 0 ? '+' : ''}{a.unrealizedPct.toFixed(1)}%)
                    </span>
                  )}
                </span>
              </div>

              <p className="mt-2 text-sm leading-relaxed">{a.headline}</p>

              <ul className="mt-2 space-y-1">
                {a.reasons.map((r) => (
                  <li key={r} className="text-2xs leading-relaxed text-muted-foreground">
                    — {r}
                  </li>
                ))}
              </ul>

              {a.progressToTarget !== null && (
                <div className="mt-2">
                  <div className="mb-1 flex items-baseline justify-between text-2xs text-muted-foreground">
                    <span>Progress to target</span>
                    <span className="font-mono">{(a.progressToTarget * 100).toFixed(0)}%</span>
                  </div>
                  <div className="h-1 w-full overflow-hidden rounded bg-muted">
                    <div
                      className="h-full rounded bg-bull"
                      style={{ width: `${Math.max(0, Math.min(100, a.progressToTarget * 100))}%` }}
                    />
                  </div>
                </div>
              )}

              {actionable && (
                <Button
                  variant="outline"
                  className="mt-3 h-7 text-xs"
                  onClick={() => onClose(a.tradeId)}
                  disabled={closing}
                >
                  Close this position
                </Button>
              )}
            </div>
          );
        })}
        <p className="text-2xs leading-relaxed text-muted-foreground">
          Each recommendation compares measured numbers — current premium against the levels set at
          entry, days remaining, and whether the underlying score still supports the direction.
          None of it is a forecast, and none of it knows something the chart does not.
        </p>
      </CardContent>
    </Card>
  );
}
