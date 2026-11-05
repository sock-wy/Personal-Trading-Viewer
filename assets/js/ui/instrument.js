import { loadBars } from "../core/data.js";
import { computeFeatures, snapshot, REGIMES, volRegime, attentionLabel } from "../core/analytics.js";
import { isNum } from "../core/indicators.js";
import { makeChart, syncCharts, lineData, candleData, rgba, theme, setRange } from "./charts.js";
import { esc, fmtPrice, fmtPct, fmtBig, signed, fmtNum, meter } from "./format.js";
import { marketOpen } from "./live.js";

const RANGES = { "1d": [["6M", 126], ["1Y", 250], ["3Y", 750], ["All", 0]], "1h": [["1M", 140], ["3M", 420], ["1Y", 1700], ["All", 0]] };

export async function renderInstrument(ctx, sym, params) {
  const { meta, view, live } = ctx;
  const inst = meta.instruments.find((i) => i.symbol === sym);
  if (!inst) throw new Error(`Unknown instrument ${sym}`);
  let freq = params.get("f") === "1h" ? "1h" : "1d";
  let charts = [];
  let unsub = null;

  const draw = async () => {
    charts.forEach((c) => c.remove());
    charts = [];
    const bars = await loadBars(sym, freq);
    const f = freq === "1d" ? (await ctx.getDaily(sym)).f : computeFeatures(bars);
    const s = snapshot(bars, f);
    paint(bars, f, s);
  };

  const paint = (bars, f, s) => {
    const isF = inst.group === "futures";
    const rg = REGIMES[s.regime] || REGIMES.neutral;
    const vr = volRegime(s.rvPct);
    const q = live.get(sym);
    const tz = isF ? "Beijing time" : "UTC";
    view.innerHTML = `
      <div class="inst-head">
        <div class="inst-title">
          <div class="eyebrow">${esc(inst.exchange)} · ${isF ? "dominant " + esc(inst.dominant) : esc(inst.product)}</div>
          <div class="sym-big">${sym}</div>
          <div class="names">${esc(inst.name)}${isF ? " · " + esc(inst.cn) : ""}</div>
        </div>
        <div class="inst-quote">
          <div><span class="big" id="q-px">${fmtPrice(q?.price ?? s.raw, inst)}</span><span class="chg" id="q-chg">${signed(q?.chg)}</span></div>
          <div class="meta" id="q-meta">${quoteMeta(q, inst)}</div>
        </div>
        <div class="inst-actions">
          <div class="seg" id="freq">${["1d", "1h"].map((x) => `<button data-f="${x}" class="${x === freq ? "on" : ""}">${x === "1d" ? "Daily" : "Hourly"}</button>`).join("")}</div>
          <a class="btn primary" href="#/backtest?sym=${sym}&f=${freq}">Backtest ${sym} →</a>
        </div>
      </div>

      <div class="kpis">
        ${kpiCard("Volatility", `<b>${fmtPct(s.rv, 1, false)}</b><span class="pill t-${vr.tone}">${vr.label}</span>`, meter(s.rvPct, "vol"), [
          ["Percentile (1y)", isNum(s.rvPct) ? s.rvPct.toFixed(0) : "—"],
          ["Parkinson (H/L)", fmtPct(s.pk, 1, false)],
          ["ATR(14) / price", fmtPct(s.atrPct, 2, false)],
        ])}
        ${kpiCard("Attention", `<b>${isNum(s.attention) ? s.attention.toFixed(0) : "—"}</b><span class="muted">${attentionLabel(s.attention)}</span>`, meter(s.attention, "att"), [
          [f.activityLabel + " pct", isNum(s.actPct) ? s.actPct.toFixed(0) : "—"],
          [(f.secondLabel || "Second signal") + " pct", isNum(s.secPct) ? s.secPct.toFixed(0) : "n/a"],
          ["Relative volume (vs 20)", isNum(s.rvol) ? s.rvol.toFixed(2) + "×" : "—"],
        ])}
        ${kpiCard("Capital flow · 5 bars", `<span class="pill t-${rg.tone}" style="font-size:13px">${rg.label}</span>`, "", isF ? [
          ["Price change", fmtPct(s.ret5)],
          [freq === "1d" ? "All-contract OI change" : "Dominant OI change", fmtPct(s.dOI5Pct)],
          ["Capital committed", fmtBig(s.flowValue, "¥")],
        ] : [
          ["Price change", fmtPct(s.ret5)],
          ["Chaikin money flow (20)", fmtNum(s.cmf, 3)],
          ["Signed $ flow (5)", fmtBig(s.flowValue, "$")],
        ])}
        ${isF ? kpiCard("Positioning", `<b>${fmtBig(s.notional, "¥")}</b><span class="muted">notional OI</span>`, meter(s.oiPct, "att"), [
          ["Open interest", fmtNum(s.oi, 0)],
          ["OI percentile (1y)", isNum(s.oiPct) ? s.oiPct.toFixed(0) : "—"],
          ["Contract", `${inst.multiplier} ${inst.unit} · tick ${inst.tick}`],
        ]) : kpiCard("Positioning", `<b>${fmtPct(s.fundAnn, 1)}</b><span class="muted">perp funding, ann.</span>`, meter(s.fundPct, "att"), [
          ["Funding percentile (1y)", isNum(s.fundPct) ? s.fundPct.toFixed(0) : "—"],
          ["Source", "Hyperliquid perp"],
          ["Read", s.fundPct > 90 ? "Longs crowded" : s.fundPct < 10 ? "Shorts crowded" : "Balanced"],
        ])}
      </div>

      <div class="card chart-stack">
        <div class="toolbar">
          <div class="seg" id="range">${RANGES[freq].map(([l, n], i) => `<button data-n="${n}" class="${i === 1 ? "on" : ""}">${l}</button>`).join("")}</div>
          <span class="muted" style="font-size:12px">${isF ? "Back-adjusted continuous (ratio), dominant contract by open interest" : "Coinbase spot"} · times in ${tz}${freq === "1h" ? ", bar end" : ""}</span>
          <span class="spacer"></span>
          ${isF && freq === "1d" ? `<label style="font-size:12px;color:var(--ink-2)"><input type="checkbox" id="show-rolls" checked> roll markers</label>` : ""}
        </div>
        <div class="pane"><div class="pane-label">Price <em>· volume</em></div><div id="c-price"></div></div>
        <div class="pane"><div class="pane-label">Volatility <em>· realized 20 (line) vs Parkinson (dotted), annualized</em></div><div id="c-vol"></div></div>
        <div class="pane"><div class="pane-label">Attention <em>· score 0–100</em></div><div id="c-att"></div></div>
        <div class="pane"><div class="pane-label">Capital flow <em>· ${isF ? (freq === "1d" ? "5-bar change in all-contract OI (bars), OI level (line)" : "5-bar change in dominant OI (bars), OI (line)") : "Chaikin money flow 20 (bars), funding ann. (line)"}</em></div><div id="c-flow"></div></div>
      </div>

      <div class="reading">${readings(inst, s, f, freq).map((r) => `<div class="card"><div class="card-head"><h3>${r[0]}</h3></div><div class="card-body">${r[1]}</div></div>`).join("")}</div>
    `;

    view.querySelectorAll("#freq button").forEach((b) => b.addEventListener("click", () => {
      freq = b.dataset.f;
      history.replaceState(null, "", `#/i/${sym}?f=${freq}`);
      draw();
    }));

    buildCharts(bars, f, inst, freq);

    const rangeBtns = view.querySelectorAll("#range button");
    const applyRange = (n) => charts.forEach((c) => setRange(c, bars.n, n));
    rangeBtns.forEach((b) => b.addEventListener("click", () => {
      rangeBtns.forEach((x) => x.classList.toggle("on", x === b));
      applyRange(+b.dataset.n);
    }));
    applyRange(RANGES[freq][1][1]);
  };

  const buildCharts = (b, f, inst, freq) => {
    const th = theme();
    const timeVisible = freq === "1h";
    const price = makeChart(view.querySelector("#c-price"), { height: 380, timeVisible, showTime: false });
    const cs = price.addCandlestickSeries({
      upColor: th.up, downColor: th.down, borderUpColor: th.up, borderDownColor: th.down,
      wickUpColor: th.up, wickDownColor: th.down, priceLineVisible: false,
    });
    cs.setData(candleData(b));
    const volSeries = price.addHistogramSeries({ priceScaleId: "vol", priceFormat: { type: "volume" }, lastValueVisible: false, priceLineVisible: false });
    price.priceScale("vol").applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
    const volArr = inst.group === "futures" && freq === "1d" ? b.V : b.v;
    volSeries.setData(b.time.map((t, i) => ({ time: t, value: volArr[i] || 0, color: rgba(b.c[i] >= b.o[i] ? th.up : th.down, 0.28) })));
    price.priceScale("right").applyOptions({ scaleMargins: { top: 0.06, bottom: 0.2 } });

    if (inst.group === "futures" && freq === "1d" && inst.rolls) {
      const markers = inst.rolls.filter((r) => r.date >= b.time[0]).map((r) => ({
        time: r.date, position: "belowBar", color: th.ink3, shape: "circle", size: 0.5, text: r.to.slice(-4),
      }));
      cs.setMarkers(markers);
      view.querySelector("#show-rolls")?.addEventListener("change", (e) => cs.setMarkers(e.target.checked ? markers : []));
    }

    // live price line
    let liveLine = null;
    const setLive = (q) => {
      if (!q || !q.source || !(q.price > 0)) return;
      if (liveLine) cs.removePriceLine(liveLine);
      liveLine = cs.createPriceLine({ price: q.price, color: th.accent, lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: "LIVE" });
    };
    setLive(live.get(sym));

    const vol = makeChart(view.querySelector("#c-vol"), { height: 140, timeVisible, showTime: false });
    const rvS = vol.addLineSeries({ color: th.hot, lineWidth: 2, priceLineVisible: false, priceFormat: { type: "percent" } });
    rvS.setData(lineData(b.time, f.rv.map((x) => x * 100)));
    vol.addLineSeries({ color: th.ink3, lineWidth: 1, lineStyle: 1, priceLineVisible: false, lastValueVisible: false })
      .setData(lineData(b.time, f.pk.map((x) => x * 100)));

    const att = makeChart(view.querySelector("#c-att"), { height: 120, timeVisible, showTime: false });
    const aS = att.addAreaSeries({ lineColor: th.accent, topColor: rgba(th.accent.startsWith("#") ? th.accent : "#C4501B", 0.25), bottomColor: "rgba(0,0,0,0)", lineWidth: 1.5, priceLineVisible: false });
    aS.setData(lineData(b.time, f.attention));
    aS.createPriceLine({ price: 50, color: th.ink3, lineWidth: 1, lineStyle: 2, axisLabelVisible: false });

    const flow = makeChart(view.querySelector("#c-flow"), { height: 170, timeVisible, showTime: true });
    const tone = (rgk) => (REGIMES[rgk] || REGIMES.neutral).tone;
    const col = (rgk) => { const t = tone(rgk); return t.startsWith("up") ? th.up : t.startsWith("down") ? th.down : th.ink3; };
    if (inst.group === "futures") {
      const hs = flow.addHistogramSeries({ priceFormat: { type: "percent" }, priceLineVisible: false });
      hs.setData(b.time.map((t, i) => ({ time: t, value: isNum(f.dOI5Pct[i]) ? f.dOI5Pct[i] * 100 : 0, color: rgba(col(f.regime[i]), tone(f.regime[i]).endsWith("weak") ? 0.35 : 0.8) })));
      const oiS = flow.addLineSeries({ priceScaleId: "left", color: th.cool, lineWidth: 1.5, priceLineVisible: false, priceFormat: { type: "volume" } });
      oiS.setData(lineData(b.time, f.oi));
      flow.priceScale("left").applyOptions({ visible: true, borderColor: th.line });
    } else {
      const hs = flow.addHistogramSeries({ priceLineVisible: false });
      hs.setData(b.time.map((t, i) => ({ time: t, value: isNum(f.cmf[i]) ? f.cmf[i] : 0, color: rgba(f.cmf[i] >= 0 ? th.up : th.down, 0.7) })));
      if (f.fundAnn.some(isNum)) {
        const fs = flow.addLineSeries({ priceScaleId: "left", color: th.warm, lineWidth: 1.5, priceLineVisible: false, priceFormat: { type: "percent" } });
        fs.setData(lineData(b.time, f.fundAnn.map((x) => x * 100)));
        flow.priceScale("left").applyOptions({ visible: true, borderColor: th.line });
      }
    }
    charts = [price, vol, att, flow];
    syncCharts(charts);
    // keep axis widths aligned so the panes line up
    charts.forEach((c) => c.applyOptions({ leftPriceScale: { minimumWidth: 64 }, rightPriceScale: { minimumWidth: 72 } }));
    if (inst.group === "crypto" && !f.fundAnn.some(isNum)) charts.forEach((c) => c.applyOptions({ leftPriceScale: { visible: false } }));
    if (inst.group === "futures" || f.fundAnn.some(isNum)) [price, vol, att].forEach((c) => c.applyOptions({ leftPriceScale: { visible: true, borderColor: th.line } }));

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
  };

  await draw();
  return () => { if (unsub) unsub(); charts.forEach((c) => c.remove()); };
}

