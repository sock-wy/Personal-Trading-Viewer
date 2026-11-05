// Thin wrapper around TradingView Lightweight Charts (vendored, v4.2) with theme-aware defaults.
import { cssVar } from "./format.js";
import { isNum } from "../core/indicators.js";

const LWC = () => window.LightweightCharts;

export function theme() {
  return {
    bg: cssVar("--surface"), ink: cssVar("--ink-2"), ink3: cssVar("--ink-3"), grid: cssVar("--grid"),
    line: cssVar("--line"), up: cssVar("--up"), down: cssVar("--down"), accent: cssVar("--accent"),
    cool: cssVar("--cool"), warm: cssVar("--warm"), hot: cssVar("--hot"), mono: cssVar("--mono"),
  };
}

export function makeChart(el, { height = 300, timeVisible = false, showTime = true } = {}) {
  const th = theme();
  const chart = LWC().createChart(el, {
    height,
    autoSize: true,
    layout: { background: { type: "solid", color: "transparent" }, textColor: th.ink3, fontFamily: th.mono, fontSize: 11, attributionLogo: false },
    grid: { vertLines: { color: th.grid }, horzLines: { color: th.grid } },
    rightPriceScale: { borderColor: th.line, minimumWidth: 72 },
    timeScale: { borderColor: th.line, timeVisible, secondsVisible: false, visible: showTime, rightOffset: 4 },
    crosshair: { mode: LWC().CrosshairMode.Normal },
    handleScroll: { vertTouchDrag: false },
  });
  el.style.height = `${height}px`;
  return chart;
}

// Keep several stacked charts on the same visible range.
export function syncCharts(charts) {
  let busy = false;
  charts.forEach((c) => {
    c.timeScale().subscribeVisibleLogicalRangeChange((r) => {
      if (busy || !r) return;
      busy = true;
      charts.forEach((o) => { if (o !== c) o.timeScale().setVisibleLogicalRange(r); });
      busy = false;
    });
  });
}

// Crosshair sync: each entry {chart, series, data: Map(time -> value)}
export function syncCrosshair(entries) {
  entries.forEach((src) => {
    src.chart.subscribeCrosshairMove((p) => {
      entries.forEach((dst) => {
        if (dst === src) return;
        if (!p || p.time === undefined) { dst.chart.clearCrosshairPosition(); return; }
        const v = dst.data.get(p.time);
        if (isNum(v)) dst.chart.setCrosshairPosition(v, p.time, dst.series);
        else dst.chart.clearCrosshairPosition();
      });
    });
  });
}

export function lineData(time, values) {
  const out = [];
  for (let i = 0; i < time.length; i++) if (isNum(values[i])) out.push({ time: time[i], value: values[i] });
  return out;
}

export function candleData(b) {
  const out = new Array(b.n);
  for (let i = 0; i < b.n; i++) out[i] = { time: b.time[i], open: b.o[i], high: b.h[i], low: b.l[i], close: b.c[i] };
  return out;
}

export function rgba(hex, a) {
  const h = hex.replace("#", "");
  if (h.length !== 6) return hex;
  const n = parseInt(h, 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

export function setRange(chart, n, bars) {
  if (!bars || bars >= n) { chart.timeScale().fitContent(); return; }
  chart.timeScale().setVisibleLogicalRange({ from: n - bars, to: n + 3 });
}
