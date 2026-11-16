import { Router } from 'express';
import { requireSystemAdmin } from '../middleware/adminOnly';
import { calendarTelemetry, type CalendarTelemetry } from '../services/calendarTelemetry';
import type { UserService } from '../services/userService';

/** Mount at /settings/calendar. The existing administrator check refreshes
 * identity and platform role from the database; caller claims are insufficient. */
export default function calendarTelemetryRoutes(userService: UserService, metrics: CalendarTelemetry = calendarTelemetry) {
  const router = Router();
  router.use((_req, res, next) => { res.set('Cache-Control', 'private, no-store'); next(); });
  router.use(requireSystemAdmin(userService));
  router.get('/telemetry', (_req, res) => res.json(metrics.snapshot()));
  return router;
}
