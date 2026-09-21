/**
 * API response types.
 *
 * `Sourced<T>` mirrors the backend's provenance envelope exactly. It is a
 * discriminated union so TypeScript forces every consumer to handle the
 * `unavailable` case — the type system enforcing the platform's core promise.
 */

export type DataStatus = 'live' | 'delayed' | 'closed' | 'unavailable';

export type Provenance =
  | 'market_data'
  | 'calculated'
  | 'rule_signal'
  | 'ai_interpretation'
  | 'user_input';

export interface Available<T> {
  status: Exclude<DataStatus, 'unavailable'>;
  value: T;
  source: string;
  asOf: string;
  staleMs: number;
  kind: Provenance;
}

export interface Unavailable {
  status: 'unavailable';
  value: null;
  reason: string;
  detail?: string;
  attempted?: Array<{ provider: string; error: string }>;
  kind: Provenance;
}

export type Sourced<T> = Available<T> | Unavailable;

export function isAvailable<T>(s: Sourced<T> | null | undefined): s is Available<T> {
  return !!s && s.status !== 'unavailable';
}

export interface ApiEnvelope<T> {
  data: T;
  meta: {
    requestId: string;
    generatedAt: string;
    [key: string]: unknown;
  };
}

export interface ApiError {
  error: {
    code: string;
    message: string;
    details?: unknown;
    requestId?: string;
  };
}

// ── auth ────────────────────────────────────────────────────────────────────

export interface AuthUserDto {
  id: string;
  email: string;
  fullName: string | null;
  role: 'user' | 'analyst' | 'admin';
  createdAt?: string;
}

// ── market ──────────────────────────────────────────────────────────────────

export type MarketPhase =
  | 'PRE_OPEN' | 'OPEN' | 'CLOSING' | 'POST' | 'CLOSED' | 'WEEKEND' | 'HOLIDAY';

export interface MarketStatusDto {
  phase: MarketPhase;
  isOpen: boolean;
  isSessionActive: boolean;
  nowIst: string;
  dateKey: string;
  label: string;
  nextTransition: { phase: MarketPhase; at: string } | null;
}

export interface IndexDto {
  symbol: string;
  name: string;
  ltp: number;
  prevClose: number | null;
  open: number | null;
  high: number | null;
  low: number | null;
  change: number | null;
  changePct: number | null;
}

export interface BreadthDto {
  advances: number;
  declines: number;
  unchanged: number;
  totalScanned: number;
  excluded: number;
  advanceDeclineRatio: number | null;
  breadthPct: number | null;
  scope: string;
  method: string;
}

export interface SectorDto {
  sector: string;
  avgChangePct: number;
  advances: number;
  declines: number;
  count: number;
  topGainer: { symbol: string; changePct: number } | null;
  topLoser: { symbol: string; changePct: number } | null;
}

export interface MoverDto {
  symbol: string;
  tradingsymbol: string;
  name: string | null;
  sector: string | null;
  ltp: number;
  prevClose: number | null;
  change: number | null;
  changePct: number | null;
  volume: number | null;
  gapPct: number | null;
  distanceFrom52wPct: number | null;
}

export interface RegimeComponentDto {
  name: string;
  score: number | null;
  weight: number;
  observed: string;
  available: boolean;
}

export interface RegimeDto {
  regime: string;
  compositeScore: number | null;
  confidence: number;
  components: RegimeComponentDto[];
  summary: string;
  caveats: string[];
  asOf: string;
}

export interface QuoteDto {
  symbol: string;
  exchange: string;
  tradingsymbol: string;
  ltp: number;
  prevClose: number | null;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number | null;
  volume: number | null;
  avgPrice: number | null;
  oi: number | null;
  bid: number | null;
  ask: number | null;
  upperCircuit: number | null;
  lowerCircuit: number | null;
  week52High: number | null;
  week52Low: number | null;
  timestamp: string;
}

