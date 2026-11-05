export async function renderMethod(ctx) {
  const { meta, view } = ctx;
  const fut = meta.instruments.filter((i) => i.group === "futures");
  view.innerHTML = `
  <div class="page-head"><div><div class="eyebrow">Methodology</div><h1>How the numbers are made</h1>
    <p>Everything on this site is computed from public data by a small Python pipeline (data) and plain JavaScript
    modules (analytics and backtest) that run in your browser. The same feature code drives the dashboard and the
    strategies.</p></div></div>
  <div class="prose">
    <h2>1. Continuous futures, built from individual contracts</h2>
    <p>Vendor "main continuous" series (e.g. <code>RB0</code>) splice consecutive contracts together, so each roll
    shows up as a price jump equal to the calendar spread. On iron ore and coking coal those gaps reach 15–19%.
    A backtest on such a series books the spread as profit or loss.</p>
    <p>Instead the pipeline downloads every listed contract (expired ones included, back to 2018) and:</p>
    <ol>
      <li>picks the <b>dominant contract</b> each day by open interest, using only the previous close
          (a later-expiry contract replaces the current one once its open interest is larger; no rolling backwards);</li>
      <li><b>ratio back-adjusts</b> history at each roll: earlier prices are multiplied by new/old close on the decision day,
          so the series' returns are exactly those of holding and rolling the dominant contract;</li>
      <li>sums volume and open interest <b>across all contracts</b>, which is roll-invariant and is what the capital-flow
          analytics use.</li>
    </ol>
    <p>As a check, our dominant contract agrees with the vendor's main contract on the large majority of days:</p>
    <table><tr><th>Product</th><th>Exchange</th><th>Rolls</th><th>Same close as vendor main</th><th>Current dominant</th></tr>
      ${fut.map((i) => `<tr><td>${i.symbol} ${i.name} ${i.cn}</td><td>${i.exchange}</td><td>${i.rolls.length}</td><td>${i.validation?.same_close_as_vendor_main_pct ?? "—"}%</td><td>${i.dominant}</td></tr>`).join("")}
    </table>
    <p>Hourly bars are spliced the same way: each trading day uses the 60-minute bars of that day's dominant contract,
    scaled by the same adjustment factor. Night-session bars (21:00–23:00) belong to the next trading day.</p>

    <h2>2. Volatility</h2>
    <p><code>RV20</code> is the annualized standard deviation of 20 log returns. The <b>Parkinson</b> estimator uses the
    high–low range, <code>σ² = mean(ln(H/L)²) / (4 ln 2)</code>, and is more efficient when there are no gaps. Each is
    ranked against its own trailing year to give a percentile and a regime (calm, normal, elevated, stressed).</p>

    <h2>3. Attention</h2>
    <p>A 0–100 score: the average of two trailing-year percentiles of 5-bar averages.</p>
    <table><tr><th></th><th>Futures</th><th>Crypto</th></tr>
      <tr><td>Activity</td><td>All-contract volume</td><td>USD volume (Coinbase spot)</td></tr>
      <tr><td>Second signal</td><td>Turnover = volume / open interest (speculative intensity)</td><td>Wikipedia pageviews (retail curiosity)</td></tr></table>

    <h2>4. Capital flow</h2>
    <p><b>Futures.</b> Open interest counts contracts that are still open, so its change measures money entering or
    leaving. Combined with price over five bars it gives four regimes: long build-up (price ↑, OI ↑), short build-up
    (price ↓, OI ↑), short covering (price ↑, OI ↓) and long liquidation (price ↓, OI ↓). "Capital committed" is the
    OI change times the contract value; notional OI is OI × price × multiplier.</p>
    <p><b>Crypto.</b> Spot venues publish no open interest, so flow uses the Chaikin money-flow ratio (where closes sit in
    the bar's range, weighted by USD volume) and, for positioning, the Hyperliquid perpetual funding rate annualized.</p>

    <h2>5. Backtest engine</h2>
    <ul>
      <li><b>No look-ahead.</b> A strategy outputs a target position at each bar's close; the engine fills it at the next
          open. A unit test re-runs every feature and strategy on truncated history and asserts nothing in the past changes.</li>
      <li><b>Futures realism.</b> Whole lots × multiplier, initial-margin cap at every fill, commission and slippage in bps,
          roll cost (close + reopen) whenever the dominant contract changes under an open position.</li>
      <li><b>P&amp;L.</b> Returns come from the adjusted series; notional, lot size and costs from the raw contract price.</li>
      <li><b>Metrics.</b> CAGR, volatility, Sharpe and Sortino (rf = 0), max drawdown and its length, Calmar, win rate, profit
          factor, time in market, turnover and cost drag. The parameter sweep shows how sensitive Sharpe is to the inputs.</li>
    </ul>

    <h2>6. Live quotes</h2>
    <p>Crypto streams from the Coinbase Exchange WebSocket. Futures use Eastmoney's public quote feed (or Sina through an
    optional Cloudflare Worker for exact contracts). If a feed is unreachable the board shows the last close and says so.</p>

    <h2>7. Known limitations</h2>
    <ul>
      <li>Exchange holidays, price limits and auction effects are not modelled.</li>
      <li>Open interest conventions differ by exchange; analytics use changes and percentiles, which are convention-free.</li>
      <li>Hourly futures history starts in 2023; per-contract 60-minute data is not available earlier.</li>
      <li>Results are in-sample. Treat any single parameter set with suspicion.</li>
    </ul>
  </div>`;
  return () => {};
}
