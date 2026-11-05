import { loadMeta, loadBars } from "./core/data.js";
import { computeFeatures, snapshot } from "./core/analytics.js";
import { LiveQuotes } from "./ui/live.js";
import { renderMarkets } from "./ui/markets.js";
import { renderInstrument } from "./ui/instrument.js";
import { renderBacktest } from "./ui/backtest.js";
import { renderMethod } from "./ui/method.js";
import { esc } from "./ui/format.js";
import { renderChain } from "./ui/chain.js";
import { L, getLang, setLang, paintStatic } from "./ui/i18n.js";

const view = document.getElementById("view");
const state = { meta: null, live: null, features: new Map(), cleanup: null };

// Daily bars + features for every instrument, computed once and shared by all views.
export async function getDaily(sym) {
  if (!state.features.has(sym)) {
    state.features.set(sym, (async () => {
      const bars = await loadBars(sym, "1d");
      const f = computeFeatures(bars);
      return { bars, f, snap: snapshot(bars, f) };
    })());
  }
  return state.features.get(sym);
}

function parseRoute() {
  const h = location.hash.replace(/^#\/?/, "");
  const [path, qs] = h.split("?");
  const parts = path.split("/").filter(Boolean);
  return { name: parts[0] || "markets", arg: parts[1], params: new URLSearchParams(qs || "") };
}

async function route() {
  const r = parseRoute();
  document.querySelectorAll(".nav a").forEach((a) => {
    a.classList.toggle("active", a.dataset.route === (r.name === "i" ? "markets" : r.name));
  });
  if (state.cleanup) { try { state.cleanup(); } catch { /* ignore */ } state.cleanup = null; }
  view.innerHTML = `<div class="loading">${L("Loading…", "加载中…")}</div>`;
  const ctx = { ...state, view, getDaily, route: r };
  try {
    if (r.name === "i" && r.arg) state.cleanup = await renderInstrument(ctx, r.arg.toUpperCase(), r.params);
    else if (r.name === "backtest") state.cleanup = await renderBacktest(ctx, r.params);
    else if (r.name === "method") state.cleanup = await renderMethod(ctx);
    else if (r.name === "chain") state.cleanup = await renderChain(ctx);
    else state.cleanup = await renderMarkets(ctx);
  } catch (e) {
    console.error(e);
    view.innerHTML = `<div class="error">${L("Could not load this page", "页面加载失败")}: ${esc(e.message)}</div>`;
  }
  view.focus({ preventScroll: true });
}

function setupToggles() {
  const root = document.documentElement;
  const langBtn = document.getElementById("btn-lang");
  const paintLang = () => { langBtn.textContent = getLang() === "zh" ? "EN" : "中"; paintStatic(); };
  paintLang();
  langBtn.addEventListener("click", () => {
    setLang(getLang() === "zh" ? "en" : "zh");
    paintLang();
    route();
  });
  const save = (k, v) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } };
  document.getElementById("btn-theme").addEventListener("click", () => {
    const dark = root.dataset.theme !== "light";
    root.dataset.theme = dark ? "light" : "dark";
    save("ptv.theme", root.dataset.theme);
    route(); // charts read colours at creation time
  });
  const colorsBtn = document.getElementById("btn-colors");
  const paint = () => { colorsBtn.title = root.dataset.colors === "cn" ? L("Colours: red = up (China convention)", "配色：红涨绿跌（国内习惯）") : L("Colours: green = up (Western convention)", "配色：绿涨红跌（海外习惯）"); };
  paint();
  colorsBtn.addEventListener("click", () => {
    root.dataset.colors = root.dataset.colors === "cn" ? "west" : "cn";
    save("ptv.colors", root.dataset.colors);
    paint();
    route();
  });
}

async function boot() {
  setupToggles();
  try {
    state.meta = await loadMeta();
  } catch (e) {
    view.innerHTML = `<div class="error">Data unavailable: ${esc(e.message)}</div>`;
    return;
  }
  const stamp = document.getElementById("stamp");
  const g = new Date(state.meta.generated_at);
  stamp.textContent = `${L("data", "数据")} ${g.toISOString().slice(0, 16).replace("T", " ")} UTC`;

  state.live = new LiveQuotes(state.meta);
  // seed quote references with the last daily closes, then go live
  await Promise.all(state.meta.instruments.map(async (inst) => {
    try {
      const { bars } = await getDaily(inst.symbol);
      const n = bars.n;
      state.live.setRef(inst.symbol, bars.rc[n - 1], bars.rc[n - 2], bars.dates[n - 1]);
    } catch (e) { console.warn(inst.symbol, e); }
  }));
  state.live.start();

  window.addEventListener("hashchange", route);
  route();
}

boot();
