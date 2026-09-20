import { Router } from 'express';
import { z } from 'zod';
import {
  asyncHandler, respond, requireAuth, validate, rateLimit, timeframeSchema,
} from '../../middleware/index.js';
import { registryForUser } from '../../providers/registry.js';
import { ask } from '../../ai/analyst.js';
import { queryRows, queryOne } from '../../db/pool.js';
import { aiAvailable, env } from '../../config/env.js';

export const aiRouter = Router();
aiRouter.use(requireAuth);

const analyzeSchema = z.object({
  question: z.string().min(3).max(2000),
  timeframe: timeframeSchema.optional(),
  conversationId: z.string().uuid().optional(),
});

aiRouter.post(
  '/analyze',
  // Model calls cost money and take seconds; limit them well below the
  // general API budget.
  rateLimit({ bucket: 'ai-analyze', limit: 20, windowSeconds: 60 }),
  validate(analyzeSchema),
  asyncHandler(async (req, res) => {
    const { question, timeframe, conversationId } = req.body as z.infer<typeof analyzeSchema>;
    const registry = await registryForUser(req.user!.id);

    const result = await ask({
      question,
      userId: req.user!.id,
      registry,
      ...(timeframe ? { timeframe } : {}),
      ...(conversationId ? { conversationId } : {}),
    });

    respond(res, result, {
      aiEnabled: aiAvailable(),
      model: result.model,
      latencyMs: result.latencyMs,
    });
  }),
);

aiRouter.get(
  '/status',
  asyncHandler(async (_req, res) => {
    respond(res, {
      enabled: aiAvailable(),
      model: aiAvailable() ? env.AI_MODEL : null,
      reason: aiAvailable()
        ? null
        : !env.AI_ENABLED
          ? 'AI_ENABLED is false'
          : 'ANTHROPIC_API_KEY is not configured',
      note:
        'When the AI analyst is unavailable the platform still answers, using deterministic summaries generated directly from retrieved market data.',
    });
  }),
);

/** Audit trail: what evidence each answer was built from, and whether it validated. */
aiRouter.get(
  '/logs',
  asyncHandler(async (req, res) => {
    const rows = await queryRows<{
      id: string; question: string; intent: string; validator_passed: boolean;
      regenerated: boolean; degraded_to_template: boolean; missing_facts: string[];
      latency_ms: number | null; created_at: Date;
    }>(
      `SELECT id, question, intent, validator_passed, regenerated, degraded_to_template,
              missing_facts, latency_ms, created_at
         FROM analysis_logs WHERE user_id = $1
        ORDER BY created_at DESC LIMIT 50`,
      [req.user!.id],
    );
    respond(res, rows.map((r) => ({
      id: r.id,
      question: r.question,
      intent: r.intent,
      validatorPassed: r.validator_passed,
      regenerated: r.regenerated,
      degradedToTemplate: r.degraded_to_template,
      missingFacts: r.missing_facts,
      latencyMs: r.latency_ms,
      createdAt: r.created_at.toISOString(),
    })));
  }),
);

aiRouter.get(
  '/logs/:id',
  validate(z.object({ id: z.string().uuid() }), 'params'),
  asyncHandler(async (req, res) => {
    const { id } = req.params as unknown as { id: string };
    const row = await queryOne(
      `SELECT * FROM analysis_logs WHERE id = $1 AND user_id = $2`,
      [id, req.user!.id],
    );
    respond(res, row);
  }),
);