export interface InstrumentDto {
  id: number;
  symbol: string;
  tradingsymbol: string;
  name: string | null;
  exchange: string;
  instrumentType: string;
  sector?: string | null;
  industry?: string | null;
  isin?: string | null;
  lotSize: number;
  indexMembership?: string[];
}

export interface CandleDto {
  ts: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  oi: number | null;
}

// ── analysis ────────────────────────────────────────────────────────────────

export interface PriceLevelDto {
  price: number;
  touches: number;
  strength: number;
  type: 'SUPPORT' | 'RESISTANCE';
  lastTouchTs: string;
}

export interface TechnicalSnapshotDto {
  symbol: string;
  timeframe: string;
  asOf: string;
  candleCount: number;
  price: {
    close: number; open: number; high: number; low: number;
    prevClose: number | null; change: number | null; changePct: number | null;
  };
  movingAverages: {
    sma20: number | null; sma50: number | null; sma100: number | null;
    sma200: number | null; ema9: number | null; ema20: number | null; ema50: number | null;
  };
  momentum: {
    rsi14: number | null; rsi14Prev: number | null; macd: number | null;
    macdSignal: number | null; macdHistogram: number | null;
    macdBullishCross: boolean; macdBearishCross: boolean;
    stochRsiK: number | null; stochRsiD: number | null;
  };
  volatility: {
    atr14: number | null; atrPct: number | null; bbUpper: number | null;
    bbMiddle: number | null; bbLower: number | null; bbWidth: number | null;
    bbPercentB: number | null; bbWidthPercentile: number | null;
  };
  volume: {
    volume: number | null; avgVolume20: number | null; relativeVolume: number | null;
    obv: number | null; obvSlope5: number | null; volumeConfirmsPrice: boolean | null;
  };
  trend: {
    adx14: number | null; plusDi: number | null; minusDi: number | null;
    supertrend: number | null; supertrendDirection: 1 | -1 | null;
    assessment: {
      label: string; strength: number; reasons: string[];
      higherHighs: boolean; higherLows: boolean; lowerHighs: boolean; lowerLows: boolean;
      aboveSma50: boolean | null; aboveSma200: boolean | null; sma50AboveSma200: boolean | null;
    };
  };
  vwap: number | null;
  priceVsVwapPct: number | null;
  pivots: {
    classic: PivotDto | null; fibonacci: PivotDto | null; camarilla: PivotDto | null;
  };
  structure: {
    swings: Array<{ index: number; ts: string; price: number; type: 'HIGH' | 'LOW' }>;
    supports: PriceLevelDto[];
    resistances: PriceLevelDto[];
    nearestSupport: PriceLevelDto | null;
    nearestResistance: PriceLevelDto | null;
    range20: RangeDto | null;
    range52w: RangeDto | null;
    divergence: { type: 'BULLISH' | 'BEARISH'; detail: string } | null;
  };
  insufficient: Array<{ field: string; required: number; available: number }>;
}

export interface PivotDto {
  pivot: number; r1: number; r2: number; r3: number;
  s1: number; s2: number; s3: number; method: string;
}

export interface RangeDto {
  high: number; low: number; positionPct: number; widthPct: number;
}

export interface RuleResultDto {
  id: string;
  label: string;
  category: 'trend' | 'momentum' | 'volume' | 'volatility' | 'structure';
  passed: boolean;
  detail: string;
  weight: number;
  evaluable: boolean;
}

export interface SetupMatchDto {
  kind: string;
  direction: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  label: string;
  description: string;
  strength: number;
  requiredRules: RuleResultDto[];
  confirmingRules: RuleResultDto[];
  disqualifyingRules: RuleResultDto[];
  reasons: string[];
}

export interface SignalReportDto {
  symbol: string;
  timeframe: string;
  asOf: string;
  allRules: RuleResultDto[];
  scores: {
    trend: number | null; momentum: number | null; volume: number | null;
    volatility: number | null; structure: number | null;
  };
  overallScore: number | null;
  setups: SetupMatchDto[];
  interpretation: string;
}

