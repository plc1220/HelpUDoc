import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { ScheduleService } from '../services/scheduleService';
import { HttpError } from '../errors';

const cadenceSchema = z.enum(['hourly', 'daily', 'weekly', 'monthly', 'custom']);
const outputModeSchema = z.enum(['append_to_conversation', 'new_conversation_per_run']);
const notificationModeSchema = z.enum(['none', 'failure', 'all']);
const statusSchema = z.enum(['active', 'paused', 'error']);

const fileContextRefSchema = z.object({
  sourceFileId: z.number().int().positive(),
  sourceName: z.string().min(1),
  sourceMimeType: z.string().nullable().optional(),
  sourceVersionFingerprint: z.string().min(1),
  artifactId: z.string().min(1),
  artifactVersion: z.number().int().positive(),
  derivedArtifactFileId: z.number().int().positive().nullable().optional(),
  derivedArtifactPath: z.string().nullable().optional(),
  effectiveMode: z.enum(['part', 'parser', 'hybrid']),
  status: z.enum(['pending', 'partial', 'ready', 'failed', 'superseded']),
  summary: z.string().nullable().optional(),
  lastError: z.string().nullable().optional(),
}).strict();

const createScheduleSchema = z.object({
  name: z.string().trim().min(1).max(255),
  cadence: cadenceSchema,
  cronExpression: z.string().trim().min(1).max(120),
  timezone: z.string().trim().min(1).max(120),
  prompt: z.string().trim().min(1),
  persona: z.string().trim().min(1).max(64),
  selectedSkills: z.array(z.string().trim().min(1)).optional(),
  contextRefs: z.array(z.string().trim().min(1)).optional(),
  taggedFiles: z.array(z.string().trim().min(1)).optional(),
  fileContextRefs: z.array(fileContextRefSchema).optional(),
  outputMode: outputModeSchema,
  notificationMode: notificationModeSchema,
  sourceConversationId: z.string().uuid().nullable().optional(),
  sourceMessageId: z.number().int().positive().nullable().optional(),
  targetConversationId: z.string().uuid().nullable().optional(),
});

const updateScheduleSchema = createScheduleSchema.partial().extend({
  status: statusSchema.optional(),
});

const listRunsSchema = z.object({
  limit: z.coerce.number().int().positive().max(100).optional(),
});

export default function scheduleRoutes(scheduleService: ScheduleService) {
  const router = Router({ mergeParams: true });

  const requireUserContext = (req: Request) => {
    if (!req.userContext) {
      throw new HttpError(401, 'Missing user context');
    }
    return req.userContext;
  };

  const handleError = (res: Response, error: unknown, fallbackMessage: string) => {
    if (error instanceof HttpError) {
      return res.status(error.statusCode).json({ error: error.message, details: error.details });
    }
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: 'Invalid schedule payload', details: error.issues });
    }
    if (error instanceof Error && /cron|timezone|prompt/i.test(error.message)) {
      return res.status(400).json({ error: error.message });
    }
    console.error(fallbackMessage, error);
    return res.status(500).json({ error: fallbackMessage });
  };

  const workspaceIdFromParams = (req: Request): string => String(req.params.workspaceId || '');

  router.get('/', async (req, res) => {
    try {
      const user = requireUserContext(req);
      const schedules = await scheduleService.listSchedulesForWorkspace(user.userId, workspaceIdFromParams(req));
      res.json({ schedules });
    } catch (error) {
      handleError(res, error, 'Failed to list schedules');
    }
  });

  router.post('/', async (req, res) => {
    try {
      const user = requireUserContext(req);
      const payload = createScheduleSchema.parse(req.body);
      const schedule = await scheduleService.createSchedule(user.userId, workspaceIdFromParams(req), payload);
      res.status(201).json(schedule);
    } catch (error) {
      handleError(res, error, 'Failed to create schedule');
    }
  });

  router.get('/:scheduleId', async (req, res) => {
    try {
      const user = requireUserContext(req);
      const schedule = await scheduleService.getSchedule(user.userId, workspaceIdFromParams(req), req.params.scheduleId);
      res.json(schedule);
    } catch (error) {
      handleError(res, error, 'Failed to load schedule');
    }
  });

  router.patch('/:scheduleId', async (req, res) => {
    try {
      const user = requireUserContext(req);
      const payload = updateScheduleSchema.parse(req.body);
      const schedule = await scheduleService.updateSchedule(
        user.userId,
        workspaceIdFromParams(req),
        req.params.scheduleId,
        payload,
      );
      res.json(schedule);
    } catch (error) {
      handleError(res, error, 'Failed to update schedule');
    }
  });

  router.delete('/:scheduleId', async (req, res) => {
    try {
      const user = requireUserContext(req);
      const deleted = await scheduleService.deleteSchedule(user.userId, workspaceIdFromParams(req), req.params.scheduleId);
      if (!deleted) {
        return res.status(404).json({ error: 'Schedule not found' });
      }
      res.status(204).send();
    } catch (error) {
      handleError(res, error, 'Failed to delete schedule');
    }
  });

  router.post('/:scheduleId/run', async (req, res) => {
    try {
      const user = requireUserContext(req);
      const run = await scheduleService.triggerScheduleNow(user.userId, workspaceIdFromParams(req), req.params.scheduleId);
      res.status(202).json(run);
    } catch (error) {
      handleError(res, error, 'Failed to run schedule');
    }
  });

  router.get('/:scheduleId/runs', async (req, res) => {
    try {
      const user = requireUserContext(req);
      const { limit } = listRunsSchema.parse(req.query);
      const runs = await scheduleService.listRunsForSchedule(
        user.userId,
        workspaceIdFromParams(req),
        req.params.scheduleId,
        limit || 20,
      );
      res.json({ runs });
    } catch (error) {
      handleError(res, error, 'Failed to list schedule runs');
    }
  });

  return router;
}
