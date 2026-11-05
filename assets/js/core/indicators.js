// Rolling indicators. Every function is causal: output[i] depends only on input[0..i].
// Missing values are represented as NaN.

export const isNum = (x) => typeof x === "number" && Number.isFinite(x);

export function sma(x, n) {
  const out = new Array(x.length).fill(NaN);
  let s = 0, cnt = 0;
  for (let i = 0; i < x.length; i++) {
    const v = x[i];
    if (isNum(v)) { s += v; cnt++; }
    if (i >= n) { const u = x[i - n]; if (isNum(u)) { s -= u; cnt--; } }
    if (i >= n - 1 && cnt === n) out[i] = s / n;
  }
  return out;
}

export function ema(x, n) {
  const out = new Array(x.length).fill(NaN);
  const a = 2 / (n + 1);
  let prev = NaN, seen = 0, seed = 0;
  for (let i = 0; i < x.length; i++) {
    const v = x[i];
    if (!isNum(v)) { out[i] = prev; continue; }
    if (seen < n) { seed += v; seen++; if (seen === n) prev = seed / n; out[i] = seen === n ? prev : NaN; continue; }
    prev = a * v + (1 - a) * prev;
    out[i] = prev;
  }
  return out;
}

export function rollingStd(x, n) {
  const out = new Array(x.length).fill(NaN);
  let s = 0, s2 = 0, cnt = 0;
  for (let i = 0; i < x.length; i++) {
    const v = x[i];
    if (isNum(v)) { s += v; s2 += v * v; cnt++; }
    if (i >= n) { const u = x[i - n]; if (isNum(u)) { s -= u; s2 -= u * u; cnt--; } }
    if (i >= n - 1 && cnt === n) {
      const m = s / n;
      out[i] = Math.sqrt(Math.max(0, (s2 - n * m * m) / (n - 1)));
    }
  }
  return out;
}

export function rollingSum(x, n) {
  const out = new Array(x.length).fill(NaN);
  let s = 0, cnt = 0;
  for (let i = 0; i < x.length; i++) {
    if (isNum(x[i])) { s += x[i]; cnt++; }
    if (i >= n && isNum(x[i - n])) { s -= x[i - n]; cnt--; }
    if (i >= n - 1 && cnt === n) out[i] = s;
  }
  return out;
}

// Highest high / lowest low of the n bars BEFORE i (excludes bar i) — the classic breakout reference.
export function priorMax(x, n) {
  const out = new Array(x.length).fill(NaN);
  const dq = [];
  for (let i = 0; i < x.length; i++) {
    while (dq.length && dq[0] < i - n) dq.shift();
    if (i >= n) out[i] = x[dq[0]];
    while (dq.length && x[dq[dq.length - 1]] <= x[i]) dq.pop();
    dq.push(i);
  }
  return out;
}

export function priorMin(x, n) {
  const out = new Array(x.length).fill(NaN);
  const dq = [];
  for (let i = 0; i < x.length; i++) {
    while (dq.length && dq[0] < i - n) dq.shift();
    if (i >= n) out[i] = x[dq[0]];
    while (dq.length && x[dq[dq.length - 1]] >= x[i]) dq.pop();
    dq.push(i);
  }
  return out;
}

export function logReturns(c) {
  const out = new Array(c.length).fill(NaN);
  for (let i = 1; i < c.length; i++) if (c[i] > 0 && c[i - 1] > 0) out[i] = Math.log(c[i] / c[i - 1]);
  return out;
}

export function atr(h, l, c, n) {
  const tr = h.map((hi, i) => i === 0 ? hi - l[i]
    : Math.max(hi - l[i], Math.abs(hi - c[i - 1]), Math.abs(l[i] - c[i - 1])));
  return ema(tr, n);
}

// Annualized close-to-close realized volatility.
export function realizedVol(c, n, barsPerYear) {
  const sd = rollingStd(logReturns(c), n);
  const k = Math.sqrt(barsPerYear);
  return sd.map((v) => v * k);
}

// Parkinson (high-low) volatility estimator, annualized. ~5x more efficient than close-to-close.
export function parkinsonVol(h, l, n, barsPerYear) {
  const x = h.map((hi, i) => (hi > 0 && l[i] > 0) ? Math.log(hi / l[i]) ** 2 : NaN);
  const m = sma(x, n);
  const k = barsPerYear / (4 * Math.LN2);
  return m.map((v) => Math.sqrt(v * k));
}

// Chaikin money flow: volume-weighted close location within the bar's range.
export function cmf(h, l, c, vol, n) {
  const mfv = c.map((ci, i) => {
    const rng = h[i] - l[i];
    if (!(rng > 0) || !isNum(vol[i])) return isNum(vol[i]) ? 0 : NaN;
    return (((ci - l[i]) - (h[i] - ci)) / rng) * vol[i];
  });
  const a = rollingSum(mfv, n), b = rollingSum(vol, n);
  return a.map((v, i) => b[i] > 0 ? v / b[i] : NaN);
}

// Rolling percentile rank (0..100) of x[i] within the last `window` valid observations including x[i].
// O(n log n) via a Fenwick tree over value ranks, so it is fast enough for 30k+ hourly bars.
export function rollingPercentile(x, window, minObs = Math.min(60, window)) {
  const n = x.length;
  const out = new Array(n).fill(NaN);
  const vals = [];
  for (let i = 0; i < n; i++) if (isNum(x[i])) vals.push(x[i]);
  const sorted = Array.from(new Set(vals)).sort((a, b) => a - b);
  const rank = new Map(sorted.map((v, i) => [v, i + 1]));
  const m = sorted.length;
  const bit = new Float64Array(m + 1);
  const add = (i, d) => { for (; i <= m; i += i & -i) bit[i] += d; };
  const sum = (i) => { let s = 0; for (; i > 0; i -= i & -i) s += bit[i]; return s; };
  const q = [];
  for (let i = 0; i < n; i++) {
    const v = x[i];
    if (!isNum(v)) continue;
    add(rank.get(v), 1);
    q.push(v);
    if (q.length > window) add(rank.get(q.shift()), -1);
    if (q.length >= minObs) out[i] = (100 * sum(rank.get(v))) / q.length;
  }
  return out;
}

export function diff(x, n = 1) {
  return x.map((v, i) => (i >= n && isNum(v) && isNum(x[i - n])) ? v - x[i - n] : NaN);
}

export function pctChange(x, n = 1) {
  return x.map((v, i) => (i >= n && isNum(v) && x[i - n] > 0) ? v / x[i - n] - 1 : NaN);
}

export function last(x) {
  for (let i = x.length - 1; i >= 0; i--) if (isNum(x[i])) return x[i];
  return NaN;
}

export function meanDefined(arr) {
  const v = arr.filter(isNum);
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : NaN;
}
