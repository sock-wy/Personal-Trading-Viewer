import { REGIMES, volRegime, attentionLabel } from "../core/analytics.js";
import { isNum } from "../core/indicators.js";
import { esc, fmtPrice, fmtPct, fmtBig, signed, sparkline, meter, fmtNum } from "./format.js";
import { marketOpen } from "./live.js";

export async function renderMarkets(ctx) {
  const { meta, view, getDaily, live } = ctx;
  const rows = await Promise.all(meta.instruments.map(async (inst) => ({ inst, ...(await getDaily(inst.symbol)) })));
  const groups = Object.entries(meta.groups);

  view.innerHTML = `
    <div class="page-head">
      <div>
        <div class="eyebrow">Market structure monitor</div>
        <h1>Black series &amp; crypto</h1>
        <p>Every instrument is scored on three axes — <b>attention</b> (is the market looking?),
        <b>volatility</b> (how hard is it moving, versus its own past year?) and <b>capital flow</b>
        (is new money opening positions, or old money leaving?).</p>
      </div>
    </div>
    <div class="markets-grid">
      <div>${groups.map(([key, g]) => groupCard(key, g, rows.filter((r) => r.inst.group === key))).join("")}</div>
      <aside>
        <div class="card map-card">
          <div class="card-head"><h3>Market map</h3><span class="sub">attention × volatility, coloured by flow</span></div>
          <div class="card-body">${marketMap(rows)}</div>
          <div class="legend">
            <span><i style="background:var(--up)"></i>new money in, price up</span>
            <span><i style="background:var(--down)"></i>new money in, price down</span>
            <span><i style="border:1.5px solid var(--ink-3)"></i>positions closing</span>
          </div>
        </div>
        <div class="card" style="margin-top:16px">
          <div class="card-head"><h3>How to read the board</h3></div>
          <dl class="explain">
            <dt>Volatility</dt><dd>20-day realized volatility (annualized) and its percentile within the past year.
              Regimes: calm &lt;20th, normal, elevated &gt;60th, stressed &gt;85th.</dd>
            <dt>Attention</dt><dd>0–100 percentile score. Futures: all-contract volume and volume/open-interest turnover.
              Crypto: USD volume and Wikipedia pageviews.</dd>
            <dt>Capital flow</dt><dd>Futures: 5-day change in all-contract open interest against price — the four
              build-up / covering / liquidation quadrants. Crypto: Chaikin money flow and perp funding.</dd>
          </dl>
        </div>
      </aside>
    </div>`;

  // click-through
  view.querySelectorAll("tr[data-sym], [data-goto]").forEach((el) => {
    el.addEventListener("click", () => { location.hash = `#/i/${el.dataset.sym || el.dataset.goto}`; });
  });
  view.querySelectorAll("tr[data-sym]").forEach((el) => {
    el.tabIndex = 0;
    el.addEventListener("keydown", (e) => { if (e.key === "Enter") location.hash = `#/i/${el.dataset.sym}`; });
  });

  // live updates
  const paintQuote = (sym, q) => {
    const tr = view.querySelector(`tr[data-sym="${sym}"]`);
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
    tr.querySelector(".src").textContent = q.source ? q.source : "last close";
  };
  meta.instruments.forEach((i) => paintQuote(i.symbol, live.get(i.symbol)));
  const paintStatus = () => {
    for (const [key] of groups) {
      const chip = view.querySelector(`[data-status="${key}"]`);
      if (!chip) continue;
      const open = key === "crypto" ? true : meta.groups[key].symbols.some((s) => marketOpen(s));
      const st = live.status[key];
      chip.className = `chip ${!open ? "closed" : st === "live" ? "live" : "delayed"}`;
      chip.lastElementChild.textContent = !open ? "Market closed · last close" : st === "live" ? "Live" : "Delayed";
    }
  };
  paintStatus();
  const unsub = live.subscribe((sym, q) => { paintQuote(sym, q); paintStatus(); });
  const t = setInterval(paintStatus, 30000);
  return () => { unsub(); clearInterval(t); };
}

function groupCard(key, g, rows) {
  const exch = [...new Set(rows.map((r) => r.inst.exchange))].join(" · ");
  return `
  <section class="card group">
    <div class="group-head">
      <h2>${esc(g.label)}</h2><span class="sub">${esc(exch)} · ${g.currency}</span>
      <span class="chip" data-status="${key}"><span class="dot"></span><span>…</span></span>
    </div>
    <div class="tbl-wrap"><table class="mkt">
      <thead><tr>
        <th>Instrument</th><th class="r">Last</th><th class="r">5D</th>
        <th>Volatility</th><th>Attention</th><th>Capital flow</th><th>60D</th>
      </tr></thead>
      <tbody>${rows.map(row).join("")}</tbody>
    </table></div>
  </section>`;
}

