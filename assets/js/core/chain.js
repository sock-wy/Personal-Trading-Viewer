// Black-series industry-chain analytics, computed from raw dominant-contract closes.
//
// Rule-of-thumb input coefficients (per tonne of output):
//   steel  : 1.6 t iron ore + 0.5 t coke   -> rebar / hot-rolled coil
//   coking : 1.33 t coking coal            -> coke
// Spreads are shown GROSS of conversion costs (energy, labour, alloys, depreciation), which industry
// sources typically put at roughly 700–900 CNY/t for long steel and ~200–300 CNY/t for coking.
import { rollingPercentile, isNum } from "./indicators.js";

export const CHAIN_METRICS = [
  { id: "rb_margin", en: "Rebar mill spread", zh: "螺纹盘面利润",
    formula: "RB − 1.6×I − 0.5×J", unit: "CNY/t", legs: ["RB", "I", "J"],
    calc: (p) => p.RB - 1.6 * p.I - 0.5 * p.J,
    en_help: "Gross margin of a blast-furnace mill buying ore and coke on the futures curve.",
    zh_help: "高炉钢厂按期货价格买入矿石和焦炭、卖出螺纹的毛利。" },
  { id: "hc_margin", en: "HRC mill spread", zh: "热卷盘面利润",
    formula: "HC − 1.6×I − 0.5×J", unit: "CNY/t", legs: ["HC", "I", "J"],
    calc: (p) => p.HC - 1.6 * p.I - 0.5 * p.J,
    en_help: "Same as above for hot-rolled coil, the flat-steel / export-sensitive product.",
    zh_help: "热卷版本，代表板材与出口需求。" },
  { id: "coke_margin", en: "Coking spread", zh: "盘面焦化利润",
    formula: "J − 1.33×JM", unit: "CNY/t", legs: ["J", "JM"],
    calc: (p) => p.J - 1.33 * p.JM,
    en_help: "Gross margin of a coke plant converting coking coal into coke.",
    zh_help: "独立焦化厂将焦煤炼成焦炭的毛利。" },
  { id: "hc_rb", en: "HRC − rebar spread", zh: "卷螺差",
    formula: "HC − RB", unit: "CNY/t", legs: ["HC", "RB"],
    calc: (p) => p.HC - p.RB,
    en_help: "Flat vs long steel: manufacturing/export demand relative to property/construction demand.",
    zh_help: "板材与长材的相对强弱：制造业、出口需求 vs 地产、基建需求。" },
  { id: "rb_i", en: "Rebar / iron ore ratio", zh: "螺矿比",
    formula: "RB ÷ I", unit: "×", legs: ["RB", "I"],
    calc: (p) => p.RB / p.I,
    en_help: "How much steel pricing power mills have over their main raw material.",
    zh_help: "钢材相对于主要原料的议价能力。" },
  { id: "j_jm", en: "Coke / coking coal ratio", zh: "焦煤焦炭比",
    formula: "J ÷ JM", unit: "×", legs: ["J", "JM"],
    calc: (p) => p.J / p.JM,
    en_help: "Pricing power of coke plants over coal miners.",
    zh_help: "焦化厂相对于煤矿的议价能力。" },
  { id: "sf_sm", en: "Ferrosilicon − silicomanganese", zh: "硅铁锰硅价差",
    formula: "SF − SM", unit: "CNY/t", legs: ["SF", "SM"],
    calc: (p) => p.SF - p.SM,
    en_help: "Relative tightness of the two ferroalloys used in steelmaking.",
    zh_help: "两种炼钢用合金的相对紧张程度。" },
];

// barsBySym: { RB: bars, I: bars, ... } (daily, futures). Aligns on common dates.
export function computeChain(barsBySym) {
  const syms = Object.keys(barsBySym);
  const maps = Object.fromEntries(syms.map((s) => {
    const b = barsBySym[s];
    return [s, new Map(b.dates.map((d, i) => [d, b.rc[i]]))];
  }));
  const dates = barsBySym[syms[0]].dates.filter((d) => syms.every((s) => maps[s].has(d)));
  const out = { dates, series: {} };
  for (const m of CHAIN_METRICS) {
    const vals = dates.map((d) => {
      const p = Object.fromEntries(m.legs.map((s) => [s, maps[s].get(d)]));
      const v = m.calc(p);
      return isNum(v) ? v : NaN;
    });
    const pct1y = rollingPercentile(vals, 244);
    const pctAll = rollingPercentile(vals, vals.length, 60);
    const i = vals.length - 1;
    const yAgo = Math.max(0, i - 244);
    const window = vals.slice(yAgo).filter(isNum);
    const mean = window.reduce((a, b) => a + b, 0) / window.length;
    const sd = Math.sqrt(window.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, window.length - 1));
    out.series[m.id] = {
      values: vals, pct1y, last: vals[i], pctNow: pct1y[i], pctAllNow: pctAll[i],
      z1y: sd > 0 ? (vals[i] - mean) / sd : NaN,
      chg20: i >= 20 ? vals[i] - vals[i - 20] : NaN,
      min1y: Math.min(...window), max1y: Math.max(...window),
    };
  }
  return out;
}
