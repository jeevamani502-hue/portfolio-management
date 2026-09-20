import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/services/api';
import { isAvailable } from '@/types/api';
import {
  Card, CardHeader, CardTitle, CardContent, Skeleton, Badge, Select, Alert, EmptyState, Tabs, Tooltip,
} from '@/components/ui';
import { DataValue, Metric, SourceLine } from '@/components/market/DataValue';
import { num, count, countCompact, signed, pct, directionClass, humanise } from '@/lib/format';
import { cn } from '@/lib/utils';
import type { OptionStrikeDto, OptionChainDto } from '@/types/api';

const UNDERLYINGS = ['NIFTY', 'BANKNIFTY', 'FINNIFTY', 'MIDCPNIFTY'] as const;

export function Fno() {
  const [underlying, setUnderlying] = useState<string>('NIFTY');
  const [expiry, setExpiry] = useState<string>('');
  const [tab, setTab] = useState('chain');

  const expiries = useQuery({
    queryKey: ['options', underlying, 'expiries'],
    queryFn: () => api.options.expiries(underlying),
  });

  const activeExpiry =
    expiry || (expiries.data && isAvailable(expiries.data) ? (expiries.data.value[0] ?? '') : '');

  const chain = useQuery({
    queryKey: ['options', underlying, 'chain', activeExpiry],
    queryFn: () => api.options.chain(underlying, activeExpiry || undefined),
    enabled: Boolean(activeExpiry),
    refetchInterval: 60_000,
  });

  const analytics = useQuery({
    queryKey: ['options', underlying, 'analytics', activeExpiry],
    queryFn: () => api.options.analytics(underlying, activeExpiry || undefined),
    enabled: Boolean(activeExpiry),
    refetchInterval: 60_000,
  });

  // `requestWithMeta` returns the envelope; the Sourced payload is `.data`.
  const analyticsSourced = analytics.data?.data;
  const chainSourced = chain.data?.data;

  const futures = useQuery({
    queryKey: ['options', underlying, 'futures'],
    queryFn: () => api.options.futures(underlying),
    enabled: tab === 'futures',
    refetchInterval: 60_000,
  });

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-1">
          <label className="text-2xs uppercase tracking-wide text-muted-foreground">
            Underlying
          </label>
          <div className="flex gap-1">
            {UNDERLYINGS.map((u) => (
              <button
                key={u}
                onClick={() => { setUnderlying(u); setExpiry(''); }}
                className={cn(
                  'rounded px-2.5 py-1.5 text-xs font-medium transition-colors',
                  underlying === u
                    ? 'bg-primary text-primary-foreground'
                    : 'bg-muted text-muted-foreground hover:text-foreground',
                )}
              >
                {u}
              </button>
            ))}
          </div>
        </div>

        <div className="w-48 space-y-1">
          <label className="text-2xs uppercase tracking-wide text-muted-foreground">Expiry</label>
          <DataValue data={expiries.data} compact>
            {(list) => (
              <Select value={activeExpiry} onChange={(e) => setExpiry(e.target.value)}>
                {list.map((d) => (
                  <option key={d} value={d}>{d}</option>
                ))}
              </Select>
            )}
          </DataValue>
        </div>

        {analyticsSourced && isAvailable(analyticsSourced) && (
          <div className="ml-auto">
            <SourceLine
              source={analyticsSourced.source}
              asOf={analyticsSourced.asOf}
              status={analyticsSourced.status}
            />
          </div>
        )}
      </div>

      {/* Analytics summary */}
      {analytics.isLoading ? (
        <Skeleton className="h-24" />
      ) : (
        <DataValue data={analyticsSourced}>
          {(a) => (
            <Card className="w-full">
              <CardContent className="grid grid-cols-2 gap-4 pt-4 sm:grid-cols-4 lg:grid-cols-7">
                <Metric label="Spot" value={num(a.spot)} />
                <Metric label="ATM strike" value={count(a.atmStrike)} />
                <Metric label="Days to expiry" value={String(a.daysToExpiry)} />
                <Metric
                  label="PCR (OI)"
                  value={num(a.pcr.pcrOi)}
                  sub={humanise(a.pcr.band)}
                  method={a.pcr.note}
                />
                <Metric
                  label="Max pain"
                  value={count(a.maxPain.maxPain)}
                  method={a.maxPain.note}
                />
                <Metric
                  label="ATM IV"
                  value={a.atmIv !== null ? pct(a.atmIv, 1) : '—'}
                  method={a.ivPercentile.note}
                />
                <Metric
                  label="Net OI change"
                  value={
                    <span className="text-xs">
                      <span className="text-muted-foreground">CE</span> {signed(a.oiShift.callOiChange, 0)}
                      {' · '}
                      <span className="text-muted-foreground">PE</span> {signed(a.oiShift.putOiChange, 0)}
                    </span>
                  }
                />
              </CardContent>
            </Card>
          )}
        </DataValue>
      )}

      <Tabs
        active={tab}
        onChange={setTab}
        tabs={[
          { id: 'chain', label: 'Option chain' },
          { id: 'levels', label: 'OI levels' },
          { id: 'greeks', label: 'Greeks' },
          { id: 'futures', label: 'Futures' },
        ]}
      />

      {tab === 'chain' && (
        <Card>
          <CardContent className="px-0 pt-4">
            {chain.isLoading ? (
              <Skeleton className="mx-4 h-96" />
            ) : (
              <DataValue data={chainSourced}>
                {(c) => <OptionChainTable chain={c} />}
              </DataValue>
            )}
          </CardContent>
        </Card>
      )}

      {tab === 'levels' && (
        <DataValue data={analyticsSourced}>
          {(a) => (
            <div className="grid w-full gap-4 md:grid-cols-2">
              <Card>
                <CardHeader>
                  <CardTitle className="text-up">Highest put OI</CardTitle>
                </CardHeader>
                <CardContent className="space-y-2">
                  {a.oiLevels.supports.map((l) => (
                    <div key={l.strike} className="flex items-center justify-between gap-3">
                      <span className="tabular text-sm font-medium">{l.strike}</span>
                      <div className="flex-1">
                        <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                          <div
                            className="h-full rounded-full bg-up"
                            style={{ width: `${Math.max(3, l.sharePct * 3)}%` }}
                          />
                        </div>
                      </div>
                      <span className="tabular w-24 text-right text-2xs text-muted-foreground">
                        {countCompact(l.oi)} ({pct(l.sharePct, 1)})
                      </span>
                    </div>
                  ))}
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle className="text-down">Highest call OI</CardTitle>
                </CardHeader>
                <CardContent className="space-y-2">
                  {a.oiLevels.resistances.map((l) => (
                    <div key={l.strike} className="flex items-center justify-between gap-3">
                      <span className="tabular text-sm font-medium">{l.strike}</span>
                      <div className="flex-1">
                        <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                          <div
                            className="h-full rounded-full bg-down"
                            style={{ width: `${Math.max(3, l.sharePct * 3)}%` }}
                          />
                        </div>
                      </div>
                      <span className="tabular w-24 text-right text-2xs text-muted-foreground">
                        {countCompact(l.oi)} ({pct(l.sharePct, 1)})
                      </span>
                    </div>
                  ))}
                </CardContent>
              </Card>

              <Card className="md:col-span-2">
                <CardContent className="space-y-2 pt-4">
                  <Alert>{a.oiLevels.note}</Alert>
                  <Alert>{a.ivSkew.note}</Alert>
                  <Alert variant="info">{a.interpretation}</Alert>
                </CardContent>
              </Card>
            </div>
          )}
        </DataValue>
      )}

      {tab === 'greeks' && (
        <Card>
          <CardContent className="px-0 pt-4">
            <DataValue data={analyticsSourced}>
              {(a) =>
                a.greeks.length === 0 ? (
                  <EmptyState
                    title="Greeks unavailable"
                    description="Greeks need a spot price and either a provider IV or a solvable option price. Neither was available for this chain."
                  />
                ) : (
                  <div className="w-full overflow-x-auto">
                    <table className="data-table">
                      <thead>
                        <tr>
                          <th colSpan={5} className="text-center">Call</th>
                          <th className="text-center">Strike</th>
                          <th colSpan={5} className="text-center">Put</th>
                        </tr>
                        <tr>
                          <th className="text-right">IV</th>
                          <th className="text-right">Delta</th>
                          <th className="text-right">Gamma</th>
                          <th className="text-right">Theta</th>
                          <th className="text-right">Vega</th>
                          <th className="text-center">—</th>
                          <th className="text-right">Vega</th>
                          <th className="text-right">Theta</th>
                          <th className="text-right">Gamma</th>
                          <th className="text-right">Delta</th>
                          <th className="text-right">IV</th>
                        </tr>
                      </thead>
                      <tbody>
                        {a.greeks.map((g) => (
                          <tr key={g.strike} className={cn(g.strike === a.atmStrike && 'bg-primary/5')}>
                            <td className="num">
                              {g.call?.iv !== null && g.call?.iv !== undefined ? (
                                <Tooltip content={`IV source: ${g.call.ivSource}`}>
                                  <span>{num(g.call.iv, 1)}</span>
                                </Tooltip>
                              ) : '—'}
                            </td>
                            <td className="num">{num(g.call?.delta, 3)}</td>
                            <td className="num">{num(g.call?.gamma, 5)}</td>
                            <td className="num">{num(g.call?.theta, 2)}</td>
                            <td className="num">{num(g.call?.vega, 3)}</td>
                            <td className="tabular text-center font-semibold">{g.strike}</td>
                            <td className="num">{num(g.put?.vega, 3)}</td>
                            <td className="num">{num(g.put?.theta, 2)}</td>
                            <td className="num">{num(g.put?.gamma, 5)}</td>
                            <td className="num">{num(g.put?.delta, 3)}</td>
                            <td className="num">
                              {g.put?.iv !== null && g.put?.iv !== undefined ? num(g.put.iv, 1) : '—'}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )
              }
            </DataValue>
          </CardContent>
        </Card>
      )}

      {tab === 'futures' && (
        <Card>
          <CardContent className="pt-4">
            {futures.isLoading ? (
              <Skeleton className="h-40" />
            ) : (
              <DataValue data={futures.data}>
                {(rows) => (
                  <div className="w-full space-y-3">
                    {rows.map((f) => (
                      <div key={f.symbol} className="rounded-md border border-border p-3">
                        <div className="flex flex-wrap items-start justify-between gap-3">
                          <div>
                            <div className="text-sm font-medium">{f.symbol}</div>
                            <div className="text-2xs text-muted-foreground">
                              Expiry {f.expiry} · lot {f.lotSize}
                            </div>
                          </div>
                          <Badge
                            variant={
                              f.buildup.type === 'LONG_BUILDUP' || f.buildup.type === 'SHORT_COVERING'
                                ? 'up'
                                : f.buildup.type === 'INDETERMINATE' ? 'muted' : 'down'
                            }
                          >
                            {f.buildup.label}
                          </Badge>
                        </div>
                        <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-5">
                          <Metric label="LTP" value={num(f.ltp)} />
                          <Metric
                            label="Change"
                            value={signed(f.priceChange)}
                            valueClassName={directionClass(f.priceChange)}
                          />
                          <Metric label="Open interest" value={countCompact(f.oi)} />
                          <Metric label="OI change" value={signed(f.oiChange, 0)} />
                          <Metric
                            label="Basis"
                            value={signed(f.basis)}
                            sub={f.basisPct !== null ? pct(f.basisPct) : undefined}
                            method="Futures price minus spot. Positive is a premium, negative a discount."
                          />
                        </div>
                        <p className="mt-2 border-t border-border pt-2 text-2xs leading-relaxed text-muted-foreground">
                          {f.buildup.interpretation}
                        </p>
                      </div>
                    ))}
                  </div>
                )}
              </DataValue>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

/**
 * The option chain table.
 *
 * OI bars are drawn inside the cell, scaled to the largest OI in the chain, so
 * the distribution is visible without a separate chart. Every cell still shows
 * its number — the bar is a second channel, never the only one.
 */
function OptionChainTable({ chain }: { chain: OptionChainDto }) {
  const [onlyNearAtm, setOnlyNearAtm] = useState(true);

  const spot = chain.futuresPrice ?? chain.spot;
  const atm =
    spot !== null && chain.strikes.length > 0
      ? chain.strikes.reduce((best, s) =>
          Math.abs(s.strike - spot) < Math.abs(best.strike - spot) ? s : best,
        ).strike
      : null;

  const maxOi = Math.max(
    1,
    ...chain.strikes.flatMap((s) => [s.call?.oi ?? 0, s.put?.oi ?? 0]),
  );

  let rows: OptionStrikeDto[] = chain.strikes;
  if (onlyNearAtm && atm !== null) {
    const idx = chain.strikes.findIndex((s) => s.strike === atm);
    rows = chain.strikes.slice(Math.max(0, idx - 10), idx + 11);
  }

  const oiBar = (oi: number | null, side: 'call' | 'put') =>
    oi === null ? null : (
      <div
        className={cn(
          'absolute inset-y-0 opacity-15',
          side === 'call' ? 'right-0 bg-down' : 'left-0 bg-up',
        )}
        style={{ width: `${(oi / maxOi) * 100}%` }}
        aria-hidden
      />
    );

  return (
    <div className="w-full">
      <div className="flex items-center justify-between gap-3 px-4 pb-2">
        <label className="flex items-center gap-1.5 text-2xs text-muted-foreground">
          <input
            type="checkbox"
            checked={onlyNearAtm}
            onChange={(e) => setOnlyNearAtm(e.target.checked)}
            className="h-3 w-3"
          />
          Show only ±10 strikes around ATM
        </label>
        <span className="text-2xs text-muted-foreground">
          {rows.length} of {chain.strikes.length} strikes
          {chain.lotSize && ` · lot ${chain.lotSize}`}
        </span>
      </div>

      <div className="max-h-[70vh] overflow-auto">
        <table className="data-table">
          <thead>
            <tr>
              <th colSpan={5} className="border-b border-border text-center text-down">CALLS</th>
              <th className="border-b border-border text-center">STRIKE</th>
              <th colSpan={5} className="border-b border-border text-center text-up">PUTS</th>
            </tr>
            <tr>
              <th className="text-right">OI</th>
              <th className="text-right">Chg OI</th>
              <th className="text-right">Vol</th>
              <th className="text-right">IV</th>
              <th className="text-right">LTP</th>
              <th className="text-center">Strike</th>
              <th className="text-right">LTP</th>
              <th className="text-right">IV</th>
              <th className="text-right">Vol</th>
              <th className="text-right">Chg OI</th>
              <th className="text-right">OI</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((s) => {
              const isAtm = s.strike === atm;
              const itmCall = spot !== null && s.strike < spot;
              const itmPut = spot !== null && s.strike > spot;
              return (
                <tr key={s.strike} className={cn(isAtm && 'bg-primary/10 font-medium')}>
                  <td className={cn('num relative', itmCall && 'bg-muted/40')}>
                    {oiBar(s.call?.oi ?? null, 'call')}
                    <span className="relative">{countCompact(s.call?.oi)}</span>
                  </td>
                  <td className={cn('num', itmCall && 'bg-muted/40', directionClass(s.call?.oiChange))}>
                    {s.call?.oiChange !== null && s.call?.oiChange !== undefined
                      ? signed(s.call.oiChange, 0) : '—'}
                  </td>
                  <td className={cn('num', itmCall && 'bg-muted/40')}>{countCompact(s.call?.volume)}</td>
                  <td className={cn('num', itmCall && 'bg-muted/40')}>{num(s.call?.iv, 1)}</td>
                  <td className={cn('num', itmCall && 'bg-muted/40')}>{num(s.call?.ltp)}</td>

                  <td className="tabular bg-accent/30 text-center font-semibold">{s.strike}</td>

                  <td className={cn('num', itmPut && 'bg-muted/40')}>{num(s.put?.ltp)}</td>
                  <td className={cn('num', itmPut && 'bg-muted/40')}>{num(s.put?.iv, 1)}</td>
                  <td className={cn('num', itmPut && 'bg-muted/40')}>{countCompact(s.put?.volume)}</td>
                  <td className={cn('num', itmPut && 'bg-muted/40', directionClass(s.put?.oiChange))}>
                    {s.put?.oiChange !== null && s.put?.oiChange !== undefined
                      ? signed(s.put.oiChange, 0) : '—'}
                  </td>
                  <td className={cn('num relative', itmPut && 'bg-muted/40')}>
                    {oiBar(s.put?.oi ?? null, 'put')}
                    <span className="relative">{countCompact(s.put?.oi)}</span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <p className="px-4 pt-3 text-2xs text-muted-foreground">
        Shaded rows are in the money. Bars behind the OI columns are scaled to the largest open
        interest in this chain and are a second reading of the same number shown beside them.
      </p>
    </div>
  );
}
