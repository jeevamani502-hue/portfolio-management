/**
 * Outbound channels — the same notification, delivered to the user's phone.
 *
 * The in-app notification is always written first (see notify()). This
 * module only decides whether a copy also goes to Telegram, WhatsApp or SMS,
 * and sends it. Delivery is best-effort: a failed send is logged, never
 * thrown, and never blocks the trade that caused it.
 *
 *   Telegram  free. One bot for the server (TELEGRAM_BOT_TOKEN); each user
 *             links their own chat by sending a one-time code to the bot.
 *   WhatsApp  Twilio's WhatsApp sender (TWILIO_WHATSAPP_FROM). Paid.
 *   SMS       Twilio SMS (TWILIO_SMS_FROM). Paid, and in India the sender
 *             needs DLT registration before business messages are delivered.
 */
import { randomBytes } from 'node:crypto';
import { request as httpsRequest, Agent as HttpsAgent } from 'node:https';
import { query, queryOne, queryRows } from '../../db/pool.js';
import { env } from '../../config/env.js';
import { logger } from '../../utils/logger.js';
import type { NotificationKind, NotificationSeverity, NotificationView } from './notifications.service.js';

const log = logger.child({ module: 'channels' });

export type Channel = 'telegram' | 'whatsapp' | 'sms' | 'callmebot';

const SEVERITY_RANK: Record<NotificationSeverity, number> = { info: 0, action: 1, warning: 2 };

/**
 * HTTPS with a kept-alive IPv4 connection and one retry.
 *
 * Node's built-in fetch stalled for the full timeout on two calls in five to
 * api.telegram.org from a Windows laptop, while a reused plain https socket
 * answered every time. A poll that stalls is a user waiting on "Connect";
 * a send that stalls is a trade alert that arrives late.
 */
const agent = new HttpsAgent({ keepAlive: true, family: 4, maxSockets: 4, timeout: 15_000 });

interface SlimResponse { ok: boolean; status: number; text: string; json(): Promise<unknown> }

function httpsOnce(url: string, init: { method?: string; headers?: Record<string, string>; body?: string; timeoutMs: number }): Promise<SlimResponse> {
  return new Promise((resolve, reject) => {
    const req = httpsRequest(url, { method: init.method ?? 'GET', headers: init.headers ?? {}, agent }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (d: Buffer) => chunks.push(d));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        const status = res.statusCode ?? 0;
        resolve({ ok: status >= 200 && status < 300, status, text, json: async () => (text ? JSON.parse(text) : {}) });
      });
      res.on('error', reject);
    });
    req.setTimeout(init.timeoutMs, () => req.destroy(new Error(`timed out after ${init.timeoutMs} ms`)));
    req.on('error', reject);
    if (init.body) req.write(init.body);
    req.end();
  });
}

async function fetchRetry(url: string, init: { method?: string; headers?: Record<string, string>; body?: string; timeoutMs?: number } = {}): Promise<SlimResponse> {
  const { timeoutMs = 8000, ...rest } = init;
  let lastErr: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await httpsOnce(url, { ...rest, timeoutMs });
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('request failed');
}
const TELEGRAM_API = 'https://api.telegram.org';
const LINK_TTL_MS = 30 * 60_000;
/** The number a user messages once to activate CallMeBot for their own WhatsApp. */
const CALLMEBOT_NUMBER = '+34 644 26 33 77';

// ── server-side configuration ───────────────────────────────────────────────

let botUsernameCache: { at: number; value: string | null } | null = null;

async function telegramBotUsername(): Promise<string | null> {
  if (!env.TELEGRAM_BOT_TOKEN) return null;
  if (botUsernameCache && Date.now() - botUsernameCache.at < 3600_000) return botUsernameCache.value;
  try {
    const res = await fetchRetry(`${TELEGRAM_API}/bot${env.TELEGRAM_BOT_TOKEN}/getMe`);
    const body = (await res.json()) as { ok?: boolean; result?: { username?: string } };
    const value = body.ok ? (body.result?.username ?? null) : null;
    botUsernameCache = { at: Date.now(), value };
    return value;
  } catch (err) {
    log.warn({ err: (err as Error).message }, 'Telegram getMe failed');
    return null;
  }
}

export interface ChannelStatus {
  telegram: { configured: boolean; botUsername: string | null };
  whatsapp: { configured: boolean };
  sms: { configured: boolean; provider: 'textbee' | 'twilio' | null };
  /** CallMeBot needs nothing on the server; each user activates it from their own phone. */
  callmebot: { configured: boolean; activationNumber: string };
}

