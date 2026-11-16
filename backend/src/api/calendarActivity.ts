import { Router } from 'express';
import { z } from 'zod';
import { CALENDAR_UI_SIGNALS, calendarTelemetry } from '../services/calendarTelemetry';

/** Mounted after the public Calendar browser/session/origin policy. Activity is
 * bounded to anonymous aggregate enum counters, never source or user labels. */
export default function calendarActivityRoutes() {
  const router = Router();
  router.post('/calendar/activity', (req, res) => {
    res.set('Cache-Control', 'private, no-store');
    if (!req.userContext || req.get('Authorization')) { res.status(403).json({ error: 'Calendar session required' }); return; }
    const body = z.object({ signal: z.enum(CALENDAR_UI_SIGNALS) }).strict().safeParse(req.body);
    if (!body.success) { res.status(422).json({ error: 'Invalid activity' }); return; }
    calendarTelemetry.recordSignal(body.data.signal);
    res.status(204).end();
  });
  return router;
}
