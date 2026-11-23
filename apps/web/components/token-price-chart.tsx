import { useEffect, useMemo, useRef, useState } from 'react';
import { ChartNoAxesCombined } from 'lucide-react';
import {
  CandlestickSeries,
  ColorType,
  LineSeries,
  LineType,
  createChart,
  type UTCTimestamp,
} from 'lightweight-charts';
import { formatIndexedAmount, type TokenPoolSwap } from '@oneshot/evm';
import {
  tokenPoolChartPoints,
  tokenPoolOhlcCandles,
  type TokenCandleInterval,
  type TokenOhlcCandle,
  type TokenPricePoint,
} from '../lib/token-price-chart';
import { tokenPriceDisplay } from '../lib/token-price';
import { Button, EmptyState } from './ui';

type ChartMode = 'swaps' | TokenCandleInterval;

const CHART_MODES: { value: ChartMode; label: string }[] = [
  { value: 'swaps', label: 'Swaps' },
  { value: '5m', label: '5m' },
  { value: '15m', label: '15m' },
  { value: '1h', label: '1h' },
  { value: '1d', label: '1d' },
];

function PointPrice({ point, nativeLabel }: { point: TokenPricePoint; nativeLabel: string }) {
  const price = tokenPriceDisplay(point.price);
  return (
    <span>
      {price.approximate && !price.belowPrecision ? '≈ ' : ''}
      {price.text} {nativeLabel} per token
    </span>
  );
}

function CandleReadout({ candle, nativeLabel }: { candle: TokenOhlcCandle; nativeLabel: string }) {
  const format = (value: number) => `≈ ${value.toPrecision(6)}`;
  return (
    <>
      <span>
        O {format(candle.open)} · H {format(candle.high)} · L {format(candle.low)} · C {format(candle.close)} {nativeLabel}
      </span>
      <span>
        {new Date(candle.time * 1000).toLocaleString(undefined, { timeZone: 'UTC', timeZoneName: 'short' })} · Vol{' '}
        {formatIndexedAmount(candle.nativeVolumeRaw, 18)} {nativeLabel} · {candle.swapCount}{' '}
        {candle.swapCount === 1 ? 'swap' : 'swaps'}
      </span>
    </>
  );
}

