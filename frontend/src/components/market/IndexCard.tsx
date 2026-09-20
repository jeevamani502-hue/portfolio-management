import { useEffect } from 'react';
import { cn } from '@/lib/utils';
import { Card } from '@/components/ui';
import { DataValue } from '@/components/market/DataValue';
import { useTicks, useTick } from '@/services/ws';
import { num, signed, signedPct, arrow, directionClass } from '@/lib/format';
import { isAvailable, type Sourced, type IndexDto } from '@/types/api';

/**
 * An index tile.
 *
 * When the websocket is streaming, the live tick overrides the REST snapshot;
 * otherwise the REST value shows with its own status chip. The component never
 * blends the two silently — `source` always reflects which one you are seeing.
 */
export function IndexCard({ symbol, data }: { symbol: string; data: Sourced<IndexDto> }) {
  const subscribe = useTicks((s) => s.subscribe);
  const unsubscribe = useTicks((s) => s.unsubscribe);

  // Indices live on the INDICES exchange in the instrument master.
  const tickKey = `INDICES:${symbol}`;
  const tick = useTick(tickKey);

  useEffect(() => {
    subscribe([tickKey]);
    return () => unsubscribe([tickKey]);
  }, [tickKey, subscribe, unsubscribe]);

  return (
    <Card
      className={cn(
        'p-3 transition-colors',
        tick?.dir === 'up' && 'animate-flash-up',
        tick?.dir === 'down' && 'animate-flash-down',
      )}
    >
      {/*
        The label sits OUTSIDE the DataValue deliberately. A card that renders
        only "Unavailable" tells the user nothing — they cannot tell which
        index failed to load. Identity is always shown; only the numbers are
        conditional.
      */}
      <div className="truncate text-2xs font-medium uppercase tracking-wide text-muted-foreground">
        {isAvailable(data) ? data.value.name || symbol : symbol}
      </div>

      <DataValue data={data} showStatus compact className="!block">
        {(idx) => {
          const ltp = tick?.ltp ?? idx.ltp;
          const change = tick?.ch ?? idx.change;
          const changePct = tick?.chp ?? idx.changePct;

          return (
            <div className="min-w-0">
              <div className="tabular mt-0.5 text-lg font-semibold leading-tight">
                {num(ltp, 2)}
              </div>
              <div className={cn('tabular text-xs', directionClass(change))}>
                <span aria-hidden>{arrow(change)}</span> {signed(change)}{' '}
                {changePct !== null && changePct !== undefined && `(${signedPct(changePct)})`}
              </div>
            </div>
          );
        }}
      </DataValue>
    </Card>
  );
}
