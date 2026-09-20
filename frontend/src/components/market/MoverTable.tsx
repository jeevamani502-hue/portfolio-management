import { Link } from 'react-router-dom';
import { inr, signedPct, countCompact, arrow, directionClass } from '@/lib/format';
import type { MoverDto } from '@/types/api';

export function MoverTable({ rows, showVolume = true }: { rows: MoverDto[]; showVolume?: boolean }) {
  if (rows.length === 0) {
    return <div className="px-4 py-6 text-center text-xs text-muted-foreground">No matches.</div>;
  }

  return (
    <div className="overflow-x-auto">
      <table className="data-table">
        <thead>
          <tr>
            <th>Symbol</th>
            <th className="text-right">LTP</th>
            <th className="text-right">Change</th>
            {showVolume && <th className="text-right">Volume</th>}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.symbol}>
              <td>
                <Link
                  to={`/stocks/${encodeURIComponent(r.symbol)}`}
                  className="font-medium hover:text-primary"
                >
                  {r.tradingsymbol}
                </Link>
                {r.sector && (
                  <div className="truncate text-2xs text-muted-foreground">{r.sector}</div>
                )}
              </td>
              <td className="num">{inr(r.ltp)}</td>
              <td className={`num ${directionClass(r.changePct)}`}>
                <span aria-hidden className="mr-0.5">
                  {arrow(r.changePct)}
                </span>
                {signedPct(r.changePct)}
              </td>
              {showVolume && <td className="num">{countCompact(r.volume)}</td>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
