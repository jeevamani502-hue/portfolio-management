import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, respond, requireAuth, validate } from '../../middleware/index.js';
import { listNotifications, markRead, notify } from './notifications.service.js';
import {
  channelStatus, getChannelPrefs, updateChannelPrefs, startTelegramLink, testChannel,
} from './channels.service.js';
import { badRequest } from '../../utils/errors.js';

export const notificationsRouter = Router();
notificationsRouter.use(requireAuth);

const listSchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  unread: z.coerce.boolean().default(false),
});

notificationsRouter.get(
  '/',
  validate(listSchema, 'query'),
  asyncHandler(async (req, res) => {
    const q = req.query as unknown as z.infer<typeof listSchema>;
    respond(res, await listNotifications(req.user!.id, { limit: q.limit, unreadOnly: q.unread }));
  }),
);

const readSchema = z.union([
  z.object({ all: z.literal(true) }),
  z.object({ ids: z.array(z.number().int().positive()).min(1).max(500) }),
]);

notificationsRouter.post(
  '/read',
  validate(readSchema),
  asyncHandler(async (req, res) => {
    const b = req.body as z.infer<typeof readSchema>;
    const updated = await markRead(req.user!.id, 'all' in b ? 'all' : b.ids);
    respond(res, { updated });
  }),
);

// ── phone channels ──────────────────────────────────────────────────────────

notificationsRouter.get('/channels', asyncHandler(async (req, res) => {
  const [status, prefs] = await Promise.all([channelStatus(), getChannelPrefs(req.user!.id)]);
  respond(res, { status, prefs });
}));

const prefsSchema = z.object({
  telegramEnabled: z.boolean().optional(),
  whatsappEnabled: z.boolean().optional(),
  smsEnabled: z.boolean().optional(),
  phone: z.string().max(20).nullable().optional(),
  kinds: z.array(z.enum(['alert', 'fno_entry', 'fno_exit', 'paper', 'paper_advice', 'live', 'system'])).max(10).optional(),
  minSeverity: z.enum(['info', 'action', 'warning']).optional(),
  unlinkTelegram: z.boolean().optional(),
  callmebotEnabled: z.boolean().optional(),
  callmebotApiKey: z.string().max(64).nullable().optional(),
});

notificationsRouter.put('/channels', validate(prefsSchema), asyncHandler(async (req, res) => {
  try {
    respond(res, await updateChannelPrefs(req.user!.id, req.body as z.infer<typeof prefsSchema>));
  } catch (err) {
    throw badRequest(err instanceof Error ? err.message : 'could not save');
  }
}));

notificationsRouter.post('/channels/telegram/link', asyncHandler(async (req, res) => {
  try {
    respond(res, await startTelegramLink(req.user!.id));
  } catch (err) {
    throw badRequest(err instanceof Error ? err.message : 'could not start the link');
  }
}));

notificationsRouter.post(
  '/channels/test',
  validate(z.object({ channel: z.enum(['telegram', 'whatsapp', 'sms', 'callmebot']) })),
  asyncHandler(async (req, res) => {
    const { channel } = req.body as { channel: 'telegram' | 'whatsapp' | 'sms' | 'callmebot' };
    respond(res, await testChannel(req.user!.id, channel));
  }),
);

/**
 * Send yourself a sample notification.
 *
 * Exists so "are desktop notifications actually working" can be answered in
 * one click rather than by waiting for a real alert to fire.
 */
notificationsRouter.post(
  '/test',
  asyncHandler(async (req, res) => {
    const { notification, sessions } = await notify(req.user!.id, {
      kind: 'system',
      severity: 'info',
      title: 'Test notification',
      message:
        'This is what an alert looks like. Entry and exit signals from the F&O engine, ' +
        'and advice on open paper positions, arrive here the same way.',
      link: '/alerts',
    });
    respond(res, { sent: true, sessions, notification });
  }),
);
