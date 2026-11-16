import { Router } from 'express';
import { z } from 'zod';
import { CalendarError, eventInput } from '../services/calendarModel';
import { CalendarProposalService } from '../services/calendarProposalService';

/** Mounted after calendarRoutes so its authenticated/manual-browser policy and
 * origin checks apply to approvals too. Agent bearer tokens cannot commit. */
export default function calendarProposalRoutes(service: CalendarProposalService) {
  const router = Router();
  const handle = (fn: (req: import('express').Request) => Promise<unknown>) => async (req: import('express').Request, res: import('express').Response) => {
    try {
      if (!req.userContext || req.get('Authorization')) { res.status(403).json({ error: 'Review this action in Calendar', code: 'POLICY_DENIED' }); return; }
      const result = await fn(req);
      res.json(result ?? { ok: true });
    } catch (error) {
      if (error instanceof CalendarError) { res.status(error.status).json({ error: error.message, code: error.code }); return; }
      if (error instanceof z.ZodError) { res.status(422).json({ error: 'Review the proposed event fields', code: 'INVALID_EVENT' }); return; }
      const status = (error as { statusCode?: number })?.statusCode;
      res.status(status || 503).json({ error: 'This Calendar proposal is unavailable' });
    }
  };
  router.get('/calendar/proposals/:id', handle(req => service.get(req.userContext!.userId, z.uuid().parse(req.params.id))));
  router.post('/calendar/proposals/:id/commit', handle(req => {
    const body = z.object({ input: eventInput, etag: z.string().max(500).optional() }).strict().parse(req.body);
    return service.commit(req.userContext!.userId, z.uuid().parse(req.params.id), body.input, body.etag);
  }));
  router.delete('/calendar/proposals/:id', handle(req => service.reject(req.userContext!.userId, z.uuid().parse(req.params.id))));
  return router;
}
