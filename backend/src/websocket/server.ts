/**
 * WebSocket gateway.
 *
 * Fan-out architecture (Architecture doc, C.1): a single ingest worker holds
 * the upstream broker socket and publishes normalized ticks to Redis pub/sub.
 * Every API pod subscribes once and fans out to its own connections. Users
 * never multiply upstream load.
 *
 * Ticks are coalesced into one frame per connection every 250 ms, so a client
 * watching 50 symbols receives 4 frames a second rather than a flood.
 */
import { WebSocketServer, WebSocket, type RawData } from 'ws';
import type { Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { logger } from '../utils/logger.js';
import { verifyAccessToken } from '../middleware/index.js';
import { subscriber, redis } from '../cache/redis.js';
import { K } from '../cache/keys.js';
import * as instrumentsRepo from '../db/repositories/instruments.js';
import { marketStatus } from '../modules/market/marketData.service.js';
import { getRegistry } from '../providers/registry.js';

const COALESCE_MS = 250;
const HEARTBEAT_MS = 30_000;
const MAX_SUBSCRIPTIONS = 200;

interface TickPayload {
  s: string;   // symbol key
  ltp: number;
  ch: number | null;
  chp: number | null;
  v: number | null;
  oi: number | null;
  src: string;
  t: number;   // source timestamp, epoch ms
}

interface Client {
  id: string;
  socket: WebSocket;
  userId: string;
  /** Instrument ids this connection wants ticks for. */
  instrumentIds: Set<number>;
  /** Buffered ticks awaiting the next flush, keyed by symbol. */
  pending: Map<string, TickPayload>;
  channels: Set<string>;
  isAlive: boolean;
}

const clients = new Map<string, Client>();
/** instrumentId → set of client ids, so a tick fans out in O(subscribers). */
const subscriptions = new Map<number, Set<string>>();

let flushTimer: NodeJS.Timeout | null = null;
let heartbeatTimer: NodeJS.Timeout | null = null;
let redisSubscribed = false;

export function attachWebSocketServer(server: Server): WebSocketServer {
  const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 64 * 1024 });

  wss.on('connection', (socket, req) => {
    // Auth: token in the query string, since browsers cannot set headers on
    // a WebSocket handshake. The token is short-lived (15 min) by design.
    let userId: string;
    try {
      const url = new URL(req.url ?? '/ws', 'http://localhost');
      const token = url.searchParams.get('token');
      if (!token) throw new Error('missing token');
      userId = verifyAccessToken(token).sub;
    } catch {
      socket.close(4401, 'Unauthorized');
      return;
    }

    const client: Client = {
      id: randomUUID(),
      socket,
      userId,
      instrumentIds: new Set(),
      pending: new Map(),
      channels: new Set(),
      isAlive: true,
    };
    clients.set(client.id, client);

    logger.debug({ clientId: client.id, userId, total: clients.size }, 'WS client connected');

    void sendStatus(client);

    socket.on('message', (raw) => void handleMessage(client, raw));
    socket.on('pong', () => { client.isAlive = true; });
    socket.on('close', () => cleanup(client));
    socket.on('error', (err) => {
      logger.debug({ err, clientId: client.id }, 'WS client error');
      cleanup(client);
    });
  });

  startFlushLoop();
  startHeartbeat(wss);
  void startRedisBridge();

  logger.info('WebSocket gateway attached at /ws');
  return wss;
}

async function handleMessage(client: Client, raw: RawData): Promise<void> {
  let msg: { op?: string; channel?: string; symbols?: string[] };
  try {
    msg = JSON.parse(raw.toString()) as typeof msg;
  } catch {
    return send(client, { op: 'error', message: 'Malformed JSON' });
  }

  switch (msg.op) {
    case 'ping':
      return send(client, { op: 'pong', ts: Date.now() });

    case 'subscribe': {
      const channel = msg.channel ?? 'ticks';
      client.channels.add(channel);
      if (channel !== 'ticks') {
        return send(client, { op: 'subscribed', channel });
      }

      const symbols = (msg.symbols ?? []).slice(0, MAX_SUBSCRIPTIONS);
      const resolved: string[] = [];
      const unresolved: string[] = [];

      for (const symbol of symbols) {
        if (client.instrumentIds.size >= MAX_SUBSCRIPTIONS) break;
        const row = await instrumentsRepo.resolveSymbol(symbol);
        if (!row) { unresolved.push(symbol); continue; }
        client.instrumentIds.add(row.id);
        let set = subscriptions.get(row.id);
        if (!set) { set = new Set(); subscriptions.set(row.id, set); }
        set.add(client.id);
        resolved.push(`${row.exchange}:${row.tradingsymbol}`);
      }

      return send(client, {
        op: 'subscribed',
        channel: 'ticks',
        symbols: resolved,
        unresolved,
        // A subscription is not a promise of data: if the feed worker is not
        // running, no ticks will arrive, and the client must show that.
        note: unresolved.length
          ? 'Some symbols could not be resolved against the instrument master.'
          : undefined,
      });
    }

    case 'unsubscribe': {
      for (const symbol of msg.symbols ?? []) {
        const row = await instrumentsRepo.resolveSymbol(symbol);
        if (!row) continue;
        client.instrumentIds.delete(row.id);
        subscriptions.get(row.id)?.delete(client.id);
        if (subscriptions.get(row.id)?.size === 0) subscriptions.delete(row.id);
      }
      return send(client, { op: 'unsubscribed', symbols: msg.symbols ?? [] });
    }

    default:
      return send(client, { op: 'error', message: `Unknown op "${msg.op}"` });
  }
}