export interface StockAnalysisDto {
  instrument: InstrumentDto;
  quote: Sourced<QuoteDto>;
  technicals: Sourced<TechnicalSnapshotDto>;
  signals: Sourced<SignalReportDto> | null;
  dataQuality: {
    candlesUsed: number;
    candleSource: string;
    servedFromStorage: boolean;
    unavailableFields: Array<{ field: string; required: number; available: number }>;
  };
}

// ── fundamentals ────────────────────────────────────────────────────────────

export interface FundamentalMetricDto {
  key: string; label: string; value: number | null;
  unit: string | null; derivation: string;
}

export interface CategoryAssessmentDto {
  category: string;
  verdict: 'strong' | 'adequate' | 'weak' | 'unavailable';
  headline: string;
  metrics: FundamentalMetricDto[];
  criteria: string[];
}

export interface FundamentalsDto {
  symbol: string;
  metrics: Record<string, number | null>;
  summary: CategoryAssessmentDto[];
  fiscalPeriod: string | null;
  coverage: { available: number; total: number; missing: string[] };
  methodology: string;
}

export interface PeersDto {
  instrument: InstrumentDto;
  sector?: string;
  peers: Array<{
    id: number; symbol: string; tradingsymbol: string; name: string | null;
    marketCap: number | null; pe: number | null; pb: number | null; roe: number | null;
  }>;
  note: string;
}

// ── options ─────────────────────────────────────────────────────────────────

export interface OptionLegDto {
  oi: number | null; oiChange: number | null; volume: number | null;
  ltp: number | null; iv: number | null; bid: number | null; ask: number | null;
  bidQty: number | null; askQty: number | null; prevClose: number | null;
}

export interface OptionStrikeDto {
  strike: number;
  call: OptionLegDto | null;
  put: OptionLegDto | null;
}

export interface OptionChainDto {
  underlying: string;
  expiry: string;
  spot: number | null;
  futuresPrice: number | null;
  strikes: OptionStrikeDto[];
  timestamp: string;
  lotSize: number | null;
}

export interface GreeksDto {
  price: number; delta: number; gamma: number; theta: number;
  vega: number; rho: number; iv: number | null;
  ivSource: 'provider' | 'derived' | 'unavailable';
}

export interface OptionAnalyticsDto {
  underlying: string;
  expiry: string;
  spot: number | null;
  futuresPrice: number | null;
  atmStrike: number | null;
  daysToExpiry: number;
  pcr: {
    pcrOi: number | null; pcrVolume: number | null;
    totalCallOi: number; totalPutOi: number;
    totalCallVolume: number; totalPutVolume: number;
    band: string; note: string;
  };
  maxPain: {
    maxPain: number | null;
    payoutByStrike: Array<{ strike: number; totalPayout: number }>;
    note: string;
  };
  oiLevels: {
    supports: Array<{ strike: number; oi: number; oiChange: number | null; sharePct: number }>;
    resistances: Array<{ strike: number; oi: number; oiChange: number | null; sharePct: number }>;
    note: string;
  };
  oiShift: {
    callOiChange: number; putOiChange: number;
    topCallAdditions: Array<{ strike: number; oiChange: number }>;
    topPutAdditions: Array<{ strike: number; oiChange: number }>;
    topCallUnwinds: Array<{ strike: number; oiChange: number }>;
    topPutUnwinds: Array<{ strike: number; oiChange: number }>;
  };
  greeks: Array<{ strike: number; call: GreeksDto | null; put: GreeksDto | null }>;
  ivSkew: {
    atmStrike: number | null; atmIv: number | null; otmCallIv: number | null;
    otmPutIv: number | null; skew: number | null; note: string;
  };
  ivPercentile: {
    current: number | null; percentile: number | null; rank: number | null;
    sampleSize: number; note: string;
  };
  atmIv: number | null;
  strikeCount: number;
  interpretation: string;
}

export interface FuturesDto {
  symbol: string;
  expiry: string | null;
  ltp: number;
  prevClose: number | null;
  priceChange: number | null;
  oi: number | null;
  oiChange: number | null;
  volume: number | null;
  spot: number | null;
  basis: number | null;
  basisPct: number | null;
  buildup: {
    type: string; label: string;
    priceChange: number | null; priceChangePct: number | null;
    oiChange: number | null; oiChangePct: number | null;
    interpretation: string;
  };
  lotSize: number;
}

