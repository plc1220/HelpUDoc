import test from 'node:test';
import assert from 'node:assert/strict';

test('selected Calendar tools work without a general Google MCP grant while unavailable MCPs stay denied', async () => {
  process.env.AUTH_MODE = 'oidc';
  const { createAgentPolicyApi } = await import('../src/api/agent/policy');
  const { GoogleOAuthTokenMissingError } = await import('../src/services/googleOAuthService');
  const { verifyAgentContextToken } = await import('../src/services/agentToken');
  let delegatedCalls = 0;
  const api = createAgentPolicyApi({ getDelegatedAccessToken: async () => { delegatedCalls++; throw new GoogleOAuthTokenMissingError('No general Google grant'); } } as never,
    { getPersonalSkillRuntimePins: async () => [], getDefaultSkillRuntimePins: async () => [] } as never);
  const policy = { isAdmin: false, skillAllowIds: [], mcpServerAllowIds: ['google-workspace', 'data-artifacts'], mcpServerDenyIds: [], workspaceMode: 'private' as const, workspaceRole: 'owner', canWriteWorkspace: true };
  const token = await api.buildAgentAuthToken({ userId: 'user', workspaceId: 'workspace', calendarEventRefs: ['meeting:selected'], policy, skipPlanApprovals: false });
  assert.ok(token); const payload = verifyAgentContextToken(token)!;
  assert.deepEqual(payload.calendarEventRefs, ['meeting:selected']); assert.ok(payload.mcpServerDenyIds?.includes('google-workspace'));
  assert.ok(!payload.mcpServerAllowIds?.includes('google-workspace')); assert.ok(payload.mcpServerAllowIds?.includes('data-artifacts')); assert.equal(payload.mcpAuth, undefined);
  assert.equal(delegatedCalls, 0, 'Selected Calendar context must not borrow a broad Google MCP grant');
  await assert.rejects(api.buildAgentAuthToken({ userId: 'user', workspaceId: 'workspace', policy, skipPlanApprovals: false }), (error: unknown) => (error as { statusCode?: number }).statusCode === 403);
  assert.equal(delegatedCalls, 1);
});
