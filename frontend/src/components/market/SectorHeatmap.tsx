/**
 * Sector performance grid.
 *
 * Diverging encoding: two poles (down / up) around a neutral gray midpoint at
 * zero, which is the correct scheme for a signed quantity. Intensity is scaled
 * to the largest absolute move on screen so a quiet day is not rendered as a
 * dramatic one.
 *
 * Every cell direct-labels its own percentage, so colour is a second channel
 * rather than the only one.
 */
import { Link } from 'react-router-dom';
import { Tooltip } from '@/components/ui';
import { signedPct, arrow } from '@/lib/format';
import type { SectorDto } from '@/types/api';

export function SectorHeatmap({ sectors }: { sectors: SectorDto[] }) {
  if (sectors.length === 0) {
    return (
      <div className="text-xs text-muted-foreground">
        No sector classification is stored for the scan universe yet.
      </div>
    );
  }

  // Scale intensity to the day's own range, floored so a flat day stays legible.
  const maxAbs = Math.max(0.5, ...sectors.map((s) => Math.abs(s.avgChangePct)));

  return (
    <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6">
      {sectors.map((s) => {
        const intensity = Math.min(1, Math.abs(s.avgChangePct) / maxAbs);
        // 0.10 floor keeps a near-zero cell visible as "neutral" rather than blank.
        const alpha = 0.10 + intensity * 0.55;
        const isUp = s.avgChangePct > 0;
        const isFlat = Math.abs(s.avgChangePct) < 0.01;

        const background = isFlat
          ? 'hsl(var(--muted))'
          : `hsl(var(--${isUp ? 'up' : 'down'}) / ${alpha.toFixed(2)})`;

        return (
          <Tooltip
            key={s.sector}
            content={
              <div className="space-y-0.5">
                <div className="font-semibold">{s.sector}</div>
                <div>
                  Average change {signedPct(s.avgChangePct)} across {s.count} stock
                  {s.count === 1 ? '' : 's'}
                </div>
                <div>
                  {s.advances} advancing · {s.declines} declining
                </div>
                {s.topGainer && (
                  <div>
                    Best: {s.topGainer.symbol} {signedPct(s.topGainer.changePct)}
                  </div>
                )}
                {s.topLoser && (
                  <div>
                    Worst: {s.topLoser.symbol} {signedPct(s.topLoser.changePct)}
                  </div>
                )}
              </div>
            }
          >
            <div
              className="w-full rounded-md border border-border/50 p-2 transition-transform hover:scale-[1.02]"
              style={{ background }}
            >
              <div className="truncate text-2xs font-medium" title={s.sector}>
                {s.sector}
              </div>
              <div className="tabular mt-0.5 text-sm font-semibold">
                <span aria-hidden className="mr-0.5">
                  {arrow(s.avgChangePct)}
                </span>
                {signedPct(s.avgChangePct)}
              </div>
              <div className="text-2xs text-muted-foreground">
                {s.advances}/{s.count} up
              </div>
            </div>
          </Tooltip>
        );
      })}
    </div>
  );
}

/** Text link version used inside dense panels. */
export function SectorLink({ sector }: { sector: string | null }) {
  if (!sector) return <span className="text-muted-foreground">—</span>;
  return (
    <Link to={`/markets?sector=${encodeURIComponent(sector)}`} className="hover:text-primary">
      {sector}
    </Link>
  );
}
