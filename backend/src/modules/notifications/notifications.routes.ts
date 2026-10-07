import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, respond, requireAuth, validate } from '../../middleware/index.js';
import { listNotifications, markRead, notify } from './notifications.service.js';

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
