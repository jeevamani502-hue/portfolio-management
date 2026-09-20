import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { ArrowRight, Activity, Newspaper, Radar } from 'lucide-react';
import { api } from '@/services/api';
import { isAvailable } from '@/types/api';
import {
  Card, CardHeader, CardTitle, CardContent, Skeleton, Badge, Alert, EmptyState, Tooltip,
} from '@/components/ui';
import { DataValue, SourceLine, StatusChip, MethodNote } from '@/components/market/DataValue';
import { IndexCard } from '@/components/market/IndexCard';
import { BreadthBar } from '@/components/market/BreadthBar';
import { SectorHeatmap } from '@/components/market/SectorHeatmap';
import { MoverTable } from '@/components/market/MoverTable';
import { inr, signedPct, signed, pct, humanise, directionClass, relativeTime } from '@/lib/format';

export function Dashboard() {
  const indices = useQuery({
    queryKey: ['market', 'indices'],
    queryFn: () => api.market.indices(),
    refetchInterval: 15_000,
  });

  const breadth = useQuery({
    queryKey: ['market', 'breadth'],
    queryFn: () => api.market.breadth(),
    refetchInterval: 60_000,
  });

  const sectors = useQuery({
    queryKey: ['market', 'sectors'],
    queryFn: () => api.market.sectors(),
    refetchInterval: 60_000,
  });

  const regime = useQuery({
    queryKey: ['market', 'regime'],
    queryFn: () => api.market.regime(),
    refetchInterval: 300_000,
  });

  const portfolio = useQuery({
    queryKey: ['portfolio', 'summary'],
    queryFn: () => api.portfolio.summary(),
    refetchInterval: 60_000,
  });

  const gainers = useQuery({
    queryKey: ['market', 'movers', 'gainers'],
    queryFn: () => api.market.movers('gainers', 'NIFTY50', 6),
    refetchInterval: 60_000,
  });

  const losers = useQuery({
    queryKey: ['market', 'movers', 'losers'],
    queryFn: () => api.market.movers('losers', 'NIFTY50', 6),
    refetchInterval: 60_000,
  });

  const news = useQuery({
    queryKey: ['news', 'dashboard'],
    queryFn: () => api.news.list({ limit: 6, sinceHours: 24 }),
    refetchInterval: 300_000,
  });

  return (
    <div className="space-y-4">
      {/* Index strip */}
      <section aria-label="Index levels">
        {indices.isLoading ? (
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-20" />
            ))}
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
            {(indices.data ?? []).map((row) => (
              <IndexCard key={row.symbol} symbol={row.symbol} data={row.data} />
            ))}
          </div>
        )}
      </section>

      <div className="grid gap-4 lg:grid-cols-3">
        {/* Breadth */}
        <Card>
          <CardHeader className="flex-row items-center justify-between space-y-0">
            <CardTitle>Market breadth</CardTitle>
            {breadth.data && isAvailable(breadth.data) && (
              <StatusChip
                status={breadth.data.status}
                asOf={breadth.data.asOf}
                source={breadth.data.source}
              />
            )}
          </CardHeader>
          <CardContent>
            {breadth.isLoading ? (
              <Skeleton className="h-24" />
            ) : (
              <DataValue data={breadth.data}>
                {(b) => (
                  <div className="w-full space-y-3">
                    <BreadthBar advances={b.advances} declines={b.declines} unchanged={b.unchanged} />
                    <div className="grid grid-cols-3 gap-2 text-center">
                      <div>
                        <div className="tabular text-lg font-semibold text-up">{b.advances}</div>
                        <div className="text-2xs text-muted-foreground">Advancing</div>
                      </div>
                      <div>
                        <div className="tabular text-lg font-semibold text-down">{b.declines}</div>
                        <div className="text-2xs text-muted-foreground">Declining</div>
                      </div>
                      <div>
                        <div className="tabular text-lg font-semibold text-flat">{b.unchanged}</div>
                        <div className="text-2xs text-muted-foreground">Unchanged</div>
                      </div>
                    </div>
                    <div className="flex items-center gap-1 text-2xs text-muted-foreground">
                      <span>
                        {b.totalScanned} of {b.totalScanned + b.excluded} scanned
                      </span>
                      <MethodNote>{b.method}</MethodNote>
                    </div>
                  </div>
                )}
              </DataValue>
            )}
          </CardContent>
        </Card>

        {/* Regime */}
        <Card>
          <CardHeader className="flex-row items-center justify-between space-y-0">
            <CardTitle className="flex items-center gap-1.5">
              <Activity className="h-3.5 w-3.5" aria-hidden />
              Market regime
            </CardTitle>
            <Badge variant="muted">Rule signal</Badge>
          </CardHeader>
          <CardContent>
            {regime.isLoading ? (
              <Skeleton className="h-24" />
            ) : (
              <DataValue data={regime.data}>
                {(r) => (
                  <div className="w-full space-y-2">
                    <div className="flex items-baseline gap-2">
                      <span className="text-lg font-semibold">{humanise(r.regime)}</span>
                      {r.compositeScore !== null && (
                        <span className="tabular text-xs text-muted-foreground">
                          {signed(r.compositeScore, 0)} / ±100
                        </span>
                      )}
                    </div>
                    <p className="text-xs leading-relaxed text-muted-foreground">{r.summary}</p>
                    <div className="space-y-1 border-t border-border pt-2">
                      {r.components
                        .filter((c) => c.available)
                        .slice(0, 4)
                        .map((c) => (
                          <div key={c.name} className="flex justify-between gap-2 text-2xs">
                            <span className="text-muted-foreground">{c.name}</span>
                            <span className="tabular">
                              {c.score !== null ? signed(c.score, 0) : '—'}
                            </span>
                          </div>
                        ))}
                    </div>
                    <div className="text-2xs text-muted-foreground">
                      Evidence coverage {pct(r.confidence, 0)}
                    </div>
                  </div>
                )}
              </DataValue>
            )}
          </CardContent>
        </Card>

        {/* Portfolio */}
        <Card>
          <CardHeader className="flex-row items-center justify-between space-y-0">
            <CardTitle>Portfolio</CardTitle>
            <Link
              to="/portfolio"
              className="inline-flex items-center gap-1 text-2xs text-primary hover:underline"
            >
              Open <ArrowRight className="h-3 w-3" aria-hidden />
            </Link>
          </CardHeader>
          <CardContent>
            {portfolio.isLoading ? (
              <Skeleton className="h-24" />
            ) : (
              <DataValue
                data={portfolio.data}
                fallback={
                  <EmptyState
                    title="No holdings yet"
                    description="Add a holding to see valuation, allocation and risk."
                  />
                }
              >
                {(p) => (
                  <div className="w-full space-y-3">
                    <div>
                      <div className="tabular text-2xl font-semibold">
                        {inr(p.health.portfolioValue)}
                      </div>
                      <div className={`tabular text-xs ${directionClass(p.health.todayPnl)}`}>
                        {signed(p.health.todayPnl)} today
                        {p.health.todayPnlPct !== null && ` (${signedPct(p.health.todayPnlPct)})`}
                      </div>
                    </div>
                    <div className="grid grid-cols-2 gap-2 border-t border-border pt-2">
                      <div>
                        <div className="text-2xs text-muted-foreground">Overall P&amp;L</div>
                        <div className={`tabular text-sm ${directionClass(p.health.overallPnl)}`}>
                          {signed(p.health.overallPnl)}
                        </div>
                      </div>
                      <div>
                        <div className="text-2xs text-muted-foreground">XIRR</div>
                        <div className="tabular text-sm">
                          {p.health.xirrPct !== null ? signedPct(p.health.xirrPct) : '—'}
                        </div>
                      </div>
                      <div>
                        <Tooltip content={p.health.riskBasis}>
                          <span className="text-2xs text-muted-foreground">Risk level</span>
                        </Tooltip>
                        <div className="text-sm capitalize">{p.health.riskLevel}</div>
                      </div>
                      <div>
                        <Tooltip content={p.health.diversificationBasis}>
                          <span className="text-2xs text-muted-foreground">Diversification</span>
                        </Tooltip>
                        <div className="tabular text-sm">
                          {p.health.diversificationScore !== null
                            ? `${p.health.diversificationScore}/100`
                            : '—'}
                        </div>
                      </div>
                    </div>
                    {p.health.concentrationFlag && (
                      <Alert variant="warning">{p.health.concentrationFlag}</Alert>
                    )}
                  </div>
                )}
              </DataValue>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Sectors */}
      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <CardTitle>Sector performance</CardTitle>
          {sectors.data && isAvailable(sectors.data) && (
            <SourceLine source={sectors.data.source} asOf={sectors.data.asOf} />
          )}
        </CardHeader>
        <CardContent>
          {sectors.isLoading ? (
            <Skeleton className="h-28" />
          ) : (
            <DataValue data={sectors.data}>{(s) => <SectorHeatmap sectors={s} />}</DataValue>
          )}
        </CardContent>
      </Card>

      {/* Movers */}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-up">Top gainers</CardTitle>
          </CardHeader>
          <CardContent className="px-0">
            {gainers.isLoading ? (
              <Skeleton className="mx-4 h-40" />
            ) : (
              <DataValue data={gainers.data}>{(m) => <MoverTable rows={m} />}</DataValue>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-down">Top losers</CardTitle>
          </CardHeader>
          <CardContent className="px-0">
            {losers.isLoading ? (
              <Skeleton className="mx-4 h-40" />
            ) : (
              <DataValue data={losers.data}>{(m) => <MoverTable rows={m} />}</DataValue>
            )}
          </CardContent>
        </Card>
      </div>

      {/* News + quick links */}
      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader className="flex-row items-center justify-between space-y-0">
            <CardTitle className="flex items-center gap-1.5">
              <Newspaper className="h-3.5 w-3.5" aria-hidden />
              Latest news
            </CardTitle>
            <Link to="/news" className="text-2xs text-primary hover:underline">
              All news
            </Link>
          </CardHeader>
          <CardContent className="space-y-2">
            {news.isLoading ? (
              <Skeleton className="h-32" />
            ) : (
              <DataValue data={news.data}>
                {(items) => (
                  <ul className="w-full divide-y divide-border">
                    {items.map((n) => (
                      <li key={n.id} className="py-2 first:pt-0 last:pb-0">
                        <a
                          href={n.url}
                          target="_blank"
                          rel="noreferrer noopener"
                          className="text-sm leading-snug hover:text-primary"
                        >
                          {n.headline}
                        </a>
                        <div className="mt-1 flex flex-wrap items-center gap-2 text-2xs text-muted-foreground">
                          <span>{n.publisher}</span>
                          <span>{relativeTime(n.publishedAt)}</span>
                          {n.sentiment.label && (
                            <Tooltip content={n.sentiment.caveat}>
                              <Badge
                                variant={
                                  n.sentiment.label === 'POSITIVE' ? 'up'
                                  : n.sentiment.label === 'NEGATIVE' ? 'down'
                                  : 'muted'
                                }
                              >
                                {humanise(n.sentiment.label)}
                                {n.sentiment.confidence !== null &&
                                  ` ${(n.sentiment.confidence * 100).toFixed(0)}%`}
                              </Badge>
                            </Tooltip>
                          )}
                          {n.relatedInstruments.slice(0, 3).map((e) => (
                            <Link
                              key={e.id}
                              to={`/stocks/${encodeURIComponent(e.symbol)}`}
                              className="text-primary hover:underline"
                            >
                              {e.symbol}
                            </Link>
                          ))}
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </DataValue>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-1.5">
              <Radar className="h-3.5 w-3.5" aria-hidden />
              Research shortcuts
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {[
              { to: '/scanner', label: 'Run the swing scanner', desc: 'Rule-confirmed setups with entry, invalidation and sizing' },
              { to: '/fno', label: 'Open the F&O desk', desc: 'Option chain, PCR, max pain, OI buildup' },
              { to: '/analyst', label: 'Ask the Market Analyst', desc: 'Questions answered only from retrieved data' },
              { to: '/backtest', label: 'Backtest a strategy', desc: 'With the full Indian cost stack applied' },
            ].map((l) => (
              <Link
                key={l.to}
                to={l.to}
                className="block rounded-md border border-border p-2.5 transition-colors hover:bg-accent"
              >
                <div className="text-xs font-medium">{l.label}</div>
                <div className="mt-0.5 text-2xs text-muted-foreground">{l.desc}</div>
              </Link>
            ))}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
