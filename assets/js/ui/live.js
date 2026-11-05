// Live quote layer. Every source degrades gracefully to the last close in the static data set,
// so the site never shows an empty board.
//
//   crypto : Coinbase Exchange WebSocket (ticker)  ->  Coinbase REST poll  ->  last close
//   futures: Sina via optional Cloudflare Worker   ->  Eastmoney JSONP     ->  last close
import { CONFIG } from "../config.js";

const EASTMONEY = {
  RB: ["113.rbm", "螺纹"], HC: ["113.hcm", "热卷"], I: ["114.im", "铁矿"], J: ["114.jm", "焦炭"],
  JM: ["114.jmm", "焦煤"], SF: ["115.SFM", "硅铁"], SM: ["115.SMM", "锰硅"],
};
const NIGHT = new Set(["RB", "HC", "I", "J", "JM"]);

export class LiveQuotes {
  constructor(meta) {
    this.meta = meta;
    this.quotes = new Map();   // symbol -> {price, chg, prevRef, ts, source, contract}
    this.subs = new Set();
    this.status = { crypto: "delayed", futures: "delayed" };
    this.ws = null;
  }

  subscribe(fn) { this.subs.add(fn); return () => this.subs.delete(fn); }
  get(sym) { return this.quotes.get(sym); }
  emit(sym) { this.subs.forEach((fn) => fn(sym, this.quotes.get(sym), this.status)); }

  setRef(sym, lastClose, prevClose, lastDate) {
    // Reference for % change: the last completed daily close in our data set.
    const q = this.quotes.get(sym) || {};
    this.quotes.set(sym, { ...q, lastClose, prevClose, lastDate,
      price: q.price ?? lastClose, chg: q.source ? q.chg : lastClose / prevClose - 1, source: q.source || null });
  }

