/**
 * Deterministic answer templates.
 *
 * Used in two situations: the AI is not configured, or the model's answer
 * failed numeric validation twice. Both times the data is real and complete —
 * only the narration is missing — so a templated summary is genuinely useful
 * and carries zero hallucination risk, because it can only print facts that
 * exist in the bundle.
 */
import type { EvidenceBundle, Fact } from './evidence.js';
import type { Intent } from './intent.js';

function get(bundle: EvidenceBundle, suffix: string): Fact | undefined {
  return bundle.facts.find((f) => f.id === suffix || f.id.endsWith(`.${suffix}`));
}

function num(bundle: EvidenceBundle, suffix: string): number | null {
  const f = get(bundle, suffix);
  return typeof f?.value === 'number' ? f.value : null;
}

function str(bundle: EvidenceBundle, suffix: string): string | null {
  const f = get(bundle, suffix);
  return typeof f?.value === 'string' ? f.value : null;
}

function ctx(bundle: EvidenceBundle, suffix: string): string | null {
  const c = bundle.context.find((x) => x.id === suffix || x.id.endsWith(`.${suffix}`));
  return c?.text ?? null;
}

const fmt = (v: number | null, dp = 2): string =>
  v === null ? 'unavailable' : v.toLocaleString('en-IN', { minimumFractionDigits: dp, maximumFractionDigits: dp });

const fmtInt = (v: number | null): string =>
  v === null ? 'unavailable' : v.toLocaleString('en-IN', { maximumFractionDigits: 0 });

const signed = (v: number | null, dp = 2): string =>
  v === null ? 'unavailable' : `${v >= 0 ? '+' : ''}${fmt(v, dp)}`;

export function renderDeterministicAnswer(intent: Intent, bundle: EvidenceBundle): string {
  const parts: string[] = [];

  switch (intent) {
    case 'stock_analysis':
    case 'compare':
      parts.push(renderStock(bundle));
      break;
    case 'portfolio_analysis':
      parts.push(renderPortfolio(bundle));
      break;
    case 'option_chain':
    case 'fno_analysis':
      parts.push(renderOptions(bundle));
      break;
    case 'market_overview':
    case 'market_why':
    case 'regime':
      parts.push(renderMarket(bundle));
      break;
    case 'scanner':
      parts.push(renderScan(bundle));
      break;
    case 'news':
      parts.push(renderNews(bundle));
      break;
    default:
      parts.push(renderGeneric(bundle));
  }

  if (bundle.missing.length > 0) {
    parts.push(
      '',
      '## Unavailable data',
      ...bundle.missing.map((m) => `- **${m.label}** — ${m.reason}`),
    );
  }

  parts.push(
    '',
    '---',
    `**Sources:** ${bundle.sources.join(', ') || 'none'}`,
    `**Data as of:** ${bundle.asOf ?? 'unknown'}`,
    `**Market session:** ${bundle.marketPhase}`,
  );

  return parts.join('\n');
}

