/**
 * Password reset links — created here, delivered by whichever channel the
 * account can be reached on. Used by the public "forgot password" flow and by
 * administrators resetting someone else's password.
 *
 * The token in the link is random and stored only as a SHA-256 hash; it
 * works once and expires after 30 minutes.
 */
import { createHash, randomBytes } from 'node:crypto';
import nodemailer from 'nodemailer';
import { query } from '../../db/pool.js';
import { env } from '../../config/env.js';
import { logger } from '../../utils/logger.js';
import { sendTelegramToUser, sendSmsToUser } from '../notifications/channels.service.js';

export type ResetDelivery = 'email' | 'telegram' | 'sms' | 'log';

const hashToken = (v: string): string => createHash('sha256').update(v).digest('hex');

/** Create a one-time reset link for the account. */
export async function createResetLink(userId: string): Promise<string> {
  const token = randomBytes(32).toString('hex');
  await query(
    `INSERT INTO password_reset_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, now() + interval '30 minutes')`,
    [userId, hashToken(token)],
  );
  const base = env.FRONTEND_ORIGIN.split(',')[0]!.trim().replace(/\/$/, '');
  return `${base}/reset-password?token=${token}`;
}

/** Redeem a link's token; returns the user id or null when invalid, used or expired. */
export async function consumeResetToken(token: string): Promise<string | null> {
  const row = (await query<{ id: string; user_id: string }>(
    `SELECT id, user_id FROM password_reset_tokens WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()`,
    [hashToken(token)],
  )).rows[0];
  if (!row) return null;
  await query('UPDATE password_reset_tokens SET used_at = now() WHERE id = $1', [row.id]);
  return row.user_id;
}

/**
 * Deliver the link: email when the server has SMTP, else Telegram, else SMS
 * (TextBee or Twilio), else the server log so a single-user install is never
 * locked out. `prefer` forces one channel, for an administrator's choice.
 */
export async function deliverResetLink(
  userId: string,
  email: string,
  link: string,
  prefer?: 'email' | 'telegram' | 'sms',
): Promise<ResetDelivery> {
  const text =
    'AdviSha password reset.\nOpen this link within 30 minutes to choose a new password:\n' + link +
    '\nIf you did not ask for this, ignore it; nothing changes until the link is used.';
  const order: Array<'email' | 'telegram' | 'sms'> = prefer ? [prefer] : ['email', 'telegram', 'sms'];

  for (const via of order) {
    if (via === 'email' && env.SMTP_URL) {
      try {
        await nodemailer.createTransport(env.SMTP_URL).sendMail({
          from: env.ALERT_FROM_EMAIL ?? 'advisha@localhost', to: email, subject: 'AdviSha password reset', text,
        });
        return 'email';
      } catch (err) {
        logger.warn({ err: (err as Error).message }, 'Reset email failed');
      }
    }
    if (via === 'telegram' && (await sendTelegramToUser(userId, text))) return 'telegram';
    if (via === 'sms' && (await sendSmsToUser(userId, `AdviSha password reset (30 min): ${link}`))) return 'sms';
  }
  logger.warn({ userId, link }, 'No mail, Telegram or SMS available: password reset link written to the server log');
  return 'log';
}
