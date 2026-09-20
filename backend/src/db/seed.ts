#!/usr/bin/env tsx
/**
 * Reference-data seed.
 *
 * Seeds only data that is *classification*, not market data: index membership,
 * sector tags, and NSE trading holidays. No prices, volumes or fundamentals
 * are ever seeded — those come from a configured provider or are reported as
 * unavailable.
 *
 * Index constituents and holiday dates change. Both are versioned here with
 * the date they were captured, and the seed is idempotent, so refreshing them
 * is a matter of editing the list and re-running.
 *
 *   npm run seed
 */
import { pool, query, queryRows } from './pool.js';
import { logger } from '../utils/logger.js';
import * as instrumentsRepo from './repositories/instruments.js';

const CAPTURED = '2026-09-20';

/**
 * NIFTY 50 constituents. Verify against
 * https://www.niftyindices.com before relying on membership for a scan.
 */
const NIFTY_50 = [
  'ADANIENT', 'ADANIPORTS', 'APOLLOHOSP', 'ASIANPAINT', 'AXISBANK', 'BAJAJ-AUTO',
  'BAJFINANCE', 'BAJAJFINSV', 'BEL', 'BHARTIARTL', 'CIPLA', 'COALINDIA',
  'DRREDDY', 'EICHERMOT', 'GRASIM', 'HCLTECH', 'HDFCBANK', 'HDFCLIFE',
  'HEROMOTOCO', 'HINDALCO', 'HINDUNILVR', 'ICICIBANK', 'INDUSINDBK', 'INFY',
  'ITC', 'JSWSTEEL', 'KOTAKBANK', 'LT', 'M&M', 'MARUTI', 'NESTLEIND', 'NTPC',
  'ONGC', 'POWERGRID', 'RELIANCE', 'SBILIFE', 'SBIN', 'SHRIRAMFIN', 'SUNPHARMA',
  'TATACONSUM', 'TATAMOTORS', 'TATASTEEL', 'TCS', 'TECHM', 'TITAN', 'TRENT',
  'ULTRACEMCO', 'WIPRO', 'JIOFIN', 'ADANIGREEN',
];

const BANK_NIFTY = [
  'AXISBANK', 'BANDHANBNK', 'BANKBARODA', 'CANBK', 'FEDERALBNK', 'HDFCBANK',
  'ICICIBANK', 'IDFCFIRSTB', 'INDUSINDBK', 'KOTAKBANK', 'PNB', 'SBIN',
];

/**
 * Sector tags. Uses a broad, readable taxonomy rather than the exchange's
 * fine-grained industry codes — the goal is a usable sector heatmap, not a
 * regulatory classification.
 */
