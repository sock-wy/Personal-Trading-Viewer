import { loadBars } from "../core/data.js";
import { computeFeatures, snapshot, REGIMES, volRegime, attentionLabel } from "../core/analytics.js";
import { priceProfile, positioningCost } from "../core/structure.js";
import { isNum } from "../core/indicators.js";
import { makeChart, syncCharts, lineData, candleData, rgba, theme, setRange } from "./charts.js";
import { esc, fmtPrice, fmtPct, fmtBig, signed, fmtNum, meter } from "./format.js";
import { marketOpen } from "./live.js";
import { L, getLang, instName, instSub } from "./i18n.js";

const RANGES = { "1d": [["6M", 126], ["1Y", 250], ["3Y", 750], ["All", 0]], "1h": [["1M", 140], ["3M", 420], ["1Y", 1700], ["All", 0]] };
const two = (pair) => (Array.isArray(pair) ? L(pair[0], pair[1]) : pair);

export async function renderInstrument(ctx, sym, params) {
  const { meta, view, live } = ctx;
  const inst = meta.instruments.find((i) => i.symbol === sym);
  if (!inst) throw new Error(`Unknown instrument ${sym}`);
  const isF = inst.group === "futures";
  let freq = params.get("f") === "1h" ? "1h" : "1d";
  let charts = [];
  let unsub = null;
  let profLines = [];
  const prof = { days: 60, mode: "volume" };
  const cost = { on: true, halfLife: 25 };

  const draw = async () => {
    charts.forEach((c) => c.remove());
    charts = [];
    const bars = await loadBars(sym, freq);
    const f = freq === "1d" ? (await ctx.getDaily(sym)).f : computeFeatures(bars);
    const s = snapshot(bars, f);
    const hourly = await loadBars(sym, "1h");
    paint(bars, f, s, hourly);
  };

  const paint = (bars, f, s, hourly) => {
    const rg = REGIMES[s.regime] || REGIMES.neutral;
    const vr = volRegime(s.rvPct);
    const q = live.get(sym);
    const tz = isF ? L("Beijing time", "北京时间") : "UTC";
    const pct = (x) => (isNum(x) ? x.toFixed(0) : "—");
    view.innerHTML = `
      <div class="inst-head">
        <div class="inst-title">
          <div class="eyebrow">${esc(inst.exchange)} · ${isF ? L("dominant ", "主力 ") + esc(inst.dominant) : esc(inst.product)}</div>
          <div class="sym-big">${sym}</div>
          <div class="names">${esc(instSub(inst))}</div>
        </div>
        <div class="inst-quote">
          <div><span class="big" id="q-px">${fmtPrice(q?.price ?? s.raw, inst)}</span><span class="chg" id="q-chg">${signed(q?.chg)}</span></div>
          <div class="meta" id="q-meta">${quoteMeta(q, inst)}</div>
        </div>
        <div class="inst-actions">
          <div class="seg" id="freq">${["1d", "1h"].map((x) => `<button data-f="${x}" class="${x === freq ? "on" : ""}">${x === "1d" ? L("Daily", "日线") : L("Hourly", "小时线")}</button>`).join("")}</div>
          <a class="btn primary" href="#/backtest?sym=${sym}&f=${freq}">${L(`Backtest ${sym} →`, `回测 ${sym} →`)}</a>
        </div>
      </div>

      <div class="kpis">
        ${kpiCard(L("Volatility", "波动率"), `<b>${fmtPct(s.rv, 1, false)}</b><span class="pill t-${vr.tone}">${L(vr.label, vr.zh)}</span>`, meter(s.rvPct, "vol"), [
          [L("Percentile (1y)", "一年分位"), pct(s.rvPct)],
          [L("Parkinson (H/L)", "Parkinson（高低价）"), fmtPct(s.pk, 1, false)],
          [L("ATR(14) / price", "ATR(14) / 价格"), fmtPct(s.atrPct, 2, false)],
        ])}
        ${kpiCard(L("Attention", "关注度"), `<b>${pct(s.attention)}</b><span class="muted">${attentionLabel(s.attention, getLang())}</span>`, meter(s.attention, "att"), [
          [two(f.activityLabel) + L(" pct", " 分位"), pct(s.actPct)],
          [(f.secondLabel ? two(f.secondLabel) : L("Second signal", "第二信号")) + L(" pct", " 分位"), isNum(s.secPct) ? s.secPct.toFixed(0) : "n/a"],
          [L("Relative volume (vs 20)", "相对成交量（vs 20）"), isNum(s.rvol) ? s.rvol.toFixed(2) + "×" : "—"],
        ])}
        ${kpiCard(L("Capital flow · 5 bars", "资金流动 · 5 根K线"), `<span class="pill t-${rg.tone}" style="font-size:13px">${L(rg.label, rg.zh)}</span>`, "", isF ? [
          [L("Price change", "价格变化"), fmtPct(s.ret5)],
          [freq === "1d" ? L("All-contract OI change", "全合约持仓变化") : L("Dominant OI change", "主力持仓变化"), fmtPct(s.dOI5Pct)],
          [L("Capital committed", "资金增减"), fmtBig(s.flowValue, "¥")],
        ] : [
          [L("Price change", "价格变化"), fmtPct(s.ret5)],
          [L("Chaikin money flow (20)", "Chaikin 资金流 (20)"), fmtNum(s.cmf, 3)],
          [L("Signed $ flow (5)", "净资金流 $ (5)"), fmtBig(s.flowValue, "$")],
        ])}
        ${isF ? kpiCard(L("Positioning", "持仓结构"), `<b>${fmtBig(s.notional, "¥")}</b><span class="muted">${L("notional OI", "持仓市值")}</span>`, meter(s.oiPct, "att"), [
          [L("Open interest", "持仓量"), fmtNum(s.oi, 0)],
          [L("OI percentile (1y)", "持仓一年分位"), pct(s.oiPct)],
          [L("Contract", "合约规格"), `${inst.multiplier} ${inst.unit} · tick ${inst.tick}`],
        ]) : kpiCard(L("Positioning", "持仓结构"), `<b>${fmtPct(s.fundAnn, 1)}</b><span class="muted">${L("perp funding, ann.", "永续资金费率（年化）")}</span>`, meter(s.fundPct, "att"), [
          [L("Funding percentile (1y)", "费率一年分位"), pct(s.fundPct)],
          [L("Source", "来源"), "Hyperliquid perp"],
          [L("Read", "解读"), s.fundPct > 90 ? L("Longs crowded", "多头拥挤") : s.fundPct < 10 ? L("Shorts crowded", "空头拥挤") : L("Balanced", "较均衡")],
        ])}
      </div>

      <div class="card chart-stack">
        <div class="toolbar">
          <div class="seg" id="range">${RANGES[freq].map(([l, n], i) => `<button data-n="${n}" class="${i === 1 ? "on" : ""}">${l}</button>`).join("")}</div>
          <span class="muted" style="font-size:12px">${isF ? L("Back-adjusted continuous (ratio), dominant by open interest", "比例复权连续合约，按持仓量确定主力") : L("Coinbase spot", "Coinbase 现货")} · ${tz}${freq === "1h" ? L(", bar end", "，K线结束时间") : ""}</span>
          <span class="spacer"></span>
          <label style="font-size:12px;color:var(--ink-2)"><input type="checkbox" id="cost-on" ${cost.on ? "checked" : ""}> ${L("Positioning cost", "持仓成本线")}</label>
          <label style="font-size:12px;color:var(--ink-2)">${L("half-life", "半衰期")} <input type="number" id="cost-hl" value="${cost.halfLife}" min="2" max="250" step="1" style="width:56px;font:12px var(--mono);background:var(--bg);color:var(--ink);border:1px solid var(--line-2);border-radius:5px;padding:2px 4px"> ${L("days", "天")}</label>
          ${isF && freq === "1d" ? `<label style="font-size:12px;color:var(--ink-2)"><input type="checkbox" id="show-rolls" checked> ${L("roll markers", "换月标记")}</label>` : ""}
        </div>
        <div class="pane"><div class="pane-label">${L("Price", "价格")} <em>· ${L("volume · cost line (dotted)", "成交量 · 持仓成本线（虚线）")}</em></div><div id="c-price"></div></div>
        <div class="pane"><div class="pane-label">${L("Volatility", "波动率")} <em>· ${L("realized 20 (line) vs Parkinson (dotted), annualized", "20 期已实现（实线）vs Parkinson（点线），年化")}</em></div><div id="c-vol"></div></div>
        <div class="pane"><div class="pane-label">${L("Attention", "关注度")} <em>· ${L("score 0–100", "得分 0–100")}</em></div><div id="c-att"></div></div>
        <div class="pane"><div class="pane-label">${L("Capital flow", "资金流动")} <em>· ${isF ? (freq === "1d" ? L("5-bar change in all-contract OI (bars), OI level (line)", "全合约持仓 5 期变化（柱），持仓量（线）") : L("5-bar change in dominant OI (bars), OI (line)", "主力持仓 5 期变化（柱），持仓量（线）")) : L("Chaikin money flow 20 (bars), funding ann. (line)", "Chaikin 资金流 20（柱），资金费率年化（线）")}</em></div><div id="c-flow"></div></div>
      </div>

      <div class="profile-wrap" style="margin-top:16px">
        <div class="card">
          <div class="card-head"><h3>${L("Market profile", "市场轮廓")}</h3>
            <span class="sub">${L("from hourly bars · POC and 70% value area are drawn on the price chart", "基于小时K线 · POC 与 70% 价值区同步画在价格图上")}</span></div>
          <div class="toolbar" style="border-top:1px solid var(--line)">
            <div class="seg" id="prof-days">${[20, 60, 120].map((d) => `<button data-d="${d}" class="${d === prof.days ? "on" : ""}">${d}${L("D", "日")}</button>`).join("")}</div>
            <div class="seg" id="prof-mode"><button data-m="volume" class="${prof.mode === "volume" ? "on" : ""}">${L("Volume (VP)", "成交量 VP")}</button><button data-m="time" class="${prof.mode === "time" ? "on" : ""}">${L("Time (TPO)", "时间 TPO")}</button></div>
          </div>
          <div class="card-body" id="prof-body"></div>
        </div>
        <div class="card calc">
          <div class="card-head"><h3>${L("Position calculator", "仓位计算器")}</h3><span class="sub">${L("risk-based sizing", "按风险定仓")}</span></div>
          <form class="card-body" id="calc" autocomplete="off">
            <div class="field"><label>${L("Capital", "本金")} (${isF ? "CNY" : "USD"})</label><input name="cap" type="number" value="${isF ? 1000000 : 100000}" min="0" step="1000"></div>
            <div class="field"><label>${L("Risk per trade %", "单笔风险 %")}</label><input name="risk" type="number" value="1" min="0.1" max="10" step="0.1"></div>
            <div class="field"><label>${L("Stop = k × ATR", "止损 = k × ATR")}</label><input name="k" type="number" value="2" min="0.5" max="10" step="0.5"></div>
            ${isF ? `<div class="field"><label>${L("Margin rate", "保证金率")}</label><input name="mr" type="number" value="0.12" min="0.03" max="1" step="0.01"></div>` : ""}
            <div class="calc-out" id="calc-out"></div>
          </form>
        </div>
      </div>

      <div class="reading">${readings(inst, s, f, freq).map((r) => `<div class="card"><div class="card-head"><h3>${r[0]}</h3></div><div class="card-body">${r[1]}</div></div>`).join("")}</div>
    `;

    view.querySelectorAll("#freq button").forEach((b) => b.addEventListener("click", () => {
      freq = b.dataset.f;
      history.replaceState(null, "", `#/i/${sym}?f=${freq}`);
      draw();
    }));

    const { cs, price } = buildCharts(bars, f);

    // positioning cost line
    const th = theme();
    const costSeries = price.addLineSeries({ color: th.warm, lineWidth: 1.5, lineStyle: 2, priceLineVisible: false, lastValueVisible: true, title: L("cost", "成本") });
    const paintCost = () => {
      const perDay = freq === "1d" ? 1 : bars.n / new Set(bars.dates).size;
      costSeries.setData(cost.on ? lineData(bars.time, positioningCost(bars, cost.halfLife * perDay)) : []);
    };
    paintCost();
    view.querySelector("#cost-on").addEventListener("change", (e) => { cost.on = e.target.checked; paintCost(); });
    view.querySelector("#cost-hl").addEventListener("change", (e) => { cost.halfLife = Math.max(2, +e.target.value || 25); paintCost(); });

    // market profile
    const paintProfile = () => {
      const days = [...new Set(hourly.dates)];
      const startDay = days[Math.max(0, days.length - prof.days)];
      const i0 = hourly.dates.indexOf(startDay);
      const p = priceProfile(hourly, i0, hourly.n - 1, { bins: 40, mode: prof.mode });
      view.querySelector("#prof-body").innerHTML = p ? profileSvg(p, inst, hourly.c[hourly.n - 1]) : "";
      profLines.forEach((pl) => cs.removePriceLine(pl));
      profLines = p ? [
        cs.createPriceLine({ price: p.poc, color: th.accent, lineWidth: 1, lineStyle: 0, axisLabelVisible: true, title: "POC" }),
        cs.createPriceLine({ price: p.vah, color: th.ink3, lineWidth: 1, lineStyle: 3, axisLabelVisible: false, title: "VAH" }),
        cs.createPriceLine({ price: p.val, color: th.ink3, lineWidth: 1, lineStyle: 3, axisLabelVisible: false, title: "VAL" }),
      ] : [];
    };
    paintProfile();
    view.querySelectorAll("#prof-days button").forEach((b) => b.addEventListener("click", () => {
      prof.days = +b.dataset.d; view.querySelectorAll("#prof-days button").forEach((x) => x.classList.toggle("on", x === b)); paintProfile();
    }));
    view.querySelectorAll("#prof-mode button").forEach((b) => b.addEventListener("click", () => {
      prof.mode = b.dataset.m; view.querySelectorAll("#prof-mode button").forEach((x) => x.classList.toggle("on", x === b)); paintProfile();
    }));

    // position calculator (raw contract price and ATR in raw terms)
    const calcForm = view.querySelector("#calc");
    const daily = freq === "1d" ? { bars, f } : null;
    const paintCalc = async () => {
      const d = daily || (await ctx.getDaily(sym));
      const n = d.bars.n;
      const rawPx = live.get(sym)?.price || d.bars.rc[n - 1];
      const atrRaw = d.f.atrPct[n - 1] * rawPx;
      const fd = new FormData(calcForm);
      const cap = +fd.get("cap"), risk = +fd.get("risk") / 100, k = +fd.get("k"), mr = isF ? +fd.get("mr") : 1;
      const mult = isF ? inst.multiplier : 1;
      const stop = k * atrRaw;
      const riskPerUnit = stop * mult;
      let qty = riskPerUnit > 0 ? (cap * risk) / riskPerUnit : 0;
      qty = isF ? Math.floor(qty) : qty;
      const notional = qty * rawPx * mult;
      const out = [
        [L("Price", "价格"), fmtPrice(rawPx, inst)],
        [L("ATR(14), daily", "ATR(14)，日线"), fmtPrice(atrRaw, inst)],
        [L("Stop distance", "止损距离"), `${fmtPrice(stop, inst)} (${fmtPct(stop / rawPx, 1, false)})`],
        [L("Risk budget", "风险预算"), fmtBig(cap * risk, isF ? "¥" : "$")],
        [isF ? L("Lots", "手数") : L("Units", "数量"), isF ? `${qty}` : fmtNum(qty, 4)],
        [L("Notional", "名义价值"), fmtBig(notional, isF ? "¥" : "$")],
        [L("Leverage", "杠杆"), `${fmtNum(notional / cap, 2)}×`],
        [isF ? L("Margin used", "占用保证金") : L("Cash used", "占用资金"), `${fmtBig(notional * mr, isF ? "¥" : "$")} (${fmtPct((notional * mr) / cap, 0, false)})`],
      ];
      view.querySelector("#calc-out").innerHTML = out.map(([a, b]) => `<div><span>${a}</span><span>${b}</span></div>`).join("");
    };
    calcForm.addEventListener("input", paintCalc);
    paintCalc();

    const rangeBtns = view.querySelectorAll("#range button");
    const applyRange = (n) => charts.forEach((c) => setRange(c, bars.n, n));
    rangeBtns.forEach((b) => b.addEventListener("click", () => {
      rangeBtns.forEach((x) => x.classList.toggle("on", x === b));
      applyRange(+b.dataset.n);
    }));
    applyRange(RANGES[freq][1][1]);
  };

  const buildCharts = (b, f) => {
    const th = theme();
    const timeVisible = freq === "1h";
    const price = makeChart(view.querySelector("#c-price"), { height: 400, timeVisible, showTime: false });
    const cs = price.addCandlestickSeries({
      upColor: th.up, downColor: th.down, borderUpColor: th.up, borderDownColor: th.down,
      wickUpColor: th.up, wickDownColor: th.down, priceLineVisible: false,
    });
    cs.setData(candleData(b));
    const volSeries = price.addHistogramSeries({ priceScaleId: "vol", priceFormat: { type: "volume" }, lastValueVisible: false, priceLineVisible: false });
    price.priceScale("vol").applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
    const volArr = isF && freq === "1d" ? b.V : b.v;
    volSeries.setData(b.time.map((t, i) => ({ time: t, value: volArr[i] || 0, color: rgba(b.c[i] >= b.o[i] ? th.up : th.down, 0.28) })));
    price.priceScale("right").applyOptions({ scaleMargins: { top: 0.06, bottom: 0.2 } });

    if (isF && freq === "1d" && inst.rolls) {
      const markers = inst.rolls.filter((r) => r.date >= b.time[0]).map((r) => ({
        time: r.date, position: "belowBar", color: th.ink3, shape: "circle", size: 0.5, text: r.to.slice(-4),
      }));
      cs.setMarkers(markers);
      view.querySelector("#show-rolls")?.addEventListener("change", (e) => cs.setMarkers(e.target.checked ? markers : []));
    }

    let liveLine = null;
    const setLive = (q) => {
      if (!q || !q.source || !(q.price > 0)) return;
      if (liveLine) cs.removePriceLine(liveLine);
      liveLine = cs.createPriceLine({ price: q.price, color: th.accent, lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: "LIVE" });
    };
    setLive(live.get(sym));

    const vol = makeChart(view.querySelector("#c-vol"), { height: 140, timeVisible, showTime: false });
    vol.addLineSeries({ color: th.hot, lineWidth: 2, priceLineVisible: false, priceFormat: { type: "percent" } })
      .setData(lineData(b.time, f.rv.map((x) => x * 100)));
    vol.addLineSeries({ color: th.ink3, lineWidth: 1, lineStyle: 1, priceLineVisible: false, lastValueVisible: false })
      .setData(lineData(b.time, f.pk.map((x) => x * 100)));

    const att = makeChart(view.querySelector("#c-att"), { height: 120, timeVisible, showTime: false });
    const aS = att.addAreaSeries({ lineColor: th.accent, topColor: rgba(th.accent, 0.25), bottomColor: "rgba(0,0,0,0)", lineWidth: 1.5, priceLineVisible: false });
    aS.setData(lineData(b.time, f.attention));
    aS.createPriceLine({ price: 50, color: th.ink3, lineWidth: 1, lineStyle: 2, axisLabelVisible: false });

    const flow = makeChart(view.querySelector("#c-flow"), { height: 170, timeVisible, showTime: true });
    const tone = (k) => (REGIMES[k] || REGIMES.neutral).tone;
    const col = (k) => { const t = tone(k); return t.startsWith("up") ? th.up : t.startsWith("down") ? th.down : th.ink3; };
    if (isF) {
      flow.addHistogramSeries({ priceFormat: { type: "percent" }, priceLineVisible: false })
        .setData(b.time.map((t, i) => ({ time: t, value: isNum(f.dOI5Pct[i]) ? f.dOI5Pct[i] * 100 : 0, color: rgba(col(f.regime[i]), tone(f.regime[i]).endsWith("weak") ? 0.35 : 0.8) })));
      flow.addLineSeries({ priceScaleId: "left", color: th.cool, lineWidth: 1.5, priceLineVisible: false, priceFormat: { type: "volume" } })
        .setData(lineData(b.time, f.oi));
    } else {
      flow.addHistogramSeries({ priceLineVisible: false })
        .setData(b.time.map((t, i) => ({ time: t, value: isNum(f.cmf[i]) ? f.cmf[i] : 0, color: rgba(f.cmf[i] >= 0 ? th.up : th.down, 0.7) })));
      flow.addLineSeries({ priceScaleId: "left", color: th.warm, lineWidth: 1.5, priceLineVisible: false, priceFormat: { type: "percent" } })
        .setData(lineData(b.time, f.fundAnn.map((x) => x * 100)));
    }
    charts = [price, vol, att, flow];
    charts.forEach((c) => c.applyOptions({ leftPriceScale: { visible: true, borderColor: th.line, minimumWidth: 64 }, rightPriceScale: { minimumWidth: 72 } }));
    syncCharts(charts);

    if (unsub) unsub();
    unsub = live.subscribe((s2, q) => {
      if (s2 !== sym) return;
      const pxEl = view.querySelector("#q-px");
      if (!pxEl) return;
      pxEl.textContent = fmtPrice(q.price, inst);
      view.querySelector("#q-chg").innerHTML = signed(q.chg);
      view.querySelector("#q-meta").innerHTML = quoteMeta(q, inst);
      setLive(q);
    });
    return { cs, price };
  };

  await draw();
  return () => { if (unsub) unsub(); charts.forEach((c) => c.remove()); };
}

