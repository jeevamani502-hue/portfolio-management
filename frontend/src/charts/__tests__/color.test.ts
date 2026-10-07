/**
 * Colour conversion for the chart library.
 *
 * This exists because of a crash that took the whole page down with
 * "Cannot parse color: hsl(218 11% 62%)". Lightweight Charts parses colours
 * itself and its parser predates space-separated HSL — which is exactly the
 * form Tailwind stores theme variables in. The bug sat latent through the
 * whole build because it only fires once there are real candles to draw.
 */
import { describe, it, expect } from 'vitest';
import { hslToRgba, chartColor } from '../color';

describe('hslToRgba', () => {
  it('converts the value that crashed the chart', () => {
    expect(hslToRgba('218 11% 62%')).toBe('rgba(147, 155, 169, 1)');
  });

  it('handles the comma-separated form too', () => {
    expect(hslToRgba('218, 11%, 62%')).toBe(hslToRgba('218 11% 62%'));
  });

  it('carries alpha through', () => {
    expect(hslToRgba('220 13% 89%', 0.5)).toMatch(/, 0\.5\)$/);
  });

  it.each([
    ['0 0% 0%', 'rgba(0, 0, 0, 1)'],
    ['0 0% 100%', 'rgba(255, 255, 255, 1)'],
    ['0 100% 50%', 'rgba(255, 0, 0, 1)'],
    ['120 100% 50%', 'rgba(0, 255, 0, 1)'],
    ['240 100% 50%', 'rgba(0, 0, 255, 1)'],
  ])('converts %s correctly', (input, expected) => {
    expect(hslToRgba(input)).toBe(expected);
  });

  it('covers every hue sector without throwing', () => {
    for (let h = 0; h < 360; h += 15) {
      expect(hslToRgba(`${h} 60% 50%`)).toMatch(/^rgba\(\d+, \d+, \d+, 1\)$/);
    }
  });

  it('returns null for something it cannot parse, rather than guessing', () => {
    expect(hslToRgba('')).toBeNull();
    expect(hslToRgba('not a colour')).toBeNull();
    expect(hslToRgba('#ff0000')).toBeNull();
  });
});

describe('chartColor', () => {
  it('normalises the space-separated hsl() a caller would naturally write', () => {
    expect(chartColor('hsl(217 91% 60%)')).toMatch(/^rgba\(/);
  });

  it('never emits a space-separated hsl(), which is what the library rejects', () => {
    // Every colour this app actually passes to the chart.
    for (const c of [
      'hsl(217 91% 60%)', 'hsl(271 81% 66%)', 'hsl(24 95% 53%)',
      'hsl(160 84% 39%)', 'hsl(340 82% 62%)', 'hsl(199 89% 48%)',
      'hsl(0 72% 51%)',
    ]) {
      const out = chartColor(c);
      expect(out).not.toMatch(/hsl\(\s*[\d.]+\s+/);
      expect(out).toMatch(/^rgba\(\d+, \d+, \d+, [\d.]+\)$/);
    }
  });

  it('handles the slash-alpha form', () => {
    expect(chartColor('hsl(218 11% 62% / 0.4)')).toMatch(/, 0\.4\)$/);
  });

  it('passes hex and rgb through untouched — they already parse', () => {
    expect(chartColor('#0c9078')).toBe('#0c9078');
    expect(chartColor('rgb(12, 144, 120)')).toBe('rgb(12, 144, 120)');
  });
});
