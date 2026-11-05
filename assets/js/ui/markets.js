import { REGIMES, volRegime, attentionLabel } from "../core/analytics.js";
import { oiScan } from "../core/structure.js";
import { computeChain, CHAIN_METRICS } from "../core/chain.js";
import { isNum } from "../core/indicators.js";
import { esc, fmtPrice, fmtPct, fmtBig, signed, sparkline, meter, fmtNum } from "./format.js";
import { marketOpen } from "./live.js";
import { L, getLang, instName, instSub } from "./i18n.js";

const rgLabel = (rg) => L(rg.label, rg.zh);
const rgHelp = (rg) => L(rg.help, rg.zh_help);

export async function renderMarkets(ctx) {
  const { meta, view, getDaily, live } = ctx;
  const rows = await Promise.all(meta.instruments.map(async (inst) => ({ inst, ...(await getDaily(inst.symbol)) })));
  const groups = Object.entries(meta.groups);
  const fut = rows.filter((r) => r.inst.group === "futures");
  const scans = fut.map((r) => ({ inst: r.inst, ...oiScan(r.bars) }));
  const chain = computeChain(Object.fromEntries(fut.map((r) => [r.inst.symbol, r.bars])));

  view.innerHTML = `
    <div class="page-head">
      <div>
        <div class="eyebrow">${L("Market structure monitor", "市场结构监控")}</div>
        <h1>${L("Black series &amp; crypto", "黑色系 &amp; 加密货币")}</h1>
        <p>${L(`Every instrument is scored on three axes — <b>attention</b> (is the market looking?),
          <b>volatility</b> (how hard is it moving, versus its own past year?) and <b>capital flow</b>
          (is new money opening positions, or old money leaving?).`,
          `每个品种从三个维度打分：<b>关注度</b>（市场在不在看它？）、<b>波动率</b>（相对自身过去一年动得有多剧烈？）
          和<b>资金流动</b>（是新资金在开仓，还是老资金在离场？）。`)}</p>
      </div>
    </div>
    <div class="markets-grid">
      <div>
        ${briefCard(rows, scans, chain)}
        ${groups.map(([key, g]) => groupCard(key, g, rows.filter((r) => r.inst.group === key))).join("")}
        ${scanCard(scans)}
      </div>
      <aside>
        <div class="card map-card">
          <div class="card-head"><h3>${L("Market map", "市场地图")}</h3><span class="sub">${L("attention × volatility, coloured by flow", "关注度 × 波动率，颜色表示资金流")}</span></div>
          <div class="card-body">${marketMap(rows)}</div>
          <div class="legend">
            <span><i style="background:var(--up)"></i>${L("new money in, price up", "增仓上涨")}</span>
            <span><i style="background:var(--down)"></i>${L("new money in, price down", "增仓下跌")}</span>
            <span><i style="border:1.5px solid var(--ink-3)"></i>${L("positions closing", "减仓")}</span>
          </div>
        </div>
        <div class="card" style="margin-top:16px">
          <div class="card-head"><h3>${L("How to read the board", "看板说明")}</h3></div>
          <dl class="explain">
            <dt>${L("Volatility", "波动率")}</dt><dd>${L(`20-day realized volatility (annualized) and its percentile within the past year.
              Regimes: calm &lt;20th, normal, elevated &gt;60th, stressed &gt;85th.`,
              `20 日已实现波动率（年化）及其在过去一年中的分位。分档：平静 &lt;20、正常、偏高 &gt;60、剧烈 &gt;85。`)}</dd>
            <dt>${L("Attention", "关注度")}</dt><dd>${L(`0–100 percentile score. Futures: all-contract volume and volume/open-interest turnover.
              Crypto: USD volume and Wikipedia pageviews.`,
              `0–100 的分位得分。期货：全合约成交量与换手率（成交/持仓）；加密货币：美元成交额与维基百科浏览量。`)}</dd>
            <dt>${L("Capital flow", "资金流动")}</dt><dd>${L(`Futures: 5-day change in all-contract open interest against price — the four
              build-up / covering / liquidation quadrants. Crypto: Chaikin money flow and perp funding.`,
              `期货：5 日全合约持仓变化与价格方向的组合，分为多头增仓、空头增仓、空头回补、多头平仓四个象限。
              加密货币：Chaikin 资金流与永续资金费率。`)}</dd>
          </dl>
        </div>
      </aside>
    </div>`;

  view.querySelectorAll("tr[data-sym], [data-goto]").forEach((el) => {
    el.addEventListener("click", () => { location.hash = `#/i/${el.dataset.sym || el.dataset.goto}`; });
  });
  view.querySelectorAll("tr[data-sym]").forEach((el) => {
    el.tabIndex = 0;
    el.addEventListener("keydown", (e) => { if (e.key === "Enter") location.hash = `#/i/${el.dataset.sym}`; });
  });

  const paintQuote = (sym, q) => {
    const tr = view.querySelector(`tr[data-sym="${sym}"]:not(.scan)`);
    if (!tr || !q) return;
    const inst = meta.instruments.find((i) => i.symbol === sym);
    const px = tr.querySelector(".px");
    const prev = px.dataset.v ? +px.dataset.v : null;
    px.textContent = fmtPrice(q.price, inst);
    px.dataset.v = q.price;
    if (prev !== null && q.price !== prev) {
      px.classList.remove("flash-up", "flash-down");
      void px.offsetWidth;
      px.classList.add(q.price > prev ? "flash-up" : "flash-down");
    }
    tr.querySelector(".chg1").innerHTML = signed(q.chg);
    tr.querySelector(".src").textContent = q.source ? q.source : L("last close", "最近收盘");
  };
  meta.instruments.forEach((i) => paintQuote(i.symbol, live.get(i.symbol)));
  const paintStatus = () => {
    for (const [key] of groups) {
      const chip = view.querySelector(`[data-status="${key}"]`);
      if (!chip) continue;
      const open = key === "crypto" ? true : meta.groups[key].symbols.some((s) => marketOpen(s));
      const st = live.status[key];
      chip.className = `chip ${!open ? "closed" : st === "live" ? "live" : "delayed"}`;
      chip.lastElementChild.textContent = !open ? L("Market closed · last close", "休市 · 最近收盘")
        : st === "live" ? L("Live", "实时") : L("Delayed", "延迟");
    }
  };
  paintStatus();
  const unsub = live.subscribe((sym, q) => { paintQuote(sym, q); paintStatus(); });
  const t = setInterval(paintStatus, 30000);
  return () => { unsub(); clearInterval(t); };
}

