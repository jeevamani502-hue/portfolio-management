/**
 * The Angel One tick wire format.
 *
 * These tests exist because the failure mode here is not a crash. A wrong
 * byte offset yields a well-formed number at the wrong scale — 124740 instead
 * of 1247.40, or a price read out of the timestamp field — and the platform
 * would display it as a live quote. Every other safeguard in this codebase
 * assumes the number it was handed is real, so this is where that assumption
 * is actually established.
 *
 * The layout was verified against the live feed during market hours: REST
 * reported RELIANCE at 1247.40 and the first streamed tick decoded to
 * 1247.40 from the same account. The fixtures below encode that layout.
 */
import { describe, it, expect } from 'vitest';
import { parseLtpPacket, buildTokenList } from '../angelone/tickStream.js';

/** Build a packet exactly as Angel One lays it out. */
function ltpPacket(opts: {
  mode?: number;
  exchangeType?: number;
  token?: string;
  sequence?: bigint;
  epochMs?: bigint;
  paise?: bigint;
  length?: number;
}): Buffer {
  // Always build the full packet, then truncate — writing at offset 43 into
  // a short buffer would throw in the helper rather than exercise the parser.
  const buf = Buffer.alloc(51);
  buf.writeUInt8(opts.mode ?? 1, 0);
  buf.writeUInt8(opts.exchangeType ?? 1, 1);
  buf.write(opts.token ?? '2885', 2, 25, 'ascii');
  buf.writeBigInt64LE(opts.sequence ?? 1n, 27);
  buf.writeBigInt64LE(opts.epochMs ?? 1790050000000n, 35);
  buf.writeBigInt64LE(opts.paise ?? 124740n, 43);
  return opts.length === undefined ? buf : buf.subarray(0, opts.length);
}

describe('parseLtpPacket', () => {
  it('decodes the packet shape seen on the live feed', () => {
    // 124740 paise is ₹1,247.40 — the value REST independently reported.
    const p = parseLtpPacket(ltpPacket({}));
    expect(p).not.toBeNull();
    expect(p!.token).toBe('2885');
    expect(p!.ltp).toBe(1247.4);
    expect(p!.exchangeType).toBe(1);
  });

  it('converts paise to rupees — not off by a factor of 100', () => {
    // The single most dangerous bug this file can have.
    expect(parseLtpPacket(ltpPacket({ paise: 100n }))!.ltp).toBe(1);
    expect(parseLtpPacket(ltpPacket({ paise: 2345945n }))!.ltp).toBe(23459.45);
  });

  it('reads the token from its fixed 25-byte field, stripping the padding', () => {
    expect(parseLtpPacket(ltpPacket({ token: '99926000' }))!.token).toBe('99926000');
    expect(parseLtpPacket(ltpPacket({ token: '1' }))!.token).toBe('1');
  });

  it('reads the exchange timestamp rather than substituting now()', () => {
    const p = parseLtpPacket(ltpPacket({ epochMs: 1790050000000n }));
    expect(p!.timestamp).toBe(new Date(1790050000000).toISOString());
  });

  it('falls back to now() only when the exchange sends no timestamp', () => {
    const before = Date.now();
    const p = parseLtpPacket(ltpPacket({ epochMs: 0n }));
    expect(new Date(p!.timestamp).getTime()).toBeGreaterThanOrEqual(before);
  });

  describe('packets it must reject rather than misread', () => {
    it('ignores a non-LTP mode — the socket multiplexes modes', () => {
      expect(parseLtpPacket(ltpPacket({ mode: 2 }))).toBeNull();
      expect(parseLtpPacket(ltpPacket({ mode: 3 }))).toBeNull();
    });

    it('ignores a truncated packet instead of reading past the end', () => {
      expect(parseLtpPacket(ltpPacket({ length: 40 }))).toBeNull();
      expect(parseLtpPacket(Buffer.alloc(0))).toBeNull();
    });

    it('drops a zero or negative price — that is not a quote', () => {
      expect(parseLtpPacket(ltpPacket({ paise: 0n }))).toBeNull();
      expect(parseLtpPacket(ltpPacket({ paise: -500n }))).toBeNull();
    });

    it('drops a packet with an empty token, which cannot be attributed', () => {
      expect(parseLtpPacket(ltpPacket({ token: '' }))).toBeNull();
    });
  });

  it('never throws, whatever arrives on the wire', () => {
    for (const len of [0, 1, 26, 50, 51, 123, 379]) {
      expect(() => parseLtpPacket(Buffer.alloc(len))).not.toThrow();
    }
    expect(() => parseLtpPacket(Buffer.from([255, 255, 255]))).not.toThrow();
  });
});

describe('buildTokenList', () => {
  it('groups tokens by Angel One exchange code', () => {
    const out = buildTokenList([
      { token: '2885', exchange: 'NSE' },
      { token: '1594', exchange: 'NSE' },
      { token: '57153', exchange: 'NFO' },
    ]);
    expect(out).toHaveLength(2);
    expect(out.find((g) => g.exchangeType === 1)!.tokens.sort()).toEqual(['1594', '2885']);
    expect(out.find((g) => g.exchangeType === 2)!.tokens).toEqual(['57153']);
  });

  it('puts indices on the cash feed, which is where they are carried', () => {
    const out = buildTokenList([{ token: '99926000', exchange: 'INDICES' }]);
    expect(out[0]!.exchangeType).toBe(1);
  });

  it('deduplicates, so a token is never subscribed twice', () => {
    const out = buildTokenList([
      { token: '2885', exchange: 'NSE' },
      { token: '2885', exchange: 'NSE' },
    ]);
    expect(out[0]!.tokens).toEqual(['2885']);
  });

  it('skips entries with no token rather than sending an empty string', () => {
    expect(buildTokenList([{ token: '', exchange: 'NSE' }])).toHaveLength(0);
  });

  it('maps every exchange the platform models', () => {
    for (const ex of ['NSE', 'BSE', 'NFO', 'BFO', 'MCX', 'CDS', 'INDICES'] as const) {
      expect(buildTokenList([{ token: '1', exchange: ex }])).toHaveLength(1);
    }
  });
});