// ── scanner ─────────────────────────────────────────────────────────────────

export interface TradeIdeaDto {
  symbol: string;
  tradingsymbol: string;
  name: string | null;
  sector: string | null;
  setup: string;
  setupLabel: string;
  direction: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  timeframe: string;
  currentPrice: number;
  entryLow: number;
  entryHigh: number;
  invalidation: number;
  target1: number;
  target2: number | null;
  riskReward: number;
  riskRewardDisplay: string;
  breakEvenWinRatePct: number;
  confidence: number;
  technicalReasons: string[];
  levelDerivation: string[];
  riskFactors: string[];
  scores: {
    trend: number | null; momentum: number | null; volume: number | null;
    volatility: number | null; structure: number | null;
  };
  atr: number | null;
  atrPct: number | null;
  positionSizing: {
    quantity: number; positionValue: number; capitalAtRisk: number;
    riskPct: number; limitedBy: string; explain: string[]; warnings: string[];
  } | null;
  dataAsOf: string;
  dataSource: string;
  disclaimer: string;
}

export interface ScanResultDto {
  ideas: TradeIdeaDto[];
  scanned: number;
  analyzed: number;
  skipped: Array<{ symbol: string; reason: string }>;
  universe: string;
  timeframe: string;
  methodology: string;
}

// ── portfolio ───────────────────────────────────────────────────────────────

export interface PortfolioDto {
  id: string;
  name: string;
  currency: string;
  broker?: string | null;
  isDefault?: boolean;
  createdAt?: string;
}

export interface HoldingDto {
  id: string;
  instrumentId: number;
  symbol: string;
  tradingsymbol: string;
  name: string | null;
  sector: string | null;
  quantity: number;
  avgPrice: number;
  invested: number;
  realizedPnl: number;
  notes: string | null;
}

export interface HoldingValuationDto {
  symbol: string;
  name: string | null;
  sector: string | null;
  quantity: number;
  avgPrice: number;
  ltp: number | null;
  prevClose: number | null;
  invested: number;
  currentValue: number | null;
  unrealizedPnl: number | null;
  unrealizedPnlPct: number | null;
  dayPnl: number | null;
  dayPnlPct: number | null;
  weightPct: number | null;
  priceUnavailable: boolean;
  realizedPnl: number;
}

export interface AllocationSliceDto {
  key: string; value: number; weightPct: number; count: number;
}

export interface ObservationDto {
  severity: 'info' | 'attention' | 'high';
  category: string;
  title: string;
  detail: string;
  evidence: Record<string, number | string | null>;
}

export interface PortfolioAnalysisDto {
  portfolio: { id: string; name: string; currency: string };
  valuation: {
    holdings: HoldingValuationDto[];
    totalInvested: number;
    currentValue: number;
    unrealizedPnl: number;
    realizedPnl: number;
    dayPnl: number | null;
    totalReturnPct: number | null;
    dayReturnPct: number | null;
    unvaluedSymbols: string[];
    valuationCoveragePct: number;
    method: string;
  };
  allocation: {
    bySector: AllocationSliceDto[];
    byMarketCap: AllocationSliceDto[];
    byInstrument: AllocationSliceDto[];
  };
  concentration: {
    hhi: number | null; effectivePositions: number | null;
    topHoldingPct: number | null; top3Pct: number | null; top5Pct: number | null;
    topSectorPct: number | null; topSector: string | null;
    positionCount: number; method: string;
  };
  xirr: {
    xirr: number | null; xirrPct: number | null; converged: boolean;
    iterations: number; reason?: string; method: string;
  };
  risk: {
    volatilityPct: number | null; maxDrawdownPct: number | null;
    maxDrawdownPeak: number | null; maxDrawdownTrough: number | null;
    currentDrawdownPct: number | null; sharpe: number | null; sortino: number | null;
    beta: number | null; alpha: number | null; correlation: number | null;
    observations: number; method: string;
  };
  correlations: Array<{ a: string; b: string; correlation: number }>;
  observations: ObservationDto[];
  dataQuality: {
    holdingsValued: number; holdingsTotal: number;
    unvaluedSymbols: string[]; snapshotDays: number;
  };
}

