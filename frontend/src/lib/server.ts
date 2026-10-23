/**
 * Where the API lives, and how the session is kept, when the frontend is
 * not served by the API itself.
 *
 * In the browser the app is same-origin with the API (Vite proxy in dev,
 * the API serving the build in production) and nothing here is needed. In
 * the Android shell the page comes from the APK, so the server address is
 * typed in once and kept on the device, and the refresh token travels in
 * the request body instead of a cookie: a cookie set by one origin is not
 * sent back by a WebView running another.
 */
import { Capacitor } from '@capacitor/core';

const SERVER_KEY = 'advisha.serverBase';
const REFRESH_KEY = 'advisha.refreshToken';

export function isNativeApp(): boolean {
  try { return Capacitor.isNativePlatform(); } catch { return false; }
}

/** Base URL of the API without a trailing slash, or '' for same-origin. */
export function getServerBase(): string {
  try {
    const saved = localStorage.getItem(SERVER_KEY);
    if (saved) return saved.replace(/\/+$/, '');
  } catch { /* storage unavailable: fall through */ }
  const env = import.meta.env['VITE_API_BASE_URL'] as string | undefined;
  return env ? env.replace(/\/+$/, '') : '';
}

export function setServerBase(value: string | null): void {
  try {
    if (value && value.trim()) localStorage.setItem(SERVER_KEY, value.trim().replace(/\/+$/, ''));
    else localStorage.removeItem(SERVER_KEY);
  } catch { /* ignore */ }
}

/** The websocket endpoint that goes with the configured server, or null for same-origin. */
export function wsBase(): string | null {
  const b = getServerBase();
  if (!b) return null;
  return b.replace(/^http/i, 'ws') + '/ws';
}

export function storedRefreshToken(): string | null {
  try { return localStorage.getItem(REFRESH_KEY); } catch { return null; }
}

export function storeRefreshToken(token: string | null): void {
  try {
    if (token) localStorage.setItem(REFRESH_KEY, token);
    else localStorage.removeItem(REFRESH_KEY);
  } catch { /* ignore */ }
}

/** Whether the session must be carried in the body rather than a cookie. */
export function usesBodyTokens(): boolean {
  return isNativeApp() || getServerBase() !== '';
}
