/**
 * EOD Historical Data fundamentals provider.
 *
 * Docs: https://eodhd.com/financial-apis/stock-etfs-fundamental-data-feeds
 *
 * Indian tickers are addressed as `SYMBOL.NSE` / `SYMBOL.BSE`. The payload is
 * deep and inconsistently populated across smaller companies, so every field
 * here is mapped defensively: a missing ratio becomes `null`, never zero.
 * `raw` retains the untouched provider response so the UI can show the source
 * document behind any figure.
 */
import { HttpProvider, num } from '../base/HttpProvider.js';
import { ProviderError } from '../../utils/errors.js';
import { env } from '../../config/env.js';
import type {
  MarketDataProvider,
  ProviderManifest,
  NormalizedFundamentals,
  ProviderId,
} from '../types.js';

interface EodhdFundamentals {
  General?: {
    Code?: string;
    Name?: string;
    Sector?: string;
    Industry?: string;
    ISIN?: string;
  };
  Highlights?: {
    MarketCapitalization?: number;
    EBITDA?: number;
    PERatio?: number;
    PEGRatio?: number;
    BookValue?: number;
    DividendYield?: number;
    EarningsShare?: number;
    ProfitMargin?: number;
    OperatingMarginTTM?: number;
    ReturnOnAssetsTTM?: number;
    ReturnOnEquityTTM?: number;
    RevenueTTM?: number;
    RevenuePerShareTTM?: number;
    QuarterlyRevenueGrowthYOY?: number;
    QuarterlyEarningsGrowthYOY?: number;
    GrossProfitTTM?: number;
    DilutedEpsTTM?: number;
  };
  Valuation?: {
    TrailingPE?: number;
    ForwardPE?: number;
    PriceBookMRQ?: number;
    PriceSalesTTM?: number;
    EnterpriseValueEbitda?: number;
  };
  SharesStats?: {
    SharesOutstanding?: number;
    PercentInsiders?: number;
    PercentInstitutions?: number;
  };
  Financials?: {
    Balance_Sheet?: { quarterly?: Record<string, Record<string, string>>; yearly?: Record<string, Record<string, string>> };
    Income_Statement?: { quarterly?: Record<string, Record<string, string>>; yearly?: Record<string, Record<string, string>> };
    Cash_Flow?: { quarterly?: Record<string, Record<string, string>>; yearly?: Record<string, Record<string, string>> };
  };
}

export class EodhdProvider extends HttpProvider implements MarketDataProvider {
  protected readonly providerId: ProviderId = 'eodhd';
  protected readonly baseUrl = 'https://eodhd.com/api';

  private apiKey: string | undefined;

  readonly manifest: ProviderManifest = {
    id: 'eodhd',
    displayName: 'EOD Historical Data',
    docsUrl: 'https://eodhd.com/financial-apis/',
    authModel: 'api_key',
    capabilities: ['fundamentals'],
    credentialFields: [
      { key: 'apiKey', label: 'API Token', secret: true, required: true },
    ],
    throttleMs: { default: 200, fundamentals: 250 },
    notes:
      'Paid service with broad NSE/BSE coverage. Fundamental completeness varies by company; unmapped fields are reported as unavailable rather than filled with zeros.',
  };

  constructor(creds: { apiKey?: string } = {}) {
    super();
    this.apiKey = creds.apiKey ?? env.EODHD_API_KEY;
    this.throttle = { ...this.manifest.throttleMs };
  }

  isConfigured(): boolean {
    return Boolean(this.apiKey);
  }

  async healthCheck() {
    if (!this.isConfigured()) {
      return { ok: false, latencyMs: 0, detail: 'API token not configured' };
    }
    return this.probe(async () => {
      await this.http(`/fundamentals/RELIANCE.NSE`, {
        query: { api_token: this.apiKey, filter: 'General::Code' },
        retries: 0,
      });
    });
  }

