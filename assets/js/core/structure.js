// Market-profile style analytics: volume / time-at-price profiles, positioning cost line, OI scanner.
import { isNum } from "./indicators.js";

// Volume profile (weight = volume) or TPO-style time profile (weight = 1 per bar) over bars [i0, i1].
// Each bar's weight is spread uniformly across its high-low range.
export function priceProfile(bars, i0, i1, { bins = 48, mode = "volume" } = {}) {
  let lo = Infinity, hi = -Infinity;
  for (let i = i0; i <= i1; i++) { lo = Math.min(lo, bars.l[i]); hi = Math.max(hi, bars.h[i]); }
  if (!(hi > lo)) return null;
  const step = (hi - lo) / bins;
  const w = new Float64Array(bins);
  for (let i = i0; i <= i1; i++) {
    const wt = mode === "volume" ? (bars.v[i] || 0) : 1;
    if (!(wt > 0)) continue;
    const a = Math.min(bins - 1, Math.floor((bars.l[i] - lo) / step));
    const b = Math.min(bins - 1, Math.floor((bars.h[i] - lo) / step));
    const share = wt / (b - a + 1);
    for (let k = a; k <= b; k++) w[k] += share;
  }
  const total = w.reduce((s, x) => s + x, 0);
  let poc = 0;
  for (let k = 1; k < bins; k++) if (w[k] > w[poc]) poc = k;
  // Value area: grow from the POC toward the heavier neighbour until 70% of the weight is covered.
  let a = poc, b = poc, acc = w[poc];
  while (acc < 0.7 * total && (a > 0 || b < bins - 1)) {
    const up = b < bins - 1 ? w[b + 1] : -1, dn = a > 0 ? w[a - 1] : -1;
    if (up >= dn) acc += w[++b]; else acc += w[--a];
  }
  const mid = (k) => lo + (k + 0.5) * step;
  return {
    lo, hi, step, bins: Array.from(w, (x, k) => ({ price: mid(k), w: x })),
    poc: mid(poc), vah: lo + (b + 1) * step, val: lo + a * step, total,
  };
}

// Positioning cost line (TDOI-WAP): an estimate of the average entry price of the open positions.
//   cost_t = (1 - a_t) * cost_{t-1} + a_t * typical_t,   a_t = 1 - lambda * (1 - n_t)
// lambda = 0.5^(1/halfLife) ages old positions; n_t is the share of today's positions that are new.
// Futures: n_t = max(dOI, 0) / OI. Crypto (no OI): n_t = volume_t / rolling 20-bar volume sum.
export function positioningCost(bars, halfLife = 25) {
  const n = bars.n;
  const out = new Array(n).fill(NaN);
  const lambda = Math.pow(0.5, 1 / halfLife);
  const oi = bars.isFutures ? (bars.freq === "1d" ? bars.OI : bars.oi) : null;
  const vol = bars.isFutures && bars.freq === "1d" ? bars.V : bars.v;
  let cost = NaN, vsum = 0;
  for (let i = 0; i < n; i++) {
    const tp = (bars.h[i] + bars.l[i] + bars.c[i]) / 3;
    vsum += vol[i] || 0;
    if (i >= 20) vsum -= vol[i - 20] || 0;
    let fresh;
    if (oi) {
      const sameCtr = !bars.ctr || bars.freq === "1d" || i === 0 || bars.ctr[i] === bars.ctr[i - 1];
      fresh = i > 0 && oi[i] > 0 && sameCtr ? Math.max(0, oi[i] - oi[i - 1]) / oi[i] : 0;
    } else {
      fresh = vsum > 0 ? (vol[i] || 0) / vsum : 0;
    }
    if (!isNum(cost)) cost = tp;
    else {
      const a = 1 - lambda * (1 - Math.min(1, fresh));
      cost = (1 - a) * cost + a * tp;
    }
    out[i] = i >= Math.min(n - 1, halfLife) ? cost : NaN;
  }
  return out;
}

// Open-interest scanner (inspired by "OI at multi-year high" screens).
// Uses all-contract OI on the daily continuous series.
export function oiScan(bars) {
  const oi = bars.OI;
  const n = oi.length;
  let peak = -Infinity, peakI = 0;
  for (let i = 0; i < n; i++) if (oi[i] > peak) { peak = oi[i]; peakI = i; }
  const cur = oi[n - 1];
  const ratio = cur / peak;
  const chg20 = n > 20 && oi[n - 21] > 0 ? cur / oi[n - 21] - 1 : NaN;
  const mult = bars.inst.multiplier;
  return {
    cur, peak, peakDate: bars.dates[peakI], ratio, chg20,
    notional: cur * bars.rc[n - 1] * mult,
    status: peakI === n - 1 ? "new_high" : ratio >= 0.9 ? "near_high" : "normal",
    historyYears: (n - 1) / bars.barsPerYear,
  };
}
