#!/usr/bin/env node
/**
 * Walk the Zerodha Kite Connect daily login and print an access token.
 *
 * Kite does not issue access tokens directly. You log in through Zerodha in a
 * browser, Zerodha redirects back with a single-use `request_token`, and that
 * is exchanged — signed with a checksum over your secret — for the access
 * token. The request_token is valid for only a few minutes; the access_token
 * expires at 6 AM the next morning (a regulatory requirement, not a setting).
 *
 * Nothing is written to disk and nothing is sent anywhere except api.kite.trade.
 * The secret is used only to compute the checksum locally.
 *
 *   Step 1 — get the login URL:
 *     node scripts/kite-access-token.mjs <api_key>
 *
 *   Step 2 — after logging in, copy request_token out of the address bar:
 *     node scripts/kite-access-token.mjs <api_key> <api_secret> <request_token>
 *
 * Named flags (--key / --secret / --request-token) work too, and so do the
 * KITE_API_KEY / KITE_API_SECRET environment variables, which keep the secret
 * out of your shell history.
 *
 * Run it with `node`, not `npm run`. npm swallows unknown flags before the
 * script ever sees them — `npm run kite:token --key abc` forwards nothing at
 * all, and npm 12 hard-errors on `--secret`. If you do use npm, everything
 * after a bare `--` is passed through: `npm run kite:token -- <api_key>`.
 */
import { createHash } from 'node:crypto';
import { request } from 'undici';

const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i !== -1 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : undefined;
};

// Anything not attached to a flag, in order: key, secret, request_token.
const positional = [];
for (let i = 0; i < argv.length; i += 1) {
  if (argv[i].startsWith('--')) {
    if (argv[i + 1] && !argv[i + 1].startsWith('--')) i += 1; // skip its value
    continue;
  }
  positional.push(argv[i]);
}

const apiKey = flag('key') ?? process.env.KITE_API_KEY ?? positional[0];
const apiSecret = flag('secret') ?? process.env.KITE_API_SECRET ?? positional[1];
const requestToken = flag('request-token') ?? positional[2];

if (!apiKey) {
  console.error('');
  console.error('Missing API key.');
  console.error('');
  // Overwhelmingly the cause when invoked through npm: npm consumes unknown
  // flags itself and forwards nothing, so the script receives an empty argv
  // and cannot tell a typo from a swallowed flag. npm_lifecycle_event is set
  // only under `npm run`, which is exactly the case that needs the warning.
  if (process.env.npm_lifecycle_event && argv.length === 0) {
    console.error('npm ate the arguments. `npm run` only forwards what follows a bare');
    console.error('`--`, so `npm run kite:token --key abc` passes nothing at all.');
    console.error('');
    console.error('Run it directly instead:');
    console.error('');
    console.error('  node scripts/kite-access-token.mjs <api_key>');
    console.error('');
    console.error('or keep npm and add the separator:');
    console.error('');
    console.error('  npm run kite:token -- <api_key>');
  } else {
    console.error('Usage:');
    console.error('');
    console.error('  node scripts/kite-access-token.mjs <api_key>');
    console.error('  node scripts/kite-access-token.mjs <api_key> <api_secret> <request_token>');
    console.error('');
    console.error('Or set KITE_API_KEY / KITE_API_SECRET in the environment.');
  }
  console.error('');
  console.error('Find the key at https://developers.kite.trade → your app.');
  console.error('');
  process.exit(1);
}

// ── Step 1: no request_token yet, so print where to go ──────────────────────
if (!requestToken) {
  const loginUrl = `https://kite.zerodha.com/connect/login?api_key=${encodeURIComponent(apiKey)}&v=3`;
  console.log('');
  console.log('Step 1 — open this URL and log in to Zerodha:');
  console.log('');
  console.log(`  ${loginUrl}`);
  console.log('');
  console.log("After the 2FA prompt, Zerodha redirects to your app's registered");
  console.log('redirect URL with ?request_token=... in the address bar. That page');
  console.log('may well fail to load — that does not matter. Copy the token out of');
  console.log('the URL anyway.');
  console.log('');
  console.log('Step 2 — exchange it (within a few minutes, it is single-use):');
  console.log('');
  console.log(`  node scripts/kite-access-token.mjs ${apiKey} <api_secret> <request_token>`);
  console.log('');
  process.exit(0);
}

// ── Step 2: exchange request_token for access_token ─────────────────────────
if (!apiSecret) {
  console.error('');
  console.error('Missing API secret.');
  console.error('');
  console.error(`  node scripts/kite-access-token.mjs ${apiKey} <api_secret> ${requestToken}`);
  console.error('');
  console.error('It signs the checksum locally and never leaves this machine.');
  console.error('Set KITE_API_SECRET instead to keep it out of your shell history.');
  console.error('');
  process.exit(1);
}

const checksum = createHash('sha256').update(apiKey + requestToken + apiSecret).digest('hex');

const res = await request('https://api.kite.trade/session/token', {
  method: 'POST',
  headers: { 'X-Kite-Version': '3', 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ api_key: apiKey, request_token: requestToken, checksum }).toString(),
});

const text = await res.body.text();
let payload;
try {
  payload = JSON.parse(text);
} catch {
  console.error(`Kite returned a non-JSON response (HTTP ${res.statusCode}):`);
  console.error(text.slice(0, 500));
  process.exit(1);
}

if (res.statusCode >= 400 || payload.status !== 'success') {
  const message = payload.message ?? `HTTP ${res.statusCode}`;
  console.error('');
  console.error(`Token exchange failed: ${message}`);
  console.error('');
  // The two failures that actually happen, and what each really means.
  if (/token|checksum/i.test(message)) {
    console.error('Most likely one of:');
    console.error('  · the request_token was already used — each one works exactly once;');
    console.error('  · more than a few minutes passed since login — it expired;');
    console.error('  · the API secret does not match the API key you logged in with.');
    console.error('');
    console.error('Re-run step 1 to get a fresh request_token.');
  } else if (/subscription|permission|plan/i.test(message)) {
    console.error('This reads like a subscription problem: Kite Connect is ₹500/month');
    console.error('and the app must be active at https://developers.kite.trade.');
  }
  console.error('');
  process.exit(1);
}

const { access_token: accessToken, user_id: userId, user_name: userName } = payload.data ?? {};
if (!accessToken) {
  console.error('No access_token in the response:');
  console.error(JSON.stringify(payload, null, 2).slice(0, 500));
  process.exit(1);
}

// Expiry is fixed by regulation at 6 AM IST the following day.
const nowIst = new Date(Date.now() + 5.5 * 3600_000);
const expiry = new Date(Date.UTC(
  nowIst.getUTCFullYear(), nowIst.getUTCMonth(), nowIst.getUTCDate() + 1, 0, 30, 0,
));

console.log('');
console.log(`✓ Access token obtained${userName ? ` for ${userName}` : ''}${userId ? ` (${userId})` : ''}`);
console.log('');
console.log(`  ${accessToken}`);
console.log('');
console.log(`Valid until 6:00 AM IST on ${expiry.toISOString().slice(0, 10)} — then repeat this.`);
console.log('');
console.log('Paste it into the app: Settings → Market data providers → Zerodha Kite');
console.log('Connect → Configure → Access Token, alongside the key and secret.');
console.log('');