function renderStock(b: EvidenceBundle): string {
  const name = str(b, 'name');
  const out: string[] = [`## ${b.subject}${name ? ` — ${name}` : ''}`];

  const ltp = num(b, 'price.ltp');
  if (ltp !== null) {
    out.push(
      '',
      '### Current market data',
      `- **Last price:** ₹${fmt(ltp)}`,
      `- **Change:** ${signed(num(b, 'price.change'))} (${signed(num(b, 'price.changePct'))}%)`,
      `- **Open / High / Low:** ₹${fmt(num(b, 'price.open'))} / ₹${fmt(num(b, 'price.high'))} / ₹${fmt(num(b, 'price.low'))}`,
      `- **Previous close:** ₹${fmt(num(b, 'price.prevClose'))}`,
      `- **Volume:** ${fmtInt(num(b, 'price.volume'))}`,
    );
    const vwap = num(b, 'tech.vwap') ?? num(b, 'price.avgPrice');
    if (vwap !== null) out.push(`- **VWAP / average traded price:** ₹${fmt(vwap)}`);
    const hi52 = num(b, 'price.week52High');
    const lo52 = num(b, 'price.week52Low');
    if (hi52 !== null || lo52 !== null) {
      out.push(`- **52-week range:** ₹${fmt(lo52)} – ₹${fmt(hi52)}`);
    }
  }

  const trend = str(b, 'tech.trend');
  const rsi = num(b, 'tech.rsi14');
  if (trend !== null || rsi !== null) {
    out.push('', '### Technical structure');
    if (trend) out.push(`- **Trend (rule engine):** ${trend.replace(/_/g, ' ').toLowerCase()}`);
    if (rsi !== null) out.push(`- **RSI(14):** ${fmt(rsi, 1)}`);
    const macd = num(b, 'tech.macd');
    const macdSig = num(b, 'tech.macdSignal');
    if (macd !== null && macdSig !== null) {
      out.push(`- **MACD:** ${fmt(macd, 3)} against signal ${fmt(macdSig, 3)}`);
    }
    const adx = num(b, 'tech.adx14');
    if (adx !== null) out.push(`- **ADX(14):** ${fmt(adx, 1)}`);
    const atrPct = num(b, 'tech.atrPct');
    if (atrPct !== null) out.push(`- **ATR(14):** ₹${fmt(num(b, 'tech.atr14'))} (${fmt(atrPct)}% of price)`);
    const relVol = num(b, 'tech.relVolume');
    if (relVol !== null) out.push(`- **Volume vs 20-period average:** ${fmt(relVol)}×`);

    const sup = get(b, 'tech.support');
    const res = get(b, 'tech.resistance');
    if (sup) out.push(`- **Nearest support:** ₹${fmt(sup.value as number)}${sup.note ? ` (${sup.note})` : ''}`);
    if (res) out.push(`- **Nearest resistance:** ₹${fmt(res.value as number)}${res.note ? ` (${res.note})` : ''}`);

    const mas = ['sma20', 'sma50', 'sma200', 'ema20']
      .map((k) => ({ k, v: num(b, `tech.${k}`) }))
      .filter((x) => x.v !== null);
    if (mas.length) {
      out.push(`- **Moving averages:** ${mas.map((m) => `${m.k.toUpperCase()} ₹${fmt(m.v)}`).join(', ')}`);
    }
  }

  const score = num(b, 'score.overall');
  if (score !== null) {
    out.push(
      '',
      '### Rule-confirmation scores',
      `- **Overall:** ${fmt(score, 0)}/100`,
      ...(['trend', 'momentum', 'volume', 'volatility', 'structure'] as const)
        .map((k) => ({ k, v: num(b, `score.${k}`) }))
        .filter((x) => x.v !== null)
        .map((x) => `- **${x.k[0]!.toUpperCase()}${x.k.slice(1)}:** ${fmt(x.v, 0)}/100`),
      '',
      '_Scores measure how many rule-based conditions currently agree, weighted by rule importance. They are not probabilities or forecasts._',
    );
  }

  const setups = ctx(b, 'setups');
  if (setups) out.push('', '### Matched setups', setups);

  const pe = num(b, 'fund.pe');
  const roe = num(b, 'fund.roe');
  if (pe !== null || roe !== null) {
    out.push('', '### Fundamentals');
    if (pe !== null) out.push(`- **P/E:** ${fmt(pe)}×`);
    if (num(b, 'fund.pb') !== null) out.push(`- **P/B:** ${fmt(num(b, 'fund.pb'))}×`);
    if (roe !== null) out.push(`- **ROE:** ${fmt(roe)}%`);
    if (num(b, 'fund.roce') !== null) out.push(`- **ROCE:** ${fmt(num(b, 'fund.roce'))}%`);
    if (num(b, 'fund.epsTtm') !== null) out.push(`- **EPS (TTM):** ₹${fmt(num(b, 'fund.epsTtm'))}`);
    if (num(b, 'fund.debtEquity') !== null) out.push(`- **Debt/Equity:** ${fmt(num(b, 'fund.debtEquity'))}`);
    const summary = ctx(b, 'fund.summary');
    if (summary) out.push('', summary);
  }

  const news = ctx(b, 'news');
  if (news) out.push('', '### Recent news', news, '',
    '_Sentiment labels are produced by a keyword classifier and can be wrong._');

  const rules = ctx(b, 'rules');
  if (rules) out.push('', '### Rule evaluation detail', '```', rules, '```');

  return out.join('\n');
}

