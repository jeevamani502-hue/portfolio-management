/**
 * Indian-market formatting.
 *
 * Two things matter here and are easy to get wrong:
 *  1. Indian digit grouping (lakh/crore), not Western thousands.
 *  2. Never rendering a placeholder for a missing value. A blank or a zero
 *     where a price should be is the bug this whole platform is built to
 *     avoid, so `null` formats as an explicit em-dash and callers that care
 *     use `<DataValue>` instead.
 */

export const NA = '—';

/** Indian grouping: 12,34,567.89 */
export function inr(
  value: number | null | undefined,
  opts: { decimals?: number; symbol?: boolean } = {},
): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return NA;
  const { decimals = 2, symbol = true } = opts;
  const formatted = value.toLocaleString('en-IN', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
  return symbol ? `₹${formatted}` : formatted;
}

/** Compact Indian scale: 1.23 Cr, 45.6 L, 12.3 K. */
export function inrCompact(value: number | null | undefined, decimals = 2): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return NA;
  const abs = Math.abs(value);
  const sign = value < 0 ? '-' : '';

  if (abs >= 1e7) return `${sign}₹${(abs / 1e7).toFixed(decimals)} Cr`;
  if (abs >= 1e5) return `${sign}₹${(abs / 1e5).toFixed(decimals)} L`;
  if (abs >= 1e3) return `${sign}₹${(abs / 1e3).toFixed(decimals)} K`;
  return `${sign}₹${abs.toFixed(decimals)}`;
}

/** Share counts and volumes, Indian grouped. */
export function count(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return NA;
  return Math.round(value).toLocaleString('en-IN');
}

export function countCompact(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return NA;
  const abs = Math.abs(value);
  const sign = value < 0 ? '-' : '';
  if (abs >= 1e7) return `${sign}${(abs / 1e7).toFixed(2)} Cr`;
  if (abs >= 1e5) return `${sign}${(abs / 1e5).toFixed(2)} L`;
  if (abs >= 1e3) return `${sign}${(abs / 1e3).toFixed(1)} K`;
  return `${sign}${Math.round(abs)}`;
}

export function pct(value: number | null | undefined, decimals = 2): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return NA;
  return `${value.toFixed(decimals)}%`;
}

/** Always shows the sign — direction must never depend on colour alone. */
export function signedPct(value: number | null | undefined, decimals = 2): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return NA;
  return `${value >= 0 ? '+' : ''}${value.toFixed(decimals)}%`;
}

export function signed(value: number | null | undefined, decimals = 2): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return NA;
  return `${value >= 0 ? '+' : ''}${value.toLocaleString('en-IN', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  })}`;
}

export function num(value: number | null | undefined, decimals = 2): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return NA;
  return value.toFixed(decimals);
}

/** A non-colour direction cue, for accessibility. */
export function arrow(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value) || value === 0) return '';
  return value > 0 ? '▲' : '▼';
}

export type Direction = 'up' | 'down' | 'flat';

export function direction(value: number | null | undefined): Direction {
  if (value === null || value === undefined || !Number.isFinite(value) || value === 0) return 'flat';
  return value > 0 ? 'up' : 'down';
}

export function directionClass(value: number | null | undefined): string {
  const d = direction(value);
  return d === 'up' ? 'text-up' : d === 'down' ? 'text-down' : 'text-flat';
}

// ── time ────────────────────────────────────────────────────────────────────

const IST_OFFSET_MIN = 330;

export function toIstDate(iso: string | Date): Date {
  const d = typeof iso === 'string' ? new Date(iso) : iso;
  return new Date(d.getTime() + IST_OFFSET_MIN * 60_000);
}

/** "09:42:13" in IST. */
export function istTime(iso: string | null | undefined, withSeconds = true): string {
  if (!iso) return NA;
  const d = toIstDate(iso);
  if (Number.isNaN(d.getTime())) return NA;
  const p = (n: number) => String(n).padStart(2, '0');
  return withSeconds
    ? `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`
    : `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

/** "15 Mar, 09:42" in IST. */
export function istDateTime(iso: string | null | undefined): string {
  if (!iso) return NA;
  const d = toIstDate(iso);
  if (Number.isNaN(d.getTime())) return NA;
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCDate()} ${months[d.getUTCMonth()]}, ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

export function istDate(iso: string | null | undefined): string {
  if (!iso) return NA;
  const d = toIstDate(iso);
  if (Number.isNaN(d.getTime())) return NA;
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${d.getUTCDate()} ${months[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** "2m ago", "just now" — for data-age display. */
export function relativeTime(iso: string | null | undefined): string {
  if (!iso) return NA;
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return NA;
  const secs = Math.floor((Date.now() - then) / 1000);

  if (secs < 5) return 'just now';
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return istDate(iso);
}

/** Symbol without the exchange prefix, for compact display. */
export function shortSymbol(symbol: string | null | undefined): string {
  if (!symbol) return NA;
  const idx = symbol.indexOf(':');
  return idx === -1 ? symbol : symbol.slice(idx + 1);
}

/** Title-cases an ALL_CAPS enum for display: STRONG_UPTREND → Strong uptrend. */
export function humanise(value: string | null | undefined): string {
  if (!value) return NA;
  const lower = value.replace(/_/g, ' ').toLowerCase();
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}