export interface HealthDto {
  portfolioValue: number;
  todayPnl: number | null;
  todayPnlPct: number | null;
  overallPnl: number;
  overallPnlPct: number | null;
  xirrPct: number | null;
  riskLevel: 'low' | 'moderate' | 'elevated' | 'unknown';
  riskBasis: string;
  diversificationScore: number | null;
  diversificationBasis: string;
  concentrationFlag: string | null;
  attentionCount: number;
}

// ── watchlist ───────────────────────────────────────────────────────────────

export interface WatchlistDto {
  id: string; name: string; isDefault: boolean; sortOrder: number; itemCount: number;
}

export interface WatchlistRowDto {
  itemId: string;
  instrumentId: number;
  symbol: string;
  tradingsymbol: string;
  name: string | null;
  sector: string | null;
  note: string | null;
  quote: Sourced<QuoteDto> | null;
  technicals: {
    timeframe: string;
    rsi: number | null;
    trend: string | null;
    score: number | null;
    signal: { label: string; direction: string; strength: number } | null;
    note: string | null;
  };
  newsCount24h: number;
}

// ── news ────────────────────────────────────────────────────────────────────

export interface NewsDto {
  id: string;
  headline: string;
  summary: string | null;
  url: string;
  publisher: string;
  author: string | null;
  category: string | null;
  publishedAt: string;
  sentiment: {
    label: 'POSITIVE' | 'NEUTRAL' | 'NEGATIVE' | null;
    score: number | null;
    confidence: number | null;
    method: string | null;
    caveat: string;
  };
  relatedInstruments: Array<{
    id: number; symbol: string; name: string | null; sector: string | null;
    relevance: number; matchReason: string;
  }>;
}

export interface NewsImpactDto {
  article: NewsDto;
  impacts: Array<{
    symbol: string; name: string | null; relevance: number;
    relevanceLabel: string; reason: string; potentialImpact: string;
  }>;
  disclaimer: string;
}

// ── risk ────────────────────────────────────────────────────────────────────

export interface PositionSizeDto {
  config: {
    capital: number; maxRiskPerTradePct: number;
    maxDailyLossPct: number; maxOpenPositions: number;
  };
  sizing: {
    direction: 'LONG' | 'SHORT';
    entry: number; stop: number; riskPerUnit: number;
    maxCapitalAtRisk: number; rawQuantity: number; quantity: number;
    lots: number | null; positionValue: number;
    actualCapitalAtRisk: number; actualRiskPct: number;
    limitedBy: string; warnings: string[]; explain: string[];
  };
  riskReward: {
    riskPerUnit: number; reward1PerUnit: number; reward2PerUnit: number | null;
    riskReward1: number; riskReward2: number | null;
    display1: string; display2: string | null;
    breakEvenWinRatePct: number; valid: boolean; issues: string[];
  } | null;
  note: string;
}

// ── AI ──────────────────────────────────────────────────────────────────────

export interface FactDto {
  id: string;
  label: string;
  value: number | string | boolean | null;
  unit?: string;
  source: string;
  asOf: string;
  kind: Provenance;
  note?: string;
}

export interface EvidenceBundleDto {
  intent: string;
  subject: string;
  facts: FactDto[];
  context: Array<{ id: string; label: string; text: string }>;
  missing: Array<{ id: string; label: string; reason: string }>;
  sources: string[];
  asOf: string | null;
  marketPhase: string;
}

