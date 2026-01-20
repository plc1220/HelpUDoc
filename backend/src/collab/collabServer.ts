import { Server } from '@hocuspocus/server';
import { Database } from '@hocuspocus/extension-database';
import type { Knex } from 'knex';
import { DatabaseService } from '../services/databaseService';
import { UserService } from '../services/userService';
import { WorkspaceService } from '../services/workspaceService';

const DEFAULT_USER_ID = process.env.DEFAULT_USER_ID || 'local-user';
const DEFAULT_USER_NAME = process.env.DEFAULT_USER_NAME || 'Local User';
const DEFAULT_USER_EMAIL = process.env.DEFAULT_USER_EMAIL || '';

const parseDocumentName = (documentName: string): { workspaceId: string; fileId: string } => {
  const [workspaceId, fileId] = documentName.split(':');
  if (!workspaceId || !fileId) {
    throw new Error('Invalid document name');
  }
  return { workspaceId, fileId };
};

class PostgresCollabExtension extends Database {
  constructor(private readonly db: Knex) {
    super({
      fetch: async ({ documentName }) => {
        const row = await this.db('collab_documents').where({ id: documentName }).first();
        return row?.state ?? null;
      },
      store: async ({ documentName, state }) => {
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

      const externalId = (requestParameters.get('userId') || DEFAULT_USER_ID).trim().toLowerCase();
      const displayName = (requestParameters.get('userName') || DEFAULT_USER_NAME).trim();
      const emailParam = (requestParameters.get('userEmail') || DEFAULT_USER_EMAIL || '').trim();
      const email = emailParam ? emailParam : undefined;

      const userRecord = await userService.ensureUser({
        externalId,
        displayName,
        email,
      });

      const membership = await workspaceService.ensureMembership(workspaceId, userRecord.id);
      if (!membership.membership.canEdit) {
        connectionConfig.readOnly = true;
      }

      const fileIdNumber = Number(fileId);
      if (!Number.isFinite(fileIdNumber)) {
        throw new Error('Invalid file id');
      }

      const file = await db('files')
        .select('id', 'workspaceId')
        .where({ id: fileIdNumber })
        .first();

      if (!file || file.workspaceId !== workspaceId) {
        throw new Error('File not found');
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