// ------------------------------------------------------------------ brief
function briefCard(rows, scans, chain) {
  const fut = rows.filter((r) => r.inst.group === "futures");
  const cry = rows.filter((r) => r.inst.group === "crypto");
  const items = [];
  const nm = (r) => `<b>${r.inst.symbol}</b> ${esc(instName(r.inst))}`;

  // 1. flow breadth in the black chain
  const counts = {};
  fut.forEach((r) => { counts[r.snap.regime] = (counts[r.snap.regime] || 0) + 1; });
  const top = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  if (top) {
    const rg = REGIMES[top[0]] || REGIMES.neutral;
    const who = fut.filter((r) => r.snap.regime === top[0]).map((r) => r.inst.symbol).join(", ");
    items.push(L(`Black chain flow: <b>${top[1]} of ${fut.length}</b> products in <span class="pill t-${rg.tone}">${rg.label}</span> (${who}).`,
      `黑色链资金面：<b>${fut.length} 个品种中 ${top[1]} 个</b>处于<span class="pill t-${rg.tone}">${rg.zh}</span>（${who}）。`));
  }
  // 2. volatility extremes
  const byVol = rows.filter((r) => isNum(r.snap.rvPct)).sort((a, b) => b.snap.rvPct - a.snap.rvPct);
  if (byVol.length) {
    const hi = byVol[0], lo = byVol[byVol.length - 1];
    items.push(L(`Volatility: ${nm(hi)} is the most stretched at the <b>${hi.snap.rvPct.toFixed(0)}th</b> percentile (${fmtPct(hi.snap.rv, 0, false)} ann.); ${nm(lo)} is the calmest (${lo.snap.rvPct.toFixed(0)}th).`,
      `波动率：${nm(hi)} 处于过去一年的 <b>${hi.snap.rvPct.toFixed(0)}</b> 分位（年化 ${fmtPct(hi.snap.rv, 0, false)}），为全场最高；${nm(lo)} 最平静（${lo.snap.rvPct.toFixed(0)} 分位）。`));
  }
  // 3. attention
  const byAtt = rows.filter((r) => isNum(r.snap.attention)).sort((a, b) => b.snap.attention - a.snap.attention);
  if (byAtt.length) {
    const a = byAtt[0];
    items.push(L(`Attention is highest on ${nm(a)} (score <b>${a.snap.attention.toFixed(0)}</b>, relative volume ${fmtNum(a.snap.rvol, 2)}×).`,
      `关注度最高的是 ${nm(a)}（得分 <b>${a.snap.attention.toFixed(0)}</b>，相对成交量 ${fmtNum(a.snap.rvol, 2)}×）。`));
  }
  // 4. chain margins at extremes
  const extremes = CHAIN_METRICS.map((m) => ({ m, s: chain.series[m.id] }))
    .filter(({ s }) => isNum(s.pctNow) && (s.pctNow >= 85 || s.pctNow <= 15))
    .sort((a, b) => Math.abs(b.s.pctNow - 50) - Math.abs(a.s.pctNow - 50)).slice(0, 2);
  extremes.forEach(({ m, s }) => {
    const hiSide = s.pctNow >= 85;
    const val = m.unit === "×" ? s.last.toFixed(2) : fmtNum(s.last, 0);
    items.push(L(`Industry chain: <a href="#/chain">${m.en}</a> at ${val} is near a 1-year <b>${hiSide ? "high" : "low"}</b> (${s.pctNow.toFixed(0)}th pct).`,
      `产业链：<a href="#/chain">${m.zh}</a> 为 ${val}，接近一年<b>${hiSide ? "高位" : "低位"}</b>（${s.pctNow.toFixed(0)} 分位）。`));
  });
  // 5. OI scanner
  const flagged = scans.filter((s) => s.status !== "normal");
  if (flagged.length) {
    items.push(L(`Open interest near a record: ${flagged.map((s) => `<b>${s.inst.symbol}</b> ${(s.ratio * 100).toFixed(0)}% of peak`).join(", ")} — heavy positioning, watch for a squeeze.`,
      `持仓接近历史峰值：${flagged.map((s) => `<b>${s.inst.symbol}</b> 达峰值的 ${(s.ratio * 100).toFixed(0)}%`).join("，")}——仓位拥挤，警惕挤仓。`));
  }
  // 6. crypto funding
  const btc = cry.find((r) => r.inst.symbol === "BTC");
  if (btc && isNum(btc.snap.fundAnn)) {
    const crowd = btc.snap.fundPct > 85 ? L("longs are crowded", "多头拥挤") : btc.snap.fundPct < 15 ? L("shorts are crowded", "空头拥挤") : L("positioning is balanced", "多空较均衡");
    items.push(L(`Crypto: BTC is in ${(REGIMES[btc.snap.regime] || REGIMES.neutral).label.toLowerCase()}; perp funding ${fmtPct(btc.snap.fundAnn, 1)} annualized — ${crowd}.`,
      `加密货币：BTC 处于「${(REGIMES[btc.snap.regime] || REGIMES.neutral).zh}」；永续资金费率年化 ${fmtPct(btc.snap.fundAnn, 1)}，${crowd}。`));
  }
  const asOf = rows.find((r) => r.inst.group === "futures")?.bars.dates.at(-1) || "";
  return `<section class="card brief" style="margin-bottom:22px">
    <div class="card-head"><h2>${L("Today's brief", "今日简报")}</h2><span class="sub">${L("generated from the data · futures as of", "由数据自动生成 · 期货截至")} ${asOf}</span></div>
    <ul class="brief-list">${items.map((x) => `<li>${x}</li>`).join("")}</ul>
  </section>`;
}

