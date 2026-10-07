/**
 * Colour conversion for Lightweight Charts.
 *
 * Kept separate from the chart component so it can be tested without a DOM:
 * these are pure functions, and the bug they exist to prevent crashed the
 * entire page rather than degrading, which makes it exactly the kind of
 * thing that should be pinned.
 */
/**
 * Convert Tailwind's `H S% L%` custom-property form into `rgba(...)`.
 *
 * Lightweight Charts parses colours itself rather than handing them to the
 * browser, and its parser predates space-separated HSL — `hsl(218 11% 62%)`
 * throws "Cannot parse color" and takes the whole chart down with it. The
 * theme variables are stored in exactly that form, so every colour read from
 * one has to be converted before it reaches the library.
 */
export function hslToRgba(raw: string, alpha = 1): string | null {
  // "218 11% 62%" and "218, 11%, 62%" both appear in the wild.
  const m = /^(-?[\d.]+)\s*,?\s+(-?[\d.]+)%\s*,?\s+(-?[\d.]+)%$/.exec(raw.trim());
  if (!m) return null;

  const h = ((Number(m[1]) % 360) + 360) % 360;
  const sat = Math.min(100, Math.max(0, Number(m[2]))) / 100;
  const lum = Math.min(100, Math.max(0, Number(m[3]))) / 100;
  if (!Number.isFinite(h) || !Number.isFinite(sat) || !Number.isFinite(lum)) return null;

  const c = (1 - Math.abs(2 * lum - 1)) * sat;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const mo = lum - c / 2;

  const [r1, g1, b1] =
    h < 60 ? [c, x, 0] :
    h < 120 ? [x, c, 0] :
    h < 180 ? [0, c, x] :
    h < 240 ? [0, x, c] :
    h < 300 ? [x, 0, c] : [c, 0, x];

  const to255 = (v: number) => Math.round((v + mo) * 255);
  return `rgba(${to255(r1!)}, ${to255(g1!)}, ${to255(b1!)}, ${alpha})`;
}

export function chartColor(input: string): string {
  const hsl = /^hsla?\(([^)]+)\)$/i.exec(input.trim());
  if (!hsl) return input; // hex and rgb() pass straight through.

  const body = hsl[1]!;
  const [colorPart, alphaPart] = body.split('/');
  const alpha = alphaPart ? Number(alphaPart.trim()) : 1;
  return hslToRgba(colorPart!, Number.isFinite(alpha) ? alpha : 1) ?? '#808080';
}
