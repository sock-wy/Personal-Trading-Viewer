import { getLang } from "./i18n.js";

export async function renderMethod(ctx) {
  const { meta, view } = ctx;
  const fut = meta.instruments.filter((i) => i.group === "futures");
  const table = `<table><tr><th>${getLang() === "zh" ? "品种" : "Product"}</th><th>${getLang() === "zh" ? "交易所" : "Exchange"}</th><th>${getLang() === "zh" ? "换月次数" : "Rolls"}</th><th>${getLang() === "zh" ? "与供应商主连收盘一致" : "Same close as vendor main"}</th><th>${getLang() === "zh" ? "当前主力" : "Current dominant"}</th></tr>
    ${fut.map((i) => `<tr><td>${i.symbol} ${getLang() === "zh" ? i.cn : i.name}</td><td>${i.exchange}</td><td>${i.rolls.length}</td><td>${i.validation?.same_close_as_vendor_main_pct ?? "—"}%</td><td>${i.dominant}</td></tr>`).join("")}</table>`;
  view.innerHTML = getLang() === "zh" ? zh(table) : en(table);
  return () => {};
}

const en = (table) => `
  <div class="page-head"><div><div class="eyebrow">Methodology</div><h1>How the numbers are made</h1>
    <p>Everything on this site is computed from public data by a small Python pipeline (data) and plain JavaScript
    modules (analytics and backtest) that run in your browser. The same feature code drives the dashboard and the strategies.</p></div></div>
  <div class="prose">
    <h2>1. Continuous futures, built from individual contracts</h2>
    <p>Vendor "main continuous" series (e.g. <code>RB0</code>) splice consecutive contracts, so each roll shows up as a price
    jump equal to the calendar spread — up to 15–19% on iron ore and coking coal. A backtest on such a series books the spread as P&amp;L.</p>
    <p>Instead the pipeline downloads every listed contract (expired ones included, back to 2018) and:</p>
    <ol>
      <li>picks the <b>dominant contract</b> each day by open interest, using only the previous close (a later-expiry contract
        replaces the current one once its open interest is larger; no rolling backwards);</li>
      <li><b>ratio back-adjusts</b> history at each roll: earlier prices are multiplied by new/old close on the decision day, so the
        series' returns are exactly those of holding and rolling the dominant contract;</li>
      <li>sums volume and open interest <b>across all contracts</b>, which is roll-invariant and drives the capital-flow analytics.</li>
    </ol>
    <p>Check against the vendor's main contract:</p>${table}
    <p>Hourly bars are spliced the same way; night-session bars (21:00–23:00) belong to the next trading day.</p>

    <h2>2. Volatility</h2>
    <p><code>RV20</code> is the annualized standard deviation of 20 log returns. The <b>Parkinson</b> estimator uses the high–low range,
    <code>σ² = mean(ln(H/L)²) / (4 ln 2)</code>. Each is ranked against its own trailing year to give a percentile and a regime.</p>

    <h2>3. Attention</h2>
    <p>A 0–100 score: the average of two trailing-year percentiles of 5-bar averages — futures: all-contract volume and
    turnover (volume / open interest); crypto: USD volume and Wikipedia pageviews.</p>

    <h2>4. Capital flow</h2>
    <p><b>Futures.</b> The change in open interest measures money entering or leaving. Combined with price over five bars it gives four
    regimes: long build-up (price ↑, OI ↑), short build-up (price ↓, OI ↑), short covering (price ↑, OI ↓), long liquidation (price ↓, OI ↓).</p>
    <p><b>Crypto.</b> Spot venues publish no open interest, so flow uses Chaikin money flow and the Hyperliquid perpetual funding rate.</p>

    <h2>5. Market structure tools</h2>
    <ul>
      <li><b>Open-interest scanner.</b> All-contract OI against its peak since 2019; flags a new high or ≥ 90% of the peak — crowded positioning.</li>
      <li><b>Market profile.</b> Volume profile (VP) and time-at-price profile (TPO) from hourly bars over 20/60/120 trading days, with each
        bar's weight spread across its range. POC = busiest price; value area = range holding 70% of the weight.</li>
      <li><b>Positioning cost line.</b> An estimate of the average entry price of open positions:
        <code>cost<sub>t</sub> = (1 − a)·cost<sub>t−1</sub> + a·typical<sub>t</sub></code>, <code>a = 1 − λ(1 − n<sub>t</sub>)</code>,
        <code>λ = 0.5<sup>1/half-life</sup></code>. For futures <code>n</code> is the share of today's OI that is new; for crypto it is today's
        share of 20-bar volume. Price above the line means the average holder is in profit.</li>
      <li><b>Industry chain.</b> Gross spreads on the futures curve: rebar/HRC mill margin <code>RB − 1.6·I − 0.5·J</code>, coking margin
        <code>J − 1.33·JM</code>, HRC−rebar, rebar/ore and coke/coal ratios, ferroalloy spread — with 1-year percentiles and z-scores.</li>
      <li><b>Position calculator.</b> Lots = capital × risk% ÷ (k × ATR × multiplier), with notional, leverage and margin used.</li>
    </ul>

    <h2>6. Backtest engine</h2>
    <ul>
      <li><b>No look-ahead.</b> A target position is decided at each bar's close and filled at the next open. A unit test re-runs every
        feature and strategy on truncated history and asserts nothing in the past changes.</li>
      <li><b>Futures realism.</b> Whole lots × multiplier, margin cap at every fill, commission and slippage, roll cost on each contract switch.</li>
      <li><b>Metrics.</b> CAGR, volatility, Sharpe, Sortino, max drawdown and its length, Calmar, win rate, profit factor, exposure,
        turnover, cost drag; a parameter sweep shows sensitivity.</li>
    </ul>

    <h2>7. Known limitations</h2>
    <ul>
      <li>Exchange holidays, price limits and auction effects are not modelled.</li>
      <li>Open-interest conventions differ by exchange; analytics use changes and percentiles.</li>
      <li>Hourly futures history starts in 2023. Results are in-sample.</li>
    </ul>
  </div>`;