function row({ inst, bars, f, snap: s }) {
  const vr = volRegime(s.rvPct);
  const rg = REGIMES[s.regime] || REGIMES.neutral;
  const sub = inst.group === "futures" ? `${inst.name} · ${inst.cn}` : inst.name;
  let flowLine;
  if (inst.group === "futures") {
    flowLine = `OI 5D ${signed(s.dOI5Pct, fmtPct(s.dOI5Pct, 1))} · ${signed(s.flowValue, fmtBig(s.flowValue, "¥"))}`;
  } else {
    flowLine = `CMF ${signed(s.cmf, fmtNum(s.cmf, 2))}${isNum(s.fundAnn) ? ` · fund ${signed(s.fundAnn, fmtPct(s.fundAnn, 1))}` : ""}`;
  }
  const n = bars.n;
  return `<tr data-sym="${inst.symbol}" title="${esc(rg.help)}">
    <td><div class="sym"><b>${inst.symbol}</b><span>${esc(sub)}</span></div></td>
    <td class="r"><div class="px" data-v="">${fmtPrice(s.raw, inst)}</div>
      <div class="chg1 num" style="font-size:12px">${signed(s.ret1)}</div><div class="src">last close</div></td>
    <td class="r num">${signed(s.ret5)}</td>
    <td><div class="cell-stack">
      <div class="row"><span class="num">${fmtPct(s.rv, 0, false)}</span><span class="pill t-${vr.tone}">${vr.label}</span></div>
      ${meter(s.rvPct, "vol")}
      <div class="row muted"><span>pct</span><span class="num">${isNum(s.rvPct) ? s.rvPct.toFixed(0) : "—"}</span></div>
    </div></td>
    <td><div class="cell-stack">
      <div class="row"><span class="num">${isNum(s.attention) ? s.attention.toFixed(0) : "—"}</span><span class="muted">${attentionLabel(s.attention)}</span></div>
      ${meter(s.attention, "att")}
      <div class="row muted"><span>rel. vol</span><span class="num">${isNum(s.rvol) ? s.rvol.toFixed(2) + "×" : "—"}</span></div>
    </div></td>
    <td><div class="cell-stack" style="min-width:170px">
      <div><span class="pill t-${rg.tone}">${rg.label}</span></div>
      <div class="num" style="font-size:12px">${flowLine}</div>
    </div></td>
    <td>${sparkline(bars.c.slice(n - 60), { w: 110, h: 30 })}</td>
  </tr>`;
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
  g += ql(P.l + 6, P.t + 14, "VOLATILE · IGNORED", "start") + ql(W - P.r - 6, P.t + 14, "CROWDED · VOLATILE", "end");
  g += ql(P.l + 6, H - P.b - 8, "QUIET", "start") + ql(W - P.r - 6, H - P.b - 8, "CROWDED · CALM", "end");
  g += `<text x="${(P.l + W - P.r) / 2}" y="${H - 6}" font-size="10" fill="var(--ink-3)" text-anchor="middle">attention →</text>`;
  g += `<text x="10" y="${(P.t + H - P.b) / 2}" font-size="10" fill="var(--ink-3)" text-anchor="middle" transform="rotate(-90 10 ${(P.t + H - P.b) / 2})">volatility pct →</text>`;
  for (const { inst, snap: s } of rows) {
    if (!isNum(s.attention) || !isNum(s.rvPct)) continue;
    const cx = x(s.attention), cy = y(s.rvPct);
    const t = tone(s.regime);
    const color = t.startsWith("up") ? "var(--up)" : t.startsWith("down") ? "var(--down)" : "var(--ink-3)";
    const solid = !t.endsWith("weak") && t !== "flat";
    const shape = inst.group === "crypto"
      ? `<rect x="${cx - 5}" y="${cy - 5}" width="10" height="10" transform="rotate(45 ${cx} ${cy})"`
      : `<circle cx="${cx}" cy="${cy}" r="6"`;
    g += `<g data-goto="${inst.symbol}" style="cursor:pointer"><title>${inst.symbol}: attention ${s.attention.toFixed(0)}, vol pct ${s.rvPct.toFixed(0)}, ${(REGIMES[s.regime] || REGIMES.neutral).label}</title>`
      + `${shape} fill="${solid ? color : "var(--surface)"}" stroke="${color}" stroke-width="1.6"/>`
      + `<text x="${cx + 9}" y="${cy + 4}" font-size="11" font-weight="600" fill="var(--ink)">${inst.symbol}</text></g>`;
  }
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Scatter of attention versus volatility percentile">${g}</svg>`;
}