function cleanup(client: Client): void {
  for (const id of client.instrumentIds) {
    const set = subscriptions.get(id);
    set?.delete(client.id);
    if (set && set.size === 0) subscriptions.delete(id);
  }
  clients.delete(client.id);
  logger.debug({ clientId: client.id, total: clients.size }, 'WS client disconnected');
}

function send(client: Client, payload: unknown): void {
  if (client.socket.readyState !== WebSocket.OPEN) return;
  try {
    client.socket.send(JSON.stringify(payload));
  } catch (err) {
    logger.debug({ err, clientId: client.id }, 'WS send failed');
  }
}

/**
 * Whether any configured provider can actually push ticks.
 *
 * Being subscribed to the Redis channel is not the same as having a feed:
 * with no upstream publisher, the socket is connected and silent forever.
 * Reporting "connected" there would tell the user prices are streaming when
 * nothing will ever arrive — precisely the kind of quiet overstatement this
 * platform exists to avoid.
 */
async function upstreamFeedAvailable(): Promise<boolean> {
  // The worker writes this when its socket connects or drops. Asking the
  // registry whether a provider *could* stream is not the same question:
  // capability without a connected socket is still silence, and reporting
  // "connected" there would claim prices are flowing when none will arrive.
  return (await redis.get(K.feedStatus).catch(() => null)) === 'connected';
}

async function sendStatus(client: Client): Promise<void> {
  const status = await marketStatus().catch(() => null);
  const hasUpstream = await upstreamFeedAvailable();

  send(client, {
    op: 'status',
    market: status?.phase ?? 'UNKNOWN',
    isOpen: status?.isOpen ?? false,
    feed: redisSubscribed && hasUpstream ? 'connected' : 'unavailable',
    reason: !hasUpstream
      ? 'No configured provider supplies a realtime tick stream, so prices are fetched on request rather than streamed. Each value still shows its own source and freshness.'
      : !redisSubscribed
        ? 'The realtime ingest worker is not publishing. Prices will be fetched on request instead of streamed.'
        : undefined,
    ts: Date.now(),
  });
}

/** Subscribe once to the tick channel pattern and route to interested clients. */
async function startRedisBridge(): Promise<void> {
  if (redisSubscribed) return;
  try {
    const sub = subscriber();
    await sub.psubscribe(K.tickChannelPattern);
    redisSubscribed = true;

    sub.on('pmessage', (_pattern, channel, message) => {
      const instrumentId = Number(channel.slice('ticks:'.length));
      if (!Number.isFinite(instrumentId)) return;

      const targets = subscriptions.get(instrumentId);
      if (!targets || targets.size === 0) return;

      let tick: TickPayload;
      try {
        tick = JSON.parse(message) as TickPayload;
      } catch {
        return;
      }

      for (const clientId of targets) {
        const client = clients.get(clientId);
        if (!client) continue;
        // Last write wins within the coalescing window — a client only ever
        // needs the newest price for a symbol.
        client.pending.set(tick.s, tick);
      }
    });

    logger.info('WebSocket gateway subscribed to the Redis tick stream');
  } catch (err) {
    logger.warn(
      { err },
      'Could not subscribe to the Redis tick stream. Live streaming is unavailable; the REST endpoints still serve quotes on request.',
    );
  }
}

function startFlushLoop(): void {
  if (flushTimer) return;
  flushTimer = setInterval(() => {
    for (const client of clients.values()) {
      if (client.pending.size === 0) continue;
      const data = [...client.pending.values()];
      client.pending.clear();
      send(client, { op: 'ticks', ts: Date.now(), data });
    }
  }, COALESCE_MS);
  flushTimer.unref();
}

function startHeartbeat(wss: WebSocketServer): void {
  if (heartbeatTimer) return;
  heartbeatTimer = setInterval(() => {
    for (const client of clients.values()) {
      if (!client.isAlive) {
        client.socket.terminate();
        cleanup(client);
        continue;
      }
      client.isAlive = false;
      try {
        client.socket.ping();
      } catch {
        cleanup(client);
      }
    }
  }, HEARTBEAT_MS);
  heartbeatTimer.unref();

  wss.on('close', () => {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    if (flushTimer) clearInterval(flushTimer);
    heartbeatTimer = null;
    flushTimer = null;
  });
}

/** Push an event to one user across all their open connections. */
export function pushToUser(userId: string, payload: unknown): number {
  let sent = 0;
  for (const client of clients.values()) {
    if (client.userId !== userId) continue;
    send(client, payload);
    sent += 1;
  }
  return sent;
}

/** Broadcast to every connection subscribed to a named channel. */
export function broadcast(channel: string, payload: unknown): number {
  let sent = 0;
  for (const client of clients.values()) {
    if (!client.channels.has(channel)) continue;
    send(client, payload);
    sent += 1;
  }
  return sent;
}

export const connectionCount = (): number => clients.size;
