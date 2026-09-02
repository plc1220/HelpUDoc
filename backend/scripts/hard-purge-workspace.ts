/**
 * Permanently destroys a retired workspace. This is the only code path in the
 * application that actually deletes workspace data.
 *
 * The retention sweep marks expired workspaces `purged` and stops there, on
 * purpose: rows and object bytes are kept so a mistake stays recoverable. That
 * makes destruction a separate, deliberate act — which is this script.
 *
 * Deleting the `workspaces` row cascades through roughly two dozen tables
 * (files, file_versions, conversations, schedules, …). `file_audit_events`,
 * `file_publications` and `audit_events` carry no cascading foreign key and
 * survive by design, so the compliance trail outlives its subject.
 *
 * Object-store bytes are NOT removed: immutable file versions can be referenced
 * by publications or another workspace, and there is no reference-aware GC yet.
 * The local mirror is removed.
 *
 * Usage:
 *   ENV_FILE=../env/local/dev.env npm run workspace:hard-purge -- <workspaceId> --confirm
 */
import * as dotenv from 'dotenv';

const envFile = process.env.ENV_FILE;
if (envFile) {
  dotenv.config({ path: envFile });
} else {
  dotenv.config();
}

import { promises as fs } from 'fs';
import * as path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { DatabaseService } from '../src/services/databaseService';
import { resolveWorkspaceRoot } from '../src/config/workspaceRoot';

const parseArgs = () => {
  const args = process.argv.slice(2);
  const positional = args.filter((arg) => !arg.startsWith('--'));
  const actorIndex = args.indexOf('--actor');
  return {
    workspaceId: positional[0] || '',
    confirmed: args.includes('--confirm'),
    actorUserId: actorIndex >= 0 ? args[actorIndex + 1] || null : null,
  };
};

async function main(): Promise<void> {
  const { workspaceId, confirmed, actorUserId } = parseArgs();
  if (!workspaceId) {
    console.error('Usage: workspace:hard-purge -- <workspaceId> --confirm [--actor <userId>]');
    process.exit(1);
  }

  const databaseService = new DatabaseService();
  const db = databaseService.getDb();

  try {
    const workspace = await db('workspaces').where({ id: workspaceId }).first();
    if (!workspace) {
      console.error(`No workspace with id ${workspaceId}.`);
      process.exit(1);
    }
    // Only a workspace that has already been retired may be destroyed. Anything
    // else has not served its retention window, and this script is not a
    // shortcut around it.
    if (workspace.status !== 'purged') {
      console.error(
        `Workspace ${workspaceId} is "${workspace.status}", not "purged". `
        + 'Only a workspace that has completed its retention window can be hard-purged.',
      );
      process.exit(1);
    }

    const [fileCount, versionCount, conversationCount] = await Promise.all([
      db('files').where({ workspaceId }).count<{ count: string }>('id as count').first(),
      db('file_versions as v').join('files as f', 'f.id', 'v.fileId').where('f.workspaceId', workspaceId)
        .count<{ count: string }>('v.id as count').first(),
      db('conversations').where({ workspaceId }).count<{ count: string }>('id as count').first(),
    ]);

    console.log(`Workspace : ${workspace.name} (${workspaceId})`);
    console.log(`Purged at : ${workspace.purgedAt}`);
    console.log(`Will delete: ${Number(fileCount?.count || 0)} files, `
      + `${Number(versionCount?.count || 0)} file versions, `
      + `${Number(conversationCount?.count || 0)} conversations, and all cascading rows.`);
    console.log('Audit trails (file_audit_events, file_publications, audit_events) are retained.');
    console.log('Object-store bytes are retained; the local mirror is removed.');

    if (!confirmed) {
      console.error('\nRefusing to proceed without --confirm. Nothing was changed.');
      process.exit(1);
    }

    const publishedVersions = await db('workspace_published_versions')
      .select('id')
      .where({ teamWorkspaceId: workspaceId })
      .catch(() => [] as Array<{ id: string }>);

    await db.transaction(async (tx) => {
      // Written before the delete: `audit_events.actorUserId` survives, but the
      // workspace row does not, so the record has to be captured from it first.
      await tx('audit_events').insert({
        id: uuidv4(),
        actorUserId: actorUserId || null,
        actorRole: 'operator',
        action: 'workspace.hard_purged',
        resourceType: 'workspace',
        resourceId: workspaceId,
        platformOverride: true,
        metadata: {
          workspaceName: workspace.name,
          ownerId: workspace.ownerId,
          purgedAt: workspace.purgedAt,
          deletedFiles: Number(fileCount?.count || 0),
          deletedFileVersions: Number(versionCount?.count || 0),
          objectBytesRetained: true,
          via: 'cli',
        },
      });
      await tx('workspaces').where({ id: workspaceId }).del();
    });

    const workspaceRoot = resolveWorkspaceRoot();
    await fs.rm(path.join(workspaceRoot, workspaceId), { recursive: true, force: true });
    await Promise.all(publishedVersions.map((version) =>
      fs.rm(path.join(workspaceRoot, '.published-versions', String(version.id)), {
        recursive: true,
        force: true,
      })));

    console.log(`\nHard-purged ${workspaceId}. This cannot be undone.`);
  } finally {
    await databaseService.getDb().destroy();
  }
}

main().catch((error) => {
  console.error('Hard purge failed:', error);
  process.exit(1);
});