const SECTORS: Record<string, string[]> = {
  'Information Technology': ['TCS', 'INFY', 'WIPRO', 'HCLTECH', 'TECHM', 'LTIM', 'PERSISTENT', 'COFORGE', 'MPHASIS'],
  'Banking': ['HDFCBANK', 'ICICIBANK', 'SBIN', 'AXISBANK', 'KOTAKBANK', 'INDUSINDBK', 'BANKBARODA', 'PNB', 'CANBK', 'FEDERALBNK', 'IDFCFIRSTB', 'BANDHANBNK', 'AUBANK'],
  'Financial Services': ['BAJFINANCE', 'BAJAJFINSV', 'SBILIFE', 'HDFCLIFE', 'SHRIRAMFIN', 'JIOFIN', 'CHOLAFIN', 'ICICIGI', 'ICICIPRULI', 'MUTHOOTFIN', 'LICHSGFIN'],
  'Oil, Gas & Energy': ['RELIANCE', 'ONGC', 'BPCL', 'IOC', 'GAIL', 'HINDPETRO', 'PETRONET', 'OIL'],
  'Power & Utilities': ['NTPC', 'POWERGRID', 'TATAPOWER', 'ADANIGREEN', 'ADANIPOWER', 'NHPC', 'TORNTPOWER', 'JSWENERGY'],
  'Automobile': ['MARUTI', 'TATAMOTORS', 'M&M', 'BAJAJ-AUTO', 'HEROMOTOCO', 'EICHERMOT', 'TVSMOTOR', 'ASHOKLEY', 'BHARATFORG', 'MOTHERSON'],
  'Pharmaceuticals': ['SUNPHARMA', 'CIPLA', 'DRREDDY', 'DIVISLAB', 'LUPIN', 'AUROPHARMA', 'TORNTPHARM', 'ZYDUSLIFE', 'ALKEM', 'GLENMARK'],
  'FMCG': ['HINDUNILVR', 'ITC', 'NESTLEIND', 'BRITANNIA', 'DABUR', 'GODREJCP', 'MARICO', 'TATACONSUM', 'COLPAL', 'UBL'],
  'Metals & Mining': ['TATASTEEL', 'JSWSTEEL', 'HINDALCO', 'COALINDIA', 'VEDL', 'JINDALSTEL', 'SAIL', 'NMDC', 'NATIONALUM'],
  'Cement & Construction': ['ULTRACEMCO', 'GRASIM', 'SHREECEM', 'AMBUJACEM', 'ACC', 'DALBHARAT', 'JKCEMENT'],
  'Infrastructure': ['LT', 'ADANIPORTS', 'GMRAIRPORT', 'IRB', 'NBCC', 'RVNL', 'IRCON'],
  'Telecom': ['BHARTIARTL', 'IDEA', 'INDUSTOWER', 'TATACOMM'],
  'Consumer Durables': ['TITAN', 'HAVELLS', 'VOLTAS', 'CROMPTON', 'DIXON', 'BLUESTARCO'],
  'Healthcare Services': ['APOLLOHOSP', 'MAXHEALTH', 'FORTIS', 'LALPATHLAB', 'METROPOLIS'],
  'Chemicals': ['PIDILITIND', 'SRF', 'UPL', 'AARTIIND', 'DEEPAKNTR', 'TATACHEM', 'ATUL'],
  'Retail & Consumer': ['TRENT', 'DMART', 'ZOMATO', 'NYKAA', 'ABFRL', 'JUBLFOOD'],
  'Conglomerate': ['ADANIENT', 'SIEMENS', 'ABB', 'BEL', 'HAL', 'BHEL'],
  'Real Estate': ['DLF', 'GODREJPROP', 'OBEROIRLTY', 'PRESTIGE', 'PHOENIXLTD'],
  'Media & Entertainment': ['ZEEL', 'PVRINOX', 'SUNTV'],
};

/**
 * NSE trading holidays. These MUST be refreshed annually from the exchange's
 * published circular — a stale list silently mislabels a holiday as a normal
 * closed day, which changes nothing functionally but is worth knowing.
 */
const HOLIDAYS_2026: Array<[string, string]> = [
  ['2026-01-26', 'Republic Day'],
  ['2026-03-04', 'Holi'],
  ['2026-03-21', 'Id-Ul-Fitr (Ramzan Id)'],
  ['2026-03-26', 'Shri Ram Navami'],
  ['2026-03-31', 'Mahavir Jayanti'],
  ['2026-04-03', 'Good Friday'],
  ['2026-04-14', 'Dr. Baba Saheb Ambedkar Jayanti'],
  ['2026-05-01', 'Maharashtra Day'],
  ['2026-05-27', 'Bakri Id'],
  ['2026-06-26', 'Muharram'],
  ['2026-08-15', 'Independence Day'],
  ['2026-08-26', 'Ganesh Chaturthi'],
  ['2026-10-02', 'Mahatma Gandhi Jayanti'],
  ['2026-10-20', 'Dussehra'],
  ['2026-11-09', 'Diwali Laxmi Pujan'],
  ['2026-11-10', 'Diwali Balipratipada'],
  ['2026-11-24', 'Guru Nanak Jayanti'],
  ['2026-12-25', 'Christmas'],
];

/**
 * Minimal instrument master.
 *
 * This is REFERENCE data — the symbol, its name, its exchange, its lot size.
 * It is not market data: no price, volume, open interest or fundamental
 * figure is seeded anywhere, and every quote endpoint keeps reporting
 * "unavailable" until a real provider is configured. Seeding it lets search,
 * watchlists and portfolio entry work for exploration before you have a
 * broker account.
 *
 * A configured provider's instruments sync supersedes this with the full
 * master (including derivatives) and merges its own provider tokens in.
 */
const INDEX_INSTRUMENTS: Array<[string, string]> = [
  ['NIFTY 50', 'NIFTY 50'],
  ['NIFTY BANK', 'NIFTY BANK'],
  ['NIFTY FIN SERVICE', 'NIFTY FINANCIAL SERVICES'],
  ['NIFTY MIDCAP 100', 'NIFTY MIDCAP 100'],
  ['NIFTY NEXT 50', 'NIFTY NEXT 50'],
  ['INDIA VIX', 'INDIA VIX'],
  ['SENSEX', 'BSE SENSEX'],
];

