import assert from 'node:assert/strict';
import test from 'node:test';
import { createAgentPolicyApi, type EffectiveAgentPolicy } from '../src/api/agent/policy';

const policy: EffectiveAgentPolicy = {
  isAdmin: false,
  skillAllowIds: ['data/dashboard'],
  mcpServerAllowIds: [],
  mcpServerDenyIds: [],
};

const decodePayload = (token: string): Record<string, unknown> =>
  JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf-8'));

test('buildAgentAuthToken preserves a disabled plan-approval bypass', async () => {
  const api = createAgentPolicyApi({} as any, {} as any);
  const token = await api.buildAgentAuthToken({
    userId: 'user-1',
    workspaceId: 'workspace-1',
    policy,
    skipPlanApprovals: false,
  });

  assert.ok(token);
  assert.equal(decodePayload(token).skipPlanApprovals, false);
});

test('buildAgentAuthToken enables trusted mode only when explicitly configured', async () => {
  const api = createAgentPolicyApi({} as any, {} as any);
  const token = await api.buildAgentAuthToken({
    userId: 'user-1',
    workspaceId: 'workspace-1',
    policy,
    skipPlanApprovals: true,
  });

  assert.ok(token);
  assert.equal(decodePayload(token).skipPlanApprovals, true);
});
