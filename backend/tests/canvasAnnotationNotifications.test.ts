import test from 'node:test';
import assert from 'node:assert/strict';
import { WorkspaceCollaborationService } from '../src/services/workspaceCollaborationService';

function harness(role = 'commenter') {
  const rows: Record<string, any[]> = {};
  const db: any = (table: string) => {
    let inserted: any;
    const query: any = {
      insert(value: any) { inserted = value; (rows[table] ||= []).push(value); return query; },
      onConflict() { return query; }, ignore() { return Promise.resolve(); },
      returning() { return Promise.resolve([inserted]); },
      where() { return query; }, update() { return Promise.resolve(); },
      then(resolve: any) { return Promise.resolve(undefined).then(resolve); },
    };
    return query;
  };
  db.fn = { now: () => 'now' };
  db.transaction = async (callback: any) => callback(db);
  const service = Object.create(WorkspaceCollaborationService.prototype) as WorkspaceCollaborationService;
  Object.assign(service, {
    db,
    workspaceService: {
      listCollaborators: async () => ({ collaborators: [{ userId: 'author' }, { userId: 'member' }, { userId: 'member' }, { userId: 'team-member' }] }),
    },
    ensureSharedWorkspaceAccess: async () => ({ membership: { role }, currentPublishedVersionId: 'version' }),
    ensureObjectAccess: async () => rows.workspace_collaboration_objects?.[0],
  });
  return { service, rows };
}

test('shared annotation notifies each other effective member once with a file/thread link', async () => {
  const { service, rows } = harness();
  await service.createObject('workspace', 'author', { type: 'annotation', visibility: 'workspace_audience', filePath: 'notes.md', body: 'Check this', anchorText: ' selected ', anchorStart: 3, anchorEnd: 13 });
  assert.deepEqual(rows.notifications.map(row => row.recipientUserId), ['member', 'team-member']);
  assert.equal(rows.notifications[0].payload.annotationId, rows.workspace_collaboration_objects[0].id);
  assert.equal(rows.notifications[0].payload.filePath, 'notes.md');
  assert.equal(rows.workspace_collaboration_objects[0].anchorText, ' selected ');
  await service.appendMessage('workspace', rows.workspace_collaboration_objects[0].id, 'author', 'Following up');
  assert.equal(rows.notifications.length, 4);
  assert.equal(rows.notifications[2].eventType, 'annotation.replied');
});

test('private annotation and its replies do not send notifications', async () => {
  const { service, rows } = harness();
  await service.createObject('workspace', 'author', { type: 'annotation', visibility: 'private', body: 'Private note' });
  await service.appendMessage('workspace', rows.workspace_collaboration_objects[0].id, 'author', 'Private follow-up');
  assert.equal(rows.notifications, undefined);
});

test('viewer cannot post shared annotations and produces no writes or notifications', async () => {
  const { service, rows } = harness('viewer');
  await assert.rejects(service.createObject('workspace', 'author', { type: 'annotation', visibility: 'workspace_audience', body: 'No access' }), /Commenter/);
  assert.deepEqual(rows, {});
});