/** symbol → company name, for the equities referenced by the seed lists. */
const EQUITY_NAMES: Record<string, string> = {
  ADANIENT: 'Adani Enterprises Ltd', ADANIPORTS: 'Adani Ports and SEZ Ltd',
  ADANIGREEN: 'Adani Green Energy Ltd', APOLLOHOSP: 'Apollo Hospitals Enterprise Ltd',
  ASIANPAINT: 'Asian Paints Ltd', AXISBANK: 'Axis Bank Ltd',
  'BAJAJ-AUTO': 'Bajaj Auto Ltd', BAJFINANCE: 'Bajaj Finance Ltd',
  BAJAJFINSV: 'Bajaj Finserv Ltd', BEL: 'Bharat Electronics Ltd',
  BHARTIARTL: 'Bharti Airtel Ltd', CIPLA: 'Cipla Ltd', COALINDIA: 'Coal India Ltd',
  DRREDDY: "Dr. Reddy's Laboratories Ltd", EICHERMOT: 'Eicher Motors Ltd',
  GRASIM: 'Grasim Industries Ltd', HCLTECH: 'HCL Technologies Ltd',
  HDFCBANK: 'HDFC Bank Ltd', HDFCLIFE: 'HDFC Life Insurance Company Ltd',
  HEROMOTOCO: 'Hero MotoCorp Ltd', HINDALCO: 'Hindalco Industries Ltd',
  HINDUNILVR: 'Hindustan Unilever Ltd', ICICIBANK: 'ICICI Bank Ltd',
  INDUSINDBK: 'IndusInd Bank Ltd', INFY: 'Infosys Ltd', ITC: 'ITC Ltd',
  JSWSTEEL: 'JSW Steel Ltd', JIOFIN: 'Jio Financial Services Ltd',
  KOTAKBANK: 'Kotak Mahindra Bank Ltd', LT: 'Larsen & Toubro Ltd',
  'M&M': 'Mahindra & Mahindra Ltd', MARUTI: 'Maruti Suzuki India Ltd',
  NESTLEIND: 'Nestle India Ltd', NTPC: 'NTPC Ltd',
  ONGC: 'Oil & Natural Gas Corporation Ltd', POWERGRID: 'Power Grid Corporation of India Ltd',
  RELIANCE: 'Reliance Industries Ltd', SBILIFE: 'SBI Life Insurance Company Ltd',
  SBIN: 'State Bank of India', SHRIRAMFIN: 'Shriram Finance Ltd',
  SUNPHARMA: 'Sun Pharmaceutical Industries Ltd', TATACONSUM: 'Tata Consumer Products Ltd',
  TATAMOTORS: 'Tata Motors Ltd', TATASTEEL: 'Tata Steel Ltd',
  TCS: 'Tata Consultancy Services Ltd', TECHM: 'Tech Mahindra Ltd',
  TITAN: 'Titan Company Ltd', TRENT: 'Trent Ltd',
  ULTRACEMCO: 'UltraTech Cement Ltd', WIPRO: 'Wipro Ltd',
  BANDHANBNK: 'Bandhan Bank Ltd', BANKBARODA: 'Bank of Baroda',
  CANBK: 'Canara Bank', FEDERALBNK: 'The Federal Bank Ltd',
  IDFCFIRSTB: 'IDFC First Bank Ltd', PNB: 'Punjab National Bank',
};

async function seedReferenceInstruments(): Promise<{ indices: number; equities: number }> {
  let indices = 0;
  for (const [symbol, name] of INDEX_INSTRUMENTS) {
    const res = await query(
      `INSERT INTO instruments
         (exchange, tradingsymbol, name, instrument_type, segment, lot_size, tick_size, source)
       VALUES ('INDICES', $1, $2, 'INDEX', 'INDICES', 1, 0.05, $3)
       ON CONFLICT (exchange, tradingsymbol) DO NOTHING`,
      [symbol, name, `seed (captured ${CAPTURED})`],
    );
    indices += res.rowCount ?? 0;
  }

  const symbols = [...new Set([...NIFTY_50, ...BANK_NIFTY, ...Object.keys(EQUITY_NAMES)])];
  let equities = 0;
  for (const symbol of symbols) {
    const res = await query(
      `INSERT INTO instruments
         (exchange, tradingsymbol, name, instrument_type, segment, lot_size, tick_size, source)
       VALUES ('NSE', $1, $2, 'EQ', 'NSE-EQ', 1, 0.05, $3)
       ON CONFLICT (exchange, tradingsymbol) DO NOTHING`,
      [symbol, EQUITY_NAMES[symbol] ?? symbol, `seed (captured ${CAPTURED})`],
    );
    equities += res.rowCount ?? 0;
  }

  return { indices, equities };
}