export async function channelStatus(): Promise<ChannelStatus> {
  const twilio = !!(env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN);
  return {
    telegram: { configured: !!env.TELEGRAM_BOT_TOKEN, botUsername: await telegramBotUsername() },
    whatsapp: { configured: twilio && !!env.TWILIO_WHATSAPP_FROM },
    sms: {
      configured: !!env.TEXTBEE_API_KEY || (twilio && !!env.TWILIO_SMS_FROM),
      provider: env.TEXTBEE_API_KEY ? 'textbee' : twilio && env.TWILIO_SMS_FROM ? 'twilio' : null,
    },
    callmebot: { configured: true, activationNumber: CALLMEBOT_NUMBER },
  };
}

// ── per-user preferences ────────────────────────────────────────────────────

export interface ChannelPrefs {
  telegram: { enabled: boolean; linked: boolean; pendingCode: string | null; pendingUntil: string | null };
  whatsapp: { enabled: boolean };
  sms: { enabled: boolean };
  callmebot: { enabled: boolean; configured: boolean };
  phone: string | null;
  kinds: NotificationKind[];
  minSeverity: NotificationSeverity;
}

interface PrefsRow {
  notify_telegram: boolean;
  telegram_chat_id: string | null;
  telegram_link_code: string | null;
  telegram_link_expires_at: Date | null;
  notify_whatsapp: boolean;
  notify_sms: boolean;
  phone_e164: string | null;
  notify_kinds: NotificationKind[];
  notify_min_severity: NotificationSeverity;
  callmebot_apikey: string | null;
  notify_callmebot: boolean;
}

const PREFS_SELECT = `notify_telegram, telegram_chat_id, telegram_link_code, telegram_link_expires_at,
  notify_whatsapp, notify_sms, phone_e164, notify_kinds, notify_min_severity, callmebot_apikey, notify_callmebot`;

async function prefsRow(userId: string): Promise<PrefsRow | null> {
  await query(`INSERT INTO user_settings (user_id) VALUES ($1) ON CONFLICT DO NOTHING`, [userId]);
  return queryOne<PrefsRow>(`SELECT ${PREFS_SELECT} FROM user_settings WHERE user_id = $1`, [userId]);
}

const toPrefs = (r: PrefsRow): ChannelPrefs => {
  const pending = r.telegram_link_code && r.telegram_link_expires_at && r.telegram_link_expires_at.getTime() > Date.now();
  return {
    telegram: {
      enabled: r.notify_telegram, linked: !!r.telegram_chat_id,
      pendingCode: pending ? r.telegram_link_code : null,
      pendingUntil: pending ? r.telegram_link_expires_at!.toISOString() : null,
    },
    whatsapp: { enabled: r.notify_whatsapp },
    sms: { enabled: r.notify_sms },
    callmebot: { enabled: r.notify_callmebot, configured: !!r.callmebot_apikey },
    phone: r.phone_e164,
    kinds: r.notify_kinds ?? [],
    minSeverity: r.notify_min_severity ?? 'action',
  };
};

export async function getChannelPrefs(userId: string): Promise<ChannelPrefs> {
  return toPrefs((await prefsRow(userId))!);
}

export interface ChannelPrefsPatch {
  telegramEnabled?: boolean;
  whatsappEnabled?: boolean;
  smsEnabled?: boolean;
  /** E.164, e.g. +919876543210. Null clears it. */
  phone?: string | null;
  kinds?: NotificationKind[];
  minSeverity?: NotificationSeverity;
  /** Forget the linked Telegram chat. */
  unlinkTelegram?: boolean;
  callmebotEnabled?: boolean;
  /** The key CallMeBot replied with. Null clears it. */
  callmebotApiKey?: string | null;
}