function renderPortfolio(b: EvidenceBundle): string {
  const out: string[] = ['## Portfolio summary'];

  out.push(
    '',
    '### Performance',
    `- **Current value:** ₹${fmt(num(b, 'portfolio.currentValue'))}`,
    `- **Invested:** ₹${fmt(num(b, 'portfolio.invested'))}`,
    `- **Unrealized P&L:** ${signed(num(b, 'portfolio.unrealizedPnl'))}`,
    `- **Realized P&L:** ${signed(num(b, 'portfolio.realizedPnl'))}`,
    `- **Today's P&L:** ${signed(num(b, 'portfolio.dayPnl'))}`,
    `- **Overall return:** ${signed(num(b, 'portfolio.totalReturnPct'))}%`,
  );

  const xirr = num(b, 'portfolio.xirr');
  if (xirr !== null) out.push(`- **XIRR:** ${fmt(xirr)}%`);

  out.push(
    '',
    '### Concentration',
    `- **Holdings:** ${fmtInt(num(b, 'portfolio.holdingsCount'))}`,
    `- **Effective positions:** ${fmt(num(b, 'portfolio.effectivePositions'), 1)} (HHI ${fmt(num(b, 'portfolio.hhi'), 0)})`,
    `- **Largest position:** ${fmt(num(b, 'portfolio.topHoldingPct'))}% of value`,
    `- **Largest sector:** ${str(b, 'portfolio.topSector') ?? 'unclassified'} at ${fmt(num(b, 'portfolio.topSectorPct'))}%`,
  );

  const vol = num(b, 'portfolio.volatility');
  if (vol !== null || num(b, 'portfolio.beta') !== null) {
    out.push('', '### Risk');
    if (vol !== null) out.push(`- **Annualised volatility:** ${fmt(vol)}%`);
    if (num(b, 'portfolio.maxDrawdown') !== null) out.push(`- **Maximum drawdown:** ${fmt(num(b, 'portfolio.maxDrawdown'))}%`);
    if (num(b, 'portfolio.beta') !== null) out.push(`- **Beta to NIFTY 50:** ${fmt(num(b, 'portfolio.beta'))}`);
    if (num(b, 'portfolio.sharpe') !== null) out.push(`- **Sharpe ratio:** ${fmt(num(b, 'portfolio.sharpe'))}`);
  }

  const alloc = ctx(b, 'portfolio.allocation');
  if (alloc) out.push('', '### Sector allocation', alloc);

  const holdings = ctx(b, 'portfolio.holdings');
  if (holdings) out.push('', '### Holdings', '```', holdings, '```');

  const obs = ctx(b, 'portfolio.observations');
  if (obs) out.push('', '### Observations', obs);

  const methods = ctx(b, 'portfolio.methods');
  if (methods) out.push('', '### How these were calculated', methods);

  return out.join('\n');
}

function renderOptions(b: EvidenceBundle): string {
  const out: string[] = [
    `## ${str(b, 'options.underlying') ?? b.subject} option chain — expiry ${str(b, 'options.expiry') ?? 'unknown'}`,
    '',
    '### Chain snapshot',
    `- **Spot:** ${fmt(num(b, 'options.spot'))}`,
    `- **ATM strike:** ${fmtInt(num(b, 'options.atmStrike'))}`,
    `- **Days to expiry:** ${fmtInt(num(b, 'options.daysToExpiry'))}`,
    `- **Total call OI:** ${fmtInt(num(b, 'options.totalCallOi'))}`,
    `- **Total put OI:** ${fmtInt(num(b, 'options.totalPutOi'))}`,
    `- **PCR (OI):** ${fmt(num(b, 'options.pcr_oi'))}`,
    `- **PCR (volume):** ${fmt(num(b, 'options.pcr_volume'))}`,
    `- **Max pain:** ${fmtInt(num(b, 'options.maxPain'))}`,
  ];

  const iv = num(b, 'options.atmIv');
  if (iv !== null) out.push(`- **ATM implied volatility:** ${fmt(iv, 1)}%`);

  const callOi = num(b, 'options.callOiChange');
  const putOi = num(b, 'options.putOiChange');
  if (callOi !== null || putOi !== null) {
    out.push(
      '',
      '### Open-interest change',
      `- **Net call OI change:** ${signed(callOi, 0)}`,
      `- **Net put OI change:** ${signed(putOi, 0)}`,
    );
  }

  const levels = ctx(b, 'options.levels');
  if (levels) out.push('', '### OI-derived levels', levels);

  for (const [label, id] of [
    ['PCR', 'options.pcrNote'],
    ['Max pain', 'options.maxPainNote'],
    ['IV skew', 'options.ivSkew'],
    ['IV percentile', 'options.ivPercentile'],
  ] as const) {
    const text = ctx(b, id);
    if (text) out.push('', `**${label}:** ${text}`);
  }

  const caveat = ctx(b, 'options.interpretation');
  if (caveat) out.push('', `_${caveat}_`);

  return out.join('\n');
}

