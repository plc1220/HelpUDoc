import { Router } from 'express';
import { z } from 'zod';
import { CalendarService } from '../services/calendarService';
import { CalendarError, eventInput } from '../services/calendarModel';
import { calendarTelemetry } from '../services/calendarTelemetry';
import type { CalendarReviewFollowUpService } from '../services/calendarReviewFollowUpService';

export default function calendarRoutes(service: CalendarService, followUps?: CalendarReviewFollowUpService) {
  const router = Router();
  router.use((_req, res, next) => { res.set('Cache-Control', 'private, no-store'); res.set('Referrer-Policy', 'no-referrer'); next(); });
  router.post('/calendar/watch', async (req, res) => {
    try { await service.notification(req.get('X-Goog-Channel-ID') || '', req.get('X-Goog-Resource-ID') || '', req.get('X-Goog-Channel-Token') || ''); res.status(204).end(); }
    catch { res.status(403).json({ error: 'Unknown watch channel' }); }
  });
  router.use((req, res, next) => {
    if (!req.userContext) { res.status(401).json({ error: 'Sign in to use Calendar' }); return; }
    // Browser session/header identity is the only supported actor on public mutation routes.
    // Agent writes are denied until an approved, signed calendar-action capability is available.
    if (req.get('Authorization') || req.body?.actor_kind || req.body?.approval_ref) { calendarTelemetry.recordSignal('agent_write_denied'); res.status(403).json({ error: 'Calendar agent writes require an approved action', code: 'POLICY_DENIED' }); return; }
    if (!['GET', 'HEAD'].includes(req.method)) {
      const origin = req.get('Origin');
      const trusted = new Set([`${req.protocol}://${req.get('host')}`]);
      for (const configured of [process.env.FRONTEND_URL, process.env.GOOGLE_OAUTH_POST_LOGIN_REDIRECT]) { try { if (configured) trusted.add(new URL(configured).origin); } catch { /* ignore invalid configured URLs */ } }
      if (process.env.NODE_ENV !== 'production') { trusted.add('http://localhost:5173'); trusted.add('http://127.0.0.1:5173'); }
      if (origin && !trusted.has(origin)) { res.status(403).json({ error: 'Untrusted request origin' }); return; }
      if (!req.is('application/json') && req.method !== 'DELETE') { res.status(415).json({ error: 'Use application/json' }); return; }
    }
    next();
  });
  const handle = (fn: (req: import('express').Request) => Promise<unknown>, status = 200) => async (req: import('express').Request, res: import('express').Response) => {
    try { const result = await fn(req); res.status(status).json(result ?? { ok: true }); }
    catch (error) {
      if (error instanceof CalendarError) { res.status(error.status).json({ error: error.message, code: error.code }); return; }
      if (error instanceof z.ZodError) { res.status(422).json({ error: 'Review the calendar fields', code: 'INVALID_EVENT', details: error.issues }); return; }
      if (typeof (error as { statusCode?: number })?.statusCode === 'number') { res.status((error as { statusCode: number }).statusCode).json({ error: 'This calendar resource is unavailable' }); return; }
      console.error('Calendar request failed', error instanceof Error ? error.name : 'Unknown error');
      res.status(503).json({ error: 'Calendar is temporarily unavailable', code: 'CALENDAR_UNAVAILABLE' });
    }
  };
  const uid = (req: import('express').Request) => req.userContext!.userId;
  const param = (req: import('express').Request, key: string) => String(req.params[key]);
  if (followUps) {
    const ruleInput = z.object({
      event_ref: z.string().min(1).max(4096), workspace_id: z.uuid(),
      file_path: z.string().trim().min(1).max(1024), thread_id: z.uuid(),
      lead_minutes: z.number().int().min(1).max(10080),
    }).strict();
    router.get('/calendar/review-follow-ups', handle(req => followUps.list(uid(req), z.string().max(4096).optional().parse(req.query.event_ref))));
    router.post('/calendar/review-follow-ups', handle(req => followUps.create(uid(req), ruleInput.parse(req.body)), 201));
    router.delete('/calendar/review-follow-ups/:id', handle(req => followUps.disable(uid(req), z.uuid().parse(param(req, 'id')))));
    router.get('/calendar/review-follow-ups/:id/audit', handle(req => followUps.audit(uid(req), z.uuid().parse(param(req, 'id')))));
  }
  router.get('/calendar/connections', handle(req => service.connection(uid(req))));
  router.post('/calendar/connect', handle(req => service.connect(uid(req))));
  router.delete('/calendar/connections/google', handle(req => service.disconnect(uid(req))));
  router.delete('/calendar/connections/:id', handle(req => service.disconnectAccount(uid(req), param(req, 'id'))));
  router.get('/calendar/sources', handle(req => service.sources(uid(req))));
  router.patch('/calendar/sources/:id', handle(req => service.setVisible(uid(req), param(req, 'id'), z.object({ visible: z.boolean() }).parse(req.body).visible)));
  router.post('/calendar/sync', handle(async req => {
    const sources = await service.sources(uid(req));
    for (const source of sources.filter(s => s.visible)) { await service.sync(uid(req), source.id); await service.watch(uid(req), source.id); }
    return { synced_at: new Date().toISOString() };
  }));
  router.get('/calendar/timeline', handle(req => {
    const query = z.object({ from: z.iso.datetime({ offset: true }), to: z.iso.datetime({ offset: true }), workspace_id: z.uuid().optional() }).parse(req.query);
    if (Date.parse(query.to) <= Date.parse(query.from) || Date.parse(query.to) - Date.parse(query.from) > 62 * 86400000) throw new CalendarError(422, 'INVALID_RANGE', 'Choose a range of up to 62 days');
    return service.timeline(uid(req), query.from, query.to, query.workspace_id);
  }));
  router.get('/calendar/events/:ref', handle(req => service.event(uid(req), param(req, 'ref'))));
  router.post('/calendar/events', handle(req => service.mutate(uid(req), 'POST', undefined, eventInput.parse(req.body), undefined, req.get('Idempotency-Key')), 201));
  router.patch('/calendar/events/:ref', handle(req => service.mutate(uid(req), 'PATCH', param(req, 'ref'), eventInput.parse(req.body), req.get('If-Match'), req.get('Idempotency-Key'))));
  router.delete('/calendar/events/:ref', handle(req => service.mutate(uid(req), 'DELETE', param(req, 'ref'), eventInput.parse(req.body || {}), req.get('If-Match'), req.get('Idempotency-Key'))));
  router.get('/calendar/context/gmail/search', handle(req => service.gmailSearch(uid(req), z.string().trim().min(1).max(200).parse(req.query.q))));
  router.post('/calendar/events/:ref/brief', handle(req => {
    const input = z.object({ include_linked_content: z.boolean().default(false), gmail_thread_ids: z.array(z.string().regex(/^[a-fA-F0-9]{1,64}$/)).max(5).default([]), include_prior_occurrence: z.boolean().default(false) }).strict().parse(req.body || {});
    return service.createBrief(uid(req), param(req, 'ref'), input.include_linked_content, input.gmail_thread_ids, input.include_prior_occurrence);
  }, 202));
  router.get('/calendar/briefs/:id', handle(req => service.brief(uid(req), param(req, 'id'))));
  router.get('/context/links', handle(req => service.links(uid(req), z.string().min(1).max(4096).parse(req.query.subject_ref))));
  router.post('/context/links', handle(req => {
    const data = z.object({ subject_ref: z.string().max(4096), file_ref: z.string().min(1).max(1024), scope: z.enum(['single', 'series']).default('single') }).strict().parse(req.body);
    const key = z.string().min(8).max(128).parse(req.get('Idempotency-Key'));
    return service.link(uid(req), data.subject_ref, data.file_ref, key, data.scope);
  }, 201));
  router.delete('/context/links/:id', handle(req => service.unlink(uid(req), param(req, 'id'))));
  router.get('/drive/picker', handle(req => service.picker(uid(req), z.string().min(1).max(100).parse(req.query.connection_id))));
  router.get('/context/workspace-files', handle(req => service.searchWorkspaceFiles(uid(req), z.uuid().parse(req.query.workspace_id), z.string().max(200).parse(req.query.q || ''))));
  router.get('/drive/files/search', handle(req => service.searchFiles(uid(req), z.string().trim().min(1).max(200).parse(req.query.q))));
  const commitment = z.object({ title: z.string().trim().min(1).max(500), start: z.iso.datetime({ offset: true }), workspace_id: z.uuid().optional(), source_ref: z.string().max(4096).optional(), confirmed: z.boolean() }).strict();
  router.post('/calendar/commitments', handle(req => service.commitment(uid(req), commitment.parse(req.body)), 201));
  router.patch('/calendar/commitments/:id', handle(req => service.commitment(uid(req), commitment.parse(req.body), param(req, 'id'))));
  return router;
}
