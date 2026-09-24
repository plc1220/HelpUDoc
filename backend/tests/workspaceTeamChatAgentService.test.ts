import assert from 'node:assert/strict';
import test from 'node:test';

import { extractAgentReplyText } from '../src/services/workspaceTeamChatAgentService';

test('extractAgentReplyText reads a direct ChatResponse reply', () => {
  assert.equal(extractAgentReplyText({ reply: 'Published answer' }), 'Published answer');
});

test('extractAgentReplyText selects the latest assistant message from agent state', () => {
  assert.equal(
    extractAgentReplyText({
      reply: {
        messages: [
          { role: 'user', content: 'Question' },
          { role: 'assistant', content: [{ type: 'text', text: 'Read-only answer' }] },
        ],
      },
    }),
    'Read-only answer',
  );
});

test('extractAgentReplyText does not echo a user-only state', () => {
  assert.equal(
    extractAgentReplyText({
      reply: {
        messages: [{ role: 'user', content: 'Do not echo me' }],
      },
    }),
    '',
  );
});

import { WorkspaceTeamChatAgentService } from '../src/services/workspaceTeamChatAgentService';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { resolveWorkspaceRoot } from '../src/config/workspaceRoot';

const makeService = (write = true) => {
  const service = Object.create(WorkspaceTeamChatAgentService.prototype) as WorkspaceTeamChatAgentService;
  Object.assign(service, {
    workspaceService: { getMcpServerPolicy: async () => ({ workspaceMode: 'shared_live', editingPolicy: write ? 'direct' : 'review', canWriteWorkspace: write, workspaceRole: 'owner' }) },
    userService: { getEffectivePromptAccess: async () => ({ skillIds: ['summary'] }), getWorkspaceSkillRuntimePins: async () => [{ available: true, skillKey: 'summary', skillId: 'summary', versionId: randomUUID(), semanticVersion: '1.0.0', manifestHash: 'a'.repeat(64) }] },
  });
  return service;
};

test('team preparation uses managed execution and keeps shared policy on the signed token', async () => {
  const service = makeService();
  const result = await service.prepare('workspace', 'user', { id: 'message', body: '@Lumo summarize', authorName: 'User', metadata: { references: [{ kind: 'skill', id: 'summary', label: 'Summary' }] } } as any, []);
  assert.equal(result.sharedTeamChannel, true);
  assert.equal(result.readOnlyWorkspace, false);
  assert.equal(result.turnId, 'team:message');
  assert.match(result.prompt, /^<<<HELPUDOC_DIRECTIVE\n\{"kind":"skill","skillId":"summary"\}/);
  const claims = JSON.parse(Buffer.from(result.authToken!.split('.')[1], 'base64url').toString());
  assert.equal(claims.canWriteWorkspace, true);
  assert.equal(claims.skipPlanApprovals, false);
  assert.deepEqual(claims.mcpServerAllowIds, []);
});

test('Review policy remains read-only and unauthorized skills fail closed', async () => {
  const service = makeService(false);
  const request = { id: 'message', body: '@Lumo help', authorName: 'User', metadata: { references: [] } } as any;
  assert.equal((await service.prepare('workspace', 'user', request, [])).readOnlyWorkspace, true);
  request.metadata.references = [{ kind: 'skill', id: 'not-granted', label: 'Untrusted label' }];
  await assert.rejects(service.prepare('workspace', 'user', request, []), /not enabled/);
});

test('file reference cannot select a file from another workspace', async () => {
  const service = makeService();
  Object.assign(service, { files: { getFileRecord: async () => ({ workspaceId: 'other' }) } });
  await assert.rejects(service.resolveReferences('workspace', 'user', [{ kind: 'file', id: '12', label: 'misleading.md' }]), /not found/);
});

test('locked file references materialize snapshot bytes rather than the Working file', async () => {
  const service = makeService();
  const workspaceId = randomUUID();
  Object.assign(service, {
    publication: {
      getVersionSnapshot: async () => ({ versionNumber: 2, files: [{ id: 'snapshot-file', name: 'docs/plan.md' }] }),
      readVersionFile: async () => ({ mimeType: 'text/markdown', content: '# Locked contents' }),
    },
    files: { getFileRecord: async () => { throw new Error('Must not resolve Working'); } },
  });
  try {
    const context = await service.resolveReferences(workspaceId, 'user', [{ kind: 'file', id: 'snapshot-file', label: '../../ignored', publishedVersionId: randomUUID() }]);
    const ref = JSON.parse(context.split('\n')[1]);
    assert.equal(ref.version, 'Locked v2');
    assert.equal(ref.name, 'docs/plan.md');
    assert.equal(await fs.readFile(path.join(resolveWorkspaceRoot(), workspaceId, ref.path), 'utf8'), '# Locked contents');
    await assert.rejects(service.resolveReferences(workspaceId, 'user', [{ kind: 'file', id: 'wrong-file', label: 'plan.md', publishedVersionId: randomUUID() }]), /not in the locked snapshot/);
  } finally { await fs.rm(path.join(resolveWorkspaceRoot(), workspaceId), { recursive: true, force: true }); }
});
