/**
 * Angel One SmartWebSocket V2 — the live tick feed.
 *
 * The wire format is binary and positional, so the byte offsets below are
 * not a detail to be approximated. A wrong offset does not throw; it yields
 * a plausible-looking number at the wrong scale, and a price that is quietly
 * wrong is the worst failure this platform can produce. Every offset here
 * comes from Angel One's own published SDK, and `parseLtpPacket` is exported
 * so the layout is pinned by tests rather than trusted.
 *
 *   LTP packet, 51 bytes, little-endian:
 *     0      uint8   subscription mode
 *     1      uint8   exchange type
 *     2–26   char25  token, null-padded
 *     27–34  int64   sequence number
 *     35–42  int64   exchange timestamp, epoch ms
 *     43–50  int64   last traded price, in paise
 */
import WebSocket from 'ws';
import { logger } from '../../utils/logger.js';
import type { NormalizedTick, TickStream, TickSubscription, Exchange } from '../types.js';

const WS_URL = 'wss://smartapisocket.angelone.in/smart-stream';

/** Angel One's numeric exchange codes, from the published SDK. */
const EXCHANGE_CODE: Record<string, number> = {
  NSE: 1, // nse_cm
  NFO: 2, // nse_fo
  BSE: 3, // bse_cm
  BFO: 4, // bse_fo
  MCX: 5, // mcx_fo
  CDS: 13, // cde_fo
  INDICES: 1, // indices are carried on the cash feed
};

const MODE_LTP = 1;
const LTP_PACKET_BYTES = 51;

/**
 * The server closes an idle socket, so a heartbeat is not optional. Ten
 * seconds is what Angel One's own client uses.
 */
const HEARTBEAT_MS = 10_000;

/** Reconnect backoff, capped so a long outage does not become a silent one. */
const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

const log = logger.child({ component: 'AngelOneTickStream' });

export interface ParsedLtp {
  token: string;
  exchangeType: number;
  /** Rupees. The wire carries paise. */
  ltp: number;
  timestamp: string;
  sequence: number;
}

/**
 * Decode one LTP packet.
 *
 * Returns null rather than throwing on a packet that is the wrong length or
 * the wrong mode — the socket multiplexes modes, and one unexpected frame
 * should not take the feed down.
 */
export function parseLtpPacket(buf: Buffer): ParsedLtp | null {
  if (buf.length < LTP_PACKET_BYTES) return null;

  const mode = buf.readUInt8(0);
  if (mode !== MODE_LTP) return null;

  const exchangeType = buf.readUInt8(1);

  // Fixed 25-byte field, null-padded rather than length-prefixed.
  const rawToken = buf.subarray(2, 27);
  const nul = rawToken.indexOf(0);
  const token = rawToken.subarray(0, nul === -1 ? rawToken.length : nul).toString('ascii').trim();
  if (!token) return null;

  const sequence = Number(buf.readBigInt64LE(27));
  const epochMs = Number(buf.readBigInt64LE(35));
  const paise = Number(buf.readBigInt64LE(43));

  // A zero or negative print is not a price. Dropping it is correct: the
  // platform would otherwise display it as live.
  if (!Number.isFinite(paise) || paise <= 0) return null;

  return {
    token,
    exchangeType,
    ltp: paise / 100,
    timestamp: new Date(epochMs > 0 ? epochMs : Date.now()).toISOString(),
    sequence,
  };
}

interface StreamCredentials {
  jwtToken: string;
  feedToken: string;
  apiKey: string;
  clientCode: string;
}

/** Map instrument tokens to Angel One's `{exchangeType, tokens[]}` grouping. */
export function buildTokenList(
  entries: ReadonlyArray<{ token: string; exchange: Exchange }>,
): Array<{ exchangeType: number; tokens: string[] }> {
  const byExchange = new Map<number, Set<string>>();
  for (const e of entries) {
    const code = EXCHANGE_CODE[e.exchange];
    if (code === undefined || !e.token) continue;
    const set = byExchange.get(code) ?? new Set<string>();
    set.add(e.token);
    byExchange.set(code, set);
  }
  return [...byExchange].map(([exchangeType, tokens]) => ({
    exchangeType,
    tokens: [...tokens],
  }));
}

export class AngelOneTickStream implements TickStream {
  private ws: WebSocket | null = null;
  private heartbeat: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectDelay = RECONNECT_MIN_MS;
  private closedByUs = false;