function profileSvg(p, inst, last) {
  const W = 900, rowH = 8, H = p.bins.length * rowH + 24;
  const mx = Math.max(...p.bins.map((b) => b.w));
  const x0 = 78, wMax = W - x0 - 12;
  let g = "";
  // bins drawn top = highest price
  p.bins.slice().reverse().forEach((b, k) => {
    const y = 6 + k * rowH;
    const inVA = b.price >= p.val && b.price <= p.vah;
    const isPoc = Math.abs(b.price - p.poc) < p.step / 2;
    const w = (b.w / mx) * wMax;
    g += `<rect x="${x0}" y="${y}" width="${Math.max(0.5, w)}" height="${rowH - 1.5}" rx="1.5" fill="${isPoc ? "var(--accent)" : inVA ? "color-mix(in srgb, var(--accent) 45%, transparent)" : "var(--surface-2)"}"/>`;
    if (k % 5 === 0) g += `<text x="${x0 - 8}" y="${y + rowH - 2}" text-anchor="end" font-size="9.5" fill="var(--ink-3)" font-family="var(--mono)">${fmtPrice(b.price, inst)}</text>`;
  });
  const yOf = (price) => 6 + (p.bins.length - 1 - Math.min(p.bins.length - 1, Math.max(0, Math.floor((price - p.lo) / p.step)))) * rowH + rowH / 2;
  g += `<line x1="${x0}" x2="${W - 8}" y1="${yOf(last)}" y2="${yOf(last)}" stroke="var(--ink)" stroke-dasharray="4 3"/>
    <text x="${W - 10}" y="${yOf(last) - 3}" text-anchor="end" font-size="10" fill="var(--ink)" font-family="var(--mono)">${L("last", "最新")} ${fmtPrice(last, inst)}</text>`;
  const where = last > p.vah ? L("above the value area — buyers in control, acceptance higher needs follow-through", "位于价值区上方——买方占优，需继续放量确认")
    : last < p.val ? L("below the value area — sellers in control", "位于价值区下方——卖方占优")
    : L("inside the value area — balanced, rotational trade", "位于价值区内——多空平衡，区间震荡");
  return `<svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto;display:block">${g}</svg>
    <div class="calc-out" style="grid-template-columns:repeat(3,minmax(0,1fr))">
      <div><span>POC</span><span>${fmtPrice(p.poc, inst)}</span></div>
      <div><span>VAH</span><span>${fmtPrice(p.vah, inst)}</span></div>
      <div><span>VAL</span><span>${fmtPrice(p.val, inst)}</span></div>
    </div>
    <p class="note">${L("Last price is ", "最新价")}${where}${L(". POC = price with the most activity; value area = range holding 70% of it.", "。POC 为成交最密集价位；价值区为覆盖 70% 成交的价格区间。")}</p>`;
}

