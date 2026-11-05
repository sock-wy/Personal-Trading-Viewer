import { loadBars } from "../core/data.js";
import { computeFeatures } from "../core/analytics.js";
import { STRATEGIES, getStrategy, defaultParams } from "../core/strategies.js";
import { runBacktest, DEFAULTS } from "../core/engine.js";
import { monthlyReturns } from "../core/metrics.js";
import { isNum } from "../core/indicators.js";
import { makeChart, syncCharts, lineData, candleData, theme, rgba } from "./charts.js";
import { esc, fmtPct, fmtNum, fmtPrice, fmtBig, fmtTime } from "./format.js";

const featCache = new Map();

async function getSet(sym, freq) {
  const key = `${sym}:${freq}`;
  if (!featCache.has(key)) {
    featCache.set(key, (async () => {
      const bars = await loadBars(sym, freq);
      return { bars, f: computeFeatures(bars) };
    })());
  }
  return featCache.get(key);
}

function readConfig(params, meta) {
  const sym = (params.get("sym") || "RB").toUpperCase();
  const inst = meta.instruments.find((i) => i.symbol === sym) || meta.instruments[0];
  const d = DEFAULTS[inst.group];
  const strat = getStrategy(params.get("s")) || getStrategy("donchian");
  const p = defaultParams(strat);
  for (const k of Object.keys(p)) if (params.has(k)) p[k] = +params.get(k);
  const num = (k, def) => (params.has(k) && isFinite(+params.get(k)) ? +params.get(k) : def);
  return {
    sym: inst.symbol, freq: params.get("f") === "1h" ? "1h" : "1d", strategy: strat.id, params: p,
    start: params.get("from") || "", end: params.get("to") || "",
    dir: params.get("dir") || (inst.group === "futures" ? "both" : "long"),
    sizing: params.get("sz") || "fixed",
    leverage: num("lev", d.leverage), targetVol: num("tv", 0.15), maxLeverage: num("maxlev", 3),
    commissionBps: num("fee", d.commissionBps), slippageBps: num("slip", d.slippageBps),
    marginRate: num("mr", d.marginRate), capital: num("cap", d.capital),
  };
}

function toQuery(c) {
  const q = new URLSearchParams({ sym: c.sym, f: c.freq, s: c.strategy, dir: c.dir, sz: c.sizing,
    lev: c.leverage, tv: c.targetVol, maxlev: c.maxLeverage, fee: c.commissionBps, slip: c.slippageBps,
    mr: c.marginRate, cap: c.capital });
  if (c.start) q.set("from", c.start);
  if (c.end) q.set("to", c.end);
  for (const [k, v] of Object.entries(c.params)) q.set(k, v);
  return q.toString();
}

