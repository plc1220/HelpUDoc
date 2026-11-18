import test from 'node:test';
import assert from 'node:assert/strict';
import type { Request, Response, Router } from 'express';
import { registerPromptSuggestionRoute } from '../src/api/agent/promptSuggestion';
import { verifyAgentContextToken } from '../src/services/agentToken';
import { registerWorkspaceStarterPromptsRoute } from '../src/api/agent/workspaceStarterPrompts';
import { AccessDeniedError } from '../src/errors';

test('suggestions require authenticated bounded conversation data and no tool grants', async () => {
  let handler: (req: Request, res: Response) => Promise<unknown>;
  let calls = 0;
  registerPromptSuggestionRoute({ post(path: string, callback: typeof handler) {
    assert.equal(path, '/prompt-suggestion'); handler = callback;
  } } as unknown as Router, async (messages, token) => {
    calls++;
    const context = verifyAgentContextToken(token)!;
    assert.equal(context.userId, 'fixture'); assert.equal(context.isAdmin, false);
    assert.deepEqual(context.skillAllowIds, []); assert.deepEqual(context.mcpServerAllowIds, []);
    assert.equal(context.workspaceId, undefined); assert.ok(context.exp! - context.iat! <= 30);
    assert.equal(messages[messages.length - 1].role, 'assistant');
    return { suggestion: 'Summarize the trade-offs in a table.' };
  });
  const messages = [{ role: 'user', content: 'Compare the options' }, { role: 'assistant', content: 'Here are the trade-offs.' }];
  const invoke = async (body: unknown, authenticated = true) => {
    const result = { status: 200, body: undefined as unknown, headers: {} as Record<string, string> };
    const res = {
      status(code: number) { result.status = code; return res; },
      json(value: unknown) { result.body = value; return res; },
      setHeader(name: string, value: string) { result.headers[name] = value; },
    };
    await handler!({ body, ...(authenticated ? { userContext: { userId: 'fixture', isAdmin: true } } : {}) } as Request, res as unknown as Response);
    return result;
  };
  assert.equal((await invoke({ messages }, false)).status, 401);
  for (const body of [{ messages: [] }, { messages: messages.slice(0, 1) }, { messages: messages.slice().reverse() }, { messages, model: 'pro' }, { messages: messages.map(m => ({ ...m, content: 'x'.repeat(8001) })) }]) {
    assert.equal((await invoke(body)).status, 400);
  }
  assert.equal(calls, 0);
  const response = await invoke({ messages });
  assert.equal(response.status, 200); assert.equal(response.headers['Cache-Control'], 'no-store');
  assert.deepEqual(response.body, { suggestion: 'Summarize the trade-offs in a table.' });
  assert.equal(calls, 1);
});

test('workspace starters use authorized metadata, scoped caches, and recheck revoked access', async () => {
  let handler: (req: Request, res: Response) => Promise<unknown>;
  let modelCalls = 0, fileCalls = 0, accessCalls = 0, revoked = false, revision = 1;
  let role = 'owner';
  const id = '11111111-1111-4111-8111-111111111111';
  const result = { prompts: [{ label: 'Review scope', prompt: 'Review proposal.docx for scope gaps.' }, { label: 'Review budget', prompt: 'Summarize budget assumptions.' }] };
  registerWorkspaceStarterPromptsRoute({ post(_path: string, callback: typeof handler) { handler = callback; } } as unknown as Router,
    { getWorkspaceForUser: async (workspaceId: string, userId: string) => {
      accessCalls++; assert.equal(workspaceId, id); assert.equal(userId, 'fixture');
      if (revoked) throw new AccessDeniedError();
      return { workspace: { name: 'Client proposal', contentRevision: revision }, membership: { role } };
    } } as never,
    { getFiles: async () => { fileCalls++; return [{ name: 'proposal.docx', mimeType: 'application/docx', content: 'PRIVATE CONTENT', publicUrl: 'PRIVATE URL' }]; } } as never,
    { listRecentConversations: async (userId: string, workspaceId: string, limit: number) => {
      assert.equal(userId, 'fixture'); assert.equal(workspaceId, id); assert.equal(limit, 5);
      return [{ title: 'Scope review' }];
    } } as never,
    async (context, token) => {
      modelCalls++;
      assert.deepEqual(context, { name: 'Client proposal', readOnly: role === 'viewer', files: [{ name: 'proposal.docx', mimeType: 'application/docx' }], recentTopics: ['Scope review'] });
      assert.ok(!JSON.stringify(context).includes('PRIVATE'));
      const claims = verifyAgentContextToken(token)!;
      assert.equal(claims.userId, 'fixture'); assert.equal(claims.workspaceId, id);
      assert.deepEqual(claims.mcpServerAllowIds, []); assert.deepEqual(claims.skillAllowIds, []);
      return result;
    });
  const invoke = async (body: unknown, authenticated = true) => {
    const response = { status: 200, body: undefined as unknown };
    const res = { status(code: number) { response.status = code; return res; }, json(value: unknown) { response.body = value; return res; }, setHeader() {} };
    await handler!({ body, ...(authenticated ? { userContext: { userId: 'fixture' } } : {}) } as Request, res as unknown as Response);
    return response;
  };
  assert.equal((await invoke({ workspaceId: id }, false)).status, 401);
  assert.equal((await invoke({ workspaceId: id, files: ['spoofed-file'] })).status, 400);
  assert.equal(accessCalls, 0);
  assert.deepEqual((await invoke({ workspaceId: id })).body, result);
  assert.deepEqual((await invoke({ workspaceId: id })).body, result);
  assert.equal(modelCalls, 1); assert.equal(accessCalls, 2);
  role = 'viewer'; revision++;
  assert.equal((await invoke({ workspaceId: id })).status, 200); assert.equal(modelCalls, 2);
  revoked = true;
  assert.equal((await invoke({ workspaceId: id })).status, 403);
  assert.equal(modelCalls, 2); assert.equal(fileCalls, 3);
});
