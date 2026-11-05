import { loadBars } from "../core/data.js";
import { computeFeatures } from "../core/analytics.js";
import { STRATEGIES, getStrategy, defaultParams } from "../core/strategies.js";
import { runBacktest, DEFAULTS } from "../core/engine.js";
import { monthlyReturns } from "../core/metrics.js";
import { isNum } from "../core/indicators.js";
import { makeChart, syncCharts, lineData, candleData, theme, rgba } from "./charts.js";
import { esc, fmtPct, fmtNum, fmtPrice, fmtBig, fmtTime } from "./format.js";
import { L, getLang } from "./i18n.js";
import { STRATEGY_ZH } from "../core/strategies.js";

const sName = (s) => L(s.name, STRATEGY_ZH[s.id]?.name || s.name);
const sFam = (s) => L(s.family, STRATEGY_ZH[s.id]?.family || s.family);
const sDesc = (s) => L(s.desc, STRATEGY_ZH[s.id]?.desc || s.desc);
const pLab = (s, p) => L(p.label, STRATEGY_ZH[s.id]?.params?.[p.key] || p.label);

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
        <div class="eyebrow">${L("Strategy lab", "策略实验室")}</div>
        <h1>${L("Backtest", "回测")}</h1>
        <p>${L(`Bar-by-bar simulation in your browser. Signals use only data up to each bar's close and fill at the next
        bar's open; futures trade whole lots on the back-adjusted dominant contract with margin, fees, slippage and roll costs.`,
        "在浏览器中逐根 K 线模拟。信号只使用截至当根收盘的数据，并在下一根开盘成交；期货按整数手交易复权主力合约，计入保证金、手续费、滑点和换月成本。")}</p>
      </div>
    </div>
    <div class="bt-grid">
      <form class="card bt-form" id="bt-form" autocomplete="off"></form>
      <div id="bt-out"><div class="card empty">${L("Configure a strategy and press <b>Run backtest</b>.", "设置策略后点击<b>运行回测</b>。")}</div></div>
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
      <fieldset><legend>${L("Market", "标的")}</legend>
        <div class="field full"><select name="sym">${Object.entries(meta.groups).map(([g, gm]) => `<optgroup label="${esc(gm.label)}">${
          meta.instruments.filter((i) => i.group === g).map((i) => `<option value="${i.symbol}" ${i.symbol === cfg.sym ? "selected" : ""}>${i.symbol} — ${esc(L(i.name, i.cn || i.name))}</option>`).join("")
        }</optgroup>`).join("")}</select></div>
        <div class="field"><label>${L("Bars", "周期")}</label><select name="freq"><option value="1d" ${cfg.freq === "1d" ? "selected" : ""}>${L("Daily", "日线")}</option><option value="1h" ${cfg.freq === "1h" ? "selected" : ""}>${L("Hourly", "小时线")}</option></select></div>
        <div class="field"><label>${L("From", "开始")}</label><input type="date" name="start" value="${cfg.start}" min="${rStart}" max="${rEnd}"></div>
        <div class="field"><label>${L("To", "结束")}</label><input type="date" name="end" value="${cfg.end}" min="${rStart}" max="${rEnd}"></div>
        <div class="field full"><span class="hint">${L("Data", "数据")}: ${rStart} → ${rEnd}</span></div>
      </fieldset>
      <fieldset><legend>${L("Strategy", "策略")}</legend>
        <div class="field full"><select name="strategy">${STRATEGIES.map((s) => `<option value="${s.id}" ${s.id === cfg.strategy ? "selected" : ""}>${esc(sName(s))} · ${esc(sFam(s))}</option>`).join("")}</select></div>
        <p class="strat-desc">${esc(sDesc(strat))}</p>
        ${strat.params.map((p) => `<div class="field"><label>${esc(pLab(strat, p))}</label><input type="number" name="p_${p.key}" value="${cfg.params[p.key]}" min="${p.min}" max="${p.max}" step="${p.step}">${p.help ? `<span class="hint">${esc(p.help)}</span>` : ""}</div>`).join("")}
        <div class="field"><label>${L("Direction", "方向")}</label><select name="dir">
          <option value="both" ${cfg.dir === "both" ? "selected" : ""}>${L("Long &amp; short", "多空双向")}</option>
          <option value="long" ${cfg.dir === "long" ? "selected" : ""}>${L("Long only", "只做多")}</option>
          <option value="short" ${cfg.dir === "short" ? "selected" : ""}>${L("Short only", "只做空")}</option></select></div>
      </fieldset>
      <fieldset><legend>${L("Sizing", "仓位")}</legend>
        <div class="field"><label>${L("Method", "方式")}</label><select name="sizing">
          <option value="fixed" ${cfg.sizing === "fixed" ? "selected" : ""}>${L("Fixed leverage", "固定杠杆")}</option>
          <option value="voltarget" ${cfg.sizing === "voltarget" ? "selected" : ""}>${L("Volatility target", "波动率目标")}</option></select></div>
        ${cfg.sizing === "fixed"
          ? `<div class="field"><label>${L("Notional / equity", "名义/权益")}</label><input type="number" name="leverage" value="${cfg.leverage}" min="0.1" max="10" step="0.1"></div>`
          : `<div class="field"><label>${L("Target vol (ann.)", "目标波动率（年化）")}</label><input type="number" name="targetVol" value="${cfg.targetVol}" min="0.02" max="1" step="0.01"></div>
             <div class="field"><label>${L("Max leverage", "最大杠杆")}</label><input type="number" name="maxLeverage" value="${cfg.maxLeverage}" min="0.5" max="10" step="0.5"></div>
             <div class="field full"><span class="hint">${L("Leverage = target vol ÷ 20-bar realized vol, capped.", "杠杆 = 目标波动率 ÷ 20 期已实现波动率，有上限。")}</span></div>`}
        <div class="field"><label>${L("Capital", "本金")} (${isF ? "CNY" : "USD"})</label><input type="number" name="capital" value="${cfg.capital}" min="1000" step="1000"></div>
      </fieldset>
      <fieldset><legend>${L("Frictions", "交易成本")}</legend>
        <div class="field"><label>${L("Commission (bps)", "手续费（bp）")}</label><input type="number" name="commissionBps" value="${cfg.commissionBps}" min="0" max="100" step="0.5"></div>
        <div class="field"><label>${L("Slippage (bps)", "滑点（bp）")}</label><input type="number" name="slippageBps" value="${cfg.slippageBps}" min="0" max="100" step="0.5"></div>
        ${isF ? `<div class="field"><label>${L("Margin rate", "保证金率")}</label><input type="number" name="marginRate" value="${cfg.marginRate}" min="0.03" max="1" step="0.01"></div>
          <div class="field full"><span class="hint">${inst.multiplier} ${inst.unit}${L(" per lot · roll cost charged on contract switches", "/手 · 主力换月时计入换月成本")}</span></div>` : ""}
      </fieldset>
      <div class="bt-actions">
        <button class="btn primary" type="submit" id="btn-run">${L("Run backtest", "运行回测")}</button>
        <button class="btn" type="button" id="btn-sweep" title="${L("Grid-search two parameters and show Sharpe", "对两个参数网格搜索并显示夏普比率")}">${L("Parameter sweep", "参数扫描")}</button>
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
    btn.disabled = true; btn.textContent = L("Running…", "运行中…");
    history.replaceState(null, "", `#/backtest?${toQuery(cfg)}`);
    try {
      const { bars, f } = await getSet(cfg.sym, cfg.freq);
      const res = simulate(bars, f, cfg);
      lastRun = { bars, f, res, cfg: { ...cfg, params: { ...cfg.params } } };
      paintResults(lastRun);
    } catch (e) {
      console.error(e);
      out.innerHTML = `<div class="card error">${L("Backtest failed", "回测失败")}: ${esc(e.message)}</div>`;
    } finally {
      btn.disabled = false; btn.textContent = L("Run backtest", "运行回测");
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
    const BH = L("B&amp;H", "持有");
    out.innerHTML = `
      <div class="card bt-section"><div class="card-head">
        <h2>${inst.symbol} · ${esc(sName(strat))} <span class="muted" style="font-weight:400">(${esc(pstr)})</span></h2>
        <span class="sub">${c.freq === "1d" ? L("Daily", "日线") : L("Hourly", "小时线")} · ${fmtTime(res.time[0])} → ${fmtTime(res.time.at(-1))} · ${res.metrics.years.toFixed(1)} ${L("yrs", "年")}${res.ruined ? ` · <b class="down">${L("account wiped out", "账户爆仓")}</b>` : ""}</span>
      </div></div>
      <div class="tiles">
        ${tile(L("CAGR", "年化收益"), fmtPct(m.cagr, 1), `${BH} ${fmtPct(bm.cagr, 1)}`, sgn(m.cagr))}
        ${tile(L("Sharpe", "夏普比率"), fmtNum(m.sharpe, 2), `${BH} ${fmtNum(bm.sharpe, 2)}`)}
        ${tile(L("Max drawdown", "最大回撤"), fmtPct(m.maxDD, 1, false), `${BH} ${fmtPct(bm.maxDD, 1, false)}`, "down")}
        ${tile(L("Volatility", "波动率"), fmtPct(m.vol, 1, false), `${BH} ${fmtPct(bm.vol, 1, false)}`)}
        ${tile(L("Sortino", "索提诺比率"), fmtNum(m.sortino, 2), `${L("Calmar", "卡玛比率")} ${fmtNum(m.calmar, 2)}`)}
        ${tile(L("Total return", "总收益"), fmtPct(m.totalReturn, 0), `${L("final", "期末")} ${cur}${fmtBig(res.equity.at(-1))}`, sgn(m.totalReturn))}
        ${tile(L("Trades", "交易次数"), m.trades + (m.openTrades ? ` +${m.openTrades}` : ""), L(`avg ${isNum(m.avgBarsHeld) ? m.avgBarsHeld.toFixed(0) : "—"} bars held`, `平均持有 ${isNum(m.avgBarsHeld) ? m.avgBarsHeld.toFixed(0) : "—"} 根`))}
        ${tile(L("Win rate", "胜率"), fmtPct(m.winRate, 0, false), `${L("PF", "盈亏比")} ${isFinite(m.profitFactor) ? fmtNum(m.profitFactor, 2) : "∞"}`)}
        ${tile(L("Time in market", "持仓时间占比"), fmtPct(m.exposure, 0, false))}
        ${tile(L("Turnover / yr", "年换手"), `${fmtNum(m.turnoverPerYear, 1)}×`)}
        ${tile(L("Cost drag / yr", "年成本拖累"), fmtPct(m.costDrag, 2, false), inst.group === "futures" ? `${L("roll", "换月")} ${cur}${fmtBig(res.rollCost)}` : "")}
        ${tile(L("Longest drawdown", "最长回撤期"), `${m.maxDDDays}${L("d", "天")}`, inst.group === "futures" && res.marginCapped ? `${res.marginCapped} ${L("margin caps", "次保证金限制")}` : "")}
      </div>
      <div class="card chart-stack bt-section">
        <div class="toolbar"><b style="font-size:13px">${L("Equity vs buy &amp; hold", "净值 vs 买入持有")}</b>
          <span class="muted" style="font-size:12px">${L("strategy (solid) · buy &amp; hold 1×, no costs (dotted)", "策略（实线）· 买入持有 1 倍、无成本（点线）")}</span>
          <span class="spacer"></span><label style="font-size:12px;color:var(--ink-2)"><input type="checkbox" id="logscale"> ${L("log scale", "对数坐标")}</label></div>
        <div class="pane"><div id="c-eq"></div></div>
        <div class="pane"><div class="pane-label">${L("Drawdown", "回撤")}</div><div id="c-dd"></div></div>
        <div class="pane"><div class="pane-label">${L("Price", "价格")} <em>· ${L("fills: ▲ buy ▼ sell", "成交：▲ 买 ▼ 卖")}</em></div><div id="c-px"></div></div>
      </div>
      <div class="card bt-section" id="sweep-card" hidden></div>
      <div class="card bt-section"><div class="card-head"><h3>${L("Monthly returns", "月度收益")}</h3><span class="sub">${L("calendar months, net of costs", "自然月，已扣成本")}</span></div>
        <div class="card-body tbl-wrap">${monthlyTable(res)}</div></div>
      <div class="card bt-section"><div class="card-head"><h3>${L("Trades", "交易记录")}</h3><span class="sub">${res.trades.length} ${L("episodes · prices are raw contract prices at the fill", "笔 · 价格为成交时的合约原始价格")}</span></div>
        <div class="card-body scroll-y">${tradesTable(res, bars, inst)}</div></div>
      <div class="card bt-section"><div class="card-head"><h3>${L("Assumptions", "假设说明")}</h3></div>
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
        btn.textContent = `${L("Sweeping", "扫描中")} ${a * xs.length + b + 1}/${xs.length * ys.length}…`;
        await new Promise((r) => setTimeout(r, 0));
        const p = { ...cfg.params, [k1]: xs[b] };
        if (k2) p[k2] = ys[a];
        const r = simulate(bars, f, { ...cfg, params: p });
        grid[a].push(r.metrics);
      }
    }
    btn.disabled = false; btn.textContent = L("Parameter sweep", "参数扫描");
    const vals = grid.flat().map((m) => m.sharpe).filter(isNum);
    const mx = Math.max(0.01, ...vals.map(Math.abs));
    const th = theme();
    const cell = (mm, b, a) => {
      const v = mm.sharpe;
      const isCur = cfg.params[k1] === xs[b] && (!k2 || cfg.params[k2] === ys[a]);
      const bg = isNum(v) ? rgba(v >= 0 ? th.up : th.down, Math.min(0.85, 0.12 + Math.abs(v) / mx * 0.7)) : "transparent";
      return `<td class="${isCur ? "cur" : ""}" data-a="${a}" data-b="${b}" style="background:${bg}" title="CAGR ${fmtPct(mm.cagr, 1)} · MaxDD ${fmtPct(mm.maxDD, 0, false)} · ${mm.trades} trades">${fmtNum(v, 2)}</td>`;
    };
    const lab = (k) => { const p = strat.params.find((x) => x.key === k); return p ? pLab(strat, p) : k; };
    card.innerHTML = `<div class="card-head"><h3>${L("Parameter sweep · Sharpe ratio", "参数扫描 · 夏普比率")}</h3>
      <span class="sub">${esc(lab(k1))} ${L("(columns)", "（列）")}${k2 ? ` × ${esc(lab(k2))} ${L("(rows)", "（行）")}` : ""} · ${L("other settings fixed · click a cell to load it", "其他设置不变 · 点击格子载入该组参数")}</span></div>
      <div class="card-body tbl-wrap"><table class="heat sweep-grid">
        <tr><th></th>${xs.map((x) => `<th>${x}</th>`).join("")}</tr>
        ${grid.map((rowM, a) => `<tr><th>${k2 ? ys[a] : ""}</th>${rowM.map((mm, b) => cell(mm, b, a)).join("")}</tr>`).join("")}
      </table>
      <p class="note">${L("A robust strategy shows a broad region of similar Sharpe, not one bright cell. The single best cell is an in-sample optimum and will be optimistic out of sample.", "稳健的策略应在一大片参数区域内夏普相近，而不是只有一个亮格。单个最优格子是样本内最优，样本外表现通常会更差。")}</p></div>`;
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
  if (e - s < 10) throw new Error(L("Date range too short", "日期区间过短"));
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
  const M = getLang() === "zh" ? ["1月", "2月", "3月", "4月", "5月", "6月", "7月", "8月", "9月", "10月", "11月", "12月"] : ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `<table class="heat"><tr><th></th>${M.map((m) => `<th>${m}</th>`).join("")}<th>${L("Year", "全年")}</th></tr>${years.map((y) => {
    const r = rows.filter((x) => x.year === y);
    const byM = Object.fromEntries(r.map((x) => [x.month, x.ret]));
    const yr = r.reduce((a, x) => a * (1 + x.ret), 1) - 1;
    return `<tr><th>${y}</th>${M.map((_, i) => cell(byM[i + 1])).join("")}<td class="yr" style="background:${rgba(yr >= 0 ? th.up : th.down, 0.18)}">${(yr * 100).toFixed(1)}</td></tr>`;
  }).join("")}</table>`;
}

function tradesTable(res, bars, inst) {
  const t = res.trades.slice(-200).reverse();
  if (!t.length) return `<p class="muted">${L("No trades.", "无交易。")}</p>`;
  const cur = inst.group === "futures" ? "¥" : "$";
  return `<table class="trades"><thead><tr><th>${L("Entry", "开仓")}</th><th>${L("Side", "方向")}</th><th>${L("Size", "数量")}</th><th>${L("Entry px", "开仓价")}</th><th>${L("Exit", "平仓")}</th><th>${L("Exit px", "平仓价")}</th><th>${L("Bars", "K线数")}</th><th>${L("P&amp;L", "盈亏")}</th><th>${L("Return", "收益率")}</th></tr></thead><tbody>${
    t.map((x) => `<tr><td>${fmtTime(x.entryTime)}</td><td class="${x.dir > 0 ? "up" : "down"}">${x.dir > 0 ? L("Long", "多") : L("Short", "空")}</td>
      <td>${inst.group === "futures" ? Math.abs(x.lots) + L(" lots", " 手") : fmtNum(Math.abs(x.lots), 3)}</td>
      <td>${fmtPrice(x.entryPrice, inst)}</td><td>${x.openTrade ? `<span class="muted">${L("open", "持仓中")}</span>` : fmtTime(x.exitTime)}</td>
      <td>${fmtPrice(x.exitPrice, inst)}</td><td>${x.bars}</td>
      <td class="${x.pnl >= 0 ? "up" : "down"}">${cur}${fmtBig(x.pnl)}</td><td class="${x.ret >= 0 ? "up" : "down"}">${fmtPct(x.ret, 2)}</td></tr>`).join("")
  }</tbody></table>${res.trades.length > 200 ? `<p class="note">${L("Showing the latest 200 trades.", "仅显示最近 200 笔。")}</p>` : ""}`;
}

function assumptions(c, inst) {
  const isF = inst.group === "futures";
  const a = [
    L("Signals are computed on bar close; orders fill at the <b>next bar's open</b>. No intrabar stops.", "信号在 K 线收盘时计算，订单在<b>下一根 K 线开盘</b>成交；不含盘中止损。"),
    L(`Costs: ${c.commissionBps} bps commission + ${c.slippageBps} bps slippage on traded notional${isF ? ", charged twice on every roll while a position is open" : ""}.`,
      `成本：成交名义金额的 ${c.commissionBps} bp 手续费 + ${c.slippageBps} bp 滑点${isF ? "；持仓期间每次换月按两次成交收取" : ""}。`),
    c.sizing === "fixed" ? L(`Position notional = ${c.leverage}× equity, re-sized only when off by more than 25%.`, `持仓名义价值 = ${c.leverage} 倍权益，偏离超过 25% 才调整。`)
      : L(`Volatility targeting: notional = ${(c.targetVol * 100).toFixed(0)}% ÷ realized vol(20), capped at ${c.maxLeverage}×.`, `波动率目标：名义价值 = ${(c.targetVol * 100).toFixed(0)}% ÷ 20 期已实现波动率，上限 ${c.maxLeverage} 倍。`),
    L("Benchmark: buy-and-hold on the same series, 1× notional, no costs.", "基准：同一序列买入持有，1 倍名义、无成本。"),
    L("Sharpe uses a zero risk-free rate; annualization from the observed bars per year.", "夏普比率按无风险利率为 0 计算，年化按每年实际 K 线数。"),
  ];
  if (isF) {
    a.push(L(`Futures: whole lots of ${inst.multiplier} ${inst.unit}; initial margin ${(c.marginRate * 100).toFixed(0)}% caps the position at each fill.`, `期货：每手 ${inst.multiplier} ${inst.unit}，按整数手交易；每次成交时以 ${(c.marginRate * 100).toFixed(0)}% 保证金率限制仓位上限。`));
    a.push(L("Prices are back-adjusted by the ratio at each roll, so returns equal holding and rolling the dominant contract; P&L is scaled to the raw contract price.", "价格在每次换月按比例复权，收益等于持有并滚动主力合约；盈亏按合约原始价格计算。"));
    a.push(L("Exchange price limits, holidays and night-session liquidity are not modelled.", "未模拟涨跌停、节假日和夜盘流动性。"));
  } else {
    a.push(L("Crypto: spot prices (Coinbase). Shorts, if enabled, ignore borrow / funding costs.", "加密货币：Coinbase 现货价格。若开启做空，不计借币/资金费率成本。"));
  }
  return a;
}
