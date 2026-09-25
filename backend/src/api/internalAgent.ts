import { Router, Request, Response } from 'express';
import { z } from 'zod';

import { HttpError } from '../errors';
import { verifyAgentContextToken } from '../services/agentToken';
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
    console.error(fallback, error);
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

  return router;
}