export async function updateChannelPrefs(userId: string, p: ChannelPrefsPatch): Promise<ChannelPrefs> {
  await prefsRow(userId);
  if (p.phone && !/^\+[1-9]\d{7,14}$/.test(p.phone)) {
    throw new Error('Phone number must be in international form, e.g. +919876543210.');
  }
  await query(
    `UPDATE user_settings SET
       notify_telegram = COALESCE($2, notify_telegram),
       notify_whatsapp = COALESCE($3, notify_whatsapp),
       notify_sms = COALESCE($4, notify_sms),
       phone_e164 = CASE WHEN $5::boolean THEN $6 ELSE phone_e164 END,
       notify_kinds = COALESCE($7, notify_kinds),
       notify_min_severity = COALESCE($8, notify_min_severity),
       telegram_chat_id = CASE WHEN $9::boolean THEN NULL ELSE telegram_chat_id END,
       notify_telegram = CASE WHEN $9::boolean THEN FALSE ELSE COALESCE($2, notify_telegram) END,
       notify_callmebot = COALESCE($10, notify_callmebot),
       callmebot_apikey = CASE WHEN $11::boolean THEN $12 ELSE callmebot_apikey END,
       updated_at = now()
     WHERE user_id = $1`,
    [
      userId, p.telegramEnabled ?? null, p.whatsappEnabled ?? null, p.smsEnabled ?? null,
      p.phone !== undefined, p.phone ?? null, p.kinds ?? null, p.minSeverity ?? null, p.unlinkTelegram === true,
      p.callmebotEnabled ?? null, p.callmebotApiKey !== undefined, p.callmebotApiKey ?? null,
    ],
  );
  return getChannelPrefs(userId);
}

// ── Telegram linking ────────────────────────────────────────────────────────

export interface TelegramLink {
  code: string;
  botUsername: string | null;
  /** Opens the bot with the code pre-filled; one tap on a phone. */
  deepLink: string | null;
  expiresAt: string;
}

/** Issue a one-time code the user sends to the bot. The poller does the rest. */
export async function startTelegramLink(userId: string): Promise<TelegramLink> {
  if (!env.TELEGRAM_BOT_TOKEN) throw new Error('Telegram is not configured on this server (TELEGRAM_BOT_TOKEN).');
  const code = randomBytes(4).toString('hex').toUpperCase();
  const expires = new Date(Date.now() + LINK_TTL_MS);
  await prefsRow(userId);
  await query(
    `UPDATE user_settings SET telegram_link_code = $2, telegram_link_expires_at = $3, updated_at = now() WHERE user_id = $1`,
    [userId, code, expires],
  );
  const botUsername = await telegramBotUsername();
  return {
    code, botUsername, expiresAt: expires.toISOString(),
    deepLink: botUsername ? `https://t.me/${botUsername}?start=${code}` : null,
  };
}

let updateOffset = 0;

/**
 * Worker job. Reads the bot's new messages and links any that carry a
 * pending code. Cheap when nothing is pending: it returns before calling
 * Telegram at all.
 */
export async function pollTelegramLinks(): Promise<void> {
  if (!env.TELEGRAM_BOT_TOKEN) return;
  // Always poll, even with nothing pending: a person who presses Start on the
  // bot expects a reply, and a code that does not match deserves an answer.
  const pending = await queryRows<{ user_id: string; telegram_link_code: string }>(
    `SELECT user_id, telegram_link_code FROM user_settings
      WHERE telegram_link_code IS NOT NULL AND telegram_link_expires_at > now()`,
  );

  let body: { ok?: boolean; result?: Array<{ update_id: number; message?: { text?: string; chat?: { id: number; first_name?: string } } }> };
  try {
    const res = await fetchRetry(
      `${TELEGRAM_API}/bot${env.TELEGRAM_BOT_TOKEN}/getUpdates?offset=${updateOffset}&timeout=0&allowed_updates=%5B%22message%22%5D`,
    );
    body = (await res.json()) as typeof body;
  } catch (err) {
    log.warn({ err: (err as Error).message }, 'Telegram getUpdates failed');
    return;
  }
  if (!body.ok || !body.result) return;

  const byCode = new Map(pending.map((p) => [p.telegram_link_code.toUpperCase(), p.user_id]));
  for (const u of body.result) {
    updateOffset = Math.max(updateOffset, u.update_id + 1);
    const text = (u.message?.text ?? '').trim();
    const chatId = u.message?.chat?.id;
    if (!text || chatId === undefined) continue;
    const code = text.replace(/^\/start\s*/i, '').trim().toUpperCase();
    const userId = byCode.get(code);
    if (!userId) {
      log.info({ chatId, textLength: text.length, pendingCodes: byCode.size }, 'Telegram message did not match a pending link code');
      const reply = !code
        ? 'Hello. To connect this chat to AdviSha: open the app, go to Settings → Phone alerts, press Connect Telegram, and send me the code it shows.'
        : 'That code is not valid or has expired. In AdviSha, go to Settings → Phone alerts and press Connect Telegram for a fresh one, then send it here.';
      await sendTelegram(String(chatId), reply).catch((err) => log.warn({ err: (err as Error).message }, 'Telegram reply failed'));
      continue;
    }
    await query(
      `UPDATE user_settings SET telegram_chat_id = $2, notify_telegram = TRUE,
              telegram_link_code = NULL, telegram_link_expires_at = NULL, updated_at = now()
        WHERE user_id = $1`,
      [userId, String(chatId)],
    );
    byCode.delete(code);
    log.info({ userId }, 'Telegram linked');
    await sendTelegram(String(chatId), 'AdviSha is connected. Trade entries, exits and alerts will arrive here.');
  }
}

