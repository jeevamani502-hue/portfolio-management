/**
 * Prompts for the Market Analyst.
 *
 * The system prompt is a hard constraint document, not a personality sketch.
 * Its rules are mirrored by the deterministic validator in validator.ts —
 * anything the prompt forbids, the validator also checks. The prompt exists
 * to make compliance likely; the validator exists to make it certain.
 */

export const SYSTEM_PROMPT = `You are the Market Analyst inside an Indian stock-market research platform (NSE/BSE).

Your role is to NARRATE pre-computed market data. You are not a forecaster, not an adviser, and not a data source.

## THE ONE UNBREAKABLE RULE

You may state ONLY values that appear in the FACTS section of the evidence you are given, or values you compute from them by simple arithmetic (a difference, a ratio, a percentage change between two facts). If you do compute something, show which facts you used.

You must NEVER:
- state a price, volume, open interest, ratio, percentage, or any other market figure that is not in the FACTS
- estimate, approximate, round to a "roughly" figure, or infer a number from memory
- draw on anything you know about these companies or this market from training — your knowledge of Indian markets is out of date and must not be used as a source of fact
- fill a gap with a plausible-sounding value

If a figure is missing, write that it is unavailable and say why, using the UNAVAILABLE section. An honest gap is a correct answer; a plausible invention is a failure.

## FORBIDDEN LANGUAGE

Never write, in any form:
- that something will definitely, certainly or surely happen
- guarantees, assured returns, risk-free anything, or "cannot lose"
- "you should buy / sell / short / invest", or any direct instruction about what to do with money
- buy/sell recommendations or ratings

Use instead: "the data shows", "this is consistent with", "one reading of this is", "the rules that fired were", "a potential scenario is".

## HOW TO DISTINGUISH WHAT YOU ARE SAYING

Every fact carries a type. Respect the distinction in your wording:
- market_data — observed from the exchange or broker. State it plainly.
- calculated — arithmetic over market data. Say what was computed.
- rule_signal — the output of the platform's rule engine. Attribute it: "the rule engine classified...".
- user_input — supplied by the user (e.g. a manually entered holding). Say so.

Never present a rule_signal or your own reading as though it were observed market data.

## SCORES AND CONFIDENCE

Scores measure how many rule-based conditions currently agree, weighted. A score is NOT a probability, a forecast, or a quality rating. When you cite one, say what it measures.

## STRUCTURE

Use short, scannable sections with headings. Lead with what the data shows, then what it does not cover. Quote figures with their units. Where a figure came from a calculation, name the inputs.

When the question is about a stock, prefer this shape:

**Current market data** — price, change, volume, VWAP if present
**Technical structure** — trend, momentum, key levels
**Fundamentals** — only if fundamental facts are present
**F&O** — only if option facts are present
**News** — only if news context is present
**What the rules found** — matched setups, with their confirmation strength
**Scenarios** — a bullish reading and a bearish reading, each tied to a specific level from the facts
**Key risks** — including what data was unavailable
**Data timestamp** — the bundle's as-of time

Omit any section for which you have no facts, rather than padding it.

## SCENARIOS

When you describe scenarios, anchor each to a level that exists in the FACTS ("above the mapped resistance at X..." / "below the support at Y..."). Never assign probabilities to scenarios. Present both directions.

## LENGTH

Be dense and specific. No preamble, no restating the question, no closing pleasantries. A trader reading this wants the numbers and what they imply, not filler.`;

export function buildUserPrompt(question: string, intent: string, renderedBundle: string): string {
  return `USER QUESTION: ${question}

DETECTED INTENT: ${intent}

Below is the complete set of data retrieved for this question. It is the only information you may use.

${renderedBundle}

Answer the user's question using only the above. Where the FACTS do not cover something the question asks about, say so explicitly rather than filling the gap.`;
}

/**
 * Local glossary. Conceptual questions ("what is RSI") need no market data and
 * no model call — and answering them from a fixed text means the explanation
 * always matches what the platform actually computes.
 */
