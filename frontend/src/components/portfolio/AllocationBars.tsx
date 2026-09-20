/**
 * Allocation display.
 *
 * Sorted horizontal bars rather than a donut. Two reasons, both about
 * accuracy: comparing bar lengths along a shared baseline is far more precise
 * than comparing angles, and bars let every slice be direct-labelled — so
 * identity never depends on matching a colour to a legend. A portfolio can
 * easily exceed a dozen sectors, well past the point where any categorical
 * palette stays distinguishable.
 *
 * Colour therefore carries no identity here: a single hue encodes magnitude,
 * and the label carries the name.
 */
import { pct, inrCompact } from '@/lib/format';
import type { AllocationSliceDto } from '@/types/api';

export function AllocationBars({
  slices,
  maxRows = 12,
}: {
  slices: AllocationSliceDto[];
  maxRows?: number;
}) {
  if (slices.length === 0) {
    return (
      <div className="text-xs text-muted-foreground">
        No valued holdings to allocate. Positions whose price could not be sourced are excluded.
      </div>
    );
  }

  // Fold the long tail rather than rendering thirty two-pixel bars.
  const head = slices.slice(0, maxRows);
  const tail = slices.slice(maxRows);
  const rows =
    tail.length > 0
      ? [
          ...head,
          {
            key: `Other (${tail.length})`,
            value: tail.reduce((s, t) => s + t.value, 0),
            weightPct: tail.reduce((s, t) => s + t.weightPct, 0),
            count: tail.reduce((s, t) => s + t.count, 0),
          },
        ]
      : head;

  const max = Math.max(...rows.map((r) => r.weightPct), 1);

  return (
    <div className="space-y-2">
      {rows.map((r) => (
        <div key={r.key} className="space-y-1">
          <div className="flex items-baseline justify-between gap-2 text-2xs">
            <span className="truncate font-medium" title={r.key}>
              {r.key}
              <span className="ml-1.5 font-normal text-muted-foreground">
                {r.count} holding{r.count === 1 ? '' : 's'}
              </span>
            </span>
            <span className="tabular shrink-0 text-muted-foreground">
              {inrCompact(r.value)} · {pct(r.weightPct, 1)}
            </span>
          </div>
          <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full bg-primary transition-all"
              // Scaled to the largest slice so small weights stay visible.
              style={{ width: `${Math.max(1.5, (r.weightPct / max) * 100)}%` }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}
