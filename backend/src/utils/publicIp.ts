/**
 * The address brokers see this process coming from. Angel One, Groww and
 * Dhan all reject orders from an IP that is not registered on the API key,
 * and a home broadband address changes without notice, so the value is
 * re-checked every few minutes rather than once at start-up.
 */
const REFRESH_MS = 5 * 60_000;
let cached: { ip: string | null; at: number } = { ip: null, at: 0 };
let inFlight: Promise<string | null> | null = null;

async function lookup(): Promise<string | null> {
  try {
    const r = await fetch('https://api.ipify.org', { signal: AbortSignal.timeout(6000) });
    const ip = (await r.text()).trim();
    return /^\d+\.\d+\.\d+\.\d+$/.test(ip) ? ip : null;
  } catch {
    return null;
  }
}

/** Current public IPv4, or null when it cannot be learned right now. */
export async function publicIp(): Promise<string | null> {
  if (cached.ip && Date.now() - cached.at < REFRESH_MS) return cached.ip;
  inFlight ??= lookup().then((ip) => {
    if (ip) cached = { ip, at: Date.now() };
    inFlight = null;
    return ip ?? cached.ip;
  });
  return inFlight;
}

/** Last known value without a network call; null until the first lookup. */
export const lastKnownPublicIp = (): string | null => cached.ip;