// ── senders ─────────────────────────────────────────────────────────────────

async function sendTelegram(chatId: string, text: string): Promise<void> {
  const res = await fetchRetry(`${TELEGRAM_API}/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text: text.slice(0, 4000), disable_web_page_preview: true }),
  });
  const body = (await res.json()) as { ok?: boolean; description?: string };
  if (!body.ok) throw new Error(body.description ?? `Telegram HTTP ${res.status}`);
}

/** Send to one user's linked Telegram chat; false when there is none or it failed. Used by password reset. */
export async function sendTelegramToUser(userId: string, text: string): Promise<boolean> {
  if (!env.TELEGRAM_BOT_TOKEN) return false;
  const row = await queryOne<{ telegram_chat_id: string | null }>(`SELECT telegram_chat_id FROM user_settings WHERE user_id = $1`, [userId]);
  if (!row?.telegram_chat_id) return false;
  try { await sendTelegram(row.telegram_chat_id, text); return true; } catch (err) {
    log.warn({ userId, err: (err as Error).message }, 'Telegram send failed');
    return false;
  }
}

/**
 * CallMeBot: a free, personal-use WhatsApp relay. The user messages the
 * CallMeBot number once from their own WhatsApp, receives an API key, and
 * from then on a plain GET delivers a message to that same number.
 * Best effort and unofficial; the message says so in the settings page.
 */
async function sendCallMeBot(phone: string, apikey: string, text: string): Promise<void> {
  const url = `https://api.callmebot.com/whatsapp.php?phone=${encodeURIComponent(phone)}&text=${encodeURIComponent(text.slice(0, 1500))}&apikey=${encodeURIComponent(apikey)}`;
  const res = await fetchRetry(url, { timeoutMs: 15_000 });
  if (!res.ok) throw new Error(`CallMeBot HTTP ${res.status}: ${res.text.slice(0, 160)}`);
  if (/error|invalid|not valid|apikey/i.test(res.text) && !/queued|sent/i.test(res.text)) {
    throw new Error(`CallMeBot: ${res.text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200)}`);
  }
}

/**
 * TextBee: SMS sent by the user's own Android phone through textbee.dev. Free,
 * and the message never passes a paid gateway. Uses the account-level endpoint
 * unless a device id is configured.
 */
async function sendTextBee(to: string, text: string): Promise<void> {
  if (!env.TEXTBEE_API_KEY) throw new Error('TextBee is not configured (TEXTBEE_API_KEY).');
  const url = env.TEXTBEE_DEVICE_ID
    ? `https://api.textbee.dev/api/v1/gateway/devices/${encodeURIComponent(env.TEXTBEE_DEVICE_ID)}/send-sms`
    : 'https://api.textbee.dev/api/v1/gateway/send-sms';
  const res = await fetchRetry(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': env.TEXTBEE_API_KEY },
    body: JSON.stringify({ recipients: [to], message: text.slice(0, 1000) }),
    timeoutMs: 15_000,
  });
  if (!res.ok) throw new Error(`TextBee HTTP ${res.status}: ${res.text.slice(0, 160)}`);
}

/** SMS by whichever gateway the server has: TextBee first (free), else Twilio. */
async function sendSms(to: string, text: string): Promise<void> {
  if (env.TEXTBEE_API_KEY) return sendTextBee(to, text);
  return sendTwilio('sms', to, text);
}

/** SMS to one user's saved number; false when there is no number or no gateway. */
export async function sendSmsToUser(userId: string, text: string): Promise<boolean> {
  if (!env.TEXTBEE_API_KEY && !(env.TWILIO_ACCOUNT_SID && env.TWILIO_SMS_FROM)) return false;
  const row = await queryOne<{ phone_e164: string | null }>(`SELECT phone_e164 FROM user_settings WHERE user_id = $1`, [userId]);
  if (!row?.phone_e164) return false;
  try { await sendSms(row.phone_e164, text); return true; } catch (err) {
    log.warn({ userId, err: (err as Error).message }, 'SMS send failed');
    return false;
  }
}

