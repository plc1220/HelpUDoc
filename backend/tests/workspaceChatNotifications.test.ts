import assert from 'node:assert/strict';
import test from 'node:test';
import { WorkspaceCollaborationService } from '../src/services/workspaceCollaborationService';

test('team messages notify collaborators once, prioritize mentions and skip the sender', async () => {
  const notifications: any[] = [];
  const db: any = (table: string) => ({
    insert: (row: any) => {
      if (table !== 'notifications') return Promise.resolve();
      return { onConflict: () => ({ ignore: async () => { notifications.push(row); } }) };
    },
  });
  db.transaction = async (work: (tx: any) => Promise<void>) => work(db);
  const service: any = new WorkspaceCollaborationService(
    { getDb: () => db } as any,
    { listCollaborators: async () => ({ collaborators: [{ userId: 'alice' }, { userId: 'bob' }, { userId: 'carol' }, { userId: 'bob' }] }) } as any,
    {} as any,
  );
  service.ensureSharedWorkspaceAccess = async () => ({ membership: { role: 'owner' }, currentPublishedVersionId: null });
  service.ensureMentionTargetHasAccess = async () => {};
  service.getTeamMessage = async (_workspaceId: string, id: string) => ({ id });
  const message = await service.createTeamMessage('workspace', 'alice', { body: 'Please review', mentionedUserIds: ['bob', 'bob'] });
  assert.equal(notifications.length, 2);
  assert.deepEqual(notifications.map((n) => [n.recipientUserId, n.eventType]), [['bob', 'chat.mentioned'], ['carol', 'chat.message']]);
  for (const n of notifications) {
    assert.equal(n.payload.workspaceId, 'workspace');
    assert.equal(n.payload.messageId, message.id);
    assert.equal(n.payload.channel, 'team');
  }
});
