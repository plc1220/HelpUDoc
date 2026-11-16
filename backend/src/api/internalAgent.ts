import { Router, Request, Response } from 'express';
import { z } from 'zod';

import { HttpError } from '../errors';
import { verifyAgentContextToken } from '../services/agentToken';
import { CalendarService } from '../services/calendarService';
import { CalendarError } from '../services/calendarModel';
import { eventInput, parseEventRef } from '../services/calendarModel';
import type { CalendarProposalService } from '../services/calendarProposalService';
import { calendarTelemetry } from '../services/calendarTelemetry';
import type { WorkspaceService } from '../services/workspaceService';
import type { UserService } from '../services/userService';
import { WorkspaceCollaborationService } from '../services/workspaceCollaborationService';

/**
 * Internal agent-callback routes authenticated by the backend-signed agent
 * context JWT (spec F3.4). This is a REAL Bearer-JWT verification path, wholly
 * separate from the browser/x-user-id userContext middleware — the middleware
 * never verifies agent tokens, so the agent could not authenticate to the
 * ordinary collaboration routes. These routes give the Python agent an
 * authenticated, scope-bound reader for exact thread-history retrieval.
 *
 * Security properties enforced here:
 *  - Signature + expiry verified via the shared HMAC secret.
 *  - The reader scope is taken from the SIGNED token (workspace/user/thread/
 *    cutoff), never from model- or client-supplied fields. Path/query values
 *    must MATCH the signed scope or the request is rejected.
 *  - Current workspace access is rechecked in the service on every call
 *    (revocation is honored even though the run's snapshot is immutable).
 *  - The upper bound is clamped to the run's immutable cutoff so the agent can
 *    never read messages created after its run began.
 */
