"use client";

import Link from "./navigation";
import { ArrowLeft, ArrowRight, ChartNoAxesCombined, LockKeyhole, Star, Users } from "lucide-react";
import { CandlestickSeries, ColorType, createChart, type CandlestickData, type IChartApi, type ISeriesApi, type UTCTimestamp } from "lightweight-charts";
import { useEffect, useRef, useState } from "react";
import { useWallet } from "../lib/client-wallet";
import { Activity, apt, Token, useApi } from "../lib/client-api";
import { ActivityTable } from "./market-data";
import { Address, AssetIcon, Badge, Button, ButtonLink, EmptyState, InfoRow, Loading, PageHeading, SafetyNote, Stat, Tabs } from "./ui";
import { WalletButton } from "./wallet-button";
import { useTheme } from "./theme-provider";

type Candle = { time: number; open: number; high: number; low: number; close: number };
type Detail = Token & { activity?: Activity[]; holderList?: { address: string; balance: string; percentage: number }[]; balance?: string };

function applyChartTheme(chart: IChartApi, series: ISeriesApi<"Candlestick">) {
  // Canvas charts cannot inherit CSS. Read the same palette as the surrounding
  // workspace, then update the existing chart without resetting its viewport.
  const styles = getComputedStyle(document.documentElement);
  const color = (name: string, fallback: string) => styles.getPropertyValue(name).trim() || fallback;
  const crosshair = {
    color: color("--chart-crosshair", "#b4cba0"),
    labelBackgroundColor: color("--chart-label", "#7c9c64"),
  };
  chart.applyOptions({
    layout: { background: { type: ColorType.Solid, color: color("--chart-surface", "#11151A") }, textColor: color("--chart-text", "#A6ADB7") },
    grid: { vertLines: { color: color("--chart-grid", "#252D36") }, horzLines: { color: color("--chart-grid", "#252D36") } },
    rightPriceScale: { borderColor: color("--chart-border", "#2A313A") },
    timeScale: { borderColor: color("--chart-border", "#2A313A") },
    crosshair: { vertLine: crosshair, horzLine: crosshair },
  });
  const up = color("--chart-up", "#96bd88");
  const down = color("--chart-down", "#cfa98f");
  series.applyOptions({ upColor: up, downColor: down, wickUpColor: up, wickDownColor: down });
}