async function sendTwilio(via: 'sms' | 'whatsapp', to: string, text: string): Promise<void> {
  const from = via === 'sms' ? env.TWILIO_SMS_FROM : env.TWILIO_WHATSAPP_FROM;
  if (!env.TWILIO_ACCOUNT_SID || !env.TWILIO_AUTH_TOKEN || !from) throw new Error(`${via} is not configured on this server.`);
  const prefix = via === 'whatsapp' ? 'whatsapp:' : '';
  const form = new URLSearchParams({
    From: from.startsWith('whatsapp:') || via === 'sms' ? from : `${prefix}${from}`,
    To: `${prefix}${to}`,
    Body: text.slice(0, via === 'sms' ? 1500 : 4000),
  });
  const res = await fetchRetry(`https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_ACCOUNT_SID}/Messages.json`, {
    method: 'POST',
    headers: {
      authorization: 'Basic ' + Buffer.from(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`).toString('base64'),
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: form.toString(),
    timeoutMs: 10_000,
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { message?: string };
    throw new Error(body.message ?? `Twilio HTTP ${res.status}`);
  }
}

const formatText = (n: NotificationView): string => {
  const tag = n.severity === 'warning' ? '⚠️ ' : n.severity === 'action' ? '🔔 ' : '';
  const base = env.API_BASE_URL.replace(/\/$/, '');
  const link = n.link ? `\n${base}${n.link}` : '';
  return `${tag}${n.title}\n${n.message}${link}`;
};

/** Send one notification to every channel the user has switched on for its kind. Never throws. */
export async function dispatchExternal(userId: string, n: NotificationView): Promise<void> {
  let row: PrefsRow | null;
  try { row = await prefsRow(userId); } catch (err) { log.warn({ err }, 'channel prefs unavailable'); return; }
  if (!row) return;
  if (!(row.notify_kinds ?? []).includes(n.kind)) return;
  if (SEVERITY_RANK[n.severity] < SEVERITY_RANK[row.notify_min_severity ?? 'action']) return;

  const text = formatText(n);
  const sends: Array<Promise<void>> = [];
  if (row.notify_telegram && row.telegram_chat_id && env.TELEGRAM_BOT_TOKEN) {
    sends.push(sendTelegram(row.telegram_chat_id, text).catch((err) => log.warn({ userId, err: (err as Error).message }, 'Telegram send failed')));
  }
  if (row.notify_whatsapp && row.phone_e164) {
    sends.push(sendTwilio('whatsapp', row.phone_e164, text).catch((err) => log.warn({ userId, err: (err as Error).message }, 'WhatsApp send failed')));
  }
  if (row.notify_sms && row.phone_e164) {
    sends.push(sendSms(row.phone_e164, text).catch((err) => log.warn({ userId, err: (err as Error).message }, 'SMS send failed')));
  }
  if (row.notify_callmebot && row.phone_e164 && row.callmebot_apikey) {
    sends.push(sendCallMeBot(row.phone_e164, row.callmebot_apikey, text).catch((err) => log.warn({ userId, err: (err as Error).message }, 'CallMeBot send failed')));
  }
  await Promise.all(sends);
}

/** Send a sample to one channel now, and say exactly what went wrong if it did not arrive. */
export async function testChannel(userId: string, channel: Channel): Promise<{ sent: boolean; detail: string }> {
  const row = await prefsRow(userId);
  if (!row) return { sent: false, detail: 'No settings row.' };
  const text = '🔔 AdviSha test\nThis is how a trade entry, exit or alert will look. If you can read this, the channel works.';
  try {
    if (channel === 'telegram') {
      if (!row.telegram_chat_id) return { sent: false, detail: 'Telegram is not linked yet. Press Connect and send the code to the bot.' };
      await sendTelegram(row.telegram_chat_id, text);
    } else if (channel === 'callmebot') {
      if (!row.phone_e164) return { sent: false, detail: 'Save your WhatsApp number first.' };
      if (!row.callmebot_apikey) return { sent: false, detail: 'Paste the API key CallMeBot sent you, then save.' };
      await sendCallMeBot(row.phone_e164, row.callmebot_apikey, text);
    } else if (channel === 'sms') {
      if (!row.phone_e164) return { sent: false, detail: 'Save a phone number first.' };
      await sendSms(row.phone_e164, text);
    } else {
      if (!row.phone_e164) return { sent: false, detail: 'Save a phone number first.' };
      await sendTwilio(channel, row.phone_e164, text);
    }
    return { sent: true, detail: 'Sent. Check your phone.' };
  } catch (err) {
    return { sent: false, detail: err instanceof Error ? err.message : 'send failed' };
  }
}