export async function renderBacktest(ctx, params) {
  const { meta, view } = ctx;
  let cfg = readConfig(params, meta);
  let charts = [];
  let lastRun = null;

  view.innerHTML = `
    <div class="page-head">
      <div>
        <div class="eyebrow">Strategy lab</div>
        <h1>Backtest</h1>
        <p>Bar-by-bar simulation in your browser. Signals use only data up to each bar's close and fill at the next
        bar's open; futures trade whole lots on the back-adjusted dominant contract with margin, fees, slippage and roll costs.</p>
      </div>
    </div>
    <div class="bt-grid">
      <form class="card bt-form" id="bt-form" autocomplete="off"></form>
      <div id="bt-out"><div class="card empty">Configure a strategy and press <b>Run backtest</b>.</div></div>
    </div>`;
  const form = view.querySelector("#bt-form");
  const out = view.querySelector("#bt-out");

  const renderForm = () => {
    const inst = meta.instruments.find((i) => i.symbol === cfg.sym);
    const strat = getStrategy(cfg.strategy);
    const isF = inst.group === "futures";
    const range = inst[cfg.freq === "1d" ? "daily" : "hourly"];
    const rStart = cfg.freq === "1d" ? range.start : (typeof range.start === "number" ? new Date(range.start * 1000).toISOString().slice(0, 10) : range.start);
    const rEnd = cfg.freq === "1d" ? range.end : (typeof range.end === "number" ? new Date(range.end * 1000).toISOString().slice(0, 10) : range.end);
    form.innerHTML = `
      <fieldset><legend>Market</legend>
        <div class="field full"><select name="sym">${Object.entries(meta.groups).map(([g, gm]) => `<optgroup label="${esc(gm.label)}">${
          meta.instruments.filter((i) => i.group === g).map((i) => `<option value="${i.symbol}" ${i.symbol === cfg.sym ? "selected" : ""}>${i.symbol} — ${esc(i.name)}${i.cn ? " " + esc(i.cn) : ""}</option>`).join("")
        }</optgroup>`).join("")}</select></div>
        <div class="field"><label>Bars</label><select name="freq"><option value="1d" ${cfg.freq === "1d" ? "selected" : ""}>Daily</option><option value="1h" ${cfg.freq === "1h" ? "selected" : ""}>Hourly</option></select></div>
        <div class="field"><label>From</label><input type="date" name="start" value="${cfg.start}" min="${rStart}" max="${rEnd}"></div>
        <div class="field"><label>To</label><input type="date" name="end" value="${cfg.end}" min="${rStart}" max="${rEnd}"></div>
        <div class="field full"><span class="hint">Data: ${rStart} → ${rEnd}</span></div>
      </fieldset>
      <fieldset><legend>Strategy</legend>
        <div class="field full"><select name="strategy">${STRATEGIES.map((s) => `<option value="${s.id}" ${s.id === cfg.strategy ? "selected" : ""}>${esc(s.name)} · ${esc(s.family)}</option>`).join("")}</select></div>
        <p class="strat-desc">${esc(strat.desc)}</p>
        ${strat.params.map((p) => `<div class="field"><label>${esc(p.label)}</label><input type="number" name="p_${p.key}" value="${cfg.params[p.key]}" min="${p.min}" max="${p.max}" step="${p.step}">${p.help ? `<span class="hint">${esc(p.help)}</span>` : ""}</div>`).join("")}
        <div class="field"><label>Direction</label><select name="dir">
          <option value="both" ${cfg.dir === "both" ? "selected" : ""}>Long &amp; short</option>
          <option value="long" ${cfg.dir === "long" ? "selected" : ""}>Long only</option>
          <option value="short" ${cfg.dir === "short" ? "selected" : ""}>Short only</option></select></div>
      </fieldset>
      <fieldset><legend>Sizing</legend>
        <div class="field"><label>Method</label><select name="sizing">
          <option value="fixed" ${cfg.sizing === "fixed" ? "selected" : ""}>Fixed leverage</option>
          <option value="voltarget" ${cfg.sizing === "voltarget" ? "selected" : ""}>Volatility target</option></select></div>
        ${cfg.sizing === "fixed"
          ? `<div class="field"><label>Notional / equity</label><input type="number" name="leverage" value="${cfg.leverage}" min="0.1" max="10" step="0.1"></div>`
          : `<div class="field"><label>Target vol (ann.)</label><input type="number" name="targetVol" value="${cfg.targetVol}" min="0.02" max="1" step="0.01"></div>
             <div class="field"><label>Max leverage</label><input type="number" name="maxLeverage" value="${cfg.maxLeverage}" min="0.5" max="10" step="0.5"></div>
             <div class="field full"><span class="hint">Leverage = target vol ÷ 20-bar realized vol, capped.</span></div>`}
        <div class="field"><label>Capital (${isF ? "CNY" : "USD"})</label><input type="number" name="capital" value="${cfg.capital}" min="1000" step="1000"></div>
      </fieldset>
      <fieldset><legend>Frictions</legend>
        <div class="field"><label>Commission (bps)</label><input type="number" name="commissionBps" value="${cfg.commissionBps}" min="0" max="100" step="0.5"></div>
        <div class="field"><label>Slippage (bps)</label><input type="number" name="slippageBps" value="${cfg.slippageBps}" min="0" max="100" step="0.5"></div>
        ${isF ? `<div class="field"><label>Margin rate</label><input type="number" name="marginRate" value="${cfg.marginRate}" min="0.03" max="1" step="0.01"></div>
          <div class="field full"><span class="hint">${inst.multiplier} ${inst.unit} per lot · roll cost charged on contract switches</span></div>` : ""}
      </fieldset>
      <div class="bt-actions">
        <button class="btn primary" type="submit" id="btn-run">Run backtest</button>
        <button class="btn" type="button" id="btn-sweep" title="Grid-search two parameters and show Sharpe">Parameter sweep</button>
      </div>`;
  };

  const collect = () => {
    const fd = new FormData(form);
    const g = (k) => fd.get(k);
    const strat = getStrategy(g("strategy"));
    const sameStrat = strat.id === cfg.strategy;
    const params = defaultParams(strat);
    if (sameStrat) for (const p of strat.params) if (g(`p_${p.key}`) !== null) params[p.key] = +g(`p_${p.key}`);
    const next = {
      ...cfg, sym: g("sym"), freq: g("freq"), strategy: strat.id, params,
      start: g("start") || "", end: g("end") || "", dir: g("dir"), sizing: g("sizing"),
      capital: +g("capital") || cfg.capital,
      commissionBps: +g("commissionBps"), slippageBps: +g("slippageBps"),
    };
    if (g("leverage") !== null) next.leverage = +g("leverage");
    if (g("targetVol") !== null) next.targetVol = +g("targetVol");
    if (g("maxLeverage") !== null) next.maxLeverage = +g("maxLeverage");
    if (g("marginRate") !== null) next.marginRate = +g("marginRate");
    if (next.sym !== cfg.sym) {
      const inst = meta.instruments.find((i) => i.symbol === next.sym);
      const oldInst = meta.instruments.find((i) => i.symbol === cfg.sym);
      if (inst.group !== oldInst.group) Object.assign(next, DEFAULTS[inst.group], { dir: inst.group === "futures" ? "both" : "long" });
    }
    if (next.freq !== cfg.freq || next.sym !== cfg.sym) { next.start = ""; next.end = ""; }
    return next;
  };

  form.addEventListener("change", (e) => {
    const structural = ["sym", "freq", "strategy", "sizing"].includes(e.target.name);
    cfg = collect();
    if (structural) renderForm();
  });
  form.addEventListener("submit", (e) => { e.preventDefault(); cfg = collect(); run(); });

  const run = async () => {
    const btn = form.querySelector("#btn-run");
    btn.disabled = true; btn.textContent = "Running…";
    history.replaceState(null, "", `#/backtest?${toQuery(cfg)}`);
    try {
      const { bars, f } = await getSet(cfg.sym, cfg.freq);
      const res = simulate(bars, f, cfg);
      lastRun = { bars, f, res, cfg: { ...cfg, params: { ...cfg.params } } };
      paintResults(lastRun);
    } catch (e) {
      console.error(e);
      out.innerHTML = `<div class="card error">Backtest failed: ${esc(e.message)}</div>`;
    } finally {
      btn.disabled = false; btn.textContent = "Run backtest";
    }
  };

  const paintResults = ({ bars, f, res, cfg: c }) => {
    charts.forEach((x) => x.remove()); charts = [];
    const inst = bars.inst;
    const strat = getStrategy(c.strategy);
    const m = res.metrics, bm = res.benchMetrics;
    const cur = inst.group === "futures" ? "¥" : "$";
    const pstr = Object.entries(c.params).map(([k, v]) => `${k}=${v}`).join(", ");
    const tile = (label, val, bench, cls = "") => `<div class="card tile"><div class="t-label">${label}</div><div class="t-val ${cls}">${val}</div><div class="t-bench">${bench ?? "&nbsp;"}</div></div>`;
    const sgn = (x) => (x > 0 ? "up" : x < 0 ? "down" : "");
    out.innerHTML = `
      <div class="card bt-section"><div class="card-head">
        <h2>${inst.symbol} · ${esc(strat.name)} <span class="muted" style="font-weight:400">(${esc(pstr)})</span></h2>
        <span class="sub">${c.freq === "1d" ? "Daily" : "Hourly"} · ${fmtTime(res.time[0])} → ${fmtTime(res.time.at(-1))} · ${res.metrics.years.toFixed(1)} yrs${res.ruined ? ' · <b class="down">account wiped out</b>' : ""}</span>
      </div></div>
      <div class="tiles">
        ${tile("CAGR", fmtPct(m.cagr, 1), `B&amp;H ${fmtPct(bm.cagr, 1)}`, sgn(m.cagr))}
        ${tile("Sharpe", fmtNum(m.sharpe, 2), `B&amp;H ${fmtNum(bm.sharpe, 2)}`)}
        ${tile("Max drawdown", fmtPct(m.maxDD, 1, false), `B&amp;H ${fmtPct(bm.maxDD, 1, false)}`, "down")}
        ${tile("Volatility", fmtPct(m.vol, 1, false), `B&amp;H ${fmtPct(bm.vol, 1, false)}`)}
        ${tile("Sortino", fmtNum(m.sortino, 2), `Calmar ${fmtNum(m.calmar, 2)}`)}
        ${tile("Total return", fmtPct(m.totalReturn, 0), `${cur}${fmtBig(res.equity.at(-1))} final`, sgn(m.totalReturn))}
        ${tile("Trades", m.trades + (m.openTrades ? ` +${m.openTrades}` : ""), `avg ${isNum(m.avgBarsHeld) ? m.avgBarsHeld.toFixed(0) : "—"} bars held`)}
        ${tile("Win rate", fmtPct(m.winRate, 0, false), `PF ${isFinite(m.profitFactor) ? fmtNum(m.profitFactor, 2) : "∞"}`)}
        ${tile("Time in market", fmtPct(m.exposure, 0, false))}
        ${tile("Turnover / yr", `${fmtNum(m.turnoverPerYear, 1)}×`)}
        ${tile("Cost drag / yr", fmtPct(m.costDrag, 2, false), inst.group === "futures" ? `roll ${cur}${fmtBig(res.rollCost)}` : "")}
        ${tile("Longest drawdown", `${m.maxDDDays}d`, inst.group === "futures" && res.marginCapped ? `${res.marginCapped} margin caps` : "")}
      </div>
      <div class="card chart-stack bt-section">
        <div class="toolbar"><b style="font-size:13px">Equity vs buy &amp; hold</b>
          <span class="muted" style="font-size:12px">strategy (solid) · buy &amp; hold 1×, no costs (dotted)</span>
          <span class="spacer"></span><label style="font-size:12px;color:var(--ink-2)"><input type="checkbox" id="logscale"> log scale</label></div>
        <div class="pane"><div id="c-eq"></div></div>
        <div class="pane"><div class="pane-label">Drawdown</div><div id="c-dd"></div></div>
        <div class="pane"><div class="pane-label">Price <em>· fills: ▲ buy ▼ sell</em></div><div id="c-px"></div></div>
      </div>
      <div class="card bt-section" id="sweep-card" hidden></div>
      <div class="card bt-section"><div class="card-head"><h3>Monthly returns</h3><span class="sub">calendar months, net of costs</span></div>
        <div class="card-body tbl-wrap">${monthlyTable(res)}</div></div>
      <div class="card bt-section"><div class="card-head"><h3>Trades</h3><span class="sub">${res.trades.length} episodes · prices are raw contract prices at the fill</span></div>
        <div class="card-body scroll-y">${tradesTable(res, bars, inst)}</div></div>
      <div class="card bt-section"><div class="card-head"><h3>Assumptions</h3></div>
        <ul class="assump">${assumptions(c, inst).map((x) => `<li>${x}</li>`).join("")}</ul></div>`;
    drawCharts(bars, res, c);
  };

  const drawCharts = (bars, res, c) => {
    const th = theme();
    const timeVisible = c.freq === "1h";
    const eq = makeChart(out.querySelector("#c-eq"), { height: 300, timeVisible, showTime: false });
    const eS = eq.addLineSeries({ color: th.accent, lineWidth: 2, priceLineVisible: false, priceFormat: { type: "price", precision: 0, minMove: 1 } });
    eS.setData(lineData(res.time, res.equity));
    eq.addLineSeries({ color: th.ink3, lineWidth: 1, lineStyle: 1, priceLineVisible: false, priceFormat: { type: "price", precision: 0, minMove: 1 } })
      .setData(lineData(res.time, res.bench));
    out.querySelector("#logscale").addEventListener("change", (e) => eq.priceScale("right").applyOptions({ mode: e.target.checked ? 1 : 0 }));

    const dd = makeChart(out.querySelector("#c-dd"), { height: 120, timeVisible, showTime: false });
    dd.addAreaSeries({ lineColor: th.down, topColor: rgba(th.down, 0.05), bottomColor: rgba(th.down, 0.35), lineWidth: 1, priceLineVisible: false, invertFilledArea: false, priceFormat: { type: "percent" } })
      .setData(lineData(res.time, res.metrics.drawdown.map((x) => x * 100)));

    const px = makeChart(out.querySelector("#c-px"), { height: 260, timeVisible, showTime: true });
    const s0 = bars.time.indexOf(res.time[0]);
    const sub = { ...bars, n: res.time.length, time: res.time, o: bars.o.slice(s0, s0 + res.time.length), h: bars.h.slice(s0, s0 + res.time.length), l: bars.l.slice(s0, s0 + res.time.length), c: bars.c.slice(s0, s0 + res.time.length) };
    const cs = px.addCandlestickSeries({ upColor: th.up, downColor: th.down, borderUpColor: th.up, borderDownColor: th.down, wickUpColor: th.up, wickDownColor: th.down, priceLineVisible: false });
    cs.setData(candleData(sub));
    const fills = res.fills.length > 600 ? res.fills.filter((fl, k) => k % Math.ceil(res.fills.length / 600) === 0) : res.fills;
    cs.setMarkers(fills.map((fl) => ({
      time: fl.time, position: fl.qty > 0 ? "belowBar" : "aboveBar", color: fl.qty > 0 ? th.up : th.down,
      shape: fl.qty > 0 ? "arrowUp" : "arrowDown", size: 0.7,
    })));
    charts = [eq, dd, px];
    charts.forEach((x) => x.applyOptions({ rightPriceScale: { minimumWidth: 80 } }));
    syncCharts(charts);
    charts.forEach((x) => x.timeScale().fitContent());
  };

  const sweep = async () => {
    const btn = form.querySelector("#btn-sweep");
    cfg = collect();
    const strat = getStrategy(cfg.strategy);
    const keys = Object.keys(strat.sweep);
    const [k1, k2] = keys;
    const xs = strat.sweep[k1], ys = k2 ? strat.sweep[k2] : [null];
    btn.disabled = true;
    const { bars, f } = await getSet(cfg.sym, cfg.freq);
    if (!lastRun || lastRun.cfg.sym !== cfg.sym || lastRun.cfg.freq !== cfg.freq) { await run(); }
    const card = out.querySelector("#sweep-card");
    card.hidden = false;
    const grid = [];
    for (let a = 0; a < ys.length; a++) {
      grid.push([]);
      for (let b = 0; b < xs.length; b++) {
        btn.textContent = `Sweeping ${a * xs.length + b + 1}/${xs.length * ys.length}…`;
        await new Promise((r) => setTimeout(r, 0));
        const p = { ...cfg.params, [k1]: xs[b] };
        if (k2) p[k2] = ys[a];
        const r = simulate(bars, f, { ...cfg, params: p });
        grid[a].push(r.metrics);
      }
    }
    btn.disabled = false; btn.textContent = "Parameter sweep";
    const vals = grid.flat().map((m) => m.sharpe).filter(isNum);
    const mx = Math.max(0.01, ...vals.map(Math.abs));
    const th = theme();
    const cell = (mm, b, a) => {
      const v = mm.sharpe;
      const isCur = cfg.params[k1] === xs[b] && (!k2 || cfg.params[k2] === ys[a]);
      const bg = isNum(v) ? rgba(v >= 0 ? th.up : th.down, Math.min(0.85, 0.12 + Math.abs(v) / mx * 0.7)) : "transparent";
      return `<td class="${isCur ? "cur" : ""}" data-a="${a}" data-b="${b}" style="background:${bg}" title="CAGR ${fmtPct(mm.cagr, 1)} · MaxDD ${fmtPct(mm.maxDD, 0, false)} · ${mm.trades} trades">${fmtNum(v, 2)}</td>`;
    };
    const lab = (k) => strat.params.find((p) => p.key === k)?.label || k;
    card.innerHTML = `<div class="card-head"><h3>Parameter sweep · Sharpe ratio</h3>
      <span class="sub">${esc(lab(k1))} (columns)${k2 ? ` × ${esc(lab(k2))} (rows)` : ""} · other settings fixed · click a cell to load it</span></div>
      <div class="card-body tbl-wrap"><table class="heat sweep-grid">
        <tr><th></th>${xs.map((x) => `<th>${x}</th>`).join("")}</tr>
        ${grid.map((rowM, a) => `<tr><th>${k2 ? ys[a] : ""}</th>${rowM.map((mm, b) => cell(mm, b, a)).join("")}</tr>`).join("")}
      </table>
      <p class="note">A robust strategy shows a broad region of similar Sharpe, not one bright cell. The single best cell is an
      in-sample optimum and will be optimistic out of sample.</p></div>`;
    card.querySelectorAll("td[data-a]").forEach((td) => td.addEventListener("click", () => {
      cfg.params[k1] = xs[+td.dataset.b];
      if (k2) cfg.params[k2] = ys[+td.dataset.a];
      renderForm();
      run().then(() => { const c2 = out.querySelector("#sweep-card"); if (c2) { c2.hidden = false; c2.innerHTML = card.innerHTML; } });
    }));
    card.scrollIntoView({ behavior: "smooth", block: "nearest" });
  };

  renderForm();
  form.addEventListener("click", (e) => { if (e.target.id === "btn-sweep") sweep(); });
  await run();
  return () => charts.forEach((x) => x.remove());
}

