import { Router } from 'express';
import { asyncHandler, respond, requireAuth } from '../../middleware/index.js';
import { agentSummary, morningPlan, closeReport } from './agent.service.js';

export const agentRouter = Router();
agentRouter.use(requireAuth);

agentRouter.get('/summary', asyncHandler(async (req, res) => {
  respond(res, await agentSummary(req.user!.id));
}));

/** Issue the morning plan now (ignored if one was already issued today). */
agentRouter.post('/brief/morning', asyncHandler(async (req, res) => {
  respond(res, { issued: await morningPlan(req.user!.id) });
}));

agentRouter.post('/brief/close', asyncHandler(async (req, res) => {
  respond(res, { issued: await closeReport(req.user!.id) });
}));
