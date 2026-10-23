/**
 * Administration — everything an administrator can see or change about the
 * accounts on this server. Every mutating call is audit-logged by its route.
 *
 * Secrets are never returned: broker credentials show as "saved", password
 * hashes are not read, reset links are delivered to the user rather than
 * shown unless the server is in development.
 */
import bcrypt from 'bcryptjs';
import { query, queryRows, queryOne } from '../../db/pool.js';
import { env } from '../../config/env.js';
import { getPerformance as paperPerformance, listTrades as listPaperTrades, type PaperTradeRow } from '../paper/paper.service.js';
import { livePerformance, listLiveTrades, type LiveTradeRow } from '../live/live.service.js';
import { createResetLink, deliverResetLink, type ResetDelivery } from '../auth/reset.service.js';
import { channelStatus, type ChannelStatus } from '../notifications/channels.service.js';

export type Role = 'user' | 'analyst' | 'admin';

// ── runtime settings ────────────────────────────────────────────────────────

export async function getAppSetting<T>(key: string): Promise<T | null> {
  const row = await queryOne<{ value: T }>(`SELECT value FROM app_settings WHERE key = $1`, [key]);
  return row ? row.value : null;
}

export async function setAppSetting(key: string, value: unknown, updatedBy: string): Promise<void> {
  await query(
    `INSERT INTO app_settings (key, value, updated_by) VALUES ($1, $2::jsonb, $3)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [key, JSON.stringify(value), updatedBy],
  );
}

/** Whether new accounts are accepted: the Admin screen's switch, else .env. */
export async function registrationOpen(): Promise<boolean> {
  const v = await getAppSetting<boolean>('registration_open');
  return v === null ? env.ALLOW_REGISTRATION : v;
}

// ── overview ────────────────────────────────────────────────────────────────

export interface AdminOverview {
  users: { total: number; active: number; admins: number; withBroker: number };
  trading: { paperEnabled: number; liveArmed: number; openPaper: number; openLive: number; paperNetToday: number; liveNetToday: number };
  registrationOpen: boolean;
  registrationSource: 'admin' | 'env';
  backgroundJobsUser: string | null;
  channels: ChannelStatus;
}

export async function overview(): Promise<AdminOverview> {
  const u = await queryOne<Record<string, string>>(
    `SELECT COUNT(*)::text AS total, COUNT(*) FILTER (WHERE is_active)::text AS active,
            COUNT(*) FILTER (WHERE role = 'admin')::text AS admins,
            (SELECT COUNT(DISTINCT user_id) FROM api_providers WHERE is_enabled AND credentials_enc IS NOT NULL)::text AS with_broker
       FROM users`,
  );
  const t = await queryOne<Record<string, string>>(
    `SELECT (SELECT COUNT(*) FROM paper_trade_config WHERE is_enabled)::text AS paper_enabled,
            (SELECT COUNT(*) FROM live_trade_config WHERE armed_until > now() AND kill_switch = FALSE)::text AS live_armed,
            (SELECT COUNT(*) FROM paper_trades WHERE status = 'OPEN')::text AS open_paper,
            (SELECT COUNT(*) FROM live_trades WHERE status IN ('PENDING','OPEN','EXITING'))::text AS open_live,
            (SELECT COALESCE(SUM(net_pnl), 0) FROM paper_trades WHERE (exit_at AT TIME ZONE 'Asia/Kolkata')::date = (now() AT TIME ZONE 'Asia/Kolkata')::date)::text AS paper_net_today,
            (SELECT COALESCE(SUM(net_pnl), 0) FROM live_trades WHERE (closed_at AT TIME ZONE 'Asia/Kolkata')::date = (now() AT TIME ZONE 'Asia/Kolkata')::date)::text AS live_net_today`,
  );
  const reg = await getAppSetting<boolean>('registration_open');
  return {
    users: { total: +u!['total']!, active: +u!['active']!, admins: +u!['admins']!, withBroker: +u!['with_broker']! },
    trading: {
      paperEnabled: +t!['paper_enabled']!, liveArmed: +t!['live_armed']!, openPaper: +t!['open_paper']!, openLive: +t!['open_live']!,
      paperNetToday: +t!['paper_net_today']!, liveNetToday: +t!['live_net_today']!,
    },
    registrationOpen: reg === null ? env.ALLOW_REGISTRATION : reg,
    registrationSource: reg === null ? 'env' : 'admin',
    backgroundJobsUser: env.BACKGROUND_JOBS_USER ?? null,
    channels: await channelStatus(),
  };
}

// ── users ───────────────────────────────────────────────────────────────────

export interface AdminUserRow {
  id: string;
  email: string;
  fullName: string | null;
  role: Role;
  isActive: boolean;
  createdAt: string;
  lastLoginAt: string | null;
  providers: Array<{ provider: string; enabled: boolean; health: string | null }>;
  paper: { enabled: boolean; openPositions: number; tradesToday: number; netToday: number; netAll: number } | null;
  live: { mode: string; armed: boolean; openPositions: number; netToday: number; netAll: number } | null;
  phone: string | null;
  telegramLinked: boolean;
}

export async function listUsers(): Promise<AdminUserRow[]> {
  const rows = await queryRows<Record<string, unknown>>(
    `SELECT u.id, u.email, u.full_name, u.role, u.is_active, u.created_at, u.last_login_at,
            s.phone_e164, (s.telegram_chat_id IS NOT NULL) AS telegram_linked,
            (SELECT json_agg(json_build_object('provider', p.provider, 'enabled', p.is_enabled, 'health', p.health_status) ORDER BY p.provider)
               FROM api_providers p WHERE p.user_id = u.id) AS providers,
            pc.is_enabled AS paper_enabled,
            (SELECT COUNT(*) FROM paper_trades t WHERE t.user_id = u.id AND t.status = 'OPEN') AS paper_open,
            (SELECT COUNT(*) FROM paper_trades t WHERE t.user_id = u.id AND (t.entry_at AT TIME ZONE 'Asia/Kolkata')::date = (now() AT TIME ZONE 'Asia/Kolkata')::date) AS paper_today,
            (SELECT COALESCE(SUM(net_pnl),0) FROM paper_trades t WHERE t.user_id = u.id AND (t.exit_at AT TIME ZONE 'Asia/Kolkata')::date = (now() AT TIME ZONE 'Asia/Kolkata')::date) AS paper_net_today,
            (SELECT COALESCE(SUM(net_pnl),0) FROM paper_trades t WHERE t.user_id = u.id) AS paper_net_all,
            lc.mode AS live_mode, (lc.armed_until > now() AND lc.kill_switch = FALSE) AS live_armed,
            (SELECT COUNT(*) FROM live_trades l WHERE l.user_id = u.id AND l.status IN ('PENDING','OPEN','EXITING')) AS live_open,
            (SELECT COALESCE(SUM(net_pnl),0) FROM live_trades l WHERE l.user_id = u.id AND (l.closed_at AT TIME ZONE 'Asia/Kolkata')::date = (now() AT TIME ZONE 'Asia/Kolkata')::date) AS live_net_today,
            (SELECT COALESCE(SUM(net_pnl),0) FROM live_trades l WHERE l.user_id = u.id) AS live_net_all
       FROM users u
       LEFT JOIN user_settings s ON s.user_id = u.id
       LEFT JOIN paper_trade_config pc ON pc.user_id = u.id
       LEFT JOIN live_trade_config lc ON lc.user_id = u.id
      ORDER BY u.created_at`,
  );
  return rows.map((r) => ({
    id: String(r['id']), email: String(r['email']), fullName: (r['full_name'] as string | null) ?? null,
    role: r['role'] as Role, isActive: Boolean(r['is_active']),
    createdAt: (r['created_at'] as Date).toISOString(),
    lastLoginAt: r['last_login_at'] ? (r['last_login_at'] as Date).toISOString() : null,
    providers: (r['providers'] as AdminUserRow['providers'] | null) ?? [],
    paper: r['paper_enabled'] === null || r['paper_enabled'] === undefined ? null : {
      enabled: Boolean(r['paper_enabled']), openPositions: Number(r['paper_open']), tradesToday: Number(r['paper_today']),
      netToday: Number(r['paper_net_today']), netAll: Number(r['paper_net_all']),
    },
    live: r['live_mode'] === null || r['live_mode'] === undefined ? null : {
      mode: String(r['live_mode']), armed: Boolean(r['live_armed']), openPositions: Number(r['live_open']),
      netToday: Number(r['live_net_today']), netAll: Number(r['live_net_all']),
    },
    phone: (r['phone_e164'] as string | null) ?? null,
    telegramLinked: Boolean(r['telegram_linked']),
  }));
}

export interface AdminUserDetail {
  user: AdminUserRow;
  paperPerformance: Awaited<ReturnType<typeof paperPerformance>> | null;
  paperTrades: PaperTradeRow[];
  livePerformance: Awaited<ReturnType<typeof livePerformance>> | null;
  liveTrades: LiveTradeRow[];
  portfolio: { holdings: number; invested: number | null; marketValue: number | null; asOf: string | null };
  notifications: { total: number; unread: number };
  audit: Array<{ action: string; resource: string | null; ip: string | null; at: string }>;
  sessions: number;
}

export async function userDetail(userId: string): Promise<AdminUserDetail | null> {
  const user = (await listUsers()).find((u) => u.id === userId);
  if (!user) return null;
  const [pp, pt, lp, lt, pf, nt, au, se] = await Promise.all([
    user.paper ? paperPerformance(userId).catch(() => null) : Promise.resolve(null),
    listPaperTrades(userId, { limit: 25 }),
    user.live ? livePerformance(userId).catch(() => null) : Promise.resolve(null),
    listLiveTrades(userId, { limit: 25 }),
    queryOne<{ holdings: string; invested: string | null; market_value: string | null; as_of: Date | null }>(
      `SELECT (SELECT COUNT(*) FROM portfolio_holdings h JOIN portfolios p ON p.id = h.portfolio_id WHERE p.user_id = $1)::text AS holdings,
              s.invested::text, s.market_value::text, s.as_of
         FROM portfolios p LEFT JOIN LATERAL (
           SELECT invested, market_value, as_of FROM portfolio_snapshots ps WHERE ps.portfolio_id = p.id ORDER BY snapshot_date DESC LIMIT 1
         ) s ON TRUE
        WHERE p.user_id = $1 ORDER BY p.created_at LIMIT 1`,
      [userId],
    ),
    queryOne<{ total: string; unread: string }>(
      `SELECT COUNT(*)::text AS total, COUNT(*) FILTER (WHERE read_at IS NULL)::text AS unread FROM user_notifications WHERE user_id = $1`,
      [userId],
    ),
    queryRows<{ action: string; resource: string | null; ip: string | null; created_at: Date }>(
      `SELECT action, resource, ip::text AS ip, created_at FROM audit_logs WHERE user_id = $1 ORDER BY created_at DESC LIMIT 20`,
      [userId],
    ),
    queryOne<{ n: string }>(`SELECT COUNT(*)::text AS n FROM refresh_tokens WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > now()`, [userId]),
  ]);
  return {
    user, paperPerformance: pp, paperTrades: pt, livePerformance: lp, liveTrades: lt,
    portfolio: {
      holdings: Number(pf?.holdings ?? 0), invested: pf?.invested === null || pf?.invested === undefined ? null : Number(pf.invested),
      marketValue: pf?.market_value === null || pf?.market_value === undefined ? null : Number(pf.market_value),
      asOf: pf?.as_of ? pf.as_of.toISOString() : null,
    },
    notifications: { total: Number(nt?.total ?? 0), unread: Number(nt?.unread ?? 0) },
    audit: au.map((a) => ({ action: a.action, resource: a.resource, ip: a.ip, at: a.created_at.toISOString() })),
    sessions: Number(se?.n ?? 0),
  };
}

async function adminCount(): Promise<number> {
  const r = await queryOne<{ n: string }>(`SELECT COUNT(*)::text AS n FROM users WHERE role = 'admin' AND is_active`);
  return Number(r?.n ?? 0);
}

export async function updateUser(
  adminId: string,
  userId: string,
  patch: { role?: Role; isActive?: boolean; fullName?: string | null },
): Promise<void> {
  const target = await queryOne<{ role: Role; is_active: boolean }>(`SELECT role, is_active FROM users WHERE id = $1`, [userId]);
  if (!target) throw new Error('No such user.');
  const demoting = (patch.role !== undefined && patch.role !== 'admin' && target.role === 'admin')
    || (patch.isActive === false && target.role === 'admin' && target.is_active);
  if (demoting && (await adminCount()) <= 1) throw new Error('That is the last active administrator; promote someone else first.');
  if (userId === adminId && (patch.isActive === false || (patch.role !== undefined && patch.role !== 'admin'))) {
    throw new Error('You cannot disable or demote your own account.');
  }
  await query(
    `UPDATE users SET role = COALESCE($2, role), is_active = COALESCE($3, is_active),
            full_name = CASE WHEN $4::boolean THEN $5 ELSE full_name END, updated_at = now()
      WHERE id = $1`,
    [userId, patch.role ?? null, patch.isActive ?? null, patch.fullName !== undefined, patch.fullName ?? null],
  );
  if (patch.isActive === false) await revokeSessions(userId);
}

export async function revokeSessions(userId: string): Promise<number> {
  const r = await query(`UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`, [userId]);
  return r.rowCount ?? 0;
}

/** Set a new password directly. Signs the user out everywhere. */
export async function setPassword(userId: string, newPassword: string): Promise<void> {
  await query('UPDATE users SET password_hash = $2, updated_at = now() WHERE id = $1', [userId, await bcrypt.hash(newPassword, env.BCRYPT_ROUNDS)]);
  await revokeSessions(userId);
}

/** Send the user a reset link by the chosen channel; the link is returned only outside production. */
export async function sendReset(userId: string, prefer?: 'email' | 'telegram' | 'sms'): Promise<{ via: ResetDelivery; link: string | null }> {
  const u = await queryOne<{ email: string }>(`SELECT email FROM users WHERE id = $1`, [userId]);
  if (!u) throw new Error('No such user.');
  const link = await createResetLink(userId);
  const via = await deliverResetLink(userId, u.email, link, prefer);
  return { via, link: env.NODE_ENV === 'production' ? null : link };
}

/** Delete an account and everything it owns. Refused with open real-money positions. */
export async function deleteUser(adminId: string, userId: string): Promise<void> {
  if (userId === adminId) throw new Error('You cannot delete your own account.');
  const target = await queryOne<{ role: Role; email: string }>(`SELECT role, email FROM users WHERE id = $1`, [userId]);
  if (!target) throw new Error('No such user.');
  if (target.role === 'admin' && (await adminCount()) <= 1) throw new Error('That is the last administrator.');
  const live = await queryOne<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM live_trades WHERE user_id = $1 AND status IN ('PENDING','OPEN','EXITING')`, [userId],
  );
  if (Number(live?.n ?? 0) > 0) throw new Error('This account has open real-money positions. Close them at the broker first.');
  await query(`DELETE FROM users WHERE id = $1`, [userId]);
}

export async function recentAudit(limit = 100): Promise<Array<{ email: string | null; action: string; resource: string | null; resourceId: string | null; ip: string | null; at: string }>> {
  const rows = await queryRows<{ email: string | null; action: string; resource: string | null; resource_id: string | null; ip: string | null; created_at: Date }>(
    `SELECT u.email, a.action, a.resource, a.resource_id, a.ip::text AS ip, a.created_at
       FROM audit_logs a LEFT JOIN users u ON u.id = a.user_id
      ORDER BY a.created_at DESC LIMIT $1`,
    [Math.min(limit, 500)],
  );
  return rows.map((r) => ({ email: r.email, action: r.action, resource: r.resource, resourceId: r.resource_id, ip: r.ip, at: r.created_at.toISOString() }));
}
