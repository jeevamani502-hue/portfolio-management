/**
 * Price chart with selectable indicators, and the trade that goes with it.
 *
 * Indicator values are computed on the server, not here. The same code that
 * scores a setup draws the line, so the chart cannot quietly disagree with
 * the signal you are about to act on — a second implementation in the
 * browser would drift, and both sides would look correct while doing so.
 *
 * Oscillators get their own pane. Plotting RSI on the price axis squashes
 * the candles into a band and makes both unreadable.
 */
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/services/api';
import { CandleChart } from '@/charts/CandleChart';
import {
  Card, CardHeader, CardTitle, CardContent, Skeleton, Alert, Tooltip,
} from '@/components/ui';
import { SourceLine } from '@/components/market/DataValue';
import { cn } from '@/lib/utils';
import type { ChartDto, IndicatorLineDto } from '@/types/api';

/**
 * A default set chosen for coverage, not count.
 *
 * One trend follower, one that combines trend with volatility, one momentum
 * oscillator and one that compares two trends. Five momentum indicators
 * reading the same closes will agree with each other, and that agreement
 * looks like confirmation without being any.
 */
const OVERLAY_CHOICES = [
  { id: 'ema20', label: 'EMA 20' },
  { id: 'ema50', label: 'EMA 50' },
  { id: 'ema200', label: 'EMA 200' },
  { id: 'supertrend', label: 'Supertrend' },
  { id: 'bb', label: 'Bollinger' },
  { id: 'vwap', label: 'VWAP' },
  { id: 'sma50', label: 'SMA 50' },
  { id: 'sma200', label: 'SMA 200' },
] as const;

const PANE_CHOICES = [
  { id: 'rsi', label: 'RSI' },
  { id: 'macd', label: 'MACD' },
  { id: 'adx', label: 'ADX' },
  { id: 'atr', label: 'ATR' },
] as const;

const TIMEFRAMES = ['15m', '1h', '1d'] as const;

/** Distinct hues, assigned in fixed order so a line keeps its colour. */
const LINE_COLORS = [
  'hsl(217 91% 60%)', 'hsl(271 81% 66%)', 'hsl(24 95% 53%)',
  'hsl(160 84% 39%)', 'hsl(340 82% 62%)', 'hsl(199 89% 48%)',
];

export function TradingChart({
  symbol,
  title,
  priceLines = [],
}: {
  symbol: string;
  title?: string;
  priceLines?: Array<{ price: number; label: string; color: string; dashed?: boolean }>;
}) {
  const [timeframe, setTimeframe] = useState<string>('1d');
  const [overlays, setOverlays] = useState<string[]>(['ema20', 'ema50', 'supertrend']);
  const [panes, setPanes] = useState<string[]>(['rsi']);

  const chart = useQuery({
    queryKey: ['chart', symbol, timeframe, overlays.join(','), panes.join(',')],
    queryFn: () => api.marketChart.get(symbol, { tf: timeframe, overlays, panes }),
  });

  const toggle = (list: string[], set: (v: string[]) => void, id: string) =>
    set(list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);

  const data = chart.data?.data as ChartDto | undefined;
  const allLines = data?.indicators ?? [];

  // A series can come back entirely null and still be legitimate: VWAP needs
  // volume, and an index has none, so on NIFTY it is undefined at every bar.
  // Drawing nothing and saying nothing would read as a broken chart, so
  // empty series are separated out and named.
  const hasValues = (l: IndicatorLineDto) => l.values.some((v) => v !== null);
  const lines = allLines.filter(hasValues);
  const empty = allLines.filter((l) => !hasValues(l));

  const priceLinesFromIndicators = lines.filter((l) => l.pane === 'price');
  const panesPresent = [...new Set(lines.filter((l) => l.pane !== 'price').map((l) => l.pane))];

  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-3 space-y-0">
        <div>
          <CardTitle>{title ?? symbol}</CardTitle>
          {chart.data && (
            <SourceLine
              source={String(chart.data.meta['source'] ?? '')}
              asOf={chart.data.meta['asOf'] as string | null}
            />
          )}
        </div>
        <div className="flex gap-1">
          {TIMEFRAMES.map((t) => (
            <button
              key={t}
              onClick={() => setTimeframe(t)}
              className={cn(
                'rounded px-2 py-1 text-xs font-medium transition-colors',
                timeframe === t
                  ? 'bg-primary text-primary-foreground'
                  : 'bg-muted text-muted-foreground hover:text-foreground',
              )}
            >
              {t}
            </button>
          ))}
        </div>
      </CardHeader>

      <CardContent className="space-y-3">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <IndicatorGroup
            label="On price"
            choices={OVERLAY_CHOICES}
            active={overlays}
            onToggle={(id) => toggle(overlays, setOverlays, id)}
          />
          <IndicatorGroup
            label="Panes"
            choices={PANE_CHOICES}
            active={panes}
            onToggle={(id) => toggle(panes, setPanes, id)}
          />
        </div>

        {chart.isLoading ? (
          <Skeleton className="h-[420px]" />
        ) : chart.isError ? (
          <Alert variant="warning" title="Chart unavailable">
            {chart.error instanceof Error ? chart.error.message : 'Could not load price history.'}
          </Alert>
        ) : !data || data.candles.length === 0 ? (
          <Alert variant="default" title="No price history">
            Nothing to plot for {symbol} on {timeframe}.
          </Alert>
        ) : (
          <>
            <CandleChart
              candles={data.candles}
              overlays={priceLinesFromIndicators.map((l, i) => ({
                label: l.label,
                values: l.values,
                color: LINE_COLORS[i % LINE_COLORS.length]!,
              }))}
              priceLines={priceLines}
              height={420}
            />

            <Legend lines={priceLinesFromIndicators} priceLines={priceLines} />

            {empty.length > 0 && (
              <p className="text-2xs leading-relaxed text-muted-foreground">
                No values on this instrument or timeframe:{' '}
                {empty.map((l) => l.label).join(', ')}. VWAP needs traded volume, which an index
                does not have, and most indicators need more bars than are loaded before they
                produce a first value.
              </p>
            )}

            {panesPresent.map((pane) => (
              <OscillatorPane
                key={pane}
                candles={data.candles}
                lines={lines.filter((l) => l.pane === pane)}
              />
            ))}
          </>
        )}
      </CardContent>
    </Card>
  );
}

