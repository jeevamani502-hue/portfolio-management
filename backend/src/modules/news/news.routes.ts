import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, respond, requireAuth, validate } from '../../middleware/index.js';
import { notFound } from '../../utils/errors.js';
import { getNews, getNewsImpact } from './news.service.js';

export const newsRouter = Router();
newsRouter.use(requireAuth);

const newsQuery = z.object({
  symbol: z.string().max(64).optional(),
  sector: z.string().max(64).optional(),
  sentiment: z.enum(['POSITIVE', 'NEUTRAL', 'NEGATIVE']).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
  offset: z.coerce.number().int().min(0).default(0),
  sinceHours: z.coerce.number().int().min(1).max(720).default(72),
});

newsRouter.get(
  '/',
  validate(newsQuery, 'query'),
  asyncHandler(async (req, res) => {
    const q = req.query as unknown as z.infer<typeof newsQuery>;
    respond(res, await getNews(q), {
      sentimentCaveat:
        'Sentiment is assigned by a transparent keyword classifier. It is a filter, not a fact about the news.',
    });
  }),
);

newsRouter.get(
  '/:id/impact',
  validate(z.object({ id: z.string().uuid() }), 'params'),
  asyncHandler(async (req, res) => {
    const { id } = req.params as unknown as { id: string };
    const impact = await getNewsImpact(id);
    if (!impact) throw notFound('Article not found');
    respond(res, impact);
  }),
);
