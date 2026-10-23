import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, respond, requireAuth, validate } from '../../middleware/index.js';
import { badRequest } from '../../utils/errors.js';
import { pnlReport } from './reports.service.js';
import { toIst } from '../../utils/time.js';

export const reportsRouter = Router();
reportsRouter.use(requireAuth);

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD');
const pnlSchema = z.object({ from: day.optional(), to: day.optional() });

/** Profit and loss, paper and live separately, with charges and taxes itemised. IST days. */
reportsRouter.get('/pnl', validate(pnlSchema, 'query'), asyncHandler(async (req, res) => {
  const q = req.query as unknown as z.infer<typeof pnlSchema>;
  const today = toIst().dateKey;
  const from = q.from ?? today.slice(0, 8) + '01';
  const to = q.to ?? today;
  if (from > to) throw badRequest('"from" must not be after "to".');
  respond(res, await pnlReport(req.user!.id, from, to));
}));
