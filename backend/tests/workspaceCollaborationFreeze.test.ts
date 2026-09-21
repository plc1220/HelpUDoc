/**
 * Unsharing a workspace freezes its collaboration surface.
 *
 * `unshareWorkspace` moves `status` but leaves `visibility` at 'team', and
 * every collaboration gate used to read only `visibility`. The owner could
 * therefore keep posting into a Team Chat their collaborators had just been
 * locked out of — one person talking in a room nobody could answer.
 *
 * The rule lives in one place, `ensureSharedWorkspaceAccess`, which every
 * collaboration method passes through. These tests drive it via the public
 * methods, because the gate itself is private and the point is that the callers
 * are wired to it.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { WorkspaceCollaborationService } from '../src/services/workspaceCollaborationService';
import { ConflictError } from '../src/errors';

type Row = Record<string, any>;

const OWNER = 'user-owner';

/**
 * @param status what `workspaces.status` reports; 'active' is a live Shared
 *   workspace, 'unshared' one whose audience has been revoked.
 */
function makeService(status: string, role = 'owner') {
  const workspace = {
    id: 'ws-1',
    ownerId: OWNER,
    visibility: 'team',
    workspaceType: 'team',
    status,
    editingPolicy: 'direct',
    currentPublishedVersionId: null,
  };
  const inserted: Row[] = [];

  const workspaceService = {
    ensureMembership: async () => ({
      workspace,
      membership: { workspaceId: 'ws-1', userId: OWNER, role, canEdit: true },
    }),
  } as any;

  // A chainable no-op query builder. These tests are about the gate, not about
  // SQL, so every builder method returns the chain and every read resolves
  // empty; `insert` is recorded so a write that slipped past would be visible.
  const db = ((table: string) => {
    const api: any = new Proxy({}, {
      get(_target, prop: string) {
        if (prop === 'insert') {
          return async (row: Row) => { inserted.push({ table, ...row }); return [row]; };
        }
        if (prop === 'first') return async () => undefined;
        if (prop === 'then') return (onF: any) => Promise.resolve([]).then(onF);
        if (prop === 'pluck') return async () => [];
        return () => api;
      },
    });
    return api;
  }) as any;
  db.transaction = async (cb: any) => cb(db);
  db.fn = { now: () => new Date().toISOString() };
  db.raw = (sql: string) => sql;

  const service = new WorkspaceCollaborationService(
    { getDb: () => db } as any,
    workspaceService,
    {} as any,
  );
  return { service, inserted };
}

test('an unshared workspace refuses a new Team Chat message', async () => {
  const { service, inserted } = makeService('unshared');
  await assert.rejects(
    () => service.createTeamMessage('ws-1', OWNER, { body: 'anyone still here?' } as any),
    (error: unknown) => error instanceof ConflictError
      && /no longer shared/.test((error as Error).message),
  );
  assert.equal(inserted.length, 0, 'nothing was written');
});

test('an unshared workspace still serves the history', async () => {
  // The whole point of freezing rather than hiding: the thread stays readable
  // as a reference, and re-sharing brings it back intact.
  const { service } = makeService('unshared');
  const messages = await service.listTeamMessages('ws-1', OWNER);
  assert.ok(Array.isArray(messages));
});

test('an active shared workspace is not stopped by the freeze', async () => {
  // The control. A gate that refuses everything is indistinguishable from one
  // that works (`LEARNINGS.md` §14).
  //
  // Asserts the freeze specifically, not overall success: the fake cannot read
  // back the row it just inserted, so the call still throws — but it throws
  // from the read, having passed the gate and written. Claiming more than that
  // would be claiming something this harness cannot see.
  const { service, inserted } = makeService('active');
  let message = '';
  try {
    await service.createTeamMessage('ws-1', OWNER, { body: 'hello team' } as any);
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  assert.doesNotMatch(message, /no longer shared/, 'the freeze did not fire');
  assert.equal(inserted.length, 1, 'the message was written');
});

test('a trashed workspace is frozen too', async () => {
  const { service } = makeService('trashed');
  await assert.rejects(
    () => service.createTeamMessage('ws-1', OWNER, { body: 'hello' } as any),
    (error: unknown) => error instanceof ConflictError,
  );
});

test('the freeze is about the workspace, not the role', async () => {
  // An owner is the one member who still reaches an unshared workspace, so if
  // the freeze were role-shaped this is exactly the case it would miss.
  const { service } = makeService('unshared', 'owner');
  await assert.rejects(
    () => service.createTeamMessage('ws-1', OWNER, { body: 'owner post' } as any),
    (error: unknown) => error instanceof ConflictError,
  );
});
