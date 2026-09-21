/**
 * Regression tests for Angel One scrip-master normalization.
 *
 * Every case here comes from a real failure: Angel One authenticated
 * successfully, Settings showed "connected", and the app displayed nothing at
 * all. Three separate defects in this one function caused it, and none of them
 * surfaced as an error the user could see.
 */
import { describe, it, expect } from 'vitest';
import { parseAngelScripMaster, type AngelScripRow } from '../angelone/index.js';

const row = (over: Partial<AngelScripRow> = {}): AngelScripRow => ({
  token: '2885',
  symbol: 'RELIANCE-EQ',
  name: 'RELIANCE',
  exch_seg: 'NSE',
  instrumenttype: '',
  lotsize: '1',
  tick_size: '5',
  ...over,
});

const one = (over: Partial<AngelScripRow> = {}) => parseAngelScripMaster([row(over)])[0]!;

describe('parseAngelScripMaster', () => {
  describe('NSE series suffix', () => {
    it('strips -EQ so the symbol matches every other provider', () => {
      // The original bug: the master stored RELIANCE-EQ while the rest of the
      // platform looks up RELIANCE, so provider_tokens never merged and Angel
      // One could not price a single NSE stock.
      expect(one({ symbol: 'RELIANCE-EQ' }).tradingsymbol).toBe('RELIANCE');
    });

    it.each(['EQ', 'BE', 'BZ', 'SM', 'ST', 'GS', 'MF', 'SG', 'N0', 'N1', 'TB', 'IV'])(
      'strips the -%s series',
      (series) => {
        expect(one({ symbol: `ACME-${series}` }).tradingsymbol).toBe('ACME');
      },
    );

    it('removes only the final segment of a hyphenated symbol', () => {
      expect(one({ symbol: 'HCL-INSYS-EQ' }).tradingsymbol).toBe('HCL-INSYS');
      expect(one({ symbol: 'KLBRENG-B-EQ' }).tradingsymbol).toBe('KLBRENG-B');
    });

    it('leaves BSE symbols alone — they carry no series', () => {
      expect(one({ symbol: 'RELIANCE', exch_seg: 'BSE' }).tradingsymbol).toBe('RELIANCE');
    });

    it('leaves derivative symbols intact', () => {
      const opt = one({
        symbol: 'RELIANCE29SEP261170PE',
        exch_seg: 'NFO',
        instrumenttype: 'OPTSTK',
        strike: '117000',
      });
      expect(opt.tradingsymbol).toBe('RELIANCE29SEP261170PE');
      expect(opt.optionType).toBe('PE');
      expect(opt.strike).toBe(1170); // paise -> rupees
    });
  });

  describe('indices', () => {
    it('moves indices onto the INDICES pseudo-exchange', () => {
      // Angel One files them under exch_seg NSE. Left there, NIFTY 50 lands on
      // a second NSE row and the dashboard's INDICES lookup finds no token.
      const idx = one({ symbol: 'NIFTY 50', exch_seg: 'NSE', instrumenttype: 'AMXIDX', token: '99926000' });
      expect(idx.exchange).toBe('INDICES');
      expect(idx.tradingsymbol).toBe('NIFTY 50'); // space preserved, no suffix stripping
      expect(idx.instrumentType).toBe('INDEX');
      expect(idx.providerToken).toBe('99926000');
    });

    it('does not strip a trailing token from an index name', () => {
      expect(one({ symbol: 'NIFTY IT', instrumenttype: 'AMXIDX' }).tradingsymbol).toBe('NIFTY IT');
    });
  });

  describe('values that violate the schema', () => {
    it('clamps a zero lot size to 1', () => {
      // lot_size > 0 is a CHECK constraint; one zero row aborted the whole
      // batch, so the entire instrument master failed to sync.
      expect(one({ lotsize: '0' }).lotSize).toBe(1);
      expect(one({ lotsize: '-1' }).lotSize).toBe(1);
      expect(one({ lotsize: undefined }).lotSize).toBe(1);
    });

    it('keeps a real lot size', () => {
      expect(one({ lotsize: '250' }).lotSize).toBe(250);
    });

    it('never produces a zero tick size', () => {
      expect(one({ tick_size: '0' }).tickSize).toBeGreaterThan(0);
      expect(one({ tick_size: '5' }).tickSize).toBeCloseTo(0.05);
    });
  });

  describe('unsupported segments', () => {
    it('drops rows this platform does not model', () => {
      // NCDEX and NCO fail the exchange CHECK constraint.
      const out = parseAngelScripMaster([
        row({ exch_seg: 'NCDEX', symbol: 'GUARSEED10' }),
        row({ exch_seg: 'NCO', symbol: 'SOMETHING' }),
        row({ exch_seg: 'NSE', symbol: 'RELIANCE-EQ' }),
      ]);
      expect(out).toHaveLength(1);
      expect(out[0]!.tradingsymbol).toBe('RELIANCE');
    });

    it('skips rows missing a token, symbol or exchange', () => {
      expect(
        parseAngelScripMaster([
          row({ token: undefined }),
          row({ symbol: undefined }),
          row({ exch_seg: undefined }),
        ]),
      ).toHaveLength(0);
    });
  });
});