async function seedHolidays(): Promise<number> {
  let count = 0;
  for (const [date, description] of HOLIDAYS_2026) {
    const res = await query(
      `INSERT INTO trading_holidays (holiday_date, exchange, description, source)
       VALUES ($1::date, 'NSE', $2, $3)
       ON CONFLICT (holiday_date) DO UPDATE SET description = EXCLUDED.description`,
      [date, description, `seed (captured ${CAPTURED})`],
    );
    count += res.rowCount ?? 0;
  }
  return count;
}

async function seedIndexMembership(): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  out['NIFTY50'] = await instrumentsRepo.tagIndexMembership(NIFTY_50, 'NIFTY50');
  out['BANKNIFTY'] = await instrumentsRepo.tagIndexMembership(BANK_NIFTY, 'BANKNIFTY');
  return out;
}

async function seedSectors(): Promise<number> {
  let tagged = 0;
  for (const [sector, symbols] of Object.entries(SECTORS)) {
    const res = await queryRows<{ id: number }>(
      `UPDATE instruments SET sector = $2
        WHERE exchange = 'NSE' AND instrument_type = 'EQ' AND tradingsymbol = ANY($1)
        RETURNING id`,
      [symbols, sector],
    );
    tagged += res.length;
  }
  return tagged;
}

/**
 * Market-cap buckets, derived from index membership rather than asserted.
 * NIFTY 50 members are large caps by construction; everything else stays
 * unclassified until a fundamentals provider supplies a market cap.
 */
async function seedMarketCapClass(): Promise<number> {
  const res = await queryRows<{ id: number }>(
    `UPDATE instruments SET market_cap_class = 'LARGE'
      WHERE exchange = 'NSE' AND instrument_type = 'EQ'
        AND 'NIFTY50' = ANY(index_membership)
        AND market_cap_class IS NULL
      RETURNING id`,
  );
  return res.length;
}

async function main(): Promise<void> {
  logger.info('Seeding reference data');

  const instrumentCount = await queryRows<{ c: number }>(
    `SELECT count(*)::int AS c FROM instruments WHERE instrument_type = 'EQ'`,
  );
  const have = instrumentCount[0]?.c ?? 0;

  const holidays = await seedHolidays();
  logger.info({ holidays }, 'Trading holidays seeded');

  if (have === 0) {
    logger.info(
      'Instrument master is empty — seeding the reference set so search, watchlists and portfolio entry work before a provider is configured. No prices are seeded.',
    );
    const seeded = await seedReferenceInstruments();
    logger.info(seeded, 'Reference instruments seeded');
  }

  const total = await queryRows<{ c: number }>(
    `SELECT count(*)::int AS c FROM instruments WHERE instrument_type = 'EQ'`,
  );
  const membership = await seedIndexMembership();
  const sectors = await seedSectors();
  const marketCaps = await seedMarketCapClass();

  logger.info(
    { instruments: total[0]?.c ?? have, membership, sectorsTagged: sectors, marketCapsTagged: marketCaps },
    'Reference data seeded',
  );

  const unclassified = await queryRows<{ c: number }>(
    `SELECT count(*)::int AS c FROM instruments
      WHERE exchange = 'NSE' AND instrument_type = 'EQ' AND sector IS NULL AND is_active`,
  );
  if ((unclassified[0]?.c ?? 0) > 0) {
    logger.info(
      { unclassified: unclassified[0]!.c },
      'Instruments without a sector tag will appear as "Unclassified" in the sector heatmap. Extend the SECTORS map in src/db/seed.ts to cover more of them.',
    );
  }
}

try {
  await main();
} catch (err) {
  logger.error({ err }, 'Seed failed');
  process.exitCode = 1;
} finally {
  await pool.end();
}
