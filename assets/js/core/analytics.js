// Market-structure analytics: Volatility, Attention, Capital Flow.
// The same feature set feeds the dashboard and the backtest strategies, so what you see is what you trade.
import {
  sma, realizedVol, parkinsonVol, rollingPercentile, rollingSum, pctChange, atr, cmf, isNum, meanDefined, last,
} from "./indicators.js";

export const VOL_WINDOW = 20;
export const FLOW_WINDOW = 5;

export function computeFeatures(bars) {
  const { c, h, l, o } = bars;
  const n = c.length;
  const A = bars.barsPerYear;
  const W = Math.max(60, Math.round(A)); // one year of bars for percentile context

  // ---------- Volatility
  const rv = realizedVol(c, VOL_WINDOW, A);
  const pk = parkinsonVol(h, l, VOL_WINDOW, A);
  const rvPct = rollingPercentile(rv, W);
  const atr14 = atr(h, l, c, 14);
  const atrPct = atr14.map((a, i) => a / c[i]);
  const ret = pctChange(c, 1);

  // ---------- Attention (how much the market is looking at this instrument)
  let activity, activityLabel, second, secondLabel;
  if (bars.isFutures) {
    const vol = bars.freq === "1d" ? bars.V : bars.v;
    const oi = bars.freq === "1d" ? bars.OI : bars.oi;
    activity = vol;
    activityLabel = bars.freq === "1d" ? "All-contract volume" : "Dominant-contract volume";
    // Volume / open interest: how fast positions turn over — speculative intensity.
    second = vol.map((v, i) => oi[i] > 0 ? v / oi[i] : NaN);
    secondLabel = "Turnover (volume / OI)";
  } else {
    activity = bars.v.map((v, i) => v * c[i]); // USD volume
    activityLabel = "USD volume (Coinbase spot)";
    if (bars.wiki && bars.wiki.some(isNum)) {
      second = bars.wiki.map((x) => (isNum(x) ? x : NaN));
      secondLabel = "Wikipedia pageviews";
    }
  }
  const actSmooth = sma(activity.map((v) => (v > 0 ? Math.log(v) : NaN)), FLOW_WINDOW);
  const actPct = rollingPercentile(actSmooth, W);
  const secPct = second ? rollingPercentile(sma(second, FLOW_WINDOW), W) : new Array(n).fill(NaN);
  const attention = actPct.map((a, i) => meanDefined([a, secPct[i]]));

  // ---------- Capital flow
  const price5 = pctChange(c, FLOW_WINDOW);
  let flow;
  if (bars.isFutures) flow = futuresFlow(bars, price5, W);
  else flow = cryptoFlow(bars, price5, W);

  return {
    n, W, ret, rv, pk, rvPct, atrPct,
    activity, activityLabel, actPct, second, secondLabel, secPct, attention, rvol: rvolFast(activity),
    price5, ...flow,
  };
}

function rvolFast(activity) {
  const m = sma(activity, VOL_WINDOW);
  return activity.map((v, i) => (m[i] > 0 ? v / m[i] : NaN));
}

function futuresFlow(bars, price5, W) {
  const daily = bars.freq === "1d";
  const oi = daily ? bars.OI : bars.oi;
  const mult = bars.inst.multiplier;
  // Bar-to-bar OI change. All-contract OI (daily) is roll-invariant; dominant-contract OI (hourly)
  // jumps at a roll, so those bars are masked.
  const dOI = oi.map((x, i) => {
    if (i === 0) return NaN;
    if (!daily && bars.ctr && bars.ctr[i] !== bars.ctr[i - 1]) return 0;
    return x - oi[i - 1];
  });
  const dOI5 = rollingSum(dOI, FLOW_WINDOW);
  const dOI5Pct = dOI5.map((d, i) => (i >= FLOW_WINDOW && oi[i - FLOW_WINDOW] > 0 ? d / oi[i - FLOW_WINDOW] : NaN));
  // Approximate capital committed: change in contracts x contract value (CNY).
  const flowValue = dOI5.map((d, i) => d * bars.rc[i] * mult);
  const notional = oi.map((x, i) => x * bars.rc[i] * mult);
  const oiPct = rollingPercentile(oi, W); // positioning crowdedness vs past year
  const flowPct = rollingPercentile(dOI5Pct, W);
  const regime = price5.map((p, i) => quadrantFutures(p, dOI5[i]));
  return {
    flowKind: "futures", oi, dOI, dOI5, dOI5Pct, flowValue, notional, oiPct, flowPct, regime,
    flowScore: dOI5Pct.map((x) => (isNum(x) ? Math.tanh(x / 0.05) : NaN)), // ~ +/-1 at +/-5% OI change
  };
}