/** This chart samples verified pool swaps; exact ratio amounts remain separate from chart coordinates. */
export function TokenPriceChart({
  swaps,
  nativeLabel = 'test ETH',
}: {
  swaps: readonly TokenPoolSwap[];
  nativeLabel?: string;
}) {
  const host = useRef<HTMLDivElement>(null);
  const [mode, setMode] = useState<ChartMode>('15m');
  const points = useMemo(() => tokenPoolChartPoints(swaps), [swaps]);
  const candles = useMemo(
    () => (mode === 'swaps' ? [] : tokenPoolOhlcCandles(swaps, mode)),
    [swaps, mode],
  );
  const [selectedPoint, setSelectedPoint] = useState<TokenPricePoint | null>(points.at(-1) || null);
  const [selectedCandle, setSelectedCandle] = useState<TokenOhlcCandle | null>(candles.at(-1) || null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setSelectedPoint(points.at(-1) || null);
    setSelectedCandle(candles.at(-1) || null);
    setFailed(false);
    const hasData = mode === 'swaps' ? points.length > 0 : candles.length > 0;
    if (!host.current || !hasData) return;

    let chart: ReturnType<typeof createChart> | null = null;
    let colors: MutationObserver | null = null;
    try {
      const formatPrice = (value: number) => `≈ ${value.toPrecision(6)}`;
      const minimumPrice =
        mode === 'swaps'
          ? points.reduce((minimum, point) => Math.min(minimum, point.value), Infinity)
          : candles.reduce((minimum, candle) => Math.min(minimum, candle.low), Infinity);
      const minMove = 10 ** (Math.floor(Math.log10(Math.max(minimumPrice, 1e-18))) - 6);
      chart = createChart(host.current, {
        autoSize: true,
        height: 300,
        layout: { fontFamily: 'Arial', fontSize: 11 },
        timeScale: { timeVisible: true, secondsVisible: mode === 'swaps' || mode === '5m' },
        localization: { priceFormatter: formatPrice },
      });

      const style = () => getComputedStyle(document.documentElement);
      const cssColor = (key: string, fallback: string) => style().getPropertyValue(key).trim() || fallback;

      if (mode === 'swaps') {
        const series = chart.addSeries(LineSeries, {
          lineWidth: 2,
          lineType: LineType.WithSteps,
          pointMarkersVisible: true,
          priceLineVisible: false,
          lastValueVisible: true,
          priceFormat: { type: 'custom', formatter: formatPrice, minMove },
        });
        const applyTheme = () => {
          chart?.applyOptions({
            layout: {
              background: { type: ColorType.Solid, color: cssColor('--chart-surface', '#11151A') },
              textColor: cssColor('--chart-text', '#A6ADB7'),
            },
            grid: {
              vertLines: { color: cssColor('--chart-grid', '#252D36') },
              horzLines: { color: cssColor('--chart-grid', '#252D36') },
            },
            rightPriceScale: { borderColor: cssColor('--chart-border', '#2A313A') },
            timeScale: { borderColor: cssColor('--chart-border', '#2A313A') },
          });
          series.applyOptions({ color: cssColor('--chart-up', '#96bd88') });
        };
        applyTheme();
        colors = new MutationObserver(applyTheme);
        colors.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
        series.setData(points.map(point => ({ time: point.time as UTCTimestamp, value: point.value })));
        chart.timeScale().fitContent();
        const byTime = new Map(points.map(point => [point.time, point]));
        chart.subscribeCrosshairMove(event =>
          setSelectedPoint(typeof event.time === 'number' ? byTime.get(event.time) || points.at(-1)! : points.at(-1)!),
        );
      } else {
        const series = chart.addSeries(CandlestickSeries, {
          upColor: cssColor('--chart-up', '#96bd88'),
          downColor: cssColor('--chart-down', '#d97777'),
          borderVisible: false,
          wickUpColor: cssColor('--chart-up', '#96bd88'),
          wickDownColor: cssColor('--chart-down', '#d97777'),
          priceFormat: { type: 'custom', formatter: formatPrice, minMove },
        });
        const applyTheme = () => {
          const up = cssColor('--chart-up', '#96bd88');
          const down = cssColor('--chart-down', '#d97777');
          chart?.applyOptions({
            layout: {
              background: { type: ColorType.Solid, color: cssColor('--chart-surface', '#11151A') },
              textColor: cssColor('--chart-text', '#A6ADB7'),
            },
            grid: {
              vertLines: { color: cssColor('--chart-grid', '#252D36') },
              horzLines: { color: cssColor('--chart-grid', '#252D36') },
            },
            rightPriceScale: { borderColor: cssColor('--chart-border', '#2A313A') },
            timeScale: { borderColor: cssColor('--chart-border', '#2A313A') },
          });
          series.applyOptions({ upColor: up, downColor: down, wickUpColor: up, wickDownColor: down });
        };
        applyTheme();
        colors = new MutationObserver(applyTheme);
        colors.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
        series.setData(
          candles.map(candle => ({
            time: candle.time as UTCTimestamp,
            open: candle.open,
            high: candle.high,
            low: candle.low,
            close: candle.close,
          })),
        );
        chart.timeScale().fitContent();
        const byTime = new Map(candles.map(candle => [candle.time, candle]));
        chart.subscribeCrosshairMove(event =>
          setSelectedCandle(typeof event.time === 'number' ? byTime.get(event.time) || candles.at(-1)! : candles.at(-1)!),
        );
      }
    } catch {
      setFailed(true);
      colors?.disconnect();
      chart?.remove();
      chart = null;
    }
    return () => {
      colors?.disconnect();
      chart?.remove();
    };
  }, [mode, points, candles]);

  const hasData = mode === 'swaps' ? points.length > 0 : candles.length > 0;
  return (
    <div className="token-price-chart">
      <div className="token-chart-controls" role="group" aria-label="Chart timeframe">
        {CHART_MODES.map(item => (
          <Button
            key={item.value}
            type="button"
            variant={mode === item.value ? 'secondary' : 'ghost'}
            aria-pressed={mode === item.value}
            onClick={() => setMode(item.value)}
          >
            {item.label}
          </Button>
        ))}
      </div>
      {!hasData ? (
        <EmptyState
          compact
          icon={ChartNoAxesCombined}
          title="No pool price history in this page"
          description="Pool swaps at this checkpoint will appear here when available. No price history is inferred from launch terms."
        />
      ) : (
        <>
          <p className="token-chart-selected">
            {mode === 'swaps'
              ? selectedPoint && (
                  <>
                    <PointPrice point={selectedPoint} nativeLabel={nativeLabel} />
                    <span>
                      {new Date(selectedPoint.time * 1000).toLocaleString(undefined, {
                        timeZone: 'UTC',
                        timeZoneName: 'short',
                      })}{' '}
                      · block {selectedPoint.blockNumber}
                    </span>
                  </>
                )
              : selectedCandle && <CandleReadout candle={selectedCandle} nativeLabel={nativeLabel} />}
          </p>
          {failed && (
            <p className="data-notice">
              The chart could not be drawn. Exact indexed prices remain available above and in the swap records.
            </p>
          )}
          <div
            ref={host}
            hidden={failed}
            className="token-chart-canvas"
            role="img"
            aria-label={
              mode === 'swaps'
                ? 'Approximate price line from loaded pool swaps'
                : `Approximate ${mode} candlestick chart from loaded pool swaps`
            }
          />
        </>
      )}
      <p className="field-hint">
        Chart coordinates are approximate and times use UTC. Covers {swaps.length} loaded pool swaps without synthesizing
        empty candles. Load earlier swaps to extend the history.
      </p>
    </div>
  );
}
