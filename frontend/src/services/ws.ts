/**
 * WebSocket client.
 *
 * Reconnects with exponential backoff and replays its subscription set on
 * every reconnect, so a dropped socket is invisible to the UI apart from the
 * feed indicator changing state.
 *
 * Important behaviour: when the socket is down, the store does NOT keep
 * serving its last tick as if it were live. `feedState` goes to
 * `disconnected` and the UI falls back to REST-sourced quotes, which carry
 * their own honest status chip.
 */
import { create } from 'zustand';
import { getAccessToken } from '@/services/api';

export interface Tick {
  s: string;
  ltp: number;
  ch: number | null;
  chp: number | null;
  v: number | null;
  oi: number | null;
  src: string;
  t: number;
  /** Set locally so components can flash on change. */
  receivedAt: number;
  /** Direction of the last change, for the flash animation. */
  dir: 'up' | 'down' | 'flat';
}

export type FeedState = 'connecting' | 'connected' | 'disconnected' | 'unavailable';

interface TickStore {
  ticks: Record<string, Tick>;
  feedState: FeedState;
  feedReason: string | null;
  marketPhase: string | null;
  subscribe: (symbols: string[]) => void;
  unsubscribe: (symbols: string[]) => void;
  reset: () => void;
}

const WS_URL = import.meta.env['VITE_WS_URL'] ?? `ws://${window.location.host}/ws`;

let socket: WebSocket | null = null;
let reconnectAttempt = 0;
let reconnectTimer: number | null = null;
let pingTimer: number | null = null;
const desired = new Set<string>();
let intentionallyClosed = false;

export const useTicks = create<TickStore>((set) => ({
  ticks: {},
  feedState: 'disconnected',
  feedReason: null,
  marketPhase: null,

  subscribe: (symbols) => {
    const added = symbols.filter((s) => !desired.has(s));
    symbols.forEach((s) => desired.add(s));
    if (added.length === 0) return;
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ op: 'subscribe', channel: 'ticks', symbols: added }));
    } else {
      connect();
    }
  },

  unsubscribe: (symbols) => {
    symbols.forEach((s) => desired.delete(s));
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ op: 'unsubscribe', channel: 'ticks', symbols }));
    }
    // Drop their cached ticks so a stale price cannot linger on screen.
    set((state) => {
      const next = { ...state.ticks };
      for (const s of symbols) delete next[s];
      return { ticks: next };
    });
  },

  reset: () => {
    desired.clear();
    set({ ticks: {}, feedState: 'disconnected', feedReason: null });
    disconnect();
  },
}));

function scheduleReconnect(): void {
  if (intentionallyClosed || reconnectTimer !== null) return;
  reconnectAttempt += 1;
  // 1s, 2s, 4s … capped at 30s, with jitter so many tabs do not sync up.
  const delay = Math.min(30_000, 1000 * 2 ** (reconnectAttempt - 1)) + Math.random() * 500;
  reconnectTimer = window.setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, delay);
}

export function connect(): void {
  const token = getAccessToken();
  if (!token) return;
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
    return;
  }

  intentionallyClosed = false;
  useTicks.setState({ feedState: 'connecting', feedReason: null });

  const url = `${WS_URL}?token=${encodeURIComponent(token)}`;
  socket = new WebSocket(url);

  socket.onopen = () => {
    reconnectAttempt = 0;
    useTicks.setState({ feedState: 'connected', feedReason: null });
    // Replay the whole subscription set — the server holds no memory of us.
    if (desired.size > 0) {
      socket?.send(JSON.stringify({ op: 'subscribe', channel: 'ticks', symbols: [...desired] }));
    }
    pingTimer = window.setInterval(() => {
      if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ op: 'ping' }));
    }, 25_000);
  };

  socket.onmessage = (event) => {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(event.data as string) as Record<string, unknown>;
    } catch {
      return;
    }

    switch (msg['op']) {
      case 'ticks': {
        const data = msg['data'] as Array<Omit<Tick, 'receivedAt' | 'dir'>> | undefined;
        if (!data) return;
        useTicks.setState((state) => {
          const next = { ...state.ticks };
          const now = Date.now();
          for (const t of data) {
            const prev = next[t.s];
            const dir: Tick['dir'] =
              prev === undefined || prev.ltp === t.ltp ? 'flat' : t.ltp > prev.ltp ? 'up' : 'down';
            next[t.s] = { ...t, receivedAt: now, dir };
          }
          return { ticks: next };
        });
        break;
      }

      case 'status': {
        const feed = msg['feed'] as string | undefined;
        useTicks.setState({
          marketPhase: (msg['market'] as string) ?? null,
          feedReason: (msg['reason'] as string) ?? null,
          // The server telling us the upstream is not publishing is different
          // from our socket being down — surface it as `unavailable`.
          feedState: feed === 'unavailable' ? 'unavailable' : 'connected',
        });
        break;
      }

      default:
        break;
    }
  };

  socket.onclose = (event) => {
    if (pingTimer !== null) { window.clearInterval(pingTimer); pingTimer = null; }
    socket = null;

    if (event.code === 4401) {
      // Auth failure: do not hammer the server; the app will reconnect after
      // the next successful token refresh.
      useTicks.setState({
        feedState: 'disconnected',
        feedReason: 'Session expired. Reconnecting after sign-in.',
      });
      return;
    }

    useTicks.setState({
      feedState: 'disconnected',
      feedReason: intentionallyClosed ? null : 'Connection lost. Reconnecting…',
    });
    scheduleReconnect();
  };

  socket.onerror = () => {
    // `onclose` always follows; nothing to do but let it handle reconnection.
  };
}

export function disconnect(): void {
  intentionallyClosed = true;
  if (reconnectTimer !== null) { window.clearTimeout(reconnectTimer); reconnectTimer = null; }
  if (pingTimer !== null) { window.clearInterval(pingTimer); pingTimer = null; }
  socket?.close(1000, 'client disconnect');
  socket = null;
  useTicks.setState({ feedState: 'disconnected', feedReason: null });
}

/** Read one symbol's live tick, if the feed is actually connected. */
export function useTick(symbol: string | null | undefined): Tick | null {
  return useTicks((s) =>
    symbol && (s.feedState === 'connected') ? (s.ticks[symbol] ?? null) : null,
  );
}