function quoteMeta(q, inst) {
  const open = inst.group === "crypto" || marketOpen(inst.symbol);
  if (q?.source) {
    const t = new Date(q.ts * 1000);
    const when = isNaN(t) ? "" : t.toLocaleString(getLang() === "zh" ? "zh-CN" : "en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit", month: "short", day: "numeric" });
    return `<span class="chip live"><span class="dot"></span>${esc(q.source)}</span> ${when}${q.contract ? " · " + esc(q.contract) : ""}`;
  }
  return `<span class="chip ${open ? "delayed" : "closed"}"><span class="dot"></span>${open ? L("Delayed", "延迟") : L("Market closed", "休市")}</span> ${L("last close", "最近收盘")} ${esc(q?.lastDate || "")}`;
}

function kpiCard(label, main, bar, rows) {
  return `<div class="card kpi"><div class="k-label">${label}</div><div class="k-main">${main}</div>${bar}
    <div class="k-rows" style="margin-top:8px">${rows.map(([a, b]) => `<div><span>${esc(a)}</span><span>${b}</span></div>`).join("")}</div></div>`;
}

function readings(inst, s, f, freq) {
  const zh = getLang() === "zh";
  const unit = freq === "1d" ? L("day", "日") : L("hour", "小时");
  const vr = volRegime(s.rvPct);
  const rg = REGIMES[s.regime] || REGIMES.neutral;
  const p0 = (x) => (isNum(x) ? x.toFixed(0) : "—");
  const pkNote = s.pk > s.rv * 1.15
    ? L("intrabar ranges are wider than close-to-close moves suggest, i.e. choppy trading.", "K 线内振幅大于收盘间波动，说明盘中来回拉锯。")
    : s.pk < s.rv * 0.85
      ? L("close-to-close moves exceed intrabar ranges, typical of gaps and trending sessions.", "收盘间波动大于盘中振幅，常见于跳空与单边行情。")
      : L("both estimators agree.", "两种估计基本一致。");
  const v = zh
    ? `<p>20 ${unit}已实现波动率为年化 <b>${fmtPct(s.rv, 1, false)}</b>，处于过去一年的 <b>${p0(s.rvPct)}</b> 分位，属于<b>${vr.zh}</b>区间。</p><p>高低价（Parkinson）估计为 ${fmtPct(s.pk, 1, false)}；${pkNote}</p>`
    : `<p>20-${unit} realized volatility is <b>${fmtPct(s.rv, 1, false)}</b> annualized, the <b>${p0(s.rvPct)}th</b> percentile of the past year — a <b>${vr.label.toLowerCase()}</b> regime.</p><p>The high–low (Parkinson) estimate is ${fmtPct(s.pk, 1, false)}; ${pkNote}</p>`;
  const rvolNote = s.rvol > 1.5 ? L("Today's activity is well above its 20-bar average — something is drawing the market in.", "当前成交明显高于 20 期均值——有事件在吸引资金关注。")
    : s.rvol < 0.7 ? L("Activity is running below its recent average.", "成交低于近期均值。") : L("Activity is in line with its recent average.", "成交与近期均值相当。");
  const a = zh
    ? `<p>关注度得分 <b>${p0(s.attention)}</b> / 100（${attentionLabel(s.attention, "zh")}）。${two(f.activityLabel)}处于 ${p0(s.actPct)} 分位${f.secondLabel ? `，${two(f.secondLabel)}处于 ${p0(s.secPct)} 分位` : ""}。</p><p>${rvolNote}</p>`
    : `<p>Attention score <b>${p0(s.attention)}</b> / 100 (${attentionLabel(s.attention).toLowerCase()}). ${two(f.activityLabel)} sits at the ${p0(s.actPct)}th percentile${f.secondLabel ? `, ${two(f.secondLabel).toLowerCase()} at the ${p0(s.secPct)}th` : ""}.</p><p>${rvolNote}</p>`;
  let c = `<p><b>${L(rg.label, rg.zh)}.</b> ${L(rg.help, rg.zh_help)}</p>`;
  if (inst.group === "futures") {
    c += zh
      ? `<p>最近 5 ${unit}价格变动 ${fmtPct(s.ret5)}，持仓量变动 ${fmtPct(s.dOI5Pct)}（约 ${fmtBig(s.flowValue, "¥")} 合约价值）。当前持仓市值 ${fmtBig(s.notional, "¥")}，处于过去一年的 ${p0(s.oiPct)} 分位。</p>`
      : `<p>Over the last 5 ${unit}s price moved ${fmtPct(s.ret5)} while open interest changed ${fmtPct(s.dOI5Pct)} (≈ ${fmtBig(s.flowValue, "¥")} of contract value). Total notional open interest is ${fmtBig(s.notional, "¥")}, the ${p0(s.oiPct)}th percentile of the past year.</p>`;
  } else {
    c += zh
      ? `<p>Chaikin 资金流为 ${fmtNum(s.cmf, 3)}${isNum(s.fundAnn) ? `；永续资金费率年化 ${fmtPct(s.fundAnn, 1)}（${p0(s.fundPct)} 分位），${s.fundAnn > 0 ? "多头向空头付费" : "空头向多头付费"}` : ""}。</p>`
      : `<p>Chaikin money flow is ${fmtNum(s.cmf, 3)}${isNum(s.fundAnn) ? `; perpetual funding annualizes to ${fmtPct(s.fundAnn, 1)} (${p0(s.fundPct)}th pct), ${s.fundAnn > 0 ? "longs paying shorts" : "shorts paying longs"}` : ""}.</p>`;
  }
  return [[L("Volatility", "波动率"), v], [L("Attention", "关注度"), a], [L("Capital flow", "资金流动"), c]];
}
