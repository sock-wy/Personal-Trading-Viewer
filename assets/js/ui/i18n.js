// Minimal bilingual support: L("English", "中文") picks the active language.
let lang = "en";
try { lang = localStorage.getItem("ptv.lang") || "en"; } catch { /* ignore */ }
document.documentElement.lang = lang === "zh" ? "zh-CN" : "en";

export const getLang = () => lang;
export function setLang(l) {
  lang = l;
  try { localStorage.setItem("ptv.lang", l); } catch { /* ignore */ }
  document.documentElement.lang = l === "zh" ? "zh-CN" : "en";
}
export const L = (en, zh) => (lang === "zh" ? zh : en);

const CRYPTO_ZH = { BTC: "比特币", ETH: "以太坊", SOL: "Solana" };
export const instName = (inst) => (lang === "zh" ? (inst.cn || CRYPTO_ZH[inst.symbol] || inst.name) : inst.name);
// Secondary name shown under the symbol: the other language for futures.
export const instSub = (inst) => (inst.group === "futures"
  ? (lang === "zh" ? `${inst.cn} · ${inst.name}` : `${inst.name} · ${inst.cn}`)
  : instName(inst));

// Static labels in index.html carry data-i18n="English|中文".
export function paintStatic(root = document) {
  root.querySelectorAll("[data-i18n]").forEach((el) => {
    const [en, zh] = el.dataset.i18n.split("|");
    el.textContent = lang === "zh" ? zh : en;
  });
}
