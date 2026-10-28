/**
 * Dhan's detailed scrip master has no EXCHANGE_SEGMENT or TRADING_SYMBOL
 * column. The first parser looked for both, skipped every row, and the
 * instrument sync wrote nothing: Settings said "connected" and no order could
 * ever find a security id. These rows are copied from the live file.
 */
import { describe, it, expect } from 'vitest';
import { parseDhanScripMaster, dhanDerivativeSymbol, dhanSegment } from '../dhan/index.js';

const HEADER = 'EXCH_ID,SEGMENT,SECURITY_ID,ISIN,INSTRUMENT,UNDERLYING_SECURITY_ID,UNDERLYING_SYMBOL,SYMBOL_NAME,DISPLAY_NAME,INSTRUMENT_TYPE,SERIES,LOT_SIZE,SM_EXPIRY_DATE,STRIKE_PRICE,OPTION_TYPE,TICK_SIZE,EXPIRY_FLAG,BRACKET_FLAG,COVER_FLAG,ASM_GSM_FLAG,ASM_GSM_CATEGORY,BUY_SELL_INDICATOR,BUY_CO_MIN_MARGIN_PER,BUY_CO_SL_RANGE_MAX_PERC,BUY_CO_SL_RANGE_MIN_PERC,BUY_BO_MIN_MARGIN_PER,BUY_BO_PROFIT_RANGE_MAX_PERC,BUY_BO_PROFIT_RANGE_MIN_PERC,MTF_LEVERAGE,SM_UPPER_LIMIT,SM_LOWER_LIMIT,SM_FREEZE_QTY,';
const ROWS = [
  'NSE,D,35018,NA,OPTIDX,26009,BANKNIFTY,BANKNIFTY-Oct2026-71900-CE,BANKNIFTY 27 OCT 71900 CALL,OP,NA,30.0,2026-10-27,71900.00000,CE,5.0000,M,N,N,N,NA,A,0,0,0,0,0,0,0,20.0500,0.0500,1441,',
  'NSE,D,35019,NA,OPTIDX,26009,BANKNIFTY,BANKNIFTY-Oct2026-71900-PE,BANKNIFTY 27 OCT 71900 PUT,OP,NA,30.0,2026-10-27,71900.00000,PE,5.0000,M,N,N,N,NA,A,0,0,0,0,0,0,0,19172.0500,15869.8500,1441,',
  'BSE,D,1100742,NA,OPTIDX,1,SENSEX,BSXOPT,SENSEX 26 NOV 70800 PUT,OPTIDX,NA,20.0,2026-11-26,70800.00000,PE,5.0000,M,N,N,N,NA,A,0,0,0,0,0,0,0,575.7500,0.0500,1001,',
  'BSE,D,1100722,NA,OPTIDX,47,SENSEX50,SX50OPT,SENSEX50 26 NOV 25500 PUT,OPTIDX,NA,75.0,2026-11-26,25500.00000,PE,5.0000,M,N,N,N,NA,A,0,0,0,0,0,0,0,2185.6500,769.0000,1801,',
  'NSE,D,48704,NA,FUTIDX,26000,NIFTY,NIFTY-Oct2026-FUT,NIFTY OCT FUT,FUT,NA,65.0,2026-10-27,-0.01000,XX,10.0000,M,N,N,N,NA,A,0,0,0,0,0,0,0,25044.0000,20490.6000,3511,',
  'NSE,D,100000,NA,OPTSTK,14413,PAGEIND,PAGEIND-Oct2026-44000-PE,PAGEIND 27 OCT 44000 PUT,OP,NA,20.0,2026-10-27,44000.00000,PE,5.0000,M,N,N,N,NA,A,0,0,0,0,0,0,0,12015.3000,8824.7000,601,',
  'NSE,E,2885,INE002A01018,EQUITY,,RELIANCE,RELIANCE INDUSTRIES LTD,Reliance Industries,ES,EQ,1.0,,,,10.0000,NA,N,N,N,NA,A,0,0,0.00,0,0,0.00,4.545455,1321.9000,1081.7000,81195,',
  'NSE,I,1,NA,INDEX,1,NIFTY MIDCAP 150,NIFTY MIDCAP 150,NIFTY Midcap 150,INDEX,NA,1.0,0001-01-01,,XX,0.0500,N,N,N,N,NA,A,0,0,0,0,0,0,0,0.0000,0.0000,0,',
  'MCX,M,483080,NA,FUTCOM,122,SILVERM,SILVERM,SILVERM NOV FUT,FUTCOM,2,1.0,2026-11-30,0.00000,XX,100.0000,M,N,N,N,NA,A,0,0,0,0,0,0,0,205586.0000,189772.0000,120,',
  'BSE,C,1026077,NA,FUTCUR,600,USDINR,USDINR,USDINR AUG FUT,FUTCUR,NA,1.0,2024-08-28,-0.01000,XX,0.2500,M,N,N,N,NA,A,0,0,0,0,0,0,0,86.4500,81.4100,701,',
];
const csv = [HEADER, ...ROWS].join('\n');