function PriceChart({ candles, interval }: { candles: Candle[]; interval: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const chartRef = useRef<{ chart: IChartApi; series: ISeriesApi<"Candlestick"> } | null>(null);
  const { theme } = useTheme();
  useEffect(() => {
    if (!ref.current || !candles.length) return;
    const chart = createChart(ref.current, { height: 310, layout: { fontSize: 9, fontFamily: "Arial" }, timeScale: { timeVisible: true, secondsVisible: false } });
    const series = chart.addSeries(CandlestickSeries, { borderVisible: false, priceFormat: { type: "price", precision: 8, minMove: 0.00000001 } });
    chartRef.current = { chart, series };
    applyChartTheme(chart, series);
    const groups = new Map<number, Candle>();
    for (const candle of [...candles].sort((a, b) => a.time - b.time)) { if (![candle.time, candle.open, candle.high, candle.low, candle.close].every(Number.isFinite)) continue; const time = Math.floor(candle.time / interval) * interval; const previous = groups.get(time); groups.set(time, previous ? { ...previous, high: Math.max(previous.high, candle.high), low: Math.min(previous.low, candle.low), close: candle.close } : { ...candle, time }); }
    series.setData([...groups.values()].map(candle => ({ ...candle, time: candle.time as UTCTimestamp })) as CandlestickData[]); chart.timeScale().fitContent();
    const observer = new ResizeObserver(entries => { const width = entries[0]?.contentRect.width; if (width) chart.applyOptions({ width }); }); observer.observe(ref.current);
    return () => { observer.disconnect(); chartRef.current = null; chart.remove(); };
  }, [candles, interval]);
  useEffect(() => { if (chartRef.current) applyChartTheme(chartRef.current.chart, chartRef.current.series); }, [theme]);
  return <div className="chart-canvas" ref={ref} />;
}
export function TokenTerminal({ id }: { id: string }) {
  const response = useApi<Detail>(`/api/tokens/${encodeURIComponent(id)}`); const { connected } = useWallet();
  const [tab, setTab] = useState("activity"); const [side, setSide] = useState("buy"); const [amount, setAmount] = useState(""); const [interval, setInterval] = useState(60); const [watched, setWatched] = useState(false);
  useEffect(() => { try { setWatched(JSON.parse(localStorage.getItem("oneshot:watchlist") || "[]").includes(id)); } catch {} }, [id]);
  function toggleWatch() { let list: string[] = []; try { list = JSON.parse(localStorage.getItem("oneshot:watchlist") || "[]"); } catch {} const next = watched ? list.filter(item => item !== id) : [...list, id]; localStorage.setItem("oneshot:watchlist", JSON.stringify(next)); setWatched(!watched); }
  if (response.loading) return <><PageHeading title="Loading market…" /><div className="panel"><Loading rows={5} /></div></>;
  if (response.error || !response.data) return <><Link className="back-link" href="/tokens"><ArrowLeft size={13} />Token markets</Link><div className="panel detail-error"><EmptyState icon={ChartNoAxesCombined} title="We couldn’t open this market" description="Return to token markets and try opening it again." action={<ButtonLink href="/tokens" variant="secondary">Back to markets <ArrowRight size={14} /></ButtonLink>} /></div><SafetyNote>Token trading is not available yet.</SafetyNote></>;
  const token = response.data;
  return <><Link className="back-link" href="/tokens"><ArrowLeft size={13} />All token markets</Link><div className="terminal-header"><AssetIcon name={token.symbol} imageUrl={token.imageUrl} large /><div className="terminal-title"><h1>{token.name}</h1><p><span>{token.symbol} / ZRO</span><Address value={token.address} /></p></div><Badge tone="mint">Locked liquidity</Badge><button className={`watch-button ${watched ? "watched" : ""}`} aria-label={watched ? "Remove from watchlist" : "Add to watchlist"} onClick={toggleWatch}><Star size={19} fill={watched ? "currentColor" : "none"} /></button></div><div className="metric-grid"><Stat label="Price" value={apt(token.priceApt, 8)} suffix="ZRO" /><Stat label="Market cap" value={apt(token.marketCapApt)} suffix="ZRO" /><Stat label="24h volume" value={apt(token.volume24hApt)} suffix="ZRO" /><Stat label="Holders" value={token.holders ?? "N/A"} /></div><div className="terminal-main"><section className="panel chart-panel"><div className="chart-toolbar"><span>{token.symbol} / ZRO </span><div className="chart-intervals">{[{ label: "1m", value: 60 }, { label: "5m", value: 300 }, { label: "15m", value: 900 }, { label: "1h", value: 3600 }].map(option => <button className={interval === option.value ? "active" : ""} key={option.value} onClick={() => setInterval(option.value)}>{option.label}</button>)}</div></div>{token.candles?.length ? <PriceChart candles={token.candles} interval={interval} /> : <div className="chart-empty"><ChartNoAxesCombined size={28} strokeWidth={1.2} /><span>No price history to show.</span></div>}<div className="data-notice">Only confirmed trades appear on this chart.</div></section><aside className="panel trade-panel"><h2>Trade {token.symbol}</h2><div className="segmented"><button className={side === "buy" ? "active" : ""} onClick={() => setSide("buy")}>Buy {token.symbol}</button><button className={side === "sell" ? "active" : ""} onClick={() => setSide("sell")}>Sell {token.symbol}</button></div><div className="trade-input"><div className="trade-input-top"><span>You {side === "buy" ? "pay" : "sell"}</span></div><div className="trade-input-bottom"><input aria-label={`${side} amount`} inputMode="decimal" placeholder="0.00" value={amount} onChange={event => setAmount(event.target.value)} /><span>{side === "buy" ? "ZRO" : token.symbol}</span></div></div><div className="amount-presets">{(side === "buy" ? ["0.1", "0.5", "1", "5"] : ["100", "1000", "10000", "100000"]).map(value => <button key={value} onClick={() => setAmount(value)}>{apt(value)}</button>)}</div><div className="trade-details"><InfoRow label="oneshot execution fee">{token.creatorFeeBps == null ? "N/A" : `${(token.creatorFeeBps / 100).toFixed(1)}%`}</InfoRow><InfoRow label="Pool fee">{token.dexFeeBps == null ? "N/A" : `${token.dexFeeBps / 100}%`}</InfoRow><InfoRow label="Minimum received">No quote yet</InfoRow><InfoRow label="Price impact">N/A</InfoRow><InfoRow label="Quote age">No quote yet</InfoRow></div><div className="gate-panel"><div className="gate-panel-title"><LockKeyhole size={13} />Trading is not open yet</div><p>Save this market to your watchlist to find it again.</p></div>{connected ? <Button disabled className="full-width">Trading unavailable</Button> : <WalletButton full />}<p className="form-help">The full quoted amount must be filled before the quote expires.</p></aside></div><section className="panel terminal-bottom"><div className="panel-toolbar"><Tabs tabs={[{ value: "activity", label: "Activity" }, { value: "holders", label: "Holders" }, { value: "balances", label: "Your balance" }, { value: "info", label: "Market details" }]} active={tab} onChange={setTab} /></div>{tab === "activity" ? <ActivityTable activities={token.activity || []} /> : tab === "holders" ? token.holderList?.length ? <div className="table-wrap"><table className="data-table"><thead><tr><th>Wallet</th><th>Balance</th><th>Supply share</th></tr></thead><tbody>{token.holderList.map(holder => <tr key={holder.address}><td><Address value={holder.address} /></td><td>{apt(holder.balance)}</td><td>{holder.percentage.toFixed(2)}%<div className="holder-bar"><span style={{ width: `${Math.min(holder.percentage, 100)}%` }} /></div></td></tr>)}</tbody></table></div> : <EmptyState compact icon={Users} title="No holders to display" description="Balances appear here after transfers are confirmed." /> : tab === "balances" ? <div style={{ padding: 22 }}><InfoRow label={`${token.symbol} balance`}>{connected ? apt(token.balance) : "Connect wallet"}</InfoRow></div> : <div style={{ padding: "10px 22px" }}><InfoRow label="Pool address"><Address value={token.poolAddress} /></InfoRow><InfoRow label="Supply">1,000,000,000 initial (8 decimals)</InfoRow><InfoRow label="oneshot execution fee">{token.creatorFeeBps == null ? "N/A" : `${token.creatorFeeBps / 100}% (fixed)`}</InfoRow><InfoRow label="Fee destination">{token.feeMode === "liquidity_burn" ? "Liquidity 75% / burn 25%" : "Creator earnings"}</InfoRow><InfoRow label="Launch liquidity">Locked</InfoRow></div>}</section></>;
}
