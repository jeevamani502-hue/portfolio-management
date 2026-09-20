import { useState, useMemo, useEffect } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ExternalLink } from 'lucide-react';
import { api } from '@/services/api';
import { isAvailable } from '@/types/api';
import {
  Card, CardHeader, CardTitle, CardContent, Skeleton, Badge, Tabs, Alert, EmptyState,
} from '@/components/ui';
import { DataValue, SourceLine, Metric, MethodNote } from '@/components/market/DataValue';
import { ScorePanel, SetupCard } from '@/components/analysis/ScorePanel';
import { CandleChart, type Overlay } from '@/charts/CandleChart';
import { useTicks, useTick } from '@/services/ws';
import {
  inr, inrCompact, num, pct, signed, signedPct, countCompact, count,
  arrow, directionClass, humanise, istDateTime,
} from '@/lib/format';

const TIMEFRAMES = ['5m', '15m', '30m', '1h', '4h', '1d', '1w', '1M'] as const;

export function StockAnalysis() {
  const { symbol = '' } = useParams<{ symbol: string }>();
  const [timeframe, setTimeframe] = useState<string>('1d');
  const [tab, setTab] = useState('overview');

  const subscribe = useTicks((s) => s.subscribe);
  const unsubscribe = useTicks((s) => s.unsubscribe);

  const analysis = useQuery({
    queryKey: ['stock', symbol, 'analysis', timeframe],
    queryFn: () => api.stocks.analysis(symbol, timeframe),
    enabled: Boolean(symbol),
    refetchInterval: 30_000,
  });

  const history = useQuery({
    queryKey: ['stock', symbol, 'history', timeframe],
    queryFn: () => api.market.history(symbol, timeframe, 300),
    enabled: Boolean(symbol),
    refetchInterval: 60_000,
  });

  const fundamentals = useQuery({
    queryKey: ['stock', symbol, 'fundamentals'],
    queryFn: () => api.stocks.fundamentals(symbol),
    enabled: Boolean(symbol) && tab === 'fundamentals',
  });

  const news = useQuery({
    queryKey: ['stock', symbol, 'news'],
    queryFn: () => api.stocks.news(symbol),
    enabled: Boolean(symbol) && tab === 'news',
  });

  const peers = useQuery({
    queryKey: ['stock', symbol, 'peers'],
    queryFn: () => api.stocks.peers(symbol),
    enabled: Boolean(symbol) && tab === 'peers',
  });

  const instrument = analysis.data?.data.instrument;
  const fullSymbol = instrument?.symbol ?? symbol;
  const tick = useTick(fullSymbol);

  useEffect(() => {
    if (!fullSymbol) return;
    subscribe([fullSymbol]);
    return () => unsubscribe([fullSymbol]);
  }, [fullSymbol, subscribe, unsubscribe]);

  const candles = history.data?.data.candles ?? [];
  const technicals = analysis.data?.data.technicals;
  const snapshot = technicals && isAvailable(technicals) ? technicals.value : null;

  // Moving-average overlays. Colours come from the categorical slots, assigned
  // in fixed order — never cycled — and each line is direct-labelled in the
  // legend below the chart.
  const overlays = useMemo<Overlay[]>(() => {
    if (!snapshot || candles.length === 0) return [];
    const flat = (v: number | null) => candles.map(() => v);
    const out: Overlay[] = [];
    if (snapshot.movingAverages.sma20 !== null) {
      out.push({ label: 'SMA 20', values: flat(snapshot.movingAverages.sma20), color: '#2a78d6', lineWidth: 1 });
    }
    if (snapshot.movingAverages.sma50 !== null) {
      out.push({ label: 'SMA 50', values: flat(snapshot.movingAverages.sma50), color: '#eb6834', lineWidth: 1 });
    }
    if (snapshot.movingAverages.sma200 !== null) {
      out.push({ label: 'SMA 200', values: flat(snapshot.movingAverages.sma200), color: '#4a3aa7', lineWidth: 1 });
    }
    return out;
  }, [snapshot, candles]);

  const priceLines = useMemo(() => {
    if (!snapshot) return [];
    const lines: Array<{ price: number; label: string; color: string; dashed?: boolean }> = [];
    const s = snapshot.structure.nearestSupport;
    const r = snapshot.structure.nearestResistance;
    if (s) lines.push({ price: s.price, label: 'Support', color: 'hsl(var(--up))', dashed: true });
    if (r) lines.push({ price: r.price, label: 'Resistance', color: 'hsl(var(--down))', dashed: true });
    return lines;
  }, [snapshot]);

  if (!symbol) return <EmptyState title="No symbol selected" />;

  if (analysis.isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-24" />
        <Skeleton className="h-96" />
      </div>
    );
  }

  if (analysis.isError) {
    return (
      <Alert variant="error" title="Could not load this instrument">
        {(analysis.error as Error).message}
      </Alert>
    );
  }

  const quote = analysis.data?.data.quote;
  const signals = analysis.data?.data.signals;
  const dq = analysis.data?.data.dataQuality;

  return (
    <div className="space-y-4">
      {/* Header */}
      <Card>
        <CardContent className="pt-4">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="text-xl font-semibold tracking-tight">
                  {instrument?.tradingsymbol ?? symbol}
                </h1>
                <Badge variant="muted">{instrument?.exchange}</Badge>
                {instrument?.sector && <Badge variant="secondary">{instrument.sector}</Badge>}
              </div>
              {instrument?.name && (
                <p className="mt-0.5 truncate text-xs text-muted-foreground">{instrument.name}</p>
              )}
            </div>

            <div className="text-right">
              <DataValue data={quote} showStatus className="!block">
                {(q) => {
                  const ltp = tick?.ltp ?? q.ltp;
                  const change = tick?.ch ?? (q.prevClose !== null ? q.ltp - q.prevClose : null);
                  const changePct =
                    tick?.chp ??
                    (q.prevClose !== null && q.prevClose > 0
                      ? ((q.ltp - q.prevClose) / q.prevClose) * 100
                      : null);
                  return (
                    <div>
                      <div className="tabular text-3xl font-semibold leading-none">{inr(ltp)}</div>
                      <div className={`tabular mt-1 text-sm ${directionClass(change)}`}>
                        <span aria-hidden>{arrow(change)}</span> {signed(change)}{' '}
                        {changePct !== null && `(${signedPct(changePct)})`}
                      </div>
                    </div>
                  );
                }}
              </DataValue>
            </div>
          </div>

          {/* Price detail strip */}
          <DataValue data={quote}>
            {(q) => (
              <div className="mt-4 grid w-full grid-cols-2 gap-x-6 gap-y-3 border-t border-border pt-3 sm:grid-cols-4 lg:grid-cols-7">
                <Metric label="Open" value={inr(q.open)} />
                <Metric label="High" value={inr(q.high)} />
                <Metric label="Low" value={inr(q.low)} />
                <Metric label="Prev close" value={inr(q.prevClose)} />
                <Metric label="Volume" value={countCompact(q.volume)} sub={count(q.volume)} />
                <Metric
                  label="VWAP"
                  value={inr(snapshot?.vwap ?? q.avgPrice)}
                  method={
                    snapshot?.vwap !== null && snapshot?.vwap !== undefined
                      ? 'Session VWAP: cumulative (typical price × volume) ÷ cumulative volume, reset at the session open.'
                      : 'Exchange-reported average traded price for the session. True VWAP is session-anchored and only shown on intraday timeframes.'
                  }
                />
                <Metric
                  label="52-week range"
                  value={
                    q.week52Low !== null || q.week52High !== null
                      ? `${inr(q.week52Low, { symbol: false })} – ${inr(q.week52High, { symbol: false })}`
                      : '—'
                  }
                  sub={
                    q.week52High === null
                      ? 'Populated by the end-of-day job'
                      : undefined
                  }
                />
              </div>
            )}
          </DataValue>
        </CardContent>
      </Card>

      {/* Timeframe selector */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-2xs uppercase tracking-wide text-muted-foreground">Timeframe</span>
        <div className="flex gap-1">
          {TIMEFRAMES.map((tf) => (
            <button
              key={tf}
              onClick={() => setTimeframe(tf)}
              className={`rounded px-2.5 py-1 text-xs font-medium transition-colors ${
                timeframe === tf
                  ? 'bg-primary text-primary-foreground'
                  : 'bg-muted text-muted-foreground hover:text-foreground'
              }`}
            >
              {tf}
            </button>
          ))}
        </div>
        {dq && (
          <span className="ml-auto text-2xs text-muted-foreground">
            {dq.candlesUsed} bars · {dq.candleSource}
            {dq.servedFromStorage && ' (stored)'}
          </span>
        )}
      </div>

      <Tabs
        active={tab}
        onChange={setTab}
        tabs={[
          { id: 'overview', label: 'Overview' },
          { id: 'technicals', label: 'Technicals' },
          { id: 'fundamentals', label: 'Fundamentals' },
          { id: 'news', label: 'News' },
          { id: 'peers', label: 'Peers' },
        ]}
      />

      {tab === 'overview' && (
        <div className="grid gap-4 lg:grid-cols-3">
          <Card className="lg:col-span-2">
            <CardHeader className="flex-row items-center justify-between space-y-0">
              <CardTitle>Price · {timeframe}</CardTitle>
              {history.data && (
                <SourceLine
                  source={String(history.data.meta['source'] ?? '')}
                  asOf={history.data.meta['asOf'] as string | null}
                />
              )}
            </CardHeader>
            <CardContent>
              {history.isLoading ? (
                <Skeleton className="h-[400px]" />
              ) : (
                <>
                  <CandleChart candles={candles} overlays={overlays} priceLines={priceLines} />
                  {overlays.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-3">
                      {overlays.map((o) => (
                        <span key={o.label} className="flex items-center gap-1.5 text-2xs">
                          <span
                            aria-hidden
                            className="h-0.5 w-4 rounded-full"
                            style={{ background: o.color }}
                          />
                          {o.label}
                        </span>
                      ))}
                      {priceLines.map((l) => (
                        <span key={l.label} className="flex items-center gap-1.5 text-2xs">
                          <span
                            aria-hidden
                            className="h-0.5 w-4 rounded-full border-t border-dashed"
                            style={{ borderColor: l.color }}
                          />
                          {l.label}
                        </span>
                      ))}
                    </div>
                  )}
                </>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Signal engine</CardTitle>
            </CardHeader>
            <CardContent>
              <DataValue data={signals}>{(r) => <ScorePanel report={r} />}</DataValue>
            </CardContent>
          </Card>

          <Card className="lg:col-span-3">
            <CardHeader>
              <CardTitle>Matched setups</CardTitle>
            </CardHeader>
            <CardContent>
              <DataValue data={signals}>
                {(r) =>
                  r.setups.length === 0 ? (
                    <EmptyState
                      title="No setup currently matches"
                      description={`None of the ${r.allRules.length} rules combine into a recognised setup on the ${timeframe} timeframe right now. That is a normal state, not an error.`}
                    />
                  ) : (
                    <div className="grid w-full gap-3 md:grid-cols-2">
                      {r.setups.map((s) => (
                        <SetupCard key={`${s.kind}-${s.direction}`} setup={s} />
                      ))}
                    </div>
                  )
                }
              </DataValue>
            </CardContent>
          </Card>
        </div>
      )}

      {tab === 'technicals' && (
        <DataValue data={technicals}>
          {(s) => (
            <div className="grid w-full gap-4 md:grid-cols-2 xl:grid-cols-3">
              <Card>
                <CardHeader><CardTitle>Moving averages</CardTitle></CardHeader>
                <CardContent className="grid grid-cols-2 gap-3">
                  <Metric label="SMA 20" value={inr(s.movingAverages.sma20)} />
                  <Metric label="SMA 50" value={inr(s.movingAverages.sma50)} />
                  <Metric label="SMA 100" value={inr(s.movingAverages.sma100)} />
                  <Metric label="SMA 200" value={inr(s.movingAverages.sma200)} />
                  <Metric label="EMA 9" value={inr(s.movingAverages.ema9)} />
                  <Metric label="EMA 20" value={inr(s.movingAverages.ema20)} />
                  <Metric label="EMA 50" value={inr(s.movingAverages.ema50)} />
                </CardContent>
              </Card>

              <Card>
                <CardHeader><CardTitle>Momentum</CardTitle></CardHeader>
                <CardContent className="grid grid-cols-2 gap-3">
                  <Metric
                    label="RSI (14)"
                    value={num(s.momentum.rsi14, 1)}
                    sub={
                      s.momentum.rsi14 === null ? undefined
                      : s.momentum.rsi14 > 70 ? 'Above the 70 line'
                      : s.momentum.rsi14 < 30 ? 'Below the 30 line'
                      : 'Between 30 and 70'
                    }
                    method="Wilder's RSI over 14 periods: 100 − 100 / (1 + average gain ÷ average loss)."
                  />
                  <Metric label="MACD" value={num(s.momentum.macd, 3)} />
                  <Metric label="Signal" value={num(s.momentum.macdSignal, 3)} />
                  <Metric label="Histogram" value={num(s.momentum.macdHistogram, 3)} />
                  <Metric label="StochRSI %K" value={num(s.momentum.stochRsiK, 1)} />
                  <Metric label="StochRSI %D" value={num(s.momentum.stochRsiD, 1)} />
                </CardContent>
              </Card>

              <Card>
                <CardHeader><CardTitle>Trend</CardTitle></CardHeader>
                <CardContent className="grid grid-cols-2 gap-3">
                  <Metric
                    label="Classification"
                    value={humanise(s.trend.assessment.label)}
                    sub={`Strength ${s.trend.assessment.strength}/100`}
                  />
                  <Metric
                    label="ADX (14)"
                    value={num(s.trend.adx14, 1)}
                    method="Wilder's ADX. Below 20 suggests range conditions, above 25 a trend. It measures strength, not direction."
                  />
                  <Metric label="+DI" value={num(s.trend.plusDi, 1)} />
                  <Metric label="−DI" value={num(s.trend.minusDi, 1)} />
                  <Metric
                    label="Supertrend"
                    value={inr(s.trend.supertrend)}
                    sub={
                      s.trend.supertrendDirection === 1 ? 'Bullish'
                      : s.trend.supertrendDirection === -1 ? 'Bearish' : undefined
                    }
                  />
                </CardContent>
                <CardContent>
                  <ul className="space-y-0.5 border-t border-border pt-2">
                    {s.trend.assessment.reasons.map((r, i) => (
                      <li key={i} className="text-2xs text-muted-foreground">• {r}</li>
                    ))}
                  </ul>
                </CardContent>
              </Card>

              <Card>
                <CardHeader><CardTitle>Volatility</CardTitle></CardHeader>
                <CardContent className="grid grid-cols-2 gap-3">
                  <Metric
                    label="ATR (14)"
                    value={inr(s.volatility.atr14)}
                    sub={s.volatility.atrPct !== null ? `${pct(s.volatility.atrPct)} of price` : undefined}
                    method="Wilder-smoothed average true range over 14 periods. Used to size stops proportionally to this instrument's own volatility."
                  />
                  <Metric label="BB upper" value={inr(s.volatility.bbUpper)} />
                  <Metric label="BB middle" value={inr(s.volatility.bbMiddle)} />
                  <Metric label="BB lower" value={inr(s.volatility.bbLower)} />
                  <Metric label="Band width" value={pct(s.volatility.bbWidth)} />
                  <Metric
                    label="Width percentile"
                    value={s.volatility.bbWidthPercentile !== null ? `${num(s.volatility.bbWidthPercentile, 0)}th` : '—'}
                    sub={
                      s.volatility.bbWidthPercentile !== null && s.volatility.bbWidthPercentile <= 20
                        ? 'Compressed'
                        : undefined
                    }
                  />
                </CardContent>
              </Card>

              <Card>
                <CardHeader><CardTitle>Volume</CardTitle></CardHeader>
                <CardContent className="grid grid-cols-2 gap-3">
                  <Metric label="Volume" value={countCompact(s.volume.volume)} />
                  <Metric label="20-period average" value={countCompact(s.volume.avgVolume20)} />
                  <Metric
                    label="Relative volume"
                    value={s.volume.relativeVolume !== null ? `${num(s.volume.relativeVolume)}×` : '—'}
                  />
                  <Metric label="OBV" value={countCompact(s.volume.obv)} />
                </CardContent>
              </Card>

              <Card>
                <CardHeader><CardTitle>Structure</CardTitle></CardHeader>
                <CardContent className="space-y-3">
                  <div className="grid grid-cols-2 gap-3">
                    <Metric
                      label="Nearest support"
                      value={inr(s.structure.nearestSupport?.price)}
                      sub={
                        s.structure.nearestSupport
                          ? `${s.structure.nearestSupport.touches} touches · strength ${s.structure.nearestSupport.strength}/100`
                          : 'None mapped in the lookback window'
                      }
                    />
                    <Metric
                      label="Nearest resistance"
                      value={inr(s.structure.nearestResistance?.price)}
                      sub={
                        s.structure.nearestResistance
                          ? `${s.structure.nearestResistance.touches} touches · strength ${s.structure.nearestResistance.strength}/100`
                          : 'None mapped in the lookback window'
                      }
                    />
                  </div>
                  {s.structure.divergence && (
                    <Alert variant="info" title={`${humanise(s.structure.divergence.type)} divergence`}>
                      {s.structure.divergence.detail}
                    </Alert>
                  )}
                  {s.pivots.classic && (
                    <div className="border-t border-border pt-2">
                      <div className="mb-1 text-2xs uppercase tracking-wide text-muted-foreground">
                        Classic pivots (from the previous bar)
                      </div>
                      <div className="grid grid-cols-4 gap-2 text-2xs">
                        {(['s2', 's1', 'pivot', 'r1', 'r2'] as const).map((k) => (
                          <div key={k}>
                            <div className="uppercase text-muted-foreground">{k}</div>
                            <div className="tabular">{num(s.pivots.classic![k])}</div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </CardContent>
              </Card>

              {s.insufficient.length > 0 && (
                <Card className="md:col-span-2 xl:col-span-3">
                  <CardContent className="pt-4">
                    <Alert variant="warning" title="Some indicators could not be computed">
                      <ul className="mt-1 space-y-0.5">
                        {s.insufficient.map((i) => (
                          <li key={i.field}>
                            <span className="font-medium">{i.field}</span> needs {i.required} bars;
                            only {i.available} are available from the configured provider.
                          </li>
                        ))}
                      </ul>
                    </Alert>
                  </CardContent>
                </Card>
              )}
            </div>
          )}
        </DataValue>
      )}

      {tab === 'fundamentals' && (
        <div>
          {fundamentals.isLoading ? (
            <Skeleton className="h-64" />
          ) : (
            <DataValue data={fundamentals.data?.fundamentals}>
              {(f) => (
                <div className="w-full space-y-4">
                  <Alert>{f.methodology}</Alert>
                  <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                    {f.summary.map((cat) => (
                      <Card key={cat.category}>
                        <CardHeader className="flex-row items-center justify-between space-y-0">
                          <CardTitle>{cat.category}</CardTitle>
                          <Badge
                            variant={
                              cat.verdict === 'strong' ? 'up'
                              : cat.verdict === 'weak' ? 'down'
                              : cat.verdict === 'unavailable' ? 'muted'
                              : 'secondary'
                            }
                          >
                            {cat.verdict}
                          </Badge>
                        </CardHeader>
                        <CardContent className="space-y-3">
                          <p className="text-xs">{cat.headline}</p>
                          <div className="space-y-2 border-t border-border pt-2">
                            {cat.metrics.map((m) => (
                              <div key={m.key} className="flex items-baseline justify-between gap-2">
                                <span className="flex items-center gap-1 text-2xs text-muted-foreground">
                                  {m.label}
                                  <MethodNote>{m.derivation}</MethodNote>
                                </span>
                                <span className="tabular text-xs font-medium">
                                  {m.value === null ? 'Not reported'
                                    : m.unit === '₹ Cr' ? inrCompact(m.value)
                                    : m.unit === '%' ? pct(m.value)
                                    : m.unit === 'x' ? `${num(m.value)}×`
                                    : m.unit === '₹' ? inr(m.value)
                                    : num(m.value)}
                                </span>
                              </div>
                            ))}
                          </div>
                          <details className="text-2xs text-muted-foreground">
                            <summary className="cursor-pointer hover:text-foreground">
                              Thresholds applied
                            </summary>
                            <ul className="mt-1 space-y-0.5 pl-3">
                              {cat.criteria.map((c, i) => <li key={i}>• {c}</li>)}
                            </ul>
                          </details>
                        </CardContent>
                      </Card>
                    ))}
                  </div>
                  <div className="text-2xs text-muted-foreground">
                    {f.coverage.available} of {f.coverage.total} fields reported by the provider
                    {f.coverage.missing.length > 0 && ` · missing: ${f.coverage.missing.join(', ')}`}
                  </div>
                </div>
              )}
            </DataValue>
          )}
        </div>
      )}

      {tab === 'news' && (
        <Card>
          <CardContent className="pt-4">
            {news.isLoading ? (
              <Skeleton className="h-48" />
            ) : (
              <DataValue data={news.data?.news}>
                {(items) => (
                  <ul className="w-full divide-y divide-border">
                    {items.map((n) => (
                      <li key={n.id} className="py-3 first:pt-0">
                        <a
                          href={n.url}
                          target="_blank"
                          rel="noreferrer noopener"
                          className="inline-flex items-start gap-1 text-sm hover:text-primary"
                        >
                          {n.headline}
                          <ExternalLink className="mt-0.5 h-3 w-3 shrink-0 opacity-50" aria-hidden />
                        </a>
                        {n.summary && (
                          <p className="mt-1 line-clamp-2 text-2xs text-muted-foreground">
                            {n.summary}
                          </p>
                        )}
                        <div className="mt-1.5 flex flex-wrap items-center gap-2 text-2xs text-muted-foreground">
                          <span>{n.publisher}</span>
                          <span>{istDateTime(n.publishedAt)}</span>
                          {n.sentiment.label && (
                            <Badge
                              variant={
                                n.sentiment.label === 'POSITIVE' ? 'up'
                                : n.sentiment.label === 'NEGATIVE' ? 'down' : 'muted'
                              }
                            >
                              {humanise(n.sentiment.label)}
                            </Badge>
                          )}
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </DataValue>
            )}
          </CardContent>
        </Card>
      )}

      {tab === 'peers' && (
        <Card>
          <CardContent className="px-0 pt-4">
            {peers.isLoading ? (
              <Skeleton className="mx-4 h-48" />
            ) : peers.data && peers.data.peers.length > 0 ? (
              <>
                <div className="overflow-x-auto">
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>Symbol</th>
                        <th>Name</th>
                        <th className="text-right">Market cap</th>
                        <th className="text-right">P/E</th>
                        <th className="text-right">P/B</th>
                        <th className="text-right">ROE</th>
                      </tr>
                    </thead>
                    <tbody>
                      {peers.data.peers.map((p) => (
                        <tr key={p.id}>
                          <td>
                            <Link
                              to={`/stocks/${encodeURIComponent(p.symbol)}`}
                              className="font-medium hover:text-primary"
                            >
                              {p.tradingsymbol}
                            </Link>
                          </td>
                          <td className="max-w-[220px] truncate text-muted-foreground">{p.name}</td>
                          <td className="num">{inrCompact(p.marketCap)}</td>
                          <td className="num">{p.pe !== null ? `${num(p.pe)}×` : '—'}</td>
                          <td className="num">{p.pb !== null ? `${num(p.pb)}×` : '—'}</td>
                          <td className="num">{pct(p.roe)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <p className="px-4 pt-3 text-2xs text-muted-foreground">{peers.data.note}</p>
              </>
            ) : (
              <EmptyState
                title="No peers available"
                description={peers.data?.note ?? 'No sector classification is stored for this instrument.'}
              />
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