export interface AnalystResponseDto {
  answer: string;
  intent: string;
  subject: string;
  symbols: string[];
  evidence: EvidenceBundleDto;
  sources: string[];
  dataAsOf: string | null;
  generatedAt: string;
  istTime: string;
  model: string | null;
  validation: {
    passed: boolean;
    numbersChecked: number;
    issues: Array<{ token: string; value: number; context: string; reason: string }>;
    regenerated: boolean;
    degradedToTemplate: boolean;
    safetyViolations: Array<{ label: string; match: string }>;
  };
  refused: boolean;
  disclaimer: string;
  latencyMs: number;
}

// ── alerts ──────────────────────────────────────────────────────────────────

export interface AlertDto {
  id: string;
  name: string | null;
  kind: string;
  params: Record<string, unknown>;
  timeframe: string;
  channels: string[];
  isActive: boolean;
  repeatMode: string;
  cooldownSec: number;
  lastFiredAt: string | null;
  fireCount: number;
  createdAt: string;
  symbol: string | null;
  instrumentName: string | null;
}

export interface AlertKindDto {
  kind: string; label: string; params: string[]; needsSymbol: boolean;
}

// ── backtest ────────────────────────────────────────────────────────────────

export interface StrategyDto {
  key: string;
  name: string;
  description: string;
  params: Record<string, { label: string; default: number; min: number; max: number }>;
}

export interface BacktestRunDto {
  id: string | null;
  symbol: string;
  strategy: string;
  timeframe: string;
  period: { from: string | null; to: string | null; bars: number };
  result: {
    trades: Array<{
      direction: string; entryTs: string; entryPrice: number; exitTs: string;
      exitPrice: number; quantity: number; barsHeld: number; grossPnl: number;
      charges: number; netPnl: number; returnPct: number; exitReason: string;
      mae: number; mfe: number;
    }>;
    equityCurve: Array<{ ts: string; equity: number; drawdownPct: number }>;
    initialCapital: number;
    finalCapital: number;
    totalReturnPct: number;
    cagr: number | null;
    maxDrawdownPct: number;
    maxDrawdownDurationBars: number;
    tradeCount: number;
    winCount: number;
    lossCount: number;
    winRate: number | null;
    avgWin: number | null;
    avgLoss: number | null;
    largestWin: number | null;
    largestLoss: number | null;
    profitFactor: number | null;
    expectancy: number | null;
    avgBarsHeld: number | null;
    sharpe: number | null;
    sortino: number | null;
    totalCharges: number;
    grossReturnPct: number;
    costDragPct: number;
    barsProcessed: number;
    warnings: string[];
    methodology: string;
  };
  disclaimer: string;
}

// ── settings ────────────────────────────────────────────────────────────────

export interface SettingsDto {
  risk: {
    capital: number; maxRiskPerTradePct: number; maxDailyLossPct: number;
    maxOpenPositions: number; maxRiskPerTradeAmount: number; maxDailyLossAmount: number;
  };
  preferences: { defaultTimeframe: string; theme: string };
  notifications: {
    browser: boolean; email: boolean; telegram: boolean; telegramChatId: string | null;
  };
}

export interface ProviderCatalogueDto {
  id: string;
  displayName: string;
  docsUrl: string;
  authModel: string;
  capabilities: string[];
  credentialFields: Array<{
    key: string; label: string; secret: boolean; required: boolean; help?: string;
  }>;
  notes?: string;
  requiresOptIn: boolean;
}

export interface ConfiguredProviderDto {
  id: string;
  provider: string;
  displayName: string;
  label: string | null;
  isEnabled: boolean;
  priority: number;
  health: { status: string; lastOkAt: string | null; lastError: string | null };
  configuredFields: Record<string, string | boolean | null>;
  decryptError: string | null;
  updatedAt: string;
}

export interface DataQualityEventDto {
  kind: string;
  provider: string | null;
  capability: string | null;
  symbol: string | null;
  detail: Record<string, unknown>;
  occurredAt: string;
}

/** One attributed number behind an F&O setup. */
export interface SetupEvidenceDto {
  label: string;
  value: string;
  source: 'chain' | 'signal_engine' | 'calculated' | 'user_input';
}