  /** Everything currently subscribed, so a reconnect can restore it. */
  private subscribed = new Map<string, Exchange>();

  constructor(
    private readonly creds: StreamCredentials,
    private readonly sub: TickSubscription,
    /** Resolve a provider token back to its exchange, for grouping. */
    private readonly exchangeFor: (token: string) => Exchange | undefined,
  ) {}

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  async open(): Promise<void> {
    this.closedByUs = false;
    await this.connect();
  }

  private async connect(): Promise<void> {
    return new Promise((resolve) => {
      const ws = new WebSocket(WS_URL, {
        headers: {
          Authorization: this.creds.jwtToken,
          'x-api-key': this.creds.apiKey,
          'x-client-code': this.creds.clientCode,
          'x-feed-token': this.creds.feedToken,
        },
      });
      this.ws = ws;

      ws.on('open', () => {
        this.reconnectDelay = RECONNECT_MIN_MS;
        log.info('Tick stream connected');
        this.sub.onStatus({ connected: true });

        this.heartbeat = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) ws.send('ping');
        }, HEARTBEAT_MS);

        // Restore subscriptions: after a reconnect the server knows nothing
        // about what this client was watching.
        if (this.subscribed.size > 0) {
          this.send(1, [...this.subscribed.keys()]);
        }
        resolve();
      });

      ws.on('message', (data: WebSocket.RawData, isBinary: boolean) => {
        if (!isBinary) return; // "pong" and text acknowledgements.
        const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
        const parsed = parseLtpPacket(buf);
        if (!parsed) return;

        const tick: NormalizedTick = {
          providerToken: parsed.token,
          ltp: parsed.ltp,
          volume: null,
          oi: null,
          open: null,
          high: null,
          low: null,
          close: null,
          prevClose: null,
          timestamp: parsed.timestamp,
        };
        this.sub.onTick(tick);
      });

      ws.on('error', (err) => {
        log.warn({ err: err.message }, 'Tick stream error');
        this.sub.onStatus({ connected: false, reason: err.message });
      });

      ws.on('close', (code) => {
        this.clearHeartbeat();
        this.sub.onStatus({
          connected: false,
          reason: this.closedByUs ? 'closed' : `socket closed (${code})`,
        });
        if (this.closedByUs) return;

        // Exponential backoff. Reconnecting instantly in a tight loop against
        // a broker that is rate limiting is how an API key gets suspended.
        log.warn({ code, retryInMs: this.reconnectDelay }, 'Tick stream closed, reconnecting');
        this.reconnectTimer = setTimeout(() => {
          void this.connect();
        }, this.reconnectDelay);
        this.reconnectDelay = Math.min(this.reconnectDelay * 2, RECONNECT_MAX_MS);
      });

      // Resolve on failure too: the caller should not hang waiting for a
      // socket that will retry in the background.
      ws.on('unexpected-response', (_req, res) => {
        log.error({ status: res.statusCode }, 'Tick stream handshake rejected');
        this.sub.onStatus({ connected: false, reason: `handshake ${res.statusCode}` });
        resolve();
      });
    });
  }

  private send(action: 0 | 1, tokens: string[]): void {
    if (this.ws?.readyState !== WebSocket.OPEN || tokens.length === 0) return;

    const entries = tokens
      .map((t) => ({ token: t, exchange: this.exchangeFor(t) }))
      .filter((e): e is { token: string; exchange: Exchange } => e.exchange !== undefined);

    const tokenList = buildTokenList(entries);
    if (tokenList.length === 0) return;

    this.ws.send(
      JSON.stringify({
        correlationID: `bt-${Date.now()}`,
        action,
        params: { mode: MODE_LTP, tokenList },
      }),
    );
  }

  async subscribe(tokens: string[]): Promise<void> {
    for (const t of tokens) {
      const ex = this.exchangeFor(t);
      if (ex) this.subscribed.set(t, ex);
    }
    this.send(1, tokens);
  }

  async unsubscribe(tokens: string[]): Promise<void> {
    for (const t of tokens) this.subscribed.delete(t);
    this.send(0, tokens);
  }

  async close(): Promise<void> {
    this.closedByUs = true;
    this.clearHeartbeat();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.close();
    this.ws = null;
  }

  private clearHeartbeat(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
  }
}
