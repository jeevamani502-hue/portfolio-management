import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/services/api';
import { Card, CardHeader, CardTitle, CardContent, Skeleton, Select, Tabs, Alert } from '@/components/ui';
import { DataValue } from '@/components/market/DataValue';
import { IndexCard } from '@/components/market/IndexCard';
import { SectorHeatmap } from '@/components/market/SectorHeatmap';
import { MoverTable } from '@/components/market/MoverTable';

const MOVER_TABS = [
  { id: 'gainers', label: 'Gainers' },
  { id: 'losers', label: 'Losers' },
  { id: 'volume', label: 'Volume shockers' },
  { id: 'gapup', label: 'Gap up' },
  { id: 'gapdown', label: 'Gap down' },
  { id: 'near52high', label: 'Near 52w high' },
  { id: 'near52low', label: 'Near 52w low' },
];

export function Markets() {
  const [scope, setScope] = useState('NIFTY50');
  const [moverTab, setMoverTab] = useState('gainers');

  const indices = useQuery({
    queryKey: ['market', 'indices', 'all'],
    queryFn: () => api.market.indices(),
    refetchInterval: 15_000,
  });

  const sectors = useQuery({
    queryKey: ['market', 'sectors', scope],
    queryFn: () => api.market.sectors(scope),
    refetchInterval: 60_000,
  });

  const movers = useQuery({
    queryKey: ['market', 'movers', moverTab, scope],
    queryFn: () => api.market.movers(moverTab, scope, 25),
    refetchInterval: 60_000,
  });

  const breadth = useQuery({
    queryKey: ['market', 'breadth', scope],
    queryFn: () => api.market.breadth(scope),
    refetchInterval: 60_000,
  });

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="w-48 space-y-1">
          <label className="text-2xs uppercase tracking-wide text-muted-foreground">Universe</label>
          <Select value={scope} onChange={(e) => setScope(e.target.value)}>
            <option value="NIFTY50">NIFTY 50</option>
            <option value="NIFTYNEXT50">NIFTY Next 50</option>
            <option value="NIFTY100">NIFTY 100</option>
            <option value="NSE">All NSE equities</option>
          </Select>
        </div>
        <DataValue data={breadth.data} compact>
          {(b) => (
            <div className="text-2xs text-muted-foreground">
              {b.advances} advancing · {b.declines} declining · {b.unchanged} unchanged across{' '}
              {b.totalScanned} scanned
            </div>
          )}
        </DataValue>
      </div>

      {indices.isLoading ? (
        <Skeleton className="h-24" />
      ) : (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
          {(indices.data ?? []).map((row) => (
            <IndexCard key={row.symbol} symbol={row.symbol} data={row.data} />
          ))}
        </div>
      )}

      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <CardTitle>Sector performance</CardTitle>
          <DataValue data={sectors.data} compact>
            {() => <></>}
          </DataValue>
        </CardHeader>
        <CardContent>
          {sectors.isLoading ? (
            <Skeleton className="h-28" />
          ) : (
            <DataValue data={sectors.data}>{(s) => <SectorHeatmap sectors={s} />}</DataValue>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-0">
          <Tabs tabs={MOVER_TABS} active={moverTab} onChange={setMoverTab} />
        </CardHeader>
        <CardContent className="px-0 pt-3">
          {movers.isLoading ? (
            <Skeleton className="mx-4 h-64" />
          ) : (
            <DataValue data={movers.data}>{(rows) => <MoverTable rows={rows} />}</DataValue>
          )}
        </CardContent>
      </Card>

      <Alert>
        Movers are computed from the quotes the platform already holds for the selected universe,
        not scraped from a published leaderboard — so the list always matches the prices shown
        elsewhere in the app, and instruments whose price could not be sourced are excluded rather
        than ranked at zero.
      </Alert>
    </div>
  );
}
