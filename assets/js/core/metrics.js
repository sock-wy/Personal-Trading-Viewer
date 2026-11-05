// Performance statistics from an equity curve.

export function computeMetrics(res) {
  const eq = res.equity;
  const n = eq.length;
  const A = res.barsPerYear;
  const rets = [];
  for (let i = 1; i < n; i++) rets.push(eq[i - 1] > 0 ? eq[i] / eq[i - 1] - 1 : 0);
  const years = Math.max(1e-9, (n - 1) / A);
  const total = eq[n - 1] / eq[0] - 1;
  const cagr = eq[n - 1] > 0 ? Math.pow(eq[n - 1] / eq[0], 1 / years) - 1 : -1;
  const mean = rets.reduce((a, b) => a + b, 0) / Math.max(1, rets.length);
  const sd = Math.sqrt(rets.reduce((a, r) => a + (r - mean) ** 2, 0) / Math.max(1, rets.length - 1));
  const dsd = Math.sqrt(rets.reduce((a, r) => a + Math.min(0, r) ** 2, 0) / Math.max(1, rets.length - 1));
  const vol = sd * Math.sqrt(A);
  const sharpe = sd > 0 ? (mean / sd) * Math.sqrt(A) : NaN;
  const sortino = dsd > 0 ? (mean / dsd) * Math.sqrt(A) : NaN;

  // drawdown series and the longest underwater stretch
  const dd = new Array(n);
  let peak = eq[0], maxDD = 0, ddStart = 0, longest = 0, curStart = 0;
  for (let i = 0; i < n; i++) {
    if (eq[i] >= peak) { peak = eq[i]; curStart = i; }
    dd[i] = peak > 0 ? eq[i] / peak - 1 : 0;
    if (dd[i] < maxDD) { maxDD = dd[i]; ddStart = curStart; }
    longest = Math.max(longest, i - curStart);
  }
  void ddStart;
  const calmar = maxDD < 0 ? cagr / -maxDD : NaN;

  const closed = (res.trades || []).filter((t) => !t.openTrade);
  const wins = closed.filter((t) => t.pnl > 0);
  const losses = closed.filter((t) => t.pnl <= 0);
  const grossWin = wins.reduce((a, t) => a + t.pnl, 0);
  const grossLoss = -losses.reduce((a, t) => a + t.pnl, 0);
  const exposure = res.exposure || [];
  const inMarket = exposure.filter((x) => Math.abs(x) > 1e-9).length / Math.max(1, exposure.length);
  const avgCapital = eq.reduce((a, b) => a + b, 0) / n;

  return {
    totalReturn: total, cagr, vol, sharpe, sortino, maxDD, calmar,
    maxDDBars: longest, maxDDDays: Math.round((longest / A) * 365),
    trades: closed.length, openTrades: (res.trades || []).length - closed.length,
    winRate: closed.length ? wins.length / closed.length : NaN,
    avgWin: wins.length ? grossWin / wins.length : NaN,
    avgLoss: losses.length ? -grossLoss / losses.length : NaN,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? Infinity : NaN),
    avgBarsHeld: closed.length ? closed.reduce((a, t) => a + t.bars, 0) / closed.length : NaN,
    exposure: inMarket,
    turnoverPerYear: (res.turnover || 0) / avgCapital / years,
    costDrag: (res.totalCost || 0) / avgCapital / years,
    years, drawdown: dd,
  };
}

// Calendar-month returns from an equity curve with ISO dates.
export function monthlyReturns(dates, equity) {
  const ends = new Map();
  let firstKey = null, startEq = equity[0];
  for (let i = 0; i < dates.length; i++) {
    const k = dates[i].slice(0, 7);
    if (firstKey === null) firstKey = k;
    ends.set(k, equity[i]);
  }
  const out = [];
  let prev = startEq;
  for (const [k, v] of ends) {
    out.push({ year: +k.slice(0, 4), month: +k.slice(5, 7), ret: prev > 0 ? v / prev - 1 : 0 });
    prev = v;
  }
  return out;
}