// ------------------------------------------------------------------ tables
function groupCard(key, g, rows) {
  const exch = [...new Set(rows.map((r) => r.inst.exchange))].join(" · ");
  const label = key === "futures" ? L(g.label, "黑色系期货") : L(g.label, "加密货币");
  return `
  <section class="card group">
    <div class="group-head">
      <h2>${esc(label)}</h2><span class="sub">${esc(exch)} · ${g.currency}</span>
      <span class="chip" data-status="${key}"><span class="dot"></span><span>…</span></span>
    </div>
    <div class="tbl-wrap"><table class="mkt">
      <thead><tr>
        <th>${L("Instrument", "品种")}</th><th class="r">${L("Last", "最新")}</th><th class="r">5D</th>
        <th>${L("Volatility", "波动率")}</th><th>${L("Attention", "关注度")}</th><th>${L("Capital flow", "资金流动")}</th><th>60D</th>
      </tr></thead>
      <tbody>${rows.map(row).join("")}</tbody>
    </table></div>
  </section>`;
}

function row({ inst, bars, snap: s }) {
  const vr = volRegime(s.rvPct);
  const rg = REGIMES[s.regime] || REGIMES.neutral;
  let flowLine;
  if (inst.group === "futures") {
    flowLine = `${L("OI 5D", "持仓5日")} ${signed(s.dOI5Pct, fmtPct(s.dOI5Pct, 1))} · ${signed(s.flowValue, fmtBig(s.flowValue, "¥"))}`;
  } else {
    flowLine = `CMF ${signed(s.cmf, fmtNum(s.cmf, 2))}${isNum(s.fundAnn) ? ` · ${L("fund", "费率")} ${signed(s.fundAnn, fmtPct(s.fundAnn, 1))}` : ""}`;
  }
  const n = bars.n;
  return `<tr data-sym="${inst.symbol}" title="${esc(rgHelp(rg))}">
    <td><div class="sym"><b>${inst.symbol}</b><span>${esc(instSub(inst))}</span></div></td>
    <td class="r"><div class="px" data-v="">${fmtPrice(s.raw, inst)}</div>
      <div class="chg1 num" style="font-size:12px">${signed(s.ret1)}</div><div class="src">${L("last close", "最近收盘")}</div></td>
    <td class="r num">${signed(s.ret5)}</td>
    <td><div class="cell-stack">
      <div class="row"><span class="num">${fmtPct(s.rv, 0, false)}</span><span class="pill t-${vr.tone}">${L(vr.label, vr.zh)}</span></div>
      ${meter(s.rvPct, "vol")}
      <div class="row muted"><span>${L("pct", "分位")}</span><span class="num">${isNum(s.rvPct) ? s.rvPct.toFixed(0) : "—"}</span></div>
    </div></td>
    <td><div class="cell-stack">
      <div class="row"><span class="num">${isNum(s.attention) ? s.attention.toFixed(0) : "—"}</span><span class="muted">${attentionLabel(s.attention, getLang())}</span></div>
      ${meter(s.attention, "att")}
      <div class="row muted"><span>${L("rel. vol", "相对量")}</span><span class="num">${isNum(s.rvol) ? s.rvol.toFixed(2) + "×" : "—"}</span></div>
    </div></td>
    <td><div class="cell-stack" style="min-width:170px">
      <div><span class="pill t-${rg.tone}">${rgLabel(rg)}</span></div>
      <div class="num" style="font-size:12px">${flowLine}</div>
    </div></td>
    <td>${sparkline(bars.c.slice(n - 60), { w: 110, h: 30 })}</td>
  </tr>`;
}

