# Personal Trading Viewer

**Live site → https://sock-wy.github.io/Personal-Trading-Viewer/**

A market dashboard and in-browser backtester for **China black-series futures** (rebar, hot-rolled coil, iron ore,
coke, coking coal, ferrosilicon, silicomanganese) and **crypto** (BTC, ETH, SOL).

Every instrument is read on three axes:

| Axis | Question | Futures | Crypto |
|---|---|---|---|
| **Attention** | Is the market looking? | All-contract volume, turnover (volume / open interest) | USD volume, Wikipedia pageviews |
| **Volatility** | How hard is it moving vs. its own history? | Realized vol (close-to-close and Parkinson), 1-year percentile, regime | same |
| **Capital flow** | Is new money opening positions, or old money leaving? | 5-day change in all-contract open interest × price direction → long/short build-up, short covering, long liquidation | Chaikin money flow, perpetual funding rate |

The backtester runs the same feature code, so a strategy can trade on exactly what the dashboard shows.

---

## What is in it

- **Markets** — one board for both asset groups: live price, volatility regime, attention score, capital-flow regime,
  60-day sparkline, and an attention × volatility "market map".
- **Instrument pages** — daily and hourly candles with volume and roll markers, plus synced panes for volatility,
  attention and capital flow, and a plain-English reading of the current state.
- **Backtest** — five strategies (MA crossover, Donchian breakout, Bollinger mean reversion, time-series momentum,
  and a flow-confirmed breakout), fixed-leverage or volatility-target sizing, costs, and a parameter-sweep heatmap.
  Results include equity vs. buy-and-hold, drawdown, fills on the price chart, monthly returns and a trade log.
  Every configuration is encoded in the URL, so a backtest can be shared as a link.
- **Methodology** — how the data is built and what each number means.

## Engineering decisions worth noting

### 1. Futures series are rebuilt from individual contracts

Vendor "main continuous" series (e.g. Sina `RB0`) splice consecutive contracts, so every roll appears as a price jump
equal to the calendar spread — up to **18.6%** on coking coal in this data set. A backtest on that series books the
spread as P&L.

The pipeline instead downloads **every listed contract** (≈100 per product, expired ones included, from 2018) and:

1. chooses the **dominant contract** by open interest using only the previous close, never rolling backwards;
2. applies **ratio back-adjustment** at each roll (`earlier prices × new/old` on the decision day), so continuous
   returns equal the return of holding and rolling the dominant contract;
3. sums volume and open interest **across all contracts**, which is roll-invariant and drives the flow analytics.

Validation: the selected dominant contract matches the vendor's main contract on 93–99% of days (differences are roll
timing). Hourly bars are spliced with the same schedule and factors, with night-session bars assigned to the next
trading day.

### 2. The backtester cannot see the future

- A strategy returns a target position decided at the **close** of bar *i*; the engine fills it at the **open** of bar *i+1*.
- `tests/engine.test.mjs` re-computes every feature and every strategy on truncated history and asserts that no past
  value changes when future bars are added.
- Further tests check fill timing on synthetic data, that a long position across a roll earns **zero** from the
  calendar-spread gap (only roll cost), integer lots, and that margin at each fill never exceeds equity.

### 3. Futures are traded like futures

Whole lots × contract multiplier, an initial-margin cap at every fill, commission and slippage in basis points, and a
roll cost (close + reopen) whenever the dominant contract changes under an open position. Returns come from the
adjusted series; notional, lot size and costs from the raw contract price.

### 4. Static, global, and degrades gracefully

- No server. GitHub Actions rebuilds the JSON data after each China close and each crypto daily close, runs the test
  suite, and commits; GitHub Pages serves the site.
- The only runtime library (TradingView Lightweight Charts) is vendored, and fonts are system fonts, so the page does
  not depend on any CDN that may be blocked in some regions.
- Live quotes: Coinbase WebSocket for crypto; Eastmoney's public feed (or Sina via an optional Cloudflare Worker) for
  futures. If a feed is unreachable the board shows the last close and labels it as such.
- Data sources were chosen to work from US-hosted CI runners (Binance and OKX geo-block US IPs).

## Architecture

```
pipeline/                 Python data build (runs in GitHub Actions)
  futures.py              Sina per-contract daily + 60m bars -> roll schedule -> adjusted series
  crypto.py               Coinbase candles, Hyperliquid funding, Wikimedia pageviews
  build.py                entry point, writes data/meta.json
  cache/                  raw per-contract bars, so daily updates are incremental
data/                     published JSON (daily/, hourly/, meta.json)
assets/js/core/           pure, framework-free modules (also run under Node for tests)
  indicators.js           causal rolling indicators, O(n log n) rolling percentile (Fenwick tree)
  analytics.js            attention / volatility / capital-flow features and regimes
  strategies.js           strategy library: (bars, features, params) -> target positions
  engine.js               bar-by-bar execution, lots, margin, costs, rolls
  metrics.js              CAGR, Sharpe, Sortino, drawdown, Calmar, trade stats, monthly returns
assets/js/ui/             views: markets, instrument, backtest, methodology; live quotes
worker/                   optional Cloudflare Worker for Sina real-time futures quotes
tests/                    node:test suite
```

## Data sources

| Data | Source | Coverage |
|---|---|---|
| Futures daily bars, per contract | Sina Finance | Jun 2019 → today (continuous series) |
| Futures 60-minute bars, per contract | Sina Finance | Jan 2023 → today |
| Crypto daily and hourly candles | Coinbase Exchange (spot, USD) | BTC/ETH 2017 →, SOL 2021 →; hourly 2023 → |
| Perpetual funding rate | Hyperliquid | May 2023 → |
| Pageviews | Wikimedia REST API | 2016 → |

## Running locally

```bash
# serve the site
python3 -m http.server 8000          # then open http://localhost:8000

# rebuild data (incremental; first run downloads ~750 contracts, a few minutes)
pip install -r pipeline/requirements.txt
python3 pipeline/build.py            # or --only futures / --only crypto

# tests
npm test
```

### Optional: real-time futures via Cloudflare Worker

```bash
cd worker && npx wrangler deploy
```

Then set `quoteProxy` in `assets/js/config.js` to the worker URL. The worker only relays `nf_*` futures symbols and
only allows this site's origin.

## Limitations

- Exchange holidays, price limits and call-auction effects are not modelled.
- Open-interest reporting conventions differ by exchange; the analytics use changes and percentiles, which do not
  depend on the convention.
- Hourly futures history starts in 2023 because per-contract 60-minute data is not available earlier.
- All results are in-sample. The parameter sweep is there to show sensitivity, not to pick a winner.

*For research and education only. Not investment advice.*
