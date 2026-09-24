import { Router } from 'express';
import { z } from 'zod';
import type { NotificationService } from '../services/notificationService';

export default function notificationRoutes(service: NotificationService) {
  const router = Router();
  router.use((req, res, next) => {
    if (!req.userContext) { res.status(401).json({ error: 'Authentication is required' }); return; }
    next();
  });
  router.get('/', async (req, res, next) => {
    try { res.json(await service.list(req.userContext!.userId, req.query.unread === 'true')); }
    catch (error) { next(error); }
  });
  router.post('/read-all', async (req, res, next) => {
    try { await service.markRead(req.userContext!.userId); res.sendStatus(204); }
    catch (error) { next(error); }
  });
  router.post('/:id/read', async (req, res, next) => {
    const id = z.string().uuid().safeParse(req.params.id);
    if (!id.success) { res.status(400).json({ error: 'Invalid notification ID' }); return; }
    try { await service.markRead(req.userContext!.userId, id.data); res.sendStatus(204); }
    catch (error) { next(error); }
  });
  return router;
}