function IndicatorGroup({
  label, choices, active, onToggle,
}: {
  label: string;
  choices: readonly { id: string; label: string }[];
  active: string[];
  onToggle: (id: string) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="text-2xs uppercase tracking-wide text-muted-foreground">{label}</span>
      {choices.map((c) => (
        <button
          key={c.id}
          onClick={() => onToggle(c.id)}
          aria-pressed={active.includes(c.id)}
          className={cn(
            'rounded border px-2 py-0.5 text-2xs font-medium transition-colors',
            active.includes(c.id)
              ? 'border-primary bg-primary/10 text-primary'
              : 'border-border text-muted-foreground hover:text-foreground',
          )}
        >
          {c.label}
        </button>
      ))}
    </div>
  );
}

function Legend({
  lines, priceLines,
}: {
  lines: IndicatorLineDto[];
  priceLines: Array<{ price: number; label: string; color: string }>;
}) {
  if (lines.length === 0 && priceLines.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-3">
      {lines.map((l, i) => (
        <Tooltip key={l.id} content={l.note}>
          <span className="flex cursor-help items-center gap-1.5 text-2xs">
            <span
              aria-hidden
              className="h-0.5 w-4 rounded-full"
              style={{ background: LINE_COLORS[i % LINE_COLORS.length] }}
            />
            {l.label}
          </span>
        </Tooltip>
      ))}
      {priceLines.map((l) => (
        <span key={l.label} className="flex items-center gap-1.5 text-2xs">
          <span aria-hidden className="h-0.5 w-4 rounded-full" style={{ background: l.color }} />
          {l.label}
        </span>
      ))}
    </div>
  );
}

/**
 * A separate chart for oscillators, sharing the x-axis by construction —
 * same candle array, same order, so bars line up with the price chart above.
 */
function OscillatorPane({
  candles, lines,
}: {
  candles: ChartDto['candles'];
  lines: IndicatorLineDto[];
}) {
  const latest = lines
    .map((l) => {
      for (let i = l.values.length - 1; i >= 0; i -= 1) {
        const v = l.values[i];
        if (v !== null && v !== undefined) return `${l.label} ${v.toFixed(2)}`;
      }
      return null;
    })
    .filter(Boolean);

  return (
    <div className="rounded border border-border/60 p-2">
      <div className="mb-1 flex flex-wrap gap-3">
        {lines.map((l, i) => (
          <Tooltip key={l.id} content={l.note}>
            <span className="flex cursor-help items-center gap-1.5 text-2xs">
              <span
                aria-hidden
                className="h-0.5 w-4 rounded-full"
                style={{ background: LINE_COLORS[i % LINE_COLORS.length] }}
              />
              {l.label}
            </span>
          </Tooltip>
        ))}
        {latest.length > 0 && (
          <span className="ml-auto font-mono text-2xs text-muted-foreground">
            {latest.join(' · ')}
          </span>
        )}
      </div>
      <CandleChart
        candles={candles}
        showCandles={false}
        showVolume={false}
        height={140}
        overlays={lines.map((l, i) => ({
          label: l.label,
          values: l.values,
          color: LINE_COLORS[i % LINE_COLORS.length]!,
        }))}
      />
    </div>
  );
}