function scanCard(scans) {
  const st = (s) => s.status === "new_high" ? `<span class="pill t-hot">${L("New high", "创历史新高")}</span>`
    : s.status === "near_high" ? `<span class="pill t-warm">${L("≥ 90% of peak", "接近峰值")}</span>`
    : `<span class="pill">${L("Normal", "正常")}</span>`;
  const sorted = scans.slice().sort((a, b) => b.ratio - a.ratio);
  return `<section class="card group">
    <div class="group-head"><h2>${L("Open-interest scanner", "持仓量异动扫描")}</h2>
      <span class="sub">${L("all-contract OI vs its peak since mid-2019 · flags ≥ 90% of peak or a new high",
        "全合约持仓 vs 2019 年以来峰值 · 达到峰值 90% 或创新高时提示")}</span></div>
    <div class="tbl-wrap"><table class="mkt">
      <thead><tr><th>${L("Product", "品种")}</th><th class="r">${L("Open interest", "当前持仓")}</th><th class="r">${L("Notional", "持仓市值")}</th>
        <th class="r">${L("Peak", "历史峰值")}</th><th>${L("Peak date", "峰值日期")}</th><th style="min-width:140px">${L("OI / peak", "持仓/峰值")}</th>
        <th class="r">${L("20D chg", "20日变化")}</th><th>${L("Status", "状态")}</th></tr></thead>
      <tbody>${sorted.map((s) => `<tr class="scan" data-sym="${s.inst.symbol}">
        <td><div class="sym"><b>${s.inst.symbol}</b><span>${esc(instSub(s.inst))}</span></div></td>
        <td class="r num">${fmtNum(s.cur, 0)}</td><td class="r num">${fmtBig(s.notional, "¥")}</td>
        <td class="r num">${fmtNum(s.peak, 0)}</td><td class="num">${s.peakDate}</td>
        <td><div class="cell-stack"><div class="row"><span class="num">${(s.ratio * 100).toFixed(0)}%</span></div>${meter(s.ratio * 100, "vol")}</div></td>
        <td class="r num">${signed(s.chg20)}</td><td>${st(s)}</td></tr>`).join("")}</tbody>
    </table></div>
    <p class="note" style="padding:0 16px 14px">${L("Notional = OI × price × contract multiplier, as reported by each exchange. A record build-up of open interest means heavy, possibly crowded positioning — the fuel for sharp moves when one side is forced out.",
      "持仓市值 = 持仓量 × 价格 × 合约乘数（按各交易所口径）。持仓量创纪录意味着仓位沉重、可能拥挤，一方被迫离场时容易引发剧烈行情。")}</p>
  </section>`;
}

