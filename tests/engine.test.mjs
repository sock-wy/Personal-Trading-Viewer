import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { normalize, sliceBars } from "../assets/js/core/data.js";
import { computeFeatures } from "../assets/js/core/analytics.js";
import { STRATEGIES, defaultParams } from "../assets/js/core/strategies.js";
import { runBacktest, DEFAULTS } from "../assets/js/core/engine.js";
import { sma, priorMax, priorMin, rollingPercentile, isNum } from "../assets/js/core/indicators.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const meta = JSON.parse(readFileSync(join(ROOT, "data/meta.json"), "utf8"));
const load = (sym, freq = "1d") => {
  const inst = meta.instruments.find((x) => x.symbol === sym);
  const raw = JSON.parse(readFileSync(join(ROOT, `data/${freq === "1d" ? "daily" : "hourly"}/${sym}.json`), "utf8"));
  return normalize(raw, inst, meta);
};
const same = (a, b) => (Number.isNaN(a) && Number.isNaN(b)) || Math.abs(a - b) < 1e-9 || a === b;

test("indicators match naive implementations", () => {
  const x = Array.from({ length: 300 }, (_, i) => Math.sin(i / 7) * 10 + i * 0.1 + ((i * 37) % 11));
  const s = sma(x, 10);
  for (let i = 9; i < x.length; i++) {
    const naive = x.slice(i - 9, i + 1).reduce((a, b) => a + b, 0) / 10;
    assert.ok(Math.abs(s[i] - naive) < 1e-9);
  }
  const hi = priorMax(x, 20), lo = priorMin(x, 20);
  for (let i = 20; i < x.length; i++) {
    assert.equal(hi[i], Math.max(...x.slice(i - 20, i)));
    assert.equal(lo[i], Math.min(...x.slice(i - 20, i)));
  }
  const p = rollingPercentile(x, 50, 50);
  for (let i = 49; i < x.length; i++) {
    const w = x.slice(i - 49, i + 1);
    assert.ok(Math.abs(p[i] - (100 * w.filter((v) => v <= x[i]).length) / 50) < 1e-9);
  }
});

for (const sym of ["RB", "JM", "BTC"]) {
  test(`no look-ahead: features and signals on ${sym} are invariant to future data`, () => {
    const full = load(sym);
    const fFull = computeFeatures(full);
    for (const k of [400, 900, full.n - 37]) {
      const cut = sliceBars(full, 0, k - 1);
      const fCut = computeFeatures(cut);
      for (const key of ["rv", "attention", "flowScore", "rvPct"]) {
        for (let i = 0; i < k; i++) assert.ok(same(fFull[key][i], fCut[key][i]), `${key}[${i}] changed at k=${k}`);
      }
      for (const st of STRATEGIES) {
        const p = defaultParams(st);
        const a = st.signal(full, fFull, p), b = st.signal(cut, fCut, p);
        for (let i = 0; i < k; i++) assert.ok(same(a[i], b[i]), `${st.id} target[${i}] changed at k=${k}`);
      }
    }
  });
}

function synth(closes, { futures = false, ctr = null, rc = null } = {}) {
  const n = closes.length;
  return {
    symbol: "X", freq: "1d", isFutures: futures, n, barsPerYear: 252,
    inst: { multiplier: futures ? 10 : 1, group: futures ? "futures" : "crypto" },
    time: closes.map((_, i) => `2024-01-${String(i + 1).padStart(2, "0")}`),
    dates: closes.map((_, i) => `2024-01-${String(i + 1).padStart(2, "0")}`),
    o: closes.map((c, i) => (i ? closes[i - 1] : c)), h: closes, l: closes, c: closes,
    rc: rc || closes, ctr, v: closes.map(() => 1),
  };
}

test("orders decided at close i fill at open i+1", () => {
  // price path; target goes long at the close of bar 2
  const c = [100, 100, 100, 110, 121, 121];
  const b = synth(c);
  b.o = [100, 100, 100, 105, 115, 121];
  const targets = [0, 0, 1, 1, 1, 1];
  const r = runBacktest(b, { rv: [] }, targets, { ...DEFAULTS.crypto, commissionBps: 0, slippageBps: 0, allowShort: true });
  assert.equal(r.fills[0].i, 3, "first fill must be on bar 3");
  assert.equal(r.fills[0].price, 105, "fills at the open of bar 3, not the close of bar 2");
  // bars 0..2 flat
  assert.deepEqual(r.equity.slice(0, 3), [100000, 100000, 100000]);
  // bar 3: bought 100000/105 units at 105, close 110
  const units = 100000 / 105;
  assert.ok(Math.abs(r.equity[3] - units * 110) < 1e-6);
});

test("futures roll: adjusted series removes the calendar-spread gap", () => {
  // Raw price of the dominant contract jumps 100 -> 120 at the roll, but the market didn't move.
  // Back-adjusted series is flat, so a long position must make 0 (minus roll cost).
  const adj = [120, 120, 120, 120, 120, 120];
  const rc = [100, 100, 100, 120, 120, 120];
  const ctr = [0, 0, 0, 1, 1, 1];
  const b = synth(adj, { futures: true, ctr, rc });
  b.o = adj.slice();
  const targets = [1, 1, 1, 1, 1, 1];
  const r0 = runBacktest(b, { rv: [] }, targets, { ...DEFAULTS.futures, commissionBps: 0, slippageBps: 0, marginRate: 0.1, allowShort: true });
  assert.ok(Math.abs(r0.equity.at(-1) - r0.capital) < 1e-6, "no P&L from the roll gap");
  const r1 = runBacktest(b, { rv: [] }, targets, { ...DEFAULTS.futures, commissionBps: 1, slippageBps: 0, marginRate: 0.1, allowShort: true });
  assert.ok(r1.rollCost > 0, "roll is charged");
});

test("futures lots are integers and respect margin", () => {
  const b = load("RB");
  const f = computeFeatures(b);
  const t = new Array(b.n).fill(1);
  const r = runBacktest(b, f, t, { ...DEFAULTS.futures, leverage: 20, marginRate: 0.12, allowShort: true });
  for (const fl of r.fills) assert.ok(Number.isInteger(fl.qty));
  assert.ok(r.marginCapped > 0, "20x on 12% margin must be capped");
  assert.ok(r.maxMarginUse <= 1 + 1e-9, "margin used at each fill never exceeds equity");
});

test("every strategy runs on every instrument (daily + hourly)", () => {
  for (const inst of meta.instruments) {
    for (const freq of ["1d", "1h"]) {
      const b = load(inst.symbol, freq);
      const f = computeFeatures(b);
      for (const st of STRATEGIES) {
        const r = runBacktest(b, f, st.signal(b, f, defaultParams(st)),
          { ...DEFAULTS[inst.group], allowShort: true, sizing: "fixed" });
        assert.ok(r.equity.every(isNum), `${inst.symbol} ${freq} ${st.id}`);
      }
    }
  }
});
