/**
 * Notifications — one path for everything that wants the user's attention.
 *
 * Persist first, push second. The websocket reaches only the sessions that
 * are open at that instant; an alert that fires at 10:14 while the laptop
 * is shut used to vanish. Writing the row before pushing means the bell in
 * the header shows it on the next visit, unread, with the numbers that
 * fired it.
 */
import { query, queryRows, queryOne } from '../../db/pool.js';
import { logger } from '../../utils/logger.js';
import { pushToUser } from '../../websocket/server.js';

export type NotificationKind = 'alert' | 'fno_entry' | 'fno_exit' | 'paper_advice' | 'live' | 'system';
export type NotificationSeverity = 'info' | 'action' | 'warning';

export interface NotificationInput {
  kind: NotificationKind;
  /** action = something to do now; warning = something going wrong; info = FYI. */
  severity?: NotificationSeverity;
  title: string;
  message: string;
  /** The observations behind it, for the expandable detail. */
  payload?: Record<string, unknown>;
  /** In-app route to open, e.g. '/fno' or '/paper'. */
  link?: string | null;
}

export interface NotificationView {
  id: number;
  kind: NotificationKind;
  severity: NotificationSeverity;
  title: string;
  message: string;
  payload: Record<string, unknown>;
  link: string | null;
  createdAt: string;
  readAt: string | null;
}

interface Row {
  id: string;
  kind: NotificationKind;
  severity: NotificationSeverity;
  title: string;
  message: string;
  payload: Record<string, unknown>;
  link: string | null;
  created_at: Date;
  read_at: Date | null;
}

const toView = (r: Row): NotificationView => ({
  id: Number(r.id),
  kind: r.kind,
  severity: r.severity,
  title: r.title,
  message: r.message,
  payload: r.payload ?? {},
  link: r.link,
  createdAt: r.created_at.toISOString(),
  readAt: r.read_at?.toISOString() ?? null,
});

const log = logger.child({ module: 'notifications' });

/** Record a notification and push it to every open session the user has. */
export async function notify(
  userId: string,
  n: NotificationInput,
): Promise<{ notification: NotificationView; sessions: number }> {
  const row = await queryOne<Row>(
    `INSERT INTO user_notifications (user_id, kind, severity, title, message, payload, link)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
     RETURNING id, kind, severity, title, message, payload, link, created_at, read_at`,
    [
      userId, n.kind, n.severity ?? 'info', n.title.slice(0, 200), n.message,
      JSON.stringify(n.payload ?? {}), n.link ?? null,
    ],
  );
  const notification = toView(row!);

  const sessions = pushToUser(userId, { op: 'notification', notification });
  log.info({ userId, kind: n.kind, severity: notification.severity, sessions, title: n.title }, 'Notification');
  return { notification, sessions };
}

export async function listNotifications(
  userId: string,
  opts: { limit?: number; unreadOnly?: boolean } = {},
): Promise<{ items: NotificationView[]; unreadCount: number }> {
  const limit = Math.min(opts.limit ?? 50, 200);
  const rows = await queryRows<Row>(
    `SELECT id, kind, severity, title, message, payload, link, created_at, read_at
       FROM user_notifications
      WHERE user_id = $1 AND ($2::boolean = FALSE OR read_at IS NULL)
      ORDER BY created_at DESC
      LIMIT $3`,
    [userId, opts.unreadOnly ?? false, limit],
  );
  return { items: rows.map(toView), unreadCount: await unreadCount(userId) };
}

export async function unreadCount(userId: string): Promise<number> {
  const row = await queryOne<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM user_notifications WHERE user_id = $1 AND read_at IS NULL`,
    [userId],
  );
  return Number(row?.n ?? 0);
}

/** Mark some (or all) of a user's notifications read. Returns how many changed. */
export async function markRead(userId: string, ids: number[] | 'all'): Promise<number> {
  const result = ids === 'all'
    ? await query(
        `UPDATE user_notifications SET read_at = now() WHERE user_id = $1 AND read_at IS NULL`,
        [userId],
      )
    : await query(
        `UPDATE user_notifications SET read_at = now()
          WHERE user_id = $1 AND read_at IS NULL AND id = ANY($2::bigint[])`,
        [userId, ids],
      );
  return result.rowCount ?? 0;
}
