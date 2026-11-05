import { isNum } from "../core/indicators.js";

export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

export function fmtPrice(x, inst) {
  if (!isNum(x)) return "—";
  const tick = inst?.tick ?? 0.01;
  let dp = tick >= 1 ? 0 : tick >= 0.5 ? 1 : 2;
  if (inst?.group === "crypto") dp = x >= 1000 ? 2 : x >= 1 ? 3 : 5;
  return x.toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp });
}

export function fmtPct(x, dp = 2, sign = true) {
  if (!isNum(x)) return "—";
  const s = (x * 100).toFixed(dp);
  return (sign && x > 0 ? "+" : "") + s + "%";
}

export function fmtNum(x, dp = 2) {
  if (!isNum(x)) return "—";
  return x.toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp });
}

export function fmtBig(x, cur = "") {
  if (!isNum(x)) return "—";
  const a = Math.abs(x), s = x < 0 ? "−" : "";
  const u = a >= 1e12 ? [1e12, "T"] : a >= 1e9 ? [1e9, "bn"] : a >= 1e6 ? [1e6, "m"] : a >= 1e3 ? [1e3, "k"] : [1, ""];
  return `${s}${cur}${(a / u[0]).toFixed(a / u[0] >= 100 ? 0 : 1)}${u[1]}`;
}

export function signed(x, text) {
  if (!isNum(x)) return `<span class="muted">${text ?? "—"}</span>`;
  return `<span class="${x > 0 ? "up" : x < 0 ? "down" : ""}">${text ?? fmtPct(x)}</span>`;
}

export const ccy = (inst) => (inst.group === "futures" ? "¥" : "$");

export function fmtTime(t, freq) {
  if (typeof t === "string") return t;
  const d = new Date(t * 1000);
  return d.toISOString().slice(0, 16).replace("T", " ");
}

export function sparkline(values, { w = 120, h = 30, cls = "" } = {}) {
  const v = values.filter(isNum);
  if (v.length < 2) return "";
  const lo = Math.min(...v), hi = Math.max(...v), rng = hi - lo || 1;
  const pts = v.map((x, i) => `${((i / (v.length - 1)) * (w - 2) + 1).toFixed(1)},${(h - 2 - ((x - lo) / rng) * (h - 4)).toFixed(1)}`);
  const up = v[v.length - 1] >= v[0];
  return `<svg class="spark ${cls}" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" aria-hidden="true">`
    + `<polyline fill="none" stroke="var(${up ? "--up" : "--down"})" stroke-width="1.5" stroke-linejoin="round" points="${pts.join(" ")}"/></svg>`;
}

export function meter(pct, kind) {
  const w = isNum(pct) ? Math.max(2, Math.min(100, pct)) : 0;
  return `<div class="meter ${kind}"><i style="width:${w}%"></i></div>`;
}

export function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}