describe('parseDhanScripMaster (detailed CSV)', () => {
  const rows = parseDhanScripMaster(csv);
  const by = (sym: string) => rows.find((r) => r.tradingsymbol === sym);

  it('keeps every row that has a known exchange segment', () => {
    expect(rows).toHaveLength(ROWS.length);
  });

  it('maps a Bank Nifty option to NFO with the security id as the token', () => {
    const r = by('BANKNIFTY-Oct2026-71900-CE')!;
    expect(r).toBeDefined();
    expect(r.exchange).toBe('NFO');
    expect(r.segment).toBe('NSE_FNO');
    expect(r.providerToken).toBe('35018');
    expect(r.underlying).toBe('BANKNIFTY');
    expect(r.expiry).toBe('2026-10-27');
    expect(r.strike).toBe(71900);
    expect(r.optionType).toBe('CE');
    expect(r.instrumentType).toBe('CE');
    expect(r.lotSize).toBe(30);
    expect(r.tickSize).toBe(5);
  });

  it('gives BSE options a unique symbol even though Dhan prints BSXOPT for all of them', () => {
    expect(by('SENSEX-Nov2026-70800-PE')?.providerToken).toBe('1100742');
    expect(by('SENSEX50-Nov2026-25500-PE')?.providerToken).toBe('1100722');
    expect(by('SENSEX-Nov2026-70800-PE')?.exchange).toBe('BFO');
  });

  it('names futures in Dhan style and leaves strike empty', () => {
    const f = by('NIFTY-Oct2026-FUT')!;
    expect(f.instrumentType).toBe('FUT');
    expect(f.strike).toBeNull();
    expect(f.optionType).toBeNull();
    expect(by('SILVERM-Nov2026-FUT')?.exchange).toBe('MCX');
  });

  it('keeps equities under their symbol with no expiry', () => {
    const e = by('RELIANCE')!;
    expect(e.exchange).toBe('NSE');
    expect(e.isin).toBe('INE002A01018');
    expect(e.expiry).toBeNull();
    expect(e.instrumentType).toBe('EQ');
    expect(e.providerToken).toBe('2885');
  });

  it('treats the 0001-01-01 placeholder on indices as no expiry', () => {
    const i = by('NIFTY MIDCAP 150')!;
    expect(i.exchange).toBe('INDICES');
    expect(i.instrumentType).toBe('INDEX');
    expect(i.expiry).toBeNull();
  });

  it('drops rows whose segment is unknown instead of guessing', () => {
    expect(parseDhanScripMaster([HEADER, 'NSE,Z,1,NA,X,1,X,X,X,X,NA,1,,,,0.05,N,N,N,N,NA,A,0,0,0,0,0,0,0,0,0,0,'].join('\n'))).toHaveLength(0);
  });

  it('returns nothing for the wrong file rather than mislabelled rows', () => {
    expect(parseDhanScripMaster('a,b,c\n1,2,3')).toHaveLength(0);
  });
});

describe('dhan helpers', () => {
  it('formats strikes without trailing zeros', () => {
    expect(dhanDerivativeSymbol('NIFTY', '2026-10-27', 25000, 'CE')).toBe('NIFTY-Oct2026-25000-CE');
    expect(dhanDerivativeSymbol('USDINR', '2026-10-27', 83.5, 'PE')).toBe('USDINR-Oct2026-83.5-PE');
    expect(dhanDerivativeSymbol('NIFTY', '2026-10-27', null, null)).toBe('NIFTY-Oct2026-FUT');
  });
  it('maps exchange + segment letters to Dhan segments', () => {
    expect(dhanSegment('NSE', 'D')).toBe('NSE_FNO');
    expect(dhanSegment('BSE', 'E')).toBe('BSE_EQ');
    expect(dhanSegment('MCX', 'M')).toBe('MCX_COMM');
    expect(dhanSegment('NSE', 'I')).toBe('IDX_I');
    expect(dhanSegment('NSE', 'Q')).toBeNull();
  });
});
