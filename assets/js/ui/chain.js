import { computeChain, CHAIN_METRICS } from "../core/chain.js";
import { REGIMES } from "../core/analytics.js";
import { isNum } from "../core/indicators.js";
import { makeChart, lineData, theme, setRange } from "./charts.js";
import { esc, fmtNum, fmtPct, signed, meter } from "./format.js";
import { L, instName } from "./i18n.js";

export async function renderChain(ctx) {
  const { meta, view, getDaily } = ctx;
  const fut = meta.instruments.filter((i) => i.group === "futures");
  const sets = Object.fromEntries(await Promise.all(fut.map(async (i) => [i.symbol, await getDaily(i.symbol)])));
  const chain = computeChain(Object.fromEntries(Object.entries(sets).map(([k, v]) => [k, v.bars])));
  const charts = [];

  view.innerHTML = `
    <div class="page-head"><div>
      <div class="eyebrow">${L("Industry chain", "产业链分析")}</div>
      <h1>${L("Black-series chain: who is making money?", "黑色产业链：利润在谁手里？")}</h1>
      <p>${L(`Steel is made from iron ore and coke; coke is made from coking coal. Spreads between the legs on the futures
        curve show where margin sits along the chain — and margins mean-revert, because producers respond by cutting or
        restarting output. All values use raw dominant-contract closes and are <b>gross</b> of conversion costs.`,
        `钢材由铁矿石和焦炭冶炼，焦炭由焦煤炼制。期货盘面上各环节之间的价差，反映利润在产业链上的分布；
        而利润具有均值回归特征，因为生产企业会随之减产或复产。以下数值基于各品种主力合约原始收盘价，为扣除加工成本<b>前</b>的毛利。`)}</p>
    </div></div>
    <div class="card" style="margin-bottom:16px">
      <div class="card-head"><h3>${L("Chain map", "产业链图")}</h3><span class="sub">${L("node colour = capital-flow regime · % = 5-day price change", "节点颜色 = 资金流状态 · 百分比 = 5 日涨跌")}</span></div>
      <div class="card-body">${chainDiagram(sets)}</div>
    </div>
    <div class="chain-grid">
      ${CHAIN_METRICS.map((m) => card(m, chain.series[m.id])).join("")}
    </div>
    <p class="note" style="margin-top:14px">${L(`Coefficients are industry rules of thumb: 1.6 t iron ore + 0.5 t coke per tonne of hot metal, 1.33 t coking coal
      per tonne of coke. Conversion costs (≈700–900 CNY/t for long steel, ≈200–300 CNY/t for coking) are not deducted.
      Different products' dominant contracts can sit on different delivery months.`,
      `系数为行业经验值：每吨铁水约耗 1.6 吨铁矿石 + 0.5 吨焦炭，每吨焦炭约耗 1.33 吨焦煤。未扣除加工成本（长材约 700–900 元/吨，焦化约 200–300 元/吨）。
      不同品种的主力合约可能对应不同交割月份。`)}</p>`;

  const th = theme();
  for (const m of CHAIN_METRICS) {
    const el = view.querySelector(`#ch-${m.id}`);
    const s = chain.series[m.id];
    const c = makeChart(el, { height: 170, showTime: true });
    const ser = c.addLineSeries({ color: th.accent, lineWidth: 1.5, priceLineVisible: false,
      priceFormat: m.unit === "×" ? { type: "price", precision: 2, minMove: 0.01 } : { type: "price", precision: 0, minMove: 1 } });
    ser.setData(lineData(chain.dates, s.values));
    ser.createPriceLine({ price: s.max1y, color: th.ink3, lineWidth: 1, lineStyle: 2, axisLabelVisible: false, title: L("1y high", "一年高") });
    ser.createPriceLine({ price: s.min1y, color: th.ink3, lineWidth: 1, lineStyle: 2, axisLabelVisible: false, title: L("1y low", "一年低") });
    if (m.unit !== "×") ser.createPriceLine({ price: 0, color: th.down, lineWidth: 1, lineStyle: 0, axisLabelVisible: false });
    setRange(c, chain.dates.length, 750);
    charts.push(c);
  }
  return () => charts.forEach((c) => c.remove());
}