export const CONCEPT_EXPLANATIONS: Record<string, string> = {
  rsi: `**RSI (Relative Strength Index)**

A momentum oscillator bounded between 0 and 100, developed by J. Welles Wilder.

**How this platform computes it:** the average gain and average loss over the last 14 periods, using Wilder's smoothing (each new value carries 1/14 weight). RSI = 100 − 100 / (1 + average gain / average loss).

**Conventional reading:** above 70 is often called overbought, below 30 oversold. Those are conventions, not rules — in a strong trend RSI can sit above 70 for weeks without the price falling.

**How it is used here:** as one input among several. The signal engine never produces a setup from RSI alone; it requires agreement from trend, volume and structure rules as well.`,

  macd: `**MACD (Moving Average Convergence Divergence)**

A trend-following momentum indicator built from two exponential moving averages.

**How this platform computes it:**
- MACD line = EMA(12) − EMA(26) of closing prices
- Signal line = EMA(9) of the MACD line
- Histogram = MACD line − signal line

**Conventional reading:** the MACD line crossing above the signal line is read as bullish momentum, below as bearish. The histogram shows the gap widening or narrowing.

**Caveat:** MACD is derived from moving averages, so it lags price by construction. In a sideways market it produces frequent crossovers that lead nowhere.`,

  atr: `**ATR (Average True Range)**

A volatility measure — how much an instrument typically moves in a period, regardless of direction.

**How this platform computes it:** true range for each bar is the largest of (high − low), |high − previous close|, |low − previous close|. ATR is Wilder's smoothed average of true range over 14 periods.

**Why it matters here:** ATR sets the width of stops and entry zones in every trade idea. A stop placed 1.5 × ATR away is proportional to that instrument's own volatility, so the same rule works on a ₹50 stock and a ₹50,000 index. ATR is also reported as a percentage of price so instruments can be compared.`,

  adx: `**ADX (Average Directional Index)**

Measures trend *strength*, not direction. Ranges 0 to 100.

**How this platform computes it:** from directional movement (+DM and −DM) smoothed over 14 periods against ATR, producing +DI and −DI; ADX is the smoothed average of |+DI − −DI| / (+DI + −DI).

**Conventional reading:** below 20 suggests no trend (range conditions), above 25 suggests a trend is present. Direction comes from whether +DI or −DI is higher, not from ADX itself.`,

  vwap: `**VWAP (Volume Weighted Average Price)**

The average price traded during a session, weighted by volume.

**How this platform computes it:** cumulative (typical price × volume) ÷ cumulative volume, where typical price is (high + low + close) / 3. The calculation **resets at each session open**.

**Important:** because VWAP is session-anchored, it is only computed for intraday timeframes here. On daily and higher bars it would be meaningless, so the platform shows the exchange-reported average traded price instead and labels it as such.`,

  supertrend: `**Supertrend**

A trend-following overlay that flips between a support line and a resistance line.

**How this platform computes it:** basic bands are (high + low) / 2 ± 3 × ATR(10). The bands are then made "sticky" — the final upper band only moves down, the final lower band only moves up, until price closes through them, at which point the trend flips.

**Reading:** when the trend is bullish the line sits below price and acts as a trailing reference; when bearish it sits above.`,

  'bollinger': `**Bollinger Bands**

A volatility envelope around a moving average.

**How this platform computes it:** a 20-period simple moving average, with upper and lower bands at ±2 population standard deviations of closing prices.

**Derived measures shown here:**
- **Bandwidth** = (upper − lower) / middle, as a percentage. Low bandwidth means compression.
- **%B** = where price sits within the bands, 0 at the lower band and 100 at the upper.
- **Squeeze** is flagged when current bandwidth sits in the bottom 20% of its own history — a statement about compression, not about which way price will break.`,

  pcr: `**PCR (Put/Call Ratio)**

Total put open interest divided by total call open interest across an option chain.

**How this platform computes it:** the sum of put OI across every strike in the expiry, divided by the sum of call OI. A volume-based version uses traded volume instead.

**Reading:** PCR is a positioning statistic. Readings at either extreme are commonly described as crowding, but the indicator is not directional evidence on its own, and its interpretation is contested — high PCR is read as bullish by contrarians and bearish by trend followers. The platform reports the number and the band, and does not assign a direction to it.`,

  'max pain': `**Max Pain**

The strike at which the total intrinsic value payable to option buyers at expiry would be smallest, given current open interest.

**How this platform computes it:** for every listed strike treated as a hypothetical settlement price S, it sums (call OI × max(0, S − strike)) + (put OI × max(0, strike − S)) across all strikes. The strike with the lowest total is max pain.

**What it is not:** a prediction of where price will settle. It describes where open interest currently sits, and it moves as open interest changes through the expiry.`,

  xirr: `**XIRR (Extended Internal Rate of Return)**

The annualised return on a series of irregularly timed cash flows — the right measure when money went in and out at different times.

**How this platform computes it:** it solves Σ CFᵢ ÷ (1+r)^(dᵢ/365) = 0 for r, where dᵢ is days from the first cash flow, using Newton-Raphson with a bisection fallback. Buys and deposits are negative flows; sells and dividends are positive; the current market value of open positions is included as a final positive flow dated today.

**Requirement:** a dated transaction history. Holdings entered without transactions have no cash-flow dates, so XIRR cannot be computed for them and is reported as unavailable.`,

  beta: `**Beta**

How much a portfolio or stock moves relative to a benchmark — here, NIFTY 50.

**How this platform computes it:** covariance(portfolio daily returns, index daily returns) ÷ variance(index daily returns), over the available daily snapshot history.

**Reading:** beta of 1.0 means it moved in line with the index on average; above 1.0 means larger moves, below 1.0 smaller. Beta is a historical average of past co-movement, and it changes over time.`,

  sharpe: `**Sharpe Ratio**

Return earned per unit of volatility taken.

**How this platform computes it:** (annualised return − risk-free rate) ÷ annualised volatility, where returns come from the daily portfolio-value series, volatility is their standard deviation × √252, and the risk-free rate defaults to 6.5%.

**Caveat:** Sharpe penalises upside and downside volatility equally. The platform also reports Sortino, which uses only downside deviation.`,

  'open interest': `**Open Interest (OI)**

The total number of derivative contracts currently outstanding — positions that have been opened and not yet closed.

**How it is used here:** OI change alongside price change is classified into four conventional readings:
- price up + OI up → **long buildup** (new long positions)
- price down + OI up → **short buildup** (new short positions)
- price up + OI down → **short covering** (shorts closing)
- price down + OI down → **long unwinding** (longs closing)

These are interpretations of two measurable facts, not forecasts. The same pattern can arise from unrelated flows, and the platform states the raw numbers alongside every classification.`,
};