function renderMarket(b: EvidenceBundle): string {
  const out: string[] = ['## Market overview', '', '### Indices'];

  for (const [key, label] of [
    ['nifty', 'NIFTY 50'],
    ['banknifty', 'NIFTY BANK'],
    ['vix', 'INDIA VIX'],
  ] as const) {
    const ltp = num(b, `index.${key}.ltp`);
    if (ltp === null) continue;
    const chg = num(b, `index.${key}.changePct`);
    out.push(`- **${label}:** ${fmt(ltp)}${chg !== null ? ` (${signed(chg)}%)` : ''}`);
  }

  const adv = num(b, 'breadth.advances');
  if (adv !== null) {
    out.push(
      '',
      '### Breadth',
      `- **Advancing:** ${fmtInt(adv)}`,
      `- **Declining:** ${fmtInt(num(b, 'breadth.declines'))}`,
      `- **Unchanged:** ${fmtInt(num(b, 'breadth.unchanged'))}`,
      `- **Percent advancing:** ${fmt(num(b, 'breadth.pct'), 1)}%`,
    );
    const method = ctx(b, 'breadth.method');
    if (method) out.push('', `_${method}_`);
  }

  const regime = str(b, 'regime.label');
  if (regime) {
    out.push(
      '',
      '### Regime',
      `- **Current regime:** ${regime.replace(/_/g, ' ').toLowerCase()}`,
      `- **Composite score:** ${fmt(num(b, 'regime.composite'), 0)} (scale −100 to +100)`,
      `- **Evidence coverage:** ${fmt(num(b, 'regime.confidence'), 0)}%`,
    );
    const summary = ctx(b, 'regime.summary');
    if (summary) out.push('', summary);
    const components = ctx(b, 'regime.components');
    if (components) out.push('', '**Components:**', components);
    const caveats = ctx(b, 'regime.caveats');
    if (caveats) out.push('', `_${caveats}_`);
  }

  const news = ctx(b, 'news.market');
  if (news) out.push('', '### Recent news', news);

  return out.join('\n');
}

function renderScan(b: EvidenceBundle): string {
  const out: string[] = [
    '## Scanner results',
    '',
    `Analysed ${fmtInt(num(b, 'scan.analyzed'))} instruments; ${fmtInt(num(b, 'scan.ideaCount'))} setups met the confirmation threshold.`,
  ];

  const results = ctx(b, 'scan.results');
  if (results) out.push('', results);

  const method = ctx(b, 'scan.method');
  if (method) out.push('', `_${method}_`);

  out.push(
    '',
    '_These are rule-based research observations, not recommendations. Each carries an invalidation level and risk factors._',
  );

  return out.join('\n');
}

function renderNews(b: EvidenceBundle): string {
  const news = ctx(b, 'news.market') ?? ctx(b, 'news');
  if (!news) return '## News\n\nNo news articles are available for this query.';
  return [
    '## Recent news',
    '',
    news,
    '',
    '_Sentiment labels are produced by a keyword classifier and are frequently wrong on irony, conditionals and mistaken entity attribution._',
  ].join('\n');
}

function renderGeneric(b: EvidenceBundle): string {
  const out: string[] = [`## ${b.subject}`, '', '### Retrieved data'];
  for (const f of b.facts) {
    out.push(`- **${f.label}:** ${String(f.value)}${f.unit ? ` ${f.unit}` : ''}`);
  }
  for (const c of b.context) {
    out.push('', `**${c.label}:**`, c.text);
  }
  return out.join('\n');
}