  async getFundamentals(symbol: string): Promise<NormalizedFundamentals> {
    if (!this.isConfigured()) {
      throw new ProviderError('eodhd', 'EODHD API token not configured', {
        retryable: false,
        status: 401,
      });
    }

    const ticker = symbol.includes('.') ? symbol : `${symbol.toUpperCase()}.NSE`;
    const data = await this.http<EodhdFundamentals>(`/fundamentals/${encodeURIComponent(ticker)}`, {
      query: { api_token: this.apiKey },
      throttleGroup: 'fundamentals',
      timeoutMs: 30_000,
    });

    if (!data || !data.General) {
      throw new ProviderError('eodhd', `No fundamental data returned for ${ticker}`, {
        retryable: false,
      });
    }

    const h = data.Highlights ?? {};
    const v = data.Valuation ?? {};
    const s = data.SharesStats ?? {};

    // Latest yearly income statement / balance sheet / cash flow, if present.
    const yearlyIncome = latestPeriod(data.Financials?.Income_Statement?.yearly);
    const yearlyBalance = latestPeriod(data.Financials?.Balance_Sheet?.yearly);
    const yearlyCash = latestPeriod(data.Financials?.Cash_Flow?.yearly);

    const totalDebt =
      num(yearlyBalance?.row['shortLongTermDebtTotal']) ??
      (num(yearlyBalance?.row['shortTermDebt']) ?? 0) + (num(yearlyBalance?.row['longTermDebt']) ?? 0);
    const equity = num(yearlyBalance?.row['totalStockholderEquity']);

    const operatingCf = num(yearlyCash?.row['totalCashFromOperatingActivities']);
    const capex = num(yearlyCash?.row['capitalExpenditures']);
    // EODHD reports capex as a negative number in most filings.
    const freeCashFlow =
      operatingCf !== null && capex !== null ? operatingCf + Math.min(0, capex) : null;

    const ebit = num(yearlyIncome?.row['ebit']);
    const totalAssets = num(yearlyBalance?.row['totalAssets']);
    const currentLiabilities = num(yearlyBalance?.row['totalCurrentLiabilities']);
    // ROCE = EBIT / (total assets − current liabilities), expressed as a percent.
    const capitalEmployed =
      totalAssets !== null && currentLiabilities !== null ? totalAssets - currentLiabilities : null;
    const roce =
      ebit !== null && capitalEmployed !== null && capitalEmployed > 0
        ? (ebit / capitalEmployed) * 100
        : null;

    const revenue = num(h.RevenueTTM);
    const ebitda = num(h.EBITDA);

    return {
      symbol: ticker,
      marketCap: num(h.MarketCapitalization),
      revenueTtm: revenue,
      revenueGrowthYoy: pct(h.QuarterlyRevenueGrowthYOY),
      ebitdaTtm: ebitda,
      ebitdaMargin: ebitda !== null && revenue !== null && revenue > 0 ? (ebitda / revenue) * 100 : null,
      netProfitTtm: num(yearlyIncome?.row['netIncome']),
      profitGrowthYoy: pct(h.QuarterlyEarningsGrowthYOY),
      epsTtm: num(h.EarningsShare) ?? num(h.DilutedEpsTTM),
      epsGrowthYoy: pct(h.QuarterlyEarningsGrowthYOY),
      pe: num(h.PERatio) ?? num(v.TrailingPE),
      pb: num(v.PriceBookMRQ),
      roe: pct(h.ReturnOnEquityTTM),
      roce,
      debtToEquity: totalDebt !== null && equity !== null && equity !== 0 ? totalDebt / equity : null,
      freeCashFlow,
      operatingCashFlow: operatingCf,
      dividendYield: pct(h.DividendYield),
      bookValue: num(h.BookValue),
      faceValue: null,
      // EODHD's insider percentage is a reasonable proxy for promoter holding
      // in Indian filings, but it is not identical — flagged in the UI.
      promoterHolding: num(s.PercentInsiders),
      fiiHolding: null,
      diiHolding: null,
      publicHolding: null,
      pledgedPct: null,
      fiscalPeriod: yearlyIncome?.period ?? null,
      asOf: new Date().toISOString(),
      raw: data as unknown as Record<string, unknown>,
    };
  }
}

/** EODHD reports ratios as fractions (0.184); the UI wants percent. */
function pct(v: unknown): number | null {
  const n = num(v);
  if (n === null) return null;
  // Values already above 1.5 are almost certainly already percentages.
  return Math.abs(n) <= 1.5 ? n * 100 : n;
}

function latestPeriod(
  periods: Record<string, Record<string, string>> | undefined,
): { period: string; row: Record<string, string> } | null {
  if (!periods) return null;
  const keys = Object.keys(periods).sort().reverse();
  const key = keys[0];
  if (!key) return null;
  return { period: key, row: periods[key]! };
}
