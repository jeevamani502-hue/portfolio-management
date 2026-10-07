/**
 * Price chart built on TradingView Lightweight Charts.
 *
 * Colours are read from the live CSS custom properties rather than hardcoded,
 * so the validated up/down pair and the theme toggle both apply here without a
 * second source of truth.
 */
import { useEffect, useRef } from 'react';
import {
  createChart, ColorType, CrosshairMode,
  type IChartApi, type ISeriesApi, type UTCTimestamp, type LineData, type CandlestickData,
} from 'lightweight-charts';
import type { CandleDto } from '@/types/api';
import { hslToRgba, chartColor } from './color';

/** Read a theme custom property as a colour the chart library can parse. */
function cssVar(name: string, alpha = 1): string {
  const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return hslToRgba(raw, alpha) ?? `rgba(128, 128, 128, ${alpha})`;
}

export interface Overlay {
  /** Series label, shown in the legend rendered by the parent. */
  label: string;
  /** Values aligned 1:1 with `candles`; null gaps are skipped. */
  values: Array<number | null>;
  color: string;
  lineWidth?: 1 | 2;
}

export function CandleChart({
  candles,
  overlays = [],
  height = 400,
  showVolume = true,
  showCandles = true,
  priceLines = [],
}: {
  candles: CandleDto[];
  overlays?: Overlay[];
  height?: number;
  showVolume?: boolean;
  /**
   * Draw the candlesticks. Off for an oscillator pane, where the series
   * shares the x-axis but not the y-scale — RSI plotted against price would
   * flatten both into unreadable lines.
   */
  showCandles?: boolean;
  priceLines?: Array<{ price: number; label: string; color: string; dashed?: boolean }>;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || candles.length === 0) return;

    const upColor = cssVar('--up');
    const downColor = cssVar('--down');
    const textColor = cssVar('--muted-foreground');
    const gridColor = cssVar('--border', 0.5);

    const chart = createChart(container, {
      height,
      layout: {
        background: { type: ColorType.Solid, color: 'transparent' },
        textColor,
        fontFamily: 'Inter, system-ui, sans-serif',
        fontSize: 11,
      },
      // Recessive grid: present enough to read against, never competing with
      // the data.
      grid: {
        vertLines: { color: gridColor, style: 1 },
        horzLines: { color: gridColor, style: 1 },
      },
      rightPriceScale: { borderColor: gridColor, scaleMargins: { top: 0.1, bottom: showVolume ? 0.28 : 0.1 } },
      timeScale: { borderColor: gridColor, timeVisible: true, secondsVisible: false },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: { color: textColor, width: 1, style: 3, labelBackgroundColor: cssVar('--card') },
        horzLine: { color: textColor, width: 1, style: 3, labelBackgroundColor: cssVar('--card') },
      },
      handleScale: { axisPressedMouseMove: { time: true, price: false } },
    });
    chartRef.current = chart;

    const toTime = (iso: string): UTCTimestamp =>
      Math.floor(new Date(iso).getTime() / 1000) as UTCTimestamp;

    let candleSeries: ISeriesApi<'Candlestick'> | null = null;
    if (showCandles) {
      candleSeries = chart.addCandlestickSeries({
        upColor,
        downColor,
        borderUpColor: upColor,
        borderDownColor: downColor,
        wickUpColor: upColor,
        wickDownColor: downColor,
      });

      const candleData: CandlestickData[] = candles.map((c) => ({
        time: toTime(c.ts),
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
      }));
      candleSeries.setData(candleData);
    }

    if (showVolume) {
      const volumeSeries = chart.addHistogramSeries({
        priceFormat: { type: 'volume' },
        priceScaleId: 'volume',
      });
      chart.priceScale('volume').applyOptions({
        scaleMargins: { top: 0.78, bottom: 0 },
      });
      volumeSeries.setData(
        candles.map((c, i) => {
          const prev = candles[i - 1];
          const rising = prev ? c.close >= prev.close : c.close >= c.open;
          return {
            time: toTime(c.ts),
            value: c.volume,
            color: rising ? cssVar('--up', 0.35) : cssVar('--down', 0.35),
          };
        }),
      );
    }

    for (const overlay of overlays) {
      const series = chart.addLineSeries({
        color: chartColor(overlay.color),
        lineWidth: overlay.lineWidth ?? 2,
        priceLineVisible: false,
        lastValueVisible: false,
        crosshairMarkerVisible: false,
      });
      const data: LineData[] = [];
      overlay.values.forEach((v, i) => {
        const candle = candles[i];
        if (v === null || v === undefined || !candle) return;
        data.push({ time: toTime(candle.ts), value: v });
      });
      series.setData(data);
    }

    // Price lines hang off the candle series, so there is nowhere to put
    // them in a lines-only pane.
    if (candleSeries) {
      for (const line of priceLines) {
        candleSeries.createPriceLine({
          price: line.price,
          color: chartColor(line.color),
          lineWidth: 1,
          lineStyle: line.dashed ? 2 : 0,
          axisLabelVisible: true,
          title: line.label,
        });
      }
    }

    chart.timeScale().fitContent();

    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width;
      if (width) chart.applyOptions({ width });
    });
    observer.observe(container);

    return () => {
      observer.disconnect();
      chart.remove();
      chartRef.current = null;
    };
    // Re-create on data or overlay identity change; cheap at these sizes.
  }, [candles, overlays, height, showVolume, showCandles, priceLines]);

  if (candles.length === 0) {
    return (
      <div
        className="flex items-center justify-center rounded-md border border-dashed border-border text-xs text-muted-foreground"
        style={{ height }}
      >
        No price history available to chart.
      </div>
    );
  }

  return <div ref={containerRef} style={{ height }} className="w-full" />;
}