export interface OptionSizingDto {
  quantity: number;
  lots: number | null;
  actualCapitalAtRisk: number;
  actualRiskPct: number;
  limitedBy: string;
  explain: string[];
  warnings: string[];
}

/**
 * A rule-derived option trade. `confirmation` counts agreeing conditions and
 * is explicitly not a probability of profit — the UI must never present it
 * as one.
 */
export interface OptionSetupDto {
  action: 'BUY_CALL' | 'BUY_PUT' | 'NO_TRADE';
  underlying: string;
  expiry: string;
  bias: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  confirmation: number;
  strike: number | null;
  optionType: 'CE' | 'PE' | null;
  entryPremium: number | null;
  stopPremium: number | null;
  targetPremium: number | null;
  underlyingStop: number | null;
  underlyingTarget: number | null;
  spot: number | null;
  lotSize: number | null;
  delta: number | null;
  rewardRisk: number | null;
  sizing: OptionSizingDto | null;
  totalPremiumAtRisk: number | null;
  evidence: SetupEvidenceDto[];
  warnings: string[];
  rejectedBecause: string[];
  interpretation: string;
}

// ── paper trading ───────────────────────────────────────────────────────────

/** Numeric columns arrive as strings from pg; the UI coerces at the edge. */
export interface PaperConfigDto {
  user_id: string;
  is_enabled: boolean;
  capital: string;
  risk_per_trade_pct: string;
  max_open_positions: number;
  max_trades_per_day: number;
  max_daily_loss_pct: string;
  min_confirmation: number;
  underlyings: string[];
  trade_options: boolean;
  trade_equity: boolean;
  halted_reason: string | null;
  halted_at: string | null;
}

export interface PaperConfigInput {
  isEnabled: boolean;
  capital: number;
  riskPerTradePct: number;
  maxOpenPositions: number;
  maxTradesPerDay: number;
  maxDailyLossPct: number;
  minConfirmation: number;
  underlyings: string[];
  tradeOptions: boolean;
  tradeEquity: boolean;
}

export interface PaperPerformanceDto {
  totalTrades: number;
  openTrades: number;
  closedTrades: number;
  wins: number;
  losses: number;
  winRate: number | null;
  grossPnl: number;
  totalCosts: number;
  netPnl: number;
  returnPct: number | null;
  bestTrade: number | null;
  worstTrade: number | null;
  avgWin: number | null;
  avgLoss: number | null;
  profitFactor: number | null;
  /** Says plainly what the numbers above do and do not establish. */
  caveat: string;
}

export interface PaperTradeDto {
  id: string;
  tradingsymbol: string;
  exchange: string;
  underlying: string | null;
  kind: 'EQUITY' | 'OPTION';
  side: 'BUY' | 'SELL';
  quantity: number;
  lot_size: number | null;
  entry_price: string;
  entry_at: string;
  stop_price: string | null;
  target_price: string | null;
  confirmation: number | null;
  rationale: string | null;
  status: 'OPEN' | 'CLOSED';
  exit_price: string | null;
  exit_at: string | null;
  exit_reason: string | null;
  gross_pnl: string | null;
  costs: string | null;
  net_pnl: string | null;
}

export interface PaperSweepDto {
  considered: number;
  opened: number;
  skipped: string[];
}

/**
 * What the advisor would do about one open position.
 *
 * `reasons` carries the measured numbers behind `headline`, so the
 * recommendation is never shown without the evidence for it.
 */
export interface PositionAdviceDto {
  tradeId: string;
  tradingsymbol: string;
  underlying: string | null;
  action: 'CLOSE' | 'CONSIDER_CLOSING' | 'WATCH' | 'HOLD' | 'CANNOT_ASSESS';
  headline: string;
  reasons: string[];
  quantity: number;
  entryPrice: number;
  currentPrice: number | null;
  unrealizedNet: number | null;
  unrealizedPct: number | null;
  stopPrice: number | null;
  targetPrice: number | null;
  progressToTarget: number | null;
  progressToStop: number | null;
  realizedRewardRisk: number | null;
  daysToExpiry: number | null;
  thesisIntact: boolean | null;
}