const zh = (table) => `
  <div class="page-head"><div><div class="eyebrow">方法论</div><h1>数据与指标是怎么来的</h1>
    <p>本站所有数据均来自公开数据源：Python 管线负责抓取与构建数据，分析与回测由在浏览器中运行的 JavaScript 模块完成。
    看板和策略使用同一套特征代码。</p></div></div>
  <div class="prose">
    <h2>1. 由单合约重建的期货连续序列</h2>
    <p>行情软件的"主力连续"（如 <code>RB0</code>）只是把相邻合约拼接起来，每次换月都会出现一个等于跨期价差的跳空——
    铁矿石、焦煤上可达 15–19%。基于这种序列做回测，会把价差误记为盈亏。</p>
    <p>本站管线下载每一个上市合约（包括已到期合约，最早到 2018 年），并且：</p>
    <ol>
      <li>按持仓量逐日确定<b>主力合约</b>，只使用前一日收盘信息（更远月合约持仓超过当前主力时才切换，不会往回切）；</li>
      <li>在每次换月时做<b>比例复权</b>：之前的价格乘以决策日新/旧合约收盘价之比，使连续序列的收益恰好等于持有并滚动主力合约的收益；</li>
      <li>将<b>全部合约</b>的成交量和持仓量加总——这一数值不受换月影响，是资金流动分析的基础。</li>
    </ol>
    <p>与供应商主连的对比：</p>${table}
    <p>小时线按相同的换月表与复权因子拼接；夜盘（21:00–23:00）归属下一交易日。</p>

    <h2>2. 波动率</h2>
    <p><code>RV20</code> 为 20 个对数收益率的年化标准差；<b>Parkinson</b> 估计量利用高低价区间：
    <code>σ² = mean(ln(H/L)²) / (4 ln 2)</code>。两者都与自身过去一年比较，得到分位和所处区间。</p>

    <h2>3. 关注度</h2>
    <p>0–100 的得分，为两个 5 期均值的一年分位的平均：期货用全合约成交量与换手率（成交/持仓）；加密货币用美元成交额与维基百科浏览量。</p>

    <h2>4. 资金流动</h2>
    <p><b>期货。</b>持仓量的变化反映资金的进出。结合 5 期价格方向分为四种状态：多头增仓（价↑仓↑）、空头增仓（价↓仓↑）、
    空头回补（价↑仓↓）、多头平仓（价↓仓↓）。</p>
    <p><b>加密货币。</b>现货交易所不公布持仓量，因此使用 Chaikin 资金流与 Hyperliquid 永续合约资金费率。</p>

    <h2>5. 市场结构工具</h2>
    <ul>
      <li><b>持仓量异动扫描。</b>全合约持仓与 2019 年以来峰值比较；创新高或达到峰值 90% 时提示——仓位拥挤。</li>
      <li><b>市场轮廓。</b>基于小时 K 线，统计最近 20/60/120 个交易日的成交量分布（VP）和时间分布（TPO），每根 K 线的权重均匀分布在其高低价区间。
        POC 为成交最密集价位；价值区为覆盖 70% 权重的价格区间。</li>
      <li><b>持仓成本线（TDOI-WAP）。</b>估计未平仓头寸的平均建仓价格：
        <code>cost<sub>t</sub> = (1 − a)·cost<sub>t−1</sub> + a·典型价<sub>t</sub></code>，<code>a = 1 − λ(1 − n<sub>t</sub>)</code>，
        <code>λ = 0.5<sup>1/半衰期</sup></code>。期货中 <code>n</code> 为当日新增持仓占比；加密货币中为当日成交量占 20 期成交量的比例。
        价格在成本线上方，意味着平均持仓者处于盈利。</li>
      <li><b>产业链分析。</b>期货盘面毛利：螺纹/热卷钢厂利润 <code>RB − 1.6·I − 0.5·J</code>，焦化利润 <code>J − 1.33·JM</code>，
        卷螺差、螺矿比、焦煤焦炭比、硅铁锰硅价差，并给出一年分位与 Z 值。</li>
      <li><b>仓位计算器。</b>手数 = 本金 × 风险比例 ÷（k × ATR × 合约乘数），同时给出名义价值、杠杆与保证金占用。</li>
    </ul>

    <h2>6. 回测引擎</h2>
    <ul>
      <li><b>无未来函数。</b>目标仓位在每根 K 线收盘时决定，下一根开盘成交。单元测试在截断的历史上重算所有特征与策略，断言过去的值不变。</li>
      <li><b>期货交易规则。</b>整数手 × 合约乘数，每次成交前检查保证金，计入手续费、滑点及每次换月成本。</li>
      <li><b>绩效指标。</b>年化收益、波动率、夏普、索提诺、最大回撤及持续时间、卡玛比率、胜率、盈亏比、持仓时间占比、换手、成本拖累；参数扫描展示敏感性。</li>
    </ul>

    <h2>7. 已知局限</h2>
    <ul>
      <li>未模拟交易所节假日、涨跌停与集合竞价。</li>
      <li>各交易所持仓量统计口径不同，分析使用变化量与分位，不受口径影响。</li>
      <li>期货小时线历史从 2023 年开始。所有结果均为样本内。</li>
    </ul>
  </div>`;