function quoteMeta(q, inst) {
  const open = inst.group === "crypto" || marketOpen(inst.symbol);
  if (q?.source) {
    const t = new Date(q.ts * 1000);
    const when = isNaN(t) ? "" : t.toLocaleString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit", month: "short", day: "numeric" });
    return `<span class="chip live"><span class="dot"></span>${esc(q.source)}</span> ${when}${q.contract ? " · " + esc(q.contract) : ""}`;
  }
  return `<span class="chip ${open ? "delayed" : "closed"}"><span class="dot"></span>${open ? "Delayed" : "Market closed"}</span> last close ${esc(q?.lastDate || "")}`;
}

function kpiCard(label, main, bar, rows) {
  return `<div class="card kpi"><div class="k-label">${label}</div><div class="k-main">${main}</div>${bar}
    <div class="k-rows" style="margin-top:8px">${rows.map(([a, b]) => `<div><span>${esc(a)}</span><span>${b}</span></div>`).join("")}</div></div>`;
}

function readings(inst, s, f, freq) {
  const unit = freq === "1d" ? "day" : "hour";
  const vr = volRegime(s.rvPct);
  const rg = REGIMES[s.regime] || REGIMES.neutral;
  const v = `<p>20-${unit} realized volatility is <b>${fmtPct(s.rv, 1, false)}</b> annualized, the
    <b>${isNum(s.rvPct) ? s.rvPct.toFixed(0) : "—"}th</b> percentile of the past year — a <b>${vr.label.toLowerCase()}</b> regime.</p>
    <p>The high–low (Parkinson) estimate is ${fmtPct(s.pk, 1, false)}; ${s.pk > s.rv * 1.15 ? "intrabar ranges are wider than close-to-close moves suggest, i.e. choppy trading."
      : s.pk < s.rv * 0.85 ? "close-to-close moves exceed intrabar ranges, typical of gaps and trending sessions." : "both estimators agree."}</p>`;
  const a = `<p>Attention score <b>${isNum(s.attention) ? s.attention.toFixed(0) : "—"}</b> / 100 (${attentionLabel(s.attention).toLowerCase()}).
    ${f.activityLabel} sits at the ${isNum(s.actPct) ? s.actPct.toFixed(0) : "—"}th percentile${f.secondLabel ? `, ${f.secondLabel.toLowerCase()} at the ${isNum(s.secPct) ? s.secPct.toFixed(0) : "—"}th` : ""}.</p>
    <p>${s.rvol > 1.5 ? "Today's activity is well above its 20-bar average — something is drawing the market in." : s.rvol < 0.7 ? "Activity is running below its recent average." : "Activity is in line with its recent average."}</p>`;
  let c = `<p><b>${rg.label}.</b> ${rg.help}</p>`;
  if (inst.group === "futures") {
    c += `<p>Over the last 5 ${unit}s price moved ${fmtPct(s.ret5)} while open interest changed ${fmtPct(s.dOI5Pct)}
      (≈ ${fmtBig(s.flowValue, "¥")} of contract value). Total notional open interest is ${fmtBig(s.notional, "¥")},
      the ${isNum(s.oiPct) ? s.oiPct.toFixed(0) : "—"}th percentile of the past year.</p>`;
  } else {
    c += `<p>Chaikin money flow is ${fmtNum(s.cmf, 3)}${isNum(s.fundAnn) ? `; perpetual funding annualizes to ${fmtPct(s.fundAnn, 1)} (${isNum(s.fundPct) ? s.fundPct.toFixed(0) : "—"}th pct), ${s.fundAnn > 0 ? "longs paying shorts" : "shorts paying longs"}` : ""}.</p>`;
  }
  return [["Volatility", v], ["Attention", a], ["Capital flow", c]];
}