function cryptoFlow(bars, price5, W) {
  const { h, l, c, v } = bars;
  const dv = v.map((x, i) => x * c[i]);
  const cmf20 = cmf(h, l, c, dv, 20);
  const mfv = c.map((ci, i) => {
    const r = h[i] - l[i];
    return r > 0 ? (((ci - l[i]) - (h[i] - ci)) / r) * dv[i] : 0;
  });
  const flowValue = rollingSum(mfv, FLOW_WINDOW); // signed USD flow proxy
  const fundAnn = (bars.fund || []).map((f) => (isNum(f) ? f * 24 * 365 : NaN)); // hourly rate -> annual
  const fundPct = rollingPercentile(fundAnn, W);
  const regime = price5.map((p, i) => quadrantCrypto(p, cmf20[i]));
  return {
    flowKind: "crypto", cmf: cmf20, flowValue, fundAnn, fundPct, regime,
    flowPct: rollingPercentile(cmf20, W),
    flowScore: cmf20.map((x) => (isNum(x) ? Math.tanh(x / 0.15) : NaN)),
  };
}

export const REGIMES = {
  long_buildup: { label: "Long build-up", short: "Longs adding", tone: "up",
    help: "Price up and open interest up: new money is entering on the long side." },
  short_buildup: { label: "Short build-up", short: "Shorts adding", tone: "down",
    help: "Price down and open interest up: new money is entering on the short side." },
  short_covering: { label: "Short covering", short: "Shorts exiting", tone: "up-weak",
    help: "Price up while open interest falls: the rally is driven by shorts closing, not new longs." },
  long_liquidation: { label: "Long liquidation", short: "Longs exiting", tone: "down-weak",
    help: "Price down while open interest falls: longs are closing out." },
  accumulation: { label: "Accumulation", short: "Buying pressure", tone: "up",
    help: "Price up and money flow positive: closes sit near highs on heavy volume." },
  distribution: { label: "Distribution", short: "Selling pressure", tone: "down",
    help: "Price down and money flow negative: closes sit near lows on heavy volume." },
  absorption: { label: "Absorption", short: "Dip bought", tone: "up-weak",
    help: "Price down but money flow positive: selling is being absorbed." },
  divergence: { label: "Weak rally", short: "Rally unbacked", tone: "down-weak",
    help: "Price up but money flow negative: the advance lacks volume support." },
  neutral: { label: "Neutral", short: "Flat", tone: "flat", help: "No clear flow signal." },
};

function quadrantFutures(p, d) {
  if (!isNum(p) || !isNum(d) || p === 0 || d === 0) return "neutral";
  if (p > 0) return d > 0 ? "long_buildup" : "short_covering";
  return d > 0 ? "short_buildup" : "long_liquidation";
}

function quadrantCrypto(p, m) {
  if (!isNum(p) || !isNum(m) || p === 0) return "neutral";
  if (p > 0) return m > 0 ? "accumulation" : "divergence";
  return m < 0 ? "distribution" : "absorption";
}

export function volRegime(pct) {
  if (!isNum(pct)) return { label: "—", tone: "flat" };
  if (pct >= 85) return { label: "Stressed", tone: "hot" };
  if (pct >= 60) return { label: "Elevated", tone: "warm" };
  if (pct >= 20) return { label: "Normal", tone: "flat" };
  return { label: "Calm", tone: "cool" };
}

export function attentionLabel(pct) {
  if (!isNum(pct)) return "—";
  if (pct >= 85) return "Crowded";
  if (pct >= 60) return "High";
  if (pct >= 30) return "Normal";
  return "Quiet";
}

export function snapshot(bars, f) {
  const i = bars.c.length - 1;
  return {
    t: bars.time[i], close: bars.c[i], raw: bars.rc ? bars.rc[i] : bars.c[i],
    ret1: f.ret[i], ret5: f.price5[i],
    rv: f.rv[i], rvPct: f.rvPct[i], pk: f.pk[i], atrPct: f.atrPct[i],
    attention: f.attention[i], actPct: f.actPct[i], secPct: f.secPct[i], rvol: f.rvol[i],
    regime: f.regime[i], flowValue: f.flowValue[i], flowScore: f.flowScore[i], flowPct: f.flowPct[i],
    oi: f.oi ? f.oi[i] : NaN, dOI5Pct: f.dOI5Pct ? f.dOI5Pct[i] : NaN, notional: f.notional ? f.notional[i] : NaN,
    oiPct: f.oiPct ? f.oiPct[i] : NaN,
    cmf: f.cmf ? f.cmf[i] : NaN, fundAnn: f.fundAnn ? last(f.fundAnn) : NaN, fundPct: f.fundPct ? last(f.fundPct) : NaN,
  };
}
