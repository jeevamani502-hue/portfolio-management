/**
 * Admin routes. Every call requires the admin role and every change is
 * audit-logged with the acting administrator's id.
 */
import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, respond, requireAuth, requireRole, validate, auditLog, rateLimit, allowTokensInResponse } from '../../middleware/index.js';
import { badRequest, notFound } from '../../utils/errors.js';
import * as admin from './admin.service.js';

export const adminRouter = Router();
adminRouter.use(requireAuth, requireRole('admin'));

const idParam = z.object({ id: z.string().uuid() });
const password = z.string().min(10).max(200).regex(/[A-Z]/, 'needs an upper-case letter').regex(/[a-z]/, 'needs a lower-case letter').regex(/\d/, 'needs a digit');

adminRouter.get('/overview', asyncHandler(async (_req, res) => { respond(res, await admin.overview()); }));
adminRouter.get('/users', asyncHandler(async (_req, res) => { respond(res, await admin.listUsers()); }));

adminRouter.get('/users/:id', validate(idParam, 'params'), asyncHandler(async (req, res) => {
  const { id } = req.params as unknown as { id: string };
  const detail = await admin.userDetail(id);
  if (!detail) throw notFound('No such user');
  respond(res, detail);
}));

adminRouter.patch(
  '/users/:id',
  validate(idParam, 'params'),
  validate(z.object({ role: z.enum(['user', 'analyst', 'admin']).optional(), isActive: z.boolean().optional(), fullName: z.string().max(200).nullable().optional() })),
  auditLog('admin.user.update', 'user'),
  asyncHandler(async (req, res) => {
    const { id } = req.params as unknown as { id: string };
    try {
      await admin.updateUser(req.user!.id, id, req.body as Parameters<typeof admin.updateUser>[2]);
    } catch (err) { throw badRequest(err instanceof Error ? err.message : 'could not update'); }
    respond(res, { updated: true });
  }),
);

adminRouter.post(
  '/users/:id/password',
  validate(idParam, 'params'),
  validate(z.union([
    z.object({ newPassword: password }),
    z.object({ sendResetLink: z.literal(true), via: z.enum(['email', 'telegram', 'sms']).optional() }),
  ])),
  rateLimit({ bucket: 'admin-password', limit: 30, windowSeconds: 3600 }),
  auditLog('admin.user.password', 'user'),
  asyncHandler(async (req, res) => {
    const { id } = req.params as unknown as { id: string };
    const body = req.body as { newPassword?: string; sendResetLink?: true; via?: 'email' | 'telegram' | 'sms' };
    try {
      if (body.newPassword) {
        await admin.setPassword(id, body.newPassword);
        respond(res, { changed: true, message: 'Password set. The user has been signed out everywhere.' });
        return;
      }
      const r = await admin.sendReset(id, body.via);
      const msg = r.via === 'log'
        ? 'No email, Telegram or SMS is available for this user; the link was written to the server log.'
        : `Reset link sent by ${r.via}. It works once and expires in 30 minutes.`;
      respond(res, { sent: true, via: r.via, link: r.link, message: msg });
    } catch (err) { throw badRequest(err instanceof Error ? err.message : 'could not reset'); }
  }),
);

adminRouter.post(
  '/users/:id/impersonate',
  // The reply carries an access token on purpose; without this the response scrubber blanks it.
  allowTokensInResponse,
  validate(idParam, 'params'),
  rateLimit({ bucket: 'admin-impersonate', limit: 30, windowSeconds: 3600 }),
  auditLog('admin.impersonate', 'user'),
  asyncHandler(async (req, res) => {
    const { id } = req.params as unknown as { id: string };
    try { respond(res, await admin.impersonate(req.user!.id, id)); }
    catch (err) { throw badRequest(err instanceof Error ? err.message : 'could not switch'); }
  }),
);

adminRouter.post('/users/:id/logout-all', validate(idParam, 'params'), auditLog('admin.user.logout_all', 'user'), asyncHandler(async (req, res) => {
  const { id } = req.params as unknown as { id: string };
  respond(res, { revoked: await admin.revokeSessions(id) });
}));

adminRouter.delete('/users/:id', validate(idParam, 'params'), auditLog('admin.user.delete', 'user'), asyncHandler(async (req, res) => {
  const { id } = req.params as unknown as { id: string };
  try { await admin.deleteUser(req.user!.id, id); } catch (err) { throw badRequest(err instanceof Error ? err.message : 'could not delete'); }
  respond(res, { deleted: true });
}));

adminRouter.get('/audit', validate(z.object({ limit: z.coerce.number().int().min(1).max(500).default(100) }), 'query'), asyncHandler(async (req, res) => {
  const { limit } = req.query as unknown as { limit: number };
  respond(res, await admin.recentAudit(limit));
}));

adminRouter.put(
  '/settings',
  validate(z.object({ registrationOpen: z.boolean().optional() })),
  auditLog('admin.settings', 'app_settings'),
  asyncHandler(async (req, res) => {
    const b = req.body as { registrationOpen?: boolean };
    if (b.registrationOpen !== undefined) await admin.setAppSetting('registration_open', b.registrationOpen, req.user!.id);
    respond(res, await admin.overview());
  }),
);