export default function internalAgentRoutes(
  collaboration: WorkspaceCollaborationService,
  calendar?: CalendarService,
  userService?: UserService,
  workspaceService?: WorkspaceService,
  calendarProposals?: CalendarProposalService,
) {
  const router = Router();

  const requireAgentContext = (req: Request) => {
    const raw = req.header('authorization') || '';
    const token = raw.toLowerCase().startsWith('bearer ') ? raw.slice(7).trim() : '';
    if (!token) throw new HttpError(401, 'Missing agent context token');
    const payload = verifyAgentContextToken(token);
    if (!payload) throw new HttpError(401, 'Invalid or expired agent context token');
    return payload;
  };

  const handleError = (res: Response, error: unknown, fallback: string) => {
    if (error instanceof z.ZodError) return res.status(400).json({ error: 'Invalid input', details: error.issues });
    if (error instanceof HttpError) return res.status(error.statusCode).json({ error: error.message, details: error.details });
    console.error(fallback, error instanceof Error ? error.name : 'Unknown error');
    return res.status(500).json({ error: fallback });
  };

  router.get('/team-chat/thread-history', async (req, res) => {
    try {
      const payload = requireAgentContext(req);
      const scope = payload.threadHistoryScope;
      if (!scope || !scope.workspaceId || !scope.userId || !scope.threadId || !Number.isFinite(Number(scope.cutoffSeq))) {
        throw new HttpError(403, 'This agent token is not scoped for thread history');
      }
      const query = z.object({
        workspaceId: z.string().min(1),
        threadId: z.string().min(1),
        fromSeq: z.coerce.number().int().nonnegative(),
        toSeq: z.coerce.number().int().nonnegative(),
        limit: z.coerce.number().int().positive().max(100).optional(),
      }).parse(req.query);

      // The request MUST target exactly the signed scope. Any mismatch is a
      // cross-scope attempt (another thread/workspace) and is refused; the model
      // cannot widen the reader beyond the run it belongs to.
      if (query.workspaceId !== scope.workspaceId || query.threadId !== scope.threadId) {
        throw new HttpError(403, 'Requested thread is outside the authorized scope');
      }

      // readThreadHistoryRange rechecks CURRENT workspace access (revocation is
      // honored) and clamps the upper bound to the immutable run cutoff.
      const result = await collaboration.readThreadHistoryRange(
        scope.workspaceId,
        scope.userId,
        scope.threadId,
        query.fromSeq,
        query.toSeq,
        { limit: query.limit, cutoffSeq: Number(scope.cutoffSeq), sourceMessageId: scope.sourceMessageId },
      );
      res.json(result);
    } catch (error) {
      handleError(res, error, 'Failed to read thread history');
    }
  });

  router.get('/calendar/events/:ref', async (req, res) => {
    try {
      const payload = requireAgentContext(req);
      if (!calendar || !userService || !payload.userId || !payload.workspaceId || await userService.isDeactivated(payload.userId)) throw new HttpError(403, 'Calendar context is not authorized for this run');
      if (!payload.calendarEventRefs?.includes(String(req.params.ref)) || !workspaceService) throw new HttpError(403, 'Meeting is outside the selected Calendar context');
      await workspaceService.ensureMembership(payload.workspaceId, payload.userId);
      const event = await calendar.event(payload.userId, String(req.params.ref));
      const links = await calendar.links(payload.userId, event.id);
      calendarTelemetry.recordSignal('agent_read_allowed');
      res.json({ event, related_files: links, source_retrieved_at: new Date().toISOString(), content_is_untrusted: true });
    } catch (error) {
      calendarTelemetry.recordSignal('agent_read_denied');
      if (error instanceof CalendarError) { res.status(error.status).json({ error: error.message, code: error.code }); return; }
      handleError(res, error, 'Calendar context is unavailable');
    }
  });

  const calendarContext = async (req: Request, ref: string) => {
    const payload = requireAgentContext(req);
    if (!calendar || !userService || !workspaceService || !payload.userId || !payload.workspaceId || await userService.isDeactivated(payload.userId)) throw new HttpError(403, 'Calendar actions are not authorized for this run');
    if (!payload.calendarEventRefs?.includes(ref)) throw new HttpError(403, 'Meeting is outside the selected Calendar context');
    await workspaceService.ensureMembership(payload.workspaceId, payload.userId);
    return { userId: payload.userId, workspaceId: payload.workspaceId, calendarSourceIds: payload.calendarSourceIds };
  };
  router.get('/calendar/events', async (req, res) => {
    try {
      const query = z.object({ event_ref: z.string().startsWith('meeting:').max(4096), from: z.iso.datetime({ offset: true }), to: z.iso.datetime({ offset: true }) }).parse(req.query);
      const context = await calendarContext(req, query.event_ref);
      if (Date.parse(query.to) <= Date.parse(query.from) || Date.parse(query.to) - Date.parse(query.from) > 31 * 86400000) throw new HttpError(422, 'Choose a range of up to 31 days');
      await calendar!.event(context.userId, query.event_ref);
      const [source] = parseEventRef(query.event_ref);
      if (!context.calendarSourceIds?.includes(source)) throw new HttpError(403, 'This run has selected-meeting access only. Allow calendar-wide context before listing a date range.');
      const timeline = await calendar!.timeline(context.userId, query.from, query.to);
      calendarTelemetry.recordSignal('agent_read_allowed');
      res.json({ generated_at: timeline.generated_at, items: timeline.items.filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null && (item as Record<string, unknown>).kind === 'MEETING' && (item as Record<string, unknown>).calendar_id === source), content_is_untrusted: true });
    } catch (error) {
      calendarTelemetry.recordSignal('agent_read_denied');
      if (error instanceof CalendarError) { res.status(error.status).json({ error: error.message, code: error.code }); return; }
      handleError(res, error, 'Calendar list is unavailable');
    }
  });
  router.post('/calendar/proposals', async (req, res) => {
    try {
      const body = z.object({ selected_event_ref: z.string().startsWith('meeting:').max(4096), method: z.enum(['POST', 'PATCH', 'DELETE']), input: eventInput, idempotency_key: z.string().min(8).max(128) }).strict().parse(req.body);
      const context = await calendarContext(req, body.selected_event_ref);
      if (!calendarProposals) throw new HttpError(503, 'Calendar action review is unavailable');
      res.status(202).json(await calendarProposals.propose(context.userId, context.workspaceId, body.selected_event_ref, body.method, body.input, body.idempotency_key));
    } catch (error) {
      calendarTelemetry.recordSignal('agent_write_denied');
      if (error instanceof CalendarError) { res.status(error.status).json({ error: error.message, code: error.code }); return; }
      handleError(res, error, 'Calendar proposal is unavailable');
    }
  });

  return router;
}