export function simulate(bars, f, c) {
  const strat = getStrategy(c.strategy);
  const targets = strat.signal(bars, f, c.params);
  let s = 0, e = bars.n - 1;
  if (c.start) { const i = bars.dates.findIndex((d) => d >= c.start); if (i >= 0) s = i; }
  if (c.end) { for (let i = bars.n - 1; i >= 0; i--) if (bars.dates[i] <= c.end) { e = i; break; } }
  if (e - s < 10) throw new Error("Date range too short");
  return runBacktest(bars, f, targets, {
    capital: c.capital, commissionBps: c.commissionBps, slippageBps: c.slippageBps, marginRate: c.marginRate,
    leverage: c.leverage, sizing: c.sizing, targetVol: c.targetVol, maxLeverage: c.maxLeverage,
    allowShort: c.dir !== "long", allowLong: c.dir !== "short", startIdx: s, endIdx: e,
  });
}

function monthlyTable(res) {
  const rows = monthlyReturns(res.dates, res.equity);
  const years = [...new Set(rows.map((r) => r.year))];
  const th = theme();
  const mx = Math.max(0.02, ...rows.map((r) => Math.abs(r.ret)));
  const cell = (r) => {
    if (r === undefined) return "<td></td>";
    const bg = rgba(r >= 0 ? th.up : th.down, Math.min(0.75, 0.08 + (Math.abs(r) / mx) * 0.67));
    return `<td style="background:${bg}">${(r * 100).toFixed(1)}</td>`;
  };
  const M = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `<table class="heat"><tr><th></th>${M.map((m) => `<th>${m}</th>`).join("")}<th>Year</th></tr>${years.map((y) => {
    const r = rows.filter((x) => x.year === y);
    const byM = Object.fromEntries(r.map((x) => [x.month, x.ret]));
    const yr = r.reduce((a, x) => a * (1 + x.ret), 1) - 1;
    return `<tr><th>${y}</th>${M.map((_, i) => cell(byM[i + 1])).join("")}<td class="yr" style="background:${rgba(yr >= 0 ? th.up : th.down, 0.18)}">${(yr * 100).toFixed(1)}</td></tr>`;
  }).join("")}</table>`;
}