function card(m, s) {
  const val = m.unit === "×" ? fmtNum(s.last, 2) : fmtNum(s.last, 0);
  const chg = m.unit === "×" ? fmtNum(s.chg20, 2) : fmtNum(s.chg20, 0);
  const read = s.pctNow >= 85 ? L("near a 1-year high", "接近一年高位") : s.pctNow <= 15 ? L("near a 1-year low", "接近一年低位") : L("mid-range", "处于区间中部");
  return `<div class="card chain-card">
    <div class="card-head"><h3>${L(m.en, m.zh)} <span class="muted" style="font-weight:400">· ${L(m.zh, m.en)}</span></h3>
      <span class="formula">${esc(m.formula)}</span></div>
    <div class="card-body">
      <div style="display:flex;align-items:baseline;gap:10px"><span class="big">${val}</span><span class="muted">${m.unit === "×" ? "" : L("CNY/t", "元/吨")}</span>
        <span class="pill ${s.pctNow >= 85 ? "t-hot" : s.pctNow <= 15 ? "t-cool" : ""}">${read}</span></div>
      <div class="stats">
        <div><span>${L("1y pct", "一年分位")}</span><span>${isNum(s.pctNow) ? s.pctNow.toFixed(0) : "—"}</span></div>
        <div><span>${L("z-score 1y", "一年 Z 值")}</span><span>${fmtNum(s.z1y, 2)}</span></div>
        <div><span>${L("20D chg", "20日变化")}</span><span>${signed(s.chg20, chg)}</span></div>
        <div><span>${L("since 2019 pct", "2019以来分位")}</span><span>${isNum(s.pctAllNow) ? s.pctAllNow.toFixed(0) : "—"}</span></div>
      </div>
      ${meter(s.pctNow, "vol")}
      <p>${L(m.en_help, m.zh_help)}</p>
    </div>
    <div id="ch-${m.id}" style="border-top:1px solid var(--line)"></div>
  </div>`;
}

function chainDiagram(sets) {
  const node = (sym, x, y) => {
    const s = sets[sym]?.snap;
    if (!s) return "";
    const rg = REGIMES[s.regime] || REGIMES.neutral;
    const col = rg.tone.startsWith("up") ? "var(--up)" : rg.tone.startsWith("down") ? "var(--down)" : "var(--ink-3)";
    const solid = !rg.tone.endsWith("weak") && rg.tone !== "flat";
    const inst = sets[sym].bars.inst;
    return `<g data-goto="${sym}" style="cursor:pointer" onclick="location.hash='#/i/${sym}'">
      <title>${sym} · ${L(rg.label, rg.zh)}</title>
      <rect x="${x - 62}" y="${y - 26}" width="124" height="52" rx="9" fill="${solid ? `color-mix(in srgb, ${col} 16%, var(--surface))` : "var(--surface)"}" stroke="${col}" stroke-width="1.4"/>
      <text x="${x}" y="${y - 6}" text-anchor="middle" font-size="12.5" font-weight="650" fill="var(--ink)" font-family="var(--mono)">${sym} ${esc(instName(inst))}</text>
      <text x="${x}" y="${y + 13}" text-anchor="middle" font-size="11.5" fill="${s.ret5 >= 0 ? "var(--up)" : "var(--down)"}" font-family="var(--mono)">${fmtPct(s.ret5, 1)} · ${L(rg.short, rg.zh_short)}</text>
    </g>`;
  };
  const arrow = (x1, y1, x2, y2, label = "") => `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="var(--line-2)" stroke-width="1.5" marker-end="url(#ah)"/>`
    + (label ? `<text x="${(x1 + x2) / 2}" y="${(y1 + y2) / 2 - 6}" text-anchor="middle" font-size="10" fill="var(--ink-3)" font-family="var(--mono)">${label}</text>` : "");
  return `<svg class="flowdiag" viewBox="0 0 860 260" role="img" aria-label="${L("Black-series industry chain", "黑色产业链")}">
    <defs><marker id="ah" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="var(--line-2)"/></marker></defs>
    ${arrow(134, 50, 236, 50, "×1.33")}
    ${arrow(340, 66, 478, 116, "×0.5")}
    ${arrow(134, 130, 470, 130, "×1.6")}
    ${arrow(240, 190, 490, 150)}
    ${arrow(400, 190, 505, 152)}
    ${arrow(598, 120, 718, 82)}
    ${arrow(598, 140, 718, 178)}
    ${node("JM", 70, 50)}${node("J", 300, 50)}${node("I", 70, 130)}
    ${node("SF", 200, 220)}${node("SM", 360, 220)}
    <g><rect x="472" y="104" width="124" height="52" rx="26" fill="var(--surface-2)" stroke="var(--line-2)"/>
      <text x="534" y="126" text-anchor="middle" font-size="12" font-weight="650" fill="var(--ink)">${L("Blast furnace", "高炉炼钢")}</text>
      <text x="534" y="143" text-anchor="middle" font-size="10.5" fill="var(--ink-3)">${L("iron → steel", "铁水 → 钢材")}</text></g>
    ${node("RB", 782, 80)}${node("HC", 782, 180)}
  </svg>`;
}