function marketMap(rows) {
  const W = 330, H = 290, P = { l: 34, r: 12, t: 12, b: 30 };
  const x = (v) => P.l + (v / 100) * (W - P.l - P.r);
  const y = (v) => H - P.b - (v / 100) * (H - P.t - P.b);
  const tone = (rg) => (REGIMES[rg] || REGIMES.neutral).tone;
  let g = "";
  g += `<rect x="${P.l}" y="${P.t}" width="${W - P.l - P.r}" height="${H - P.t - P.b}" fill="none" stroke="var(--line)"/>`;
  g += `<line x1="${x(50)}" x2="${x(50)}" y1="${P.t}" y2="${H - P.b}" stroke="var(--line)" stroke-dasharray="3 3"/>`;
  g += `<line x1="${P.l}" x2="${W - P.r}" y1="${y(50)}" y2="${y(50)}" stroke="var(--line)" stroke-dasharray="3 3"/>`;
  const ql = (tx, ty, s, anchor) => `<text x="${tx}" y="${ty}" font-size="9.5" fill="var(--ink-3)" text-anchor="${anchor}">${s}</text>`;
  g += ql(P.l + 6, P.t + 14, L("VOLATILE · IGNORED", "高波动 · 冷门"), "start") + ql(W - P.r - 6, P.t + 14, L("CROWDED · VOLATILE", "拥挤 · 高波动"), "end");
  g += ql(P.l + 6, H - P.b - 8, L("QUIET", "冷清"), "start") + ql(W - P.r - 6, H - P.b - 8, L("CROWDED · CALM", "拥挤 · 平静"), "end");
  g += `<text x="${(P.l + W - P.r) / 2}" y="${H - 6}" font-size="10" fill="var(--ink-3)" text-anchor="middle">${L("attention →", "关注度 →")}</text>`;
  g += `<text x="10" y="${(P.t + H - P.b) / 2}" font-size="10" fill="var(--ink-3)" text-anchor="middle" transform="rotate(-90 10 ${(P.t + H - P.b) / 2})">${L("volatility pct →", "波动率分位 →")}</text>`;
  // simple label collision avoidance: flip label to the left if it would overlap an earlier one
  const placed = [];
  const pts = rows.filter(({ snap: s }) => isNum(s.attention) && isNum(s.rvPct))
    .map(({ inst, snap: s }) => ({ inst, s, cx: x(s.attention), cy: y(s.rvPct) }))
    .sort((a, b) => a.cy - b.cy);
  for (const { inst, s, cx, cy } of pts) {
    const t = tone(s.regime);
    const color = t.startsWith("up") ? "var(--up)" : t.startsWith("down") ? "var(--down)" : "var(--ink-3)";
    const solid = !t.endsWith("weak") && t !== "flat";
    const w = inst.symbol.length * 7 + 4;
    let lx = cx + 9, anchor = "start";
    const hit = (bx) => placed.some((p) => Math.abs(p.y - cy) < 11 && bx < p.x + p.w && bx + w > p.x);
    if (hit(lx) || lx + w > W - P.r) { lx = cx - 9; anchor = "end"; }
    placed.push({ x: anchor === "start" ? lx : lx - w, y: cy, w });
    placed.push({ x: cx - 6, y: cy, w: 12 });
    const shape = inst.group === "crypto"
      ? `<rect x="${cx - 5}" y="${cy - 5}" width="10" height="10" transform="rotate(45 ${cx} ${cy})"`
      : `<circle cx="${cx}" cy="${cy}" r="6"`;
    const rg = REGIMES[s.regime] || REGIMES.neutral;
    g += `<g data-goto="${inst.symbol}" style="cursor:pointer"><title>${inst.symbol}: ${L("attention", "关注度")} ${s.attention.toFixed(0)}, ${L("vol pct", "波动率分位")} ${s.rvPct.toFixed(0)}, ${rgLabel(rg)}</title>`
      + `${shape} fill="${solid ? color : "var(--surface)"}" stroke="${color}" stroke-width="1.6"/>`
      + `<text x="${lx}" y="${cy + 4}" font-size="11" font-weight="600" fill="var(--ink)" text-anchor="${anchor}">${inst.symbol}</text></g>`;
  }
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${L("Scatter of attention versus volatility percentile", "关注度与波动率分位散点图")}">${g}</svg>`;
}