function tradesTable(res, bars, inst) {
  const t = res.trades.slice(-200).reverse();
  if (!t.length) return '<p class="muted">No trades.</p>';
  const cur = inst.group === "futures" ? "¥" : "$";
  return `<table class="trades"><thead><tr><th>Entry</th><th>Side</th><th>Size</th><th>Entry px</th><th>Exit</th><th>Exit px</th><th>Bars</th><th>P&amp;L</th><th>Return</th></tr></thead><tbody>${
    t.map((x) => `<tr><td>${fmtTime(x.entryTime)}</td><td class="${x.dir > 0 ? "up" : "down"}">${x.dir > 0 ? "Long" : "Short"}</td>
      <td>${inst.group === "futures" ? Math.abs(x.lots) + " lots" : fmtNum(Math.abs(x.lots), 3)}</td>
      <td>${fmtPrice(x.entryPrice, inst)}</td><td>${x.openTrade ? '<span class="muted">open</span>' : fmtTime(x.exitTime)}</td>
      <td>${fmtPrice(x.exitPrice, inst)}</td><td>${x.bars}</td>
      <td class="${x.pnl >= 0 ? "up" : "down"}">${cur}${fmtBig(x.pnl)}</td><td class="${x.ret >= 0 ? "up" : "down"}">${fmtPct(x.ret, 2)}</td></tr>`).join("")
  }</tbody></table>${res.trades.length > 200 ? '<p class="note">Showing the latest 200 trades.</p>' : ""}`;
}