  start() {
    this.startCrypto();
    this.pollFutures();
    this.timer = setInterval(() => this.pollFutures(), CONFIG.futuresPollMs);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") this.pollFutures();
    });
  }

  // ---------------------------------------------------------------- crypto
  cryptoInsts() { return this.meta.instruments.filter((i) => i.group === "crypto"); }

  startCrypto() {
    const insts = this.cryptoInsts();
    const byProduct = new Map(insts.map((i) => [i.product, i.symbol]));
    let opened = false;
    try {
      const ws = new WebSocket("wss://ws-feed.exchange.coinbase.com");
      this.ws = ws;
      ws.onopen = () => {
        opened = true;
        ws.send(JSON.stringify({ type: "subscribe", product_ids: [...byProduct.keys()], channels: ["ticker"] }));
      };
      ws.onmessage = (ev) => {
        const m = JSON.parse(ev.data);
        if (m.type !== "ticker") return;
        const sym = byProduct.get(m.product_id);
        if (sym) this.update(sym, +m.price, Date.parse(m.time) / 1000, "Coinbase WS", "crypto");
      };
      ws.onclose = () => {
        this.status.crypto = "delayed";
        setTimeout(() => (opened ? this.startCrypto() : this.pollCryptoRest()), opened ? 3000 : 0);
      };
      ws.onerror = () => ws.close();
    } catch {
      this.pollCryptoRest();
    }
  }

  async pollCryptoRest() {
    for (const inst of this.cryptoInsts()) {
      try {
        const r = await fetch(`https://api.exchange.coinbase.com/products/${inst.product}/ticker`);
        if (!r.ok) throw new Error(r.status);
        const j = await r.json();
        this.update(inst.symbol, +j.price, Date.parse(j.time) / 1000, "Coinbase REST", "crypto");
      } catch { /* keep last close */ }
    }
    clearTimeout(this.cryptoTimer);
    this.cryptoTimer = setTimeout(() => this.startCrypto(), 30000);
  }

  // ---------------------------------------------------------------- futures
  futuresInsts() { return this.meta.instruments.filter((i) => i.group === "futures"); }

  async pollFutures() {
    if (document.visibilityState === "hidden") return;
    const insts = this.futuresInsts();
    if (!insts.some((i) => marketOpen(i.symbol)) && this._polledOnce) return;
    this._polledOnce = true;
    if (CONFIG.quoteProxy) {
      try { await this.pollSina(insts); return; } catch { /* fall through */ }
    }
    try { await this.pollEastmoney(insts); } catch { /* keep last close */ }
  }

  async pollSina(insts) {
    const list = insts.map((i) => `nf_${i.dominant}`).join(",");
    const r = await fetch(`${CONFIG.quoteProxy.replace(/\/$/, "")}/?list=${list}`);
    if (!r.ok) throw new Error(`proxy ${r.status}`);
    const text = await r.text();
    let n = 0;
    for (const inst of insts) {
      const m = text.match(new RegExp(`hq_str_nf_${inst.dominant}="([^"]*)"`));
      if (!m || !m[1]) continue;
      const f = m[1].split(",");
      const price = +f[8], date = f[17], hhmmss = f[1].padStart(6, "0");
      if (!(price > 0)) continue;
      const ts = Date.parse(`${date}T${hhmmss.slice(0, 2)}:${hhmmss.slice(2, 4)}:${hhmmss.slice(4, 6)}+08:00`) / 1000;
      this.update(inst.symbol, price, ts, "Sina", "futures", inst.dominant, date);
      n++;
    }
    if (!n) throw new Error("empty proxy response");
  }

  pollEastmoney(insts) {
    return new Promise((resolve, reject) => {
      const cb = `ptv_em_${Date.now()}`;
      const secids = insts.map((i) => EASTMONEY[i.symbol]?.[0]).filter(Boolean).join(",");
      const s = document.createElement("script");
      const done = (ok) => { clearTimeout(to); delete window[cb]; s.remove(); ok ? resolve() : reject(new Error("eastmoney")); };
      const to = setTimeout(() => done(false), 8000);
      window[cb] = (j) => {
        const rows = j?.data?.diff || [];
        for (const row of rows) {
          const inst = insts.find((i) => EASTMONEY[i.symbol]?.[0].endsWith(`.${row.f12}`));
          if (!inst || !String(row.f14 || "").includes(EASTMONEY[inst.symbol][1])) continue; // sanity check name
          const price = +row.f2;
          if (!(price > 0)) continue;
          this.update(inst.symbol, price, +row.f124 || Date.now() / 1000, "Eastmoney", "futures", null, null, +row.f3 / 100);
        }
        done(rows.length > 0);
      };
      s.src = `https://push2.eastmoney.com/api/qt/ulist.np/get?fltt=2&secids=${secids}`
        + `&fields=f12,f14,f2,f3,f124&cb=${cb}&_=${Date.now()}`;
      s.onerror = () => done(false);
      document.head.appendChild(s);
    });
  }

  // ---------------------------------------------------------------- common
  update(sym, price, ts, source, group, contract = null, quoteDate = null, vendorChg = null) {
    if (!(price > 0)) return;
    const q = this.quotes.get(sym) || {};
    // If the quote belongs to a later session than our last bar, compare with our last close;
    // otherwise the last bar *is* today's session, so compare with the one before it.
    const qDate = quoteDate || new Date(ts * 1000).toISOString().slice(0, 10);
    const ref = q.lastDate && qDate <= q.lastDate ? q.prevClose : q.lastClose;
    const chg = vendorChg ?? (ref ? price / ref - 1 : NaN);
    this.quotes.set(sym, { ...q, price, chg, ts, source, contract, prevPrice: q.price });
    this.status[group] = "live";
    this.emit(sym);
  }
}

// China futures sessions (Asia/Shanghai). Exchange holidays are not modelled.
export function marketOpen(sym, now = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Shanghai", weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(now).map((p) => [p.type, p.value]));
  const wd = parts.weekday;
  const hm = (+parts.hour % 24) * 60 + +parts.minute;
  const inR = (a, b) => hm >= a && hm < b;
  const day = !["Sat", "Sun"].includes(wd)
    && (inR(9 * 60, 10 * 60 + 15) || inR(10 * 60 + 30, 11 * 60 + 30) || inR(13 * 60 + 30, 15 * 60));
  const night = NIGHT.has(sym) && !["Sat", "Sun"].includes(wd) && inR(21 * 60, 23 * 60);
  return day || night;
}
