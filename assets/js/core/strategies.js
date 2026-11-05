// Strategy library. Each strategy maps (bars, features, params) -> target[i] in [-1, 1],
// decided with information up to and including the CLOSE of bar i. The engine executes it at the
// OPEN of bar i+1, so a strategy cannot trade on the bar that produced its signal.
import { sma, rollingStd, priorMax, priorMin, isNum } from "./indicators.js";

const int = (key, label, def, min, max, step = 1, help = "") => ({ key, label, def, min, max, step, type: "int", help });
const num = (key, label, def, min, max, step, help = "") => ({ key, label, def, min, max, step, type: "float", help });

export const STRATEGIES = [
  {
    id: "sma_cross",
    name: "Moving-average crossover",
    family: "Trend",
    desc: "Long when the fast SMA is above the slow SMA, short when below.",
    params: [int("fast", "Fast SMA", 20, 2, 200), int("slow", "Slow SMA", 60, 5, 400)],
    sweep: { fast: [5, 10, 20, 30, 40, 60], slow: [40, 60, 90, 120, 160, 200] },
    signal(b, f, p) {
      if (p.fast >= p.slow) return new Array(b.n).fill(0);
      const a = sma(b.c, p.fast), s = sma(b.c, p.slow);
      return a.map((x, i) => (isNum(x) && isNum(s[i]) ? (x > s[i] ? 1 : -1) : 0));
    },
  },
  {
    id: "donchian",
    name: "Donchian breakout",
    family: "Trend",
    desc: "Turtle-style: enter on a close beyond the prior N-bar high/low, exit on the opposite M-bar channel.",
    params: [int("entry", "Entry channel", 55, 5, 300), int("exit", "Exit channel", 20, 2, 200)],
    sweep: { entry: [20, 40, 55, 80, 100, 150], exit: [10, 20, 30, 40, 55] },
    signal(b, f, p) {
      return breakoutStateMachine(b, p, () => true, () => true);
    },
  },
  {
    id: "boll_mr",
    name: "Bollinger mean reversion",
    family: "Mean reversion",
    desc: "Fade closes more than k standard deviations from the N-bar mean; exit at the mean.",
    params: [int("n", "Lookback", 20, 5, 200), num("k", "Band width (sd)", 2, 0.5, 4, 0.25)],
    sweep: { n: [10, 20, 30, 50, 80], k: [1, 1.5, 2, 2.5, 3] },
    signal(b, f, p) {
      const m = sma(b.c, p.n), sd = rollingStd(b.c, p.n);
      const out = new Array(b.n).fill(0);
      let pos = 0;
      for (let i = 0; i < b.n; i++) {
        if (!isNum(m[i]) || !isNum(sd[i])) { out[i] = 0; continue; }
        const z = (b.c[i] - m[i]) / (sd[i] || 1e-12);
        if (pos === 0) {
          if (z < -p.k) pos = 1;
          else if (z > p.k) pos = -1;
        } else if ((pos === 1 && z >= 0) || (pos === -1 && z <= 0)) {
          pos = 0;
        }
        out[i] = pos;
      }
      return out;
    },
  },
  {
    id: "tsmom",
    name: "Time-series momentum",
    family: "Trend",
    desc: "Sign of the trailing L-bar return (Moskowitz, Ooi & Pedersen 2012). Pair with volatility targeting.",
    params: [int("lookback", "Lookback", 120, 5, 500)],
    sweep: { lookback: [20, 40, 60, 90, 120, 180, 250] },
    signal(b, f, p) {
      return b.c.map((x, i) => (i >= p.lookback ? Math.sign(x / b.c[i - p.lookback] - 1) : 0));
    },
  },
  {
    id: "flow_breakout",
    name: "Flow-confirmed breakout",
    family: "Trend + flow",
    desc: "Donchian breakout that only enters when capital flow confirms the direction and attention is "
      + "above a threshold. Futures: open interest must be rising (a build-up, not short covering). "
      + "Crypto: Chaikin money flow must agree with the breakout.",
    params: [
      int("entry", "Entry channel", 40, 5, 300),
      int("exit", "Exit channel", 20, 2, 200),
      num("minAttention", "Min attention pct", 40, 0, 95, 5, "Skip breakouts nobody is watching"),
    ],
    sweep: { entry: [20, 30, 40, 55, 80, 100], minAttention: [0, 20, 40, 60, 80] },
    signal(b, f, p) {
      const confirm = (i, dir) => {
        if (!(f.attention[i] >= p.minAttention)) return false;
        if (f.flowKind === "futures") return f.dOI5[i] > 0; // new positions are being opened
        return dir > 0 ? f.cmf[i] > 0 : f.cmf[i] < 0;
      };
      return breakoutStateMachine(b, p, (i) => confirm(i, 1), (i) => confirm(i, -1));
    },
  },
];

function breakoutStateMachine(b, p, okLong, okShort) {
  const hi = priorMax(b.h, p.entry), lo = priorMin(b.l, p.entry);
  const xhi = priorMax(b.h, p.exit), xlo = priorMin(b.l, p.exit);
  const out = new Array(b.n).fill(0);
  let pos = 0;
  for (let i = 0; i < b.n; i++) {
    if (pos === 1 && isNum(xlo[i]) && b.c[i] < xlo[i]) pos = 0;
    else if (pos === -1 && isNum(xhi[i]) && b.c[i] > xhi[i]) pos = 0;
    if (pos <= 0 && isNum(hi[i]) && b.c[i] > hi[i] && okLong(i)) pos = 1;
    else if (pos >= 0 && isNum(lo[i]) && b.c[i] < lo[i] && okShort(i)) pos = -1;
    out[i] = pos;
  }
  return out;
}

export function getStrategy(id) {
  return STRATEGIES.find((s) => s.id === id);
}

export function defaultParams(strat) {
  return Object.fromEntries(strat.params.map((p) => [p.key, p.def]));
}
