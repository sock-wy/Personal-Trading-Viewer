// Loads the static JSON produced by the pipeline and normalizes it into a bar set.

const cache = new Map();
let metaPromise = null;

export function dataUrl(path) {
  return new URL(`../../../data/${path}`, import.meta.url).href;
}

async function getJSON(path) {
  const res = await fetch(dataUrl(path), { cache: "no-cache" });
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return res.json();
}

export function loadMeta() {
  if (!metaPromise) metaPromise = getJSON("meta.json");
  return metaPromise;
}

export async function loadBars(symbol, freq = "1d") {
  const key = `${symbol}:${freq}`;
  if (!cache.has(key)) {
    cache.set(key, (async () => {
      const meta = await loadMeta();
      const inst = meta.instruments.find((x) => x.symbol === symbol);
      if (!inst) throw new Error(`unknown symbol ${symbol}`);
      const raw = await getJSON(`${freq === "1d" ? "daily" : "hourly"}/${symbol}.json`);
      return normalize(raw, inst, meta);
    })());
  }
  try {
    return await cache.get(key);
  } catch (e) {
    cache.delete(key);
    throw e;
  }
}

const DAY = 86400;

export function normalize(raw, inst, meta) {
  const isFutures = inst.group === "futures";
  const freq = raw.freq;
  const n = raw.c.length;
  // Time axis for charts: daily -> 'YYYY-MM-DD' business-day strings; hourly -> epoch seconds.
  const t = raw.t;
  const time = freq === "1d" ? t.slice() : t.map(Number);
  const dates = freq === "1d" ? t.slice() : t.map((s) => new Date(s * 1000).toISOString().slice(0, 10));

  let barsPerYear;
  if (freq === "1d") {
    barsPerYear = meta?.groups?.[inst.group]?.annualization ?? (isFutures ? 244 : 365);
  } else {
    const spanYears = (time[n - 1] - time[0]) / (365.25 * DAY);
    // trading days per year x bars per trading day
    const days = new Set(dates).size;
    const perDay = n / Math.max(1, days);
    barsPerYear = isFutures ? 244 * perDay : (n - 1) / Math.max(spanYears, 1e-9);
  }

  const bars = {
    symbol: inst.symbol, inst, freq, isFutures, n, time, dates, barsPerYear,
    o: raw.o, h: raw.h, l: raw.l, c: raw.c,
    v: raw.v,
    rc: raw.rc || raw.c,
    ctr: raw.ctr || null, contracts: raw.contracts || null,
    oi: raw.oi || null, OI: raw.OI || null, V: raw.V || null,
    fund: raw.fund || null, wiki: raw.wiki || null,
  };
  return bars;
}

// Slice a bar set to [i0, i1] inclusive (used by the backtester's date range and by tests).
export function sliceBars(bars, i0, i1) {
  const s = (a) => (Array.isArray(a) ? a.slice(i0, i1 + 1) : a);
  return {
    ...bars,
    n: i1 - i0 + 1,
    time: s(bars.time), dates: s(bars.dates), o: s(bars.o), h: s(bars.h), l: s(bars.l), c: s(bars.c),
    v: s(bars.v), rc: s(bars.rc), ctr: s(bars.ctr), oi: s(bars.oi), OI: s(bars.OI), V: s(bars.V),
    fund: s(bars.fund), wiki: s(bars.wiki),
  };
}