function assumptions(c, inst) {
  const isF = inst.group === "futures";
  const a = [
    "Signals are computed on bar close; orders fill at the <b>next bar's open</b>. No intrabar stops.",
    `Costs: ${c.commissionBps} bps commission + ${c.slippageBps} bps slippage on traded notional${isF ? ", charged twice on every roll while a position is open" : ""}.`,
    c.sizing === "fixed" ? `Position notional = ${c.leverage}× equity, re-sized only when off by more than 25%.`
      : `Volatility targeting: notional = ${(c.targetVol * 100).toFixed(0)}% ÷ realized vol(20), capped at ${c.maxLeverage}×.`,
    "Benchmark: buy-and-hold on the same series, 1× notional, no costs.",
    "Sharpe uses a zero risk-free rate; annualization from the observed bars per year.",
  ];
  if (isF) {
    a.push(`Futures: whole lots of ${inst.multiplier} ${inst.unit}; initial margin ${(c.marginRate * 100).toFixed(0)}% caps the position at each fill.`);
    a.push("Prices are back-adjusted by the ratio at each roll, so returns equal holding and rolling the dominant contract; P&L is scaled to the raw contract price.");
    a.push("Exchange price limits, holidays and night-session liquidity are not modelled.");
  } else {
    a.push("Crypto: spot prices (Coinbase). Shorts, if enabled, ignore borrow / funding costs.");
  }
  return a;
}
