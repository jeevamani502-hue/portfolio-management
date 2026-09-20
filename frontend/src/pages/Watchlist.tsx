import { useState, useEffect, useMemo } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2, Newspaper } from 'lucide-react';
import { api } from '@/services/api';
import { isAvailable } from '@/types/api';
import {
  Card, CardContent, Skeleton, Badge, Button, Input, Select, EmptyState, Tooltip, Alert,
} from '@/components/ui';
import { StatusChip, Unavailable } from '@/components/market/DataValue';
import { useTicks, useTick } from '@/services/ws';
import { inr, num, signed, signedPct, countCompact, arrow, directionClass, humanise } from '@/lib/format';
import { cn } from '@/lib/utils';
import type { WatchlistRowDto } from '@/types/api';

export function Watchlist() {
  const [activeId, setActiveId] = useState<string>('');
  const [tf, setTf] = useState('1d');
  const [newSymbol, setNewSymbol] = useState('');
  const qc = useQueryClient();

  const lists = useQuery({ queryKey: ['watchlists'], queryFn: () => api.watchlists.list() });
  const listId = activeId || lists.data?.[0]?.id || '';

  const rows = useQuery({
    queryKey: ['watchlists', listId, 'live', tf],
    queryFn: () => api.watchlists.live(listId, tf, true),
    enabled: Boolean(listId),
    refetchInterval: 30_000,
  });

  const addItem = useMutation({
    mutationFn: (symbol: string) => api.watchlists.addItem(listId, symbol),
    onSuccess: () => {
      setNewSymbol('');
      void qc.invalidateQueries({ queryKey: ['watchlists'] });
    },
  });

  const removeItem = useMutation({
    mutationFn: (itemId: string) => api.watchlists.removeItem(listId, itemId),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['watchlists'] }),
  });

  // Stream every symbol on the visible list.
  const subscribe = useTicks((s) => s.subscribe);
  const unsubscribe = useTicks((s) => s.unsubscribe);
  const symbols = useMemo(() => (rows.data ?? []).map((r) => r.symbol), [rows.data]);

  useEffect(() => {
    if (symbols.length === 0) return;
    subscribe(symbols);
    return () => unsubscribe(symbols);
  }, [symbols, subscribe, unsubscribe]);

  if (lists.isLoading) return <Skeleton className="h-64" />;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <div className="w-48 space-y-1">
          <label className="text-2xs uppercase tracking-wide text-muted-foreground">Watchlist</label>
          <Select value={listId} onChange={(e) => setActiveId(e.target.value)}>
            {(lists.data ?? []).map((l) => (
              <option key={l.id} value={l.id}>
                {l.name} ({l.itemCount})
              </option>
            ))}
          </Select>
        </div>

        <div className="w-28 space-y-1">
          <label className="text-2xs uppercase tracking-wide text-muted-foreground">Timeframe</label>
          <Select value={tf} onChange={(e) => setTf(e.target.value)}>
            {['15m', '1h', '1d', '1w'].map((t) => (
              <option key={t} value={t}>{t}</option>
            ))}
          </Select>
        </div>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (newSymbol.trim()) addItem.mutate(newSymbol.trim().toUpperCase());
          }}
          className="flex items-end gap-2"
        >
          <div className="w-44 space-y-1">
            <label className="text-2xs uppercase tracking-wide text-muted-foreground">
              Add symbol
            </label>
            <Input
              value={newSymbol}
              onChange={(e) => setNewSymbol(e.target.value)}
              placeholder="RELIANCE"
            />
          </div>
          <Button type="submit" size="sm" disabled={!newSymbol.trim() || addItem.isPending}>
            <Plus className="h-3.5 w-3.5" aria-hidden />
            Add
          </Button>
        </form>
      </div>

      {addItem.isError && <Alert variant="error">{(addItem.error as Error).message}</Alert>}

      <Card>
        <CardContent className="px-0 pt-4">
          {rows.isLoading ? (
            <Skeleton className="mx-4 h-64" />
          ) : (rows.data ?? []).length === 0 ? (
            <EmptyState
              title="This watchlist is empty"
              description="Add a symbol above to track its price, momentum and current rule-based signal."
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Symbol</th>
                    <th className="text-right">LTP</th>
                    <th className="text-right">Change</th>
                    <th className="text-right">Volume</th>
                    <th className="text-right">RSI</th>
                    <th>Trend</th>
                    <th className="text-right">Score</th>
                    <th>Signal</th>
                    <th className="text-center">News</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {(rows.data ?? []).map((row) => (
                    <WatchRow
                      key={row.itemId}
                      row={row}
                      onRemove={() => removeItem.mutate(row.itemId)}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <p className="text-2xs text-muted-foreground">
        RSI, trend and signal are computed on {tf} bars from stored history. The score measures how
        many rule-based conditions currently agree — it is not a forecast.
      </p>
    </div>
  );
}

function WatchRow({ row, onRemove }: { row: WatchlistRowDto; onRemove: () => void }) {
  const tick = useTick(row.symbol);
  const quote = row.quote;

  const ltp = tick?.ltp ?? (quote && isAvailable(quote) ? quote.value.ltp : null);
  const prevClose = quote && isAvailable(quote) ? quote.value.prevClose : null;
  const change = tick?.ch ?? (ltp !== null && prevClose !== null ? ltp - prevClose : null);
  const changePct =
    tick?.chp ?? (ltp !== null && prevClose !== null && prevClose > 0
      ? ((ltp - prevClose) / prevClose) * 100
      : null);
  const volume = tick?.v ?? (quote && isAvailable(quote) ? quote.value.volume : null);

  return (
    <tr
      className={cn(
        tick?.dir === 'up' && 'animate-flash-up',
        tick?.dir === 'down' && 'animate-flash-down',
      )}
    >
      <td>
        <Link
          to={`/stocks/${encodeURIComponent(row.symbol)}`}
          className="font-medium hover:text-primary"
        >
          {row.tradingsymbol}
        </Link>
        {row.sector && <div className="text-2xs text-muted-foreground">{row.sector}</div>}
      </td>
      <td className="num">
        {ltp !== null ? (
          <span className="inline-flex items-center gap-1.5">
            {inr(ltp)}
            {quote && isAvailable(quote) && (
              <StatusChip
                status={tick ? 'live' : quote.status}
                asOf={tick ? new Date(tick.t).toISOString() : quote.asOf}
                source={tick?.src ?? quote.source}
                showLabel={false}
              />
            )}
          </span>
        ) : (
          <Unavailable compact detail={quote && !isAvailable(quote) ? quote.detail : undefined} />
        )}
      </td>
      <td className={cn('num', directionClass(change))}>
        {change !== null ? (
          <>
            <span aria-hidden>{arrow(change)}</span> {signed(change)}
            <div className="text-2xs">{signedPct(changePct)}</div>
          </>
        ) : '—'}
      </td>
      <td className="num">{countCompact(volume)}</td>
      <td className="num">
        {row.technicals.rsi !== null ? (
          <span
            className={cn(
              row.technicals.rsi > 70 && 'text-down',
              row.technicals.rsi < 30 && 'text-up',
            )}
          >
            {num(row.technicals.rsi, 1)}
          </span>
        ) : (
          <Tooltip content={row.technicals.note ?? 'Not enough history'}>
            <span className="text-2xs text-muted-foreground">—</span>
          </Tooltip>
        )}
      </td>
      <td className="text-2xs">{row.technicals.trend ? humanise(row.technicals.trend) : '—'}</td>
      <td className="num">{row.technicals.score ?? '—'}</td>
      <td>
        {row.technicals.signal ? (
          <Badge variant={row.technicals.signal.direction === 'BULLISH' ? 'up' : 'down'}>
            {row.technicals.signal.label} {row.technicals.signal.strength}
          </Badge>
        ) : (
          <span className="text-2xs text-muted-foreground">None</span>
        )}
      </td>
      <td className="text-center">
        {row.newsCount24h > 0 ? (
          <Tooltip content={`${row.newsCount24h} articles in the last 24 hours`}>
            <Link to={`/stocks/${encodeURIComponent(row.symbol)}`} className="inline-flex">
              <Newspaper className="h-3.5 w-3.5 text-primary" aria-hidden />
            </Link>
          </Tooltip>
        ) : (
          <span className="text-2xs text-muted-foreground">—</span>
        )}
      </td>
      <td className="text-right">
        <button
          onClick={onRemove}
          aria-label={`Remove ${row.tradingsymbol}`}
          className="text-muted-foreground transition-colors hover:text-destructive"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </td>
    </tr>
  );
}
