/**
 * Advance/decline proportion bar.
 *
 * A single stacked bar showing one whole split three ways — the right form for
 * "share of a total" with few parts. Segments are separated by a 2px surface
 * gap and each carries its own count as a direct label when it is wide enough,
 * so the reading never depends on colour.
 */
import { Tooltip } from '@/components/ui';

export function BreadthBar({
  advances,
  declines,
  unchanged,
}: {
  advances: number;
  declines: number;
  unchanged: number;
}) {
  const total = advances + declines + unchanged;
  if (total === 0) {
    return (
      <div className="text-xs text-muted-foreground">
        No instruments returned a usable quote, so breadth cannot be shown.
      </div>
    );
  }

  const segments = [
    { key: 'adv', label: 'Advancing', value: advances, cls: 'bg-up' },
    { key: 'unch', label: 'Unchanged', value: unchanged, cls: 'bg-flat' },
    { key: 'dec', label: 'Declining', value: declines, cls: 'bg-down' },
  ].filter((s) => s.value > 0);

  return (
    <div
      className="flex h-7 w-full gap-0.5 overflow-hidden rounded"
      role="img"
      aria-label={`${advances} advancing, ${declines} declining, ${unchanged} unchanged out of ${total}`}
    >
      {segments.map((s) => {
        const sharePct = (s.value / total) * 100;
        return (
          <Tooltip
            key={s.key}
            content={`${s.label}: ${s.value} of ${total} (${sharePct.toFixed(1)}%)`}
            className="h-full"
            // Flex basis carries the proportion; the gap is the 2px spacer.
          >
            <div
              className={`${s.cls} flex h-full items-center justify-center overflow-hidden
                          rounded-sm px-1 transition-all`}
              style={{ width: `${sharePct}%`, minWidth: sharePct > 0 ? '3px' : 0 }}
            >
              {/* Direct-label only where the segment is genuinely wide enough
                  to hold the text without clipping. */}
              {sharePct > 12 && (
                <span className="tabular truncate text-2xs font-semibold text-white">
                  {s.value}
                </span>
              )}
            </div>
          </Tooltip>
        );
      })}
    </div>
  );
}
