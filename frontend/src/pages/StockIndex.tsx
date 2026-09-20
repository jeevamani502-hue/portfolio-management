import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Search } from 'lucide-react';
import { api } from '@/services/api';
import { Card, CardContent, Input, Badge, Skeleton, EmptyState } from '@/components/ui';

const POPULAR = [
  'RELIANCE', 'TCS', 'HDFCBANK', 'ICICIBANK', 'INFY', 'SBIN',
  'BHARTIARTL', 'ITC', 'LT', 'AXISBANK', 'KOTAKBANK', 'HINDUNILVR',
];

export function StockIndex() {
  const [query, setQuery] = useState('');

  const results = useQuery({
    queryKey: ['search', 'page', query],
    queryFn: () => api.market.search(query, 30),
    enabled: query.trim().length >= 1,
  });

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <div className="space-y-1">
        <h1 className="text-lg font-semibold">Stock analysis</h1>
        <p className="text-xs text-muted-foreground">
          Search the instrument master, or pick one of the frequently analysed names below.
        </p>
      </div>

      <div className="relative">
        <Search
          className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
          aria-hidden
        />
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search by symbol or company name"
          className="pl-9"
          autoFocus
        />
      </div>

      {query.trim().length === 0 ? (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
          {POPULAR.map((s) => (
            <Link
              key={s}
              to={`/stocks/NSE:${s}`}
              className="rounded-md border border-border p-3 text-sm font-medium transition-colors hover:bg-accent"
            >
              {s}
            </Link>
          ))}
        </div>
      ) : results.isLoading ? (
        <Skeleton className="h-64" />
      ) : (results.data ?? []).length === 0 ? (
        <EmptyState
          title={`Nothing matches "${query}"`}
          description="If you expected a result, the instrument master may not be synced yet. Configure a provider in Settings and run the sync."
        />
      ) : (
        <Card>
          <CardContent className="px-0 pt-2">
            <ul className="divide-y divide-border">
              {(results.data ?? []).map((r) => (
                <li key={r.id}>
                  <Link
                    to={`/stocks/${encodeURIComponent(r.symbol)}`}
                    className="flex items-center justify-between gap-3 px-4 py-2.5 transition-colors hover:bg-accent"
                  >
                    <div className="min-w-0">
                      <div className="text-sm font-medium">{r.tradingsymbol}</div>
                      {r.name && (
                        <div className="truncate text-2xs text-muted-foreground">{r.name}</div>
                      )}
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      {r.sector && (
                        <span className="hidden text-2xs text-muted-foreground sm:inline">
                          {r.sector}
                        </span>
                      )}
                      <Badge variant="muted">{r.exchange}</Badge>
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
