import { Router } from 'express';
import { z } from 'zod';
import { DailyReflectionService, getAnalyticsTimezone } from '../services/dailyReflectionService';
import { HttpError, NotFoundError } from '../errors';

const generateReflectionSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  timezone: z.string().min(1).optional(),
});

export default function settingsReflectionRoutes(reflectionService: DailyReflectionService) {
  const router = Router();

  const handleError = (res: any, error: unknown, fallbackMessage: string) => {
    if (error instanceof HttpError) {
      return res.status(error.statusCode).json({ error: error.message, details: error.details });
    }
    if (error instanceof NotFoundError) {
      return res.status(404).json({ error: error.message });
    }
    console.error(fallbackMessage, error);
    return res.status(500).json({ error: fallbackMessage });
  };

  router.get('/daily', async (req, res) => {
    try {
      const date = typeof req.query.date === 'string' ? req.query.date : undefined;
      const timezone = typeof req.query.timezone === 'string' ? req.query.timezone : getAnalyticsTimezone();
      const reflection = date
        ? await reflectionService.getReflectionByDate(date, timezone)
        : await reflectionService.getLatestReflection(timezone);
      res.json(reflection);
    } catch (error) {
      handleError(res, error, 'Failed to load daily reflection');
    }
  });

  router.get('/trends', async (req, res) => {
    try {
      const rawDays = typeof req.query.days === 'string' ? Number(req.query.days) : 14;
      const days = Number.isFinite(rawDays) && rawDays > 0 ? Math.min(Math.floor(rawDays), 90) : 14;
      const timezone = typeof req.query.timezone === 'string' ? req.query.timezone : getAnalyticsTimezone();
      const trends = await reflectionService.getTrendPoints(days, timezone);
      res.json(trends);
    } catch (error) {
      handleError(res, error, 'Failed to load reflection trends');
    }
  });

  router.post('/generate', async (req, res) => {
    try {
      const { date, timezone } = generateReflectionSchema.parse(req.body || {});
      const reflection = await reflectionService.generateReflection(date, timezone || getAnalyticsTimezone());
      res.json(reflection);
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: 'Invalid input' });
      }
      handleError(res, error, 'Failed to generate reflection');
    }
  });

  return router;
}
