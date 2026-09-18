import { Server } from '@hocuspocus/server';
import { Database } from '@hocuspocus/extension-database';
import type { Knex } from 'knex';
import { DatabaseService } from '../services/databaseService';
import { UserService, isUserDeactivated } from '../services/userService';
import { WorkspaceService, isWorkspaceContentLocked } from '../services/workspaceService';
import { isFileContentProtected } from '../services/fileStatusService';

const DEFAULT_USER_NAME = process.env.DEFAULT_USER_NAME || 'Local User';
const DEFAULT_USER_EMAIL = process.env.DEFAULT_USER_EMAIL || '';

const parseDocumentName = (documentName: string): { workspaceId: string; fileId: string } => {
  const [workspaceId, fileId] = documentName.split(':');
  if (!workspaceId || !fileId) {
    throw new Error('Invalid document name');
  }
  return { workspaceId, fileId };
};

/**
 * Recently resolved workspace lock states, so `store` — which fires on every
 * debounced keystroke — does not query per change.
 *
 * Module scope rather than an instance field on purpose: the test suite builds
 * services with `Object.create(prototype)`, which skips field initializers and
 * would leave an instance-level cache `undefined` (`LEARNINGS.md` §6).
 */
const workspaceLockCache = new Map<string, { locked: boolean; at: number }>();
const WORKSPACE_LOCK_CACHE_MS = 5_000;

const isWorkspaceLockedForCollab = async (db: Knex, workspaceId: string): Promise<boolean> => {
  const cached = workspaceLockCache.get(workspaceId);
  const now = Date.now();
  if (cached && now - cached.at < WORKSPACE_LOCK_CACHE_MS) return cached.locked;
  const workspace = await db('workspaces')
    .select('visibility', 'workspaceType', 'currentPublishedVersionId')
    .where({ id: workspaceId })
    .first();
  const locked = Boolean(workspace) && isWorkspaceContentLocked(workspace as any);
  workspaceLockCache.set(workspaceId, { locked, at: now });
  return locked;
};

/**
 * Whether the document's own file is signed off, cached on the same terms as the
 * workspace lock and for the same reason: `store` fires per debounced change.
 */
const fileProtectedCache = new Map<string, { protectedFile: boolean; at: number }>();

const isFileProtectedForCollab = async (
  db: Knex,
  workspaceId: string,
  fileId: string,
): Promise<boolean> => {
  const key = `${workspaceId}:${fileId}`;
  const cached = fileProtectedCache.get(key);
  const now = Date.now();
  if (cached && now - cached.at < WORKSPACE_LOCK_CACHE_MS) return cached.protectedFile;
  const numericId = Number(fileId);
  if (!Number.isFinite(numericId)) return false;
  const [file, workspace] = await Promise.all([
    db('files').select('status').where({ id: numericId, workspaceId }).whereNull('deletedAt').first(),
    db('workspaces').select('visibility', 'workspaceType').where({ id: workspaceId }).first(),
  ]);
  const protectedFile = Boolean(file) && Boolean(workspace)
    && isFileContentProtected(file as any, workspace as any);
  fileProtectedCache.set(key, { protectedFile, at: now });
  return protectedFile;
};

class PostgresCollabExtension extends Database {
  constructor(private readonly db: Knex) {
    super({
      fetch: async ({ documentName }) => {
        const row = await this.db('collab_documents').where({ id: documentName }).first();
        return row?.state ?? null;
      },
      store: async ({ documentName, state }) => {
        // `onAuthenticate` sets `readOnly` once, at the handshake. A session that
        // was already open when the workspace was locked would otherwise keep
        // persisting, so the authority has to sit here, where the write happens.
        const { workspaceId, fileId } = parseDocumentName(documentName);
        if (await isWorkspaceLockedForCollab(this.db, workspaceId)) return;
        // Same reasoning one level down: the file may have been approved after
        // this session opened, and `onAuthenticate` resolved that once.
        if (await isFileProtectedForCollab(this.db, workspaceId, fileId)) return;
        const buffer = Buffer.isBuffer(state) ? state : Buffer.from(state);
        await this.db('collab_documents')
          .insert({
            id: documentName,
            state: buffer,
            updatedAt: this.db.fn.now(),
          })
          .onConflict('id')
          .merge({
            state: buffer,
            updatedAt: this.db.fn.now(),
          });
      },
    });
  }
}

export function startCollabServer(databaseService: DatabaseService, userService: UserService) {
  const db = databaseService.getDb();
  const workspaceService = new WorkspaceService(databaseService);
  const port = Number(process.env.COLLAB_PORT || 1234);

  const server = new Server({
    port,
    extensions: [new PostgresCollabExtension(db)],
    async onAuthenticate({ documentName, requestParameters, connectionConfig }) {
      const { workspaceId: nameWorkspaceId, fileId: nameFileId } = parseDocumentName(documentName);
      const workspaceId = requestParameters.get('workspaceId') || nameWorkspaceId;
      const fileId = requestParameters.get('fileId') || nameFileId;

      if (workspaceId !== nameWorkspaceId || fileId !== nameFileId) {
        throw new Error('Document name mismatch');
      }

      const externalId = (requestParameters.get('userId') || '').trim().toLowerCase();
      if (!externalId) {
        throw new Error('Missing user identity');
      }
      const displayName = (requestParameters.get('userName') || DEFAULT_USER_NAME).trim();
      const emailParam = (requestParameters.get('userEmail') || DEFAULT_USER_EMAIL || '').trim();
      const email = emailParam ? emailParam : undefined;

      const userRecord = await userService.ensureUser({
        externalId,
        displayName,
        email,
      });

      // This server runs on its own port and authenticates from query
      // parameters, so none of the Express middleware applies to it. Without
      // this check a deactivated user keeps editing documents live over the
      // websocket while every HTTP route refuses them.
      if (isUserDeactivated(userRecord)) {
        throw new Error('This account has been deactivated');
      }

      const membership = await workspaceService.ensureMembership(workspaceId, userRecord.id);
      if (!membership.membership.canEdit) {
        connectionConfig.readOnly = true;
      }

      const fileIdNumber = Number(fileId);
      if (!Number.isFinite(fileIdNumber)) {
        throw new Error('Invalid file id');
      }

      const file = await db('files')
        .select('id', 'workspaceId', 'status')
        .where({ id: fileIdNumber })
        .first();

      if (!file || file.workspaceId !== workspaceId) {
        throw new Error('File not found');
      }
      if (isFileContentProtected(file, membership.workspace)) {
        connectionConfig.readOnly = true;
      }

      return {
        user: {
          id: userRecord.id,
          externalId: userRecord.externalId,
          name: userRecord.displayName,
          email: userRecord.email,
        },
        workspaceId,
        fileId: fileIdNumber,
      };
    },
    async onConnect({ documentName, context }) {
      const userName = context?.user?.name ?? 'unknown';
      console.log(`Collab connection: ${userName} -> ${documentName}`);
    },
  });

  server.listen().catch((error) => {
    console.error('Failed to start collab server', error);
  });
  console.log(`Collab server listening on ws://localhost:${port}`);

  return server;
}
