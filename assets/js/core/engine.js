// Bar-by-bar backtest engine.
//
// Timing:   target[i] is decided at the close of bar i and filled at the OPEN of bar i+1.
// Prices:   P&L uses back-adjusted prices for returns (so contract rolls create no fake P&L) and
//           the raw dominant-contract price for notional, lot sizing, margin and costs.
// Futures:  integer lots x contract multiplier, exchange-style margin check, roll cost charged when
//           the dominant contract changes while a position is open.
// Crypto:   fractional units, fees in bps.
import { isNum } from "./indicators.js";
import { computeMetrics } from "./metrics.js";

export const DEFAULTS = {
  futures: { capital: 1_000_000, commissionBps: 1, slippageBps: 2, marginRate: 0.12, leverage: 1 },
  crypto: { capital: 100_000, commissionBps: 6, slippageBps: 2, marginRate: 1, leverage: 1 },
};

export function runBacktest(bars, features, targets, cfg) {
  const isF = bars.isFutures;
  const mult = isF ? bars.inst.multiplier : 1;
  const costRate = (cfg.commissionBps + cfg.slippageBps) / 1e4;
  const s = cfg.startIdx ?? 0;
  const e = cfg.endIdx ?? bars.n - 1;
  const band = cfg.rebalanceBand ?? 0.25;
  const { o, c, rc } = bars;
  const rawPer = (i) => (isF ? rc[i] / c[i] : 1); // raw price per unit of adjusted price on bar i

  const sizeAt = (i) => {
    let t = targets[i];
    if (!isNum(t)) t = 0;
    if (!cfg.allowShort && t < 0) t = 0;
    if (cfg.allowLong === false && t > 0) t = 0;
    let lev = cfg.leverage;
    if (cfg.sizing === "voltarget") {
      const rv = features.rv[i];
      lev = isNum(rv) && rv > 0 ? Math.min(cfg.maxLeverage, cfg.targetVol / rv) : 0;
    }
    return t * lev;
  };

  const equity = [], exposure = [], time = [], dates = [];
  const trades = [];
  const fills = [];
  let eq = cfg.capital;
  let q = 0;                 // contracts (futures) or units (crypto)
  let totalCost = 0, rollCost = 0, turnover = 0, marginCapped = 0, ruined = false, maxMarginUse = 0;
  let open = null;           // current trade episode

  equity.push(eq); exposure.push(0); time.push(bars.time[s]); dates.push(bars.dates[s]);

  for (let i = s + 1; i <= e; i++) {
    const rawOpen = o[i] * rawPer(i);
    const unitCost = mult * rawOpen * costRate;

    // 1) gap P&L (previous close -> this open) on the carried position, plus roll cost if the
    //    dominant contract changed overnight. Adjusted prices make the gap roll-neutral.
    const gapPnl = q * mult * rc[i - 1] * (o[i] / c[i - 1] - 1);
    const rolled = isF && q !== 0 && bars.ctr && bars.ctr[i] !== bars.ctr[i - 1];
    const rollC = rolled ? 2 * Math.abs(q) * unitCost : 0;

    // 2) rebalance at the open toward the target decided at the previous close
    const eqOpen = eq + gapPnl - rollC;
    const tgt = sizeAt(i - 1);
    let qd = eqOpen > 0 ? (tgt * eqOpen) / (mult * rawOpen) : 0;
    if (isF) qd = Math.trunc(qd);
    // skip tiny same-side resizes to avoid churning costs
    if (q !== 0 && Math.sign(qd) === Math.sign(q) && Math.abs(qd - q) / Math.abs(q) < band) qd = q;
    if (isF) { // margin check is applied last so no rule can hold a position the account can't margin
      const maxLots = Math.floor(Math.max(0, eqOpen) / (mult * rawOpen * cfg.marginRate));
      if (Math.abs(qd) > maxLots) { qd = Math.sign(qd) * maxLots; marginCapped++; }
      if (eqOpen > 0) maxMarginUse = Math.max(maxMarginUse, (Math.abs(qd) * mult * rawOpen * cfg.marginRate) / eqOpen);
    }
    const dq = qd - q;
    const tradeC = Math.abs(dq) * unitCost;
    if (dq !== 0) {
      turnover += Math.abs(dq) * mult * rawOpen;
      fills.push({ i, time: bars.time[i], qty: dq, price: rawOpen, adjPrice: o[i] });
    }

    // 3) intrabar P&L (open -> close) on the new position
    const intraPnl = qd * mult * rawOpen * (c[i] / o[i] - 1);

    eq = eq + gapPnl + intraPnl - rollC - tradeC;
    totalCost += rollC + tradeC;
    rollCost += rollC;

    // trade-episode attribution
    const closes = q !== 0 && (qd === 0 || Math.sign(qd) !== Math.sign(q));
    if (open) {
      open.pnl += gapPnl - rollC;
      if (closes) {
        open.pnl -= Math.abs(q) * unitCost; // cost of closing the old position
        Object.assign(open, { exitI: i, exitTime: bars.time[i], exitPrice: rawOpen, bars: i - open.entryI });
        open.ret = open.pnl / open.entryEquity;
        trades.push(open);
        open = null;
      }
    }
    if (qd !== 0) {
      if (!open) {
        open = { dir: Math.sign(qd), entryI: i, entryTime: bars.time[i], entryPrice: rawOpen,
          entryEquity: eqOpen, lots: qd, pnl: -Math.abs(qd) * unitCost };
      } else {
        open.pnl -= tradeC; // resize on the same side
      }
      open.pnl += intraPnl;
    }
    q = qd;

    if (eq <= 0) { // account blown: liquidate and stop
      eq = 0; q = 0; ruined = true;
      if (open) {
        Object.assign(open, { exitI: i, exitTime: bars.time[i], exitPrice: c[i] * rawPer(i), bars: i - open.entryI });
        open.ret = open.pnl / open.entryEquity; trades.push(open); open = null;
      }
    }
    equity.push(eq);
    exposure.push(eq > 0 ? (q * mult * rc[i]) / eq : 0);
    time.push(bars.time[i]); dates.push(bars.dates[i]);
    if (ruined) break;
  }
  if (open) {
    open.exitI = null; open.exitTime = null; open.exitPrice = c[e] * rawPer(e);
    open.ret = open.pnl / open.entryEquity; open.bars = e - open.entryI; open.openTrade = true;
    trades.push(open);
  }

  // Buy-and-hold benchmark on adjusted prices, no costs, 1x.
  const bench = [];
  for (let i = s; i <= s + equity.length - 1; i++) bench.push(cfg.capital * (c[i] / c[s]));

  const res = { equity, bench, exposure, time, dates, trades, fills, totalCost, rollCost, turnover,
    marginCapped, maxMarginUse, ruined, capital: cfg.capital, barsPerYear: bars.barsPerYear };
  res.metrics = computeMetrics(res);
  res.benchMetrics = computeMetrics({ ...res, equity: bench, trades: [], exposure: bench.map(() => 1), totalCost: 0, turnover: 0 });
  return res;
}
