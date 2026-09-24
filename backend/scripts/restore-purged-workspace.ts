/**
 * Restores a workspace the retention sweep retired.
 *
 * `purgeExpiredTrashedWorkspaces` marks an expired workspace `purged` rather
 * than deleting it: the rows, the local mirror and the object bytes all survive,
 * and every application read path hides the row. This script is the way back.
 *
 * It is deliberately CLI-only and has no HTTP route. Restoring somebody's
 * retired workspace is an operator decision with a person accountable for it,
 * not a button — and keeping it off the API means the admin oversight surface
 * stays read-only end to end.
 *
 * Usage:
 *   ENV_FILE=../env/local/dev.env npm run workspace:restore -- <workspaceId>
 *   ENV_FILE=../env/local/dev.env npm run workspace:restore -- <workspaceId> --actor <userId>
 */
import * as dotenv from 'dotenv';

const envFile = process.env.ENV_FILE;
if (envFile) {
  dotenv.config({ path: envFile });
} else {
  dotenv.config();
}

import { v4 as uuidv4 } from 'uuid';
import { DatabaseService } from '../src/services/databaseService';

const parseArgs = () => {
  const args = process.argv.slice(2);
  const positional = args.filter((arg) => !arg.startsWith('--'));
  const actorIndex = args.indexOf('--actor');
  return {
    workspaceId: positional[0] || '',
    actorUserId: actorIndex >= 0 ? args[actorIndex + 1] || null : null,
  };
};

async function main(): Promise<void> {
  const { workspaceId, actorUserId } = parseArgs();
  if (!workspaceId) {
    console.error('Usage: workspace:restore -- <workspaceId> [--actor <userId>]');
    process.exit(1);
  }

  const databaseService = new DatabaseService();
  const db = databaseService.getDb();

  try {
    const workspace = await db('workspaces').where({ id: workspaceId }).first();
    if (!workspace) {
      console.error(`No workspace with id ${workspaceId}. It may have been hard-purged.`);
      process.exit(1);
    }
    if (workspace.status !== 'purged') {
      console.error(`Workspace ${workspaceId} is "${workspace.status}", not "purged". Nothing to restore.`);
      process.exit(1);
    }

    // The owner is restored along with the workspace, so refuse rather than
    // resurrect a workspace into an account that can no longer sign in.
    const owner = await db('users').where({ id: workspace.ownerId }).first();
    if (!owner) {
      console.error(`Workspace ${workspaceId} has no owner row (${workspace.ownerId}). Reassign ownership before restoring.`);
      process.exit(1);
    }
    if (owner.status === 'deactivated') {
      console.warn(`Warning: owner ${owner.displayName} is deactivated. The workspace will be restored but unreachable until they are reactivated.`);
    }

    await db.transaction(async (tx) => {
      await tx('workspaces').where({ id: workspaceId }).update({
        status: 'active',
        purgedAt: null,
        purgeAfter: null,
        trashedAt: null,
        trashedByUserId: null,
        trashReason: null,
        updatedAt: tx.fn.now(),
      });
      await tx('audit_events').insert({
        id: uuidv4(),
        actorUserId: actorUserId || null,
        actorRole: 'operator',
        action: 'workspace.restored_from_purge',
        resourceType: 'workspace',
        resourceId: workspaceId,
        platformOverride: true,
        metadata: {
          workspaceName: workspace.name,
          ownerId: workspace.ownerId,
          purgedAt: workspace.purgedAt,
          via: 'cli',
        },
      });
    });

    const fileCount = await db('files')
      .where({ workspaceId })
      .whereNull('deletedAt')
      .count<{ count: string }>('id as count')
      .first();

    console.log(`Restored "${workspace.name}" (${workspaceId}) to active.`);
    console.log(`Owner: ${owner.displayName} <${owner.email || 'no email'}>`);
    console.log(`Files still attached: ${Number(fileCount?.count || 0)}`);
  } finally {
    await databaseService.getDb().destroy();
  }
}

main().catch((error) => {
  console.error('Restore failed:', error);
  process.exit(1);
});
