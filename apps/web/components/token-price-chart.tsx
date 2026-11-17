import { useEffect, useMemo, useRef, useState } from 'react';
import { ChartNoAxesCombined } from 'lucide-react';
import { ColorType, LineSeries, LineType, createChart, type UTCTimestamp } from 'lightweight-charts';
import type { TokenPoolSwap } from '@oneshot/evm';
import { tokenPoolChartPoints, type TokenPricePoint } from '../lib/token-price-chart';
import { tokenPriceDisplay } from '../lib/token-price';
import { EmptyState } from './ui';

function PointPrice({ point }: { point: TokenPricePoint }) {
  const price = tokenPriceDisplay(point.price);
  return <span>{price.approximate && !price.belowPrecision ? '≈ ' : ''}{price.text} test ETH per token</span>;
}

/** This line samples verified pool swaps; exact ratio amounts remain separate from chart coordinates. */
export function TokenPriceChart({ swaps }: { swaps: readonly TokenPoolSwap[] }) {
  const host = useRef<HTMLDivElement>(null), points = useMemo(() => tokenPoolChartPoints(swaps), [swaps]);
  const [selected, setSelected] = useState<TokenPricePoint | null>(points.at(-1) || null), [failed, setFailed] = useState(false);
  useEffect(() => {
    setSelected(points.at(-1) || null); setFailed(false); if (!host.current || !points.length) return;
    let chart: ReturnType<typeof createChart> | null = null, colors: MutationObserver | null = null;
    try {
      const formatPrice = (value: number) => `≈ ${value.toPrecision(6)}`;
      const minimumPrice = points.reduce((minimum, point) => Math.min(minimum, point.value), Infinity);
      const minMove = 10 ** (Math.floor(Math.log10(minimumPrice)) - 6);
      chart = createChart(host.current, { autoSize: true, height: 300, layout: { fontFamily: 'Arial', fontSize: 11 }, timeScale: { timeVisible: true, secondsVisible: true }, localization: { priceFormatter: formatPrice } });
      const series = chart.addSeries(LineSeries, { lineWidth: 2, lineType: LineType.WithSteps, pointMarkersVisible: true, priceLineVisible: false, lastValueVisible: true, priceFormat: { type: 'custom', formatter: formatPrice, minMove } });
      const theme = () => {
        const style = getComputedStyle(document.documentElement), color = (key: string, fallback: string) => style.getPropertyValue(key).trim() || fallback;
        chart?.applyOptions({ layout: { background: { type: ColorType.Solid, color: color('--chart-surface', '#11151A') }, textColor: color('--chart-text', '#A6ADB7') }, grid: { vertLines: { color: color('--chart-grid', '#252D36') }, horzLines: { color: color('--chart-grid', '#252D36') } }, rightPriceScale: { borderColor: color('--chart-border', '#2A313A') }, timeScale: { borderColor: color('--chart-border', '#2A313A') } });
        series.applyOptions({ color: color('--chart-up', '#96bd88') });
      };
      theme(); colors = new MutationObserver(theme); colors.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
      series.setData(points.map(point => ({ time: point.time as UTCTimestamp, value: point.value }))); chart.timeScale().fitContent();
      const byTime = new Map(points.map(point => [point.time, point]));
      chart.subscribeCrosshairMove(event => setSelected(typeof event.time === 'number' ? byTime.get(event.time) || points.at(-1)! : points.at(-1)!));
    } catch { setFailed(true); colors?.disconnect(); chart?.remove(); chart = null; }
    return () => { colors?.disconnect(); chart?.remove(); };
  }, [points]);
  return <div className="token-price-chart">
    {!points.length ? <EmptyState compact icon={ChartNoAxesCombined} title="No pool price history in this page" description="Pool swaps at this checkpoint will appear here when available. No price history is inferred from launch terms." /> : <>
      <p className="token-chart-selected">{selected && <><PointPrice point={selected} /><span>{new Date(selected.time * 1000).toLocaleString(undefined, { timeZone: 'UTC', timeZoneName: 'short' })} · block {selected.blockNumber}</span></>}</p>
      {failed && <p className="data-notice">The chart could not be drawn. Exact indexed prices remain available above and in the swap records.</p>}<div ref={host} hidden={failed} className="token-chart-canvas" role="img" aria-label="Approximate price line from loaded pool swaps" />
    </>}
    <p className="field-hint">Chart coordinates are approximate and times use UTC. The line covers {swaps.length} loaded pool swaps, with the last swap in each second shown. Load earlier swaps to extend the history.</p>
  </div>;
}
