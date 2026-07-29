import assert from 'node:assert/strict';
import * as fs from 'fs/promises';
import { v4 as uuidv4 } from 'uuid';

import { ConflictError } from '../src/errors';
import { DatabaseService } from '../src/services/databaseService';
import { FileService } from '../src/services/fileService';
import { UserService } from '../src/services/userService';
import { WorkspacePublicationService } from '../src/services/workspacePublicationService';
import { WorkspaceService } from '../src/services/workspaceService';

async function main() {
  const databaseService = new DatabaseService();
  await databaseService.initialize();
  const db = databaseService.getDb();
  const workspaceService = new WorkspaceService(databaseService);
  const fileService = new FileService(databaseService, workspaceService);
  const publicationService = new WorkspacePublicationService(databaseService, workspaceService);
  const userService = new UserService(databaseService);

  const aliceId = uuidv4();
  const bobId = uuidv4();
  const teamId = uuidv4();

  try {
    await db('users').insert([
      { id: aliceId, externalId: `publication-alice-${aliceId}`, displayName: 'Alice Publisher' },
      { id: bobId, externalId: `publication-bob-${bobId}`, displayName: 'Bob Teammate' },
    ]);
    await db('groups').insert({ id: teamId, name: `Publication test ${teamId}` });
    await db('group_members').insert([
      { groupId: teamId, userId: aliceId },
      { groupId: teamId, userId: bobId },
    ]);

    const alicePrivate = await workspaceService.createWorkspace(
      {
        userId: aliceId,
        externalId: `publication-alice-${aliceId}`,
        displayName: 'Alice Publisher',
        isAdmin: false,
      },
      'Customer research',
    );
    const aliceFile = await fileService.createTextFile(
      alicePrivate.id,
      'brief.md',
      'Published version one',
      aliceId,
    );

    const firstPublication = await publicationService.publish(alicePrivate.id, aliceId, { teamId });
    const bobWorkspaces = await workspaceService.listWorkspacesForUser(bobId);
    const teamWorkspace = bobWorkspaces.find((workspace) => workspace.id === firstPublication.teamWorkspaceId);
    assert(teamWorkspace);
    assert.equal(teamWorkspace.visibility, 'team');
    assert.equal(teamWorkspace.canEdit, false);
    assert.equal(teamWorkspace.privateCopyWorkspaceId, null);

    const teamFiles = await fileService.getFiles(teamWorkspace.id, bobId);
    assert.equal(teamFiles.length, 1);
    await assert.rejects(
      () => fileService.updateFile(Number(teamFiles[0].id), 'Not allowed', bobId),
      /Team workspaces are read-only/,
    );

    const bobPrivate = await publicationService.createPrivateCopy(teamWorkspace.id, bobId);
    const bobFiles = await fileService.getFiles(bobPrivate.id, bobId);
    await fileService.updateFile(Number(bobFiles[0].id), 'Bob private changes', bobId);

    await fileService.updateFile(Number(aliceFile.id), 'Alice team changes', aliceId);
    await publicationService.publish(alicePrivate.id, aliceId, { note: 'Alice update' });

    const bobAfterTeamUpdate = (await workspaceService.listWorkspacesForUser(bobId))
      .find((workspace) => workspace.id === bobPrivate.id);
    assert.equal(bobAfterTeamUpdate?.publicationStatus, 'review_needed');

    let conflicts: Array<{ path: string }> = [];
    try {
      await publicationService.sync(bobPrivate.id, bobId);
      assert.fail('Expected overlapping changes to require review');
    } catch (error) {
      assert(error instanceof ConflictError);
      conflicts = (error.details as { conflicts?: Array<{ path: string }> })?.conflicts || [];
    }
    assert.deepEqual(conflicts.map((conflict) => conflict.path), ['brief.md']);

    await publicationService.sync(bobPrivate.id, bobId, { 'brief.md': 'private' });
    const bobAfterReview = (await workspaceService.listWorkspacesForUser(bobId))
      .find((workspace) => workspace.id === bobPrivate.id);
    assert.equal(bobAfterReview?.publicationStatus, 'changes_to_publish');

    await workspaceService.addCollaborator(teamWorkspace.id, aliceId, bobId, 'editor');
    const bobPublication = await publicationService.publish(bobPrivate.id, bobId, { note: 'Bob update' });
    assert.equal(bobPublication.publishedVersionNumber, 3);

    await publicationService.sync(alicePrivate.id, aliceId);
    const refreshedAliceFiles = await fileService.getFiles(alicePrivate.id, aliceId);
    const refreshedBobFiles = await fileService.getFiles(bobPrivate.id, bobId);
    await fileService.updateFile(Number(refreshedAliceFiles[0].id), 'Alice concurrent publication', aliceId);
    await fileService.updateFile(Number(refreshedBobFiles[0].id), 'Bob concurrent publication', bobId);

    const concurrentPublications = await Promise.allSettled([
      publicationService.publish(alicePrivate.id, aliceId, { note: 'Alice concurrent update' }),
      publicationService.publish(bobPrivate.id, bobId, { note: 'Bob concurrent update' }),
    ]);
    assert.equal(
      concurrentPublications.filter((result) => result.status === 'fulfilled').length,
      1,
      'exactly one concurrent publication should succeed',
    );
    assert.equal(
      concurrentPublications.filter((result) => result.status === 'rejected').length,
      1,
      'the stale concurrent publication should be rejected',
    );
    const winningContent = concurrentPublications[0].status === 'fulfilled'
      ? 'Alice concurrent publication'
      : 'Bob concurrent publication';
    const teamFilesAfterConcurrentPublish = await fileService.getFiles(teamWorkspace.id, aliceId);
    const teamFileAfterConcurrentPublish = await fileService.getFileContent(
      Number(teamFilesAfterConcurrentPublish[0].id),
      aliceId,
    );
    assert.equal(teamFileAfterConcurrentPublish.content, winningContent);

    const history = await publicationService.listHistory(teamWorkspace.id, aliceId);
    assert.deepEqual(history.map((version) => Number(version.versionNumber)), [4, 3, 2, 1]);
    const firstVersion = history.find((version) => Number(version.versionNumber) === 1);
    assert(firstVersion);
    await publicationService.restore(teamWorkspace.id, firstVersion.id, aliceId);

    const restoredFiles = await fileService.getFiles(teamWorkspace.id, aliceId);
    const restored = await fileService.getFileContent(Number(restoredFiles[0].id), aliceId);
    assert.equal(restored.content, 'Published version one');

    await userService.removeGroupMember(teamId, bobId);
    const bobAfterRemoval = await workspaceService.listWorkspacesForUser(bobId);
    assert.equal(
      bobAfterRemoval.some((workspace) => workspace.id === teamWorkspace.id),
      false,
      'removed team members should no longer list the team workspace',
    );
    const bobPrivateAfterRemoval = bobAfterRemoval.find((workspace) => workspace.id === bobPrivate.id);
    assert(bobPrivateAfterRemoval);
    assert.equal(bobPrivateAfterRemoval.canPublish, false);
    assert.equal(bobPrivateAfterRemoval.currentPublishedVersionNumber, null);
    assert.equal(bobPrivateAfterRemoval.latestPublisherName, null);
    await assert.rejects(
      () => workspaceService.ensureMembership(teamWorkspace.id, bobId),
      /Team membership is required/,
    );
    await assert.rejects(
      () => publicationService.publish(bobPrivate.id, bobId, { note: 'Should not publish' }),
      /Team membership is required/,
    );

    assert.equal(await userService.deleteUser(bobId), true);
    const historyAfterUserDeletion = await publicationService.listHistory(teamWorkspace.id, aliceId);
    assert(
      historyAfterUserDeletion.some((version) => version.publisherName === 'Former user'),
      'published history should remain visible after deleting a publisher',
    );

    console.log('workspace publication integration ok');
  } finally {
    const workspaceIds = await db('workspaces')
      .whereIn('ownerId', [aliceId, bobId])
      .select('id');
    for (const workspace of workspaceIds) {
      await workspaceService.deleteWorkspaceForCleanup(workspace.id).catch(() => undefined);
    }
    await db('groups').where({ id: teamId }).del();
    await db('users').whereIn('id', [aliceId, bobId]).del();
    await db.destroy();
    const root = process.env.WORKSPACE_ROOT;
    if (root) {
      await fs.rm(root, { recursive: true, force: true });
    }
  }
}

void main();
