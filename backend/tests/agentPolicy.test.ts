import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createAgentPolicyApi,
  findUnknownRuntimeMcpServerIds,
  resolveRuntimeSkillAccess,
  type EffectiveAgentPolicy,
} from '../src/api/agent/policy';

test('MCP Team assignments reject unknown or disabled runtime servers', () => {
  assert.deepEqual(findUnknownRuntimeMcpServerIds(
    ['google-workspace', 'removed-server', 'removed-server'],
    [{ name: 'google-workspace' }, { name: 'aws-pricing' }],
  ), ['removed-server']);
});

const policy: EffectiveAgentPolicy = {
  isAdmin: false,
  skillAllowIds: ['data/dashboard'],
  mcpServerAllowIds: [],
  mcpServerDenyIds: [],
  workspaceMode: 'private',
  workspaceRole: 'owner',
  canWriteWorkspace: true,
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

test('buildAgentAuthToken carries the published workspace write boundary to the agent sandbox', async () => {
  const api = createAgentPolicyApi({} as any, {} as any);
  const token = await api.buildAgentAuthToken({
    userId: 'user-1',
    workspaceId: 'workspace-1',
    policy: {
      ...policy,
      workspaceMode: 'published_read_only',
      workspaceRole: 'commenter',
      canWriteWorkspace: false,
    },
    skipPlanApprovals: false,
  });

  assert.ok(token);
  const payload = decodePayload(token);
  assert.equal(payload.workspaceMode, 'published_read_only');
  assert.equal(payload.workspaceRole, 'commenter');
  assert.equal(payload.canWriteWorkspace, false);
  assert.deepEqual(payload.skillAllowIds, []);
});

test('buildAgentAuthToken restricts team workspaces to entitled exact pins', async () => {
  const api = createAgentPolicyApi({} as any, {
    getWorkspaceSkillRuntimePins: async () => [
      {
        skillId: 'skill-1',
        skillKey: 'data/dashboard',
        versionId: 'version-1',
        semanticVersion: '2.4.0',
        manifestHash: 'manifest-1',
        available: true,
      },
      {
        skillId: 'skill-2',
        skillKey: 'restricted/internal',
        versionId: 'version-2',
        semanticVersion: '1.0.0',
        manifestHash: 'manifest-2',
        available: true,
      },
    ],
  } as any);
  const token = await api.buildAgentAuthToken({
    userId: 'user-1',
    workspaceId: 'workspace-1',
    policy: {
      ...policy,
      workspaceMode: 'published_read_only',
    },
    skipPlanApprovals: false,
  });

  assert.ok(token);
  const payload = decodePayload(token);
  assert.deepEqual(payload.skillAllowIds, ['data/dashboard']);
  assert.deepEqual(payload.skillVersionPins, {
    'data/dashboard': {
      skillId: 'skill-1',
      versionId: 'version-1',
      semanticVersion: '2.4.0',
      manifestHash: 'manifest-1',
    },
  });
});

test('buildAgentAuthToken fails closed when a private workspace pin is unavailable', async () => {
  const api = createAgentPolicyApi({} as any, {
    getWorkspaceSkillRuntimePins: async () => [{
      skillId: 'skill-1',
      skillKey: 'data/dashboard',
      versionId: 'version-1',
      semanticVersion: '2.4.0',
      manifestHash: 'manifest-1',
      available: false,
    }],
  } as any);
  const token = await api.buildAgentAuthToken({
    userId: 'user-1',
    workspaceId: 'workspace-1',
    policy,
    skipPlanApprovals: false,
  });

  assert.ok(token);
  const payload = decodePayload(token);
  assert.deepEqual(payload.skillAllowIds, []);
  assert.deepEqual(payload.skillVersionPins, {});
});

test('Platform Admin metadata never becomes runtime skill consumption access', async () => {
  const api = createAgentPolicyApi({} as any, {
    getEffectivePromptAccess: async () => ({
      isAdmin: true,
      skillIds: [],
      mcpServerIds: [],
      knowledgeSourceIds: [],
    }),
  } as any);
  const resolved = await api.resolveEffectiveAgentPolicy('admin-user', {
    mcpServerAllowIds: [],
    mcpServerDenyIds: [],
    workspaceMode: 'private',
    workspaceRole: 'owner',
    canWriteWorkspace: true,
  });

  assert.equal(resolved.isAdmin, false);
  assert.deepEqual(resolved.skillAllowIds, []);
});

test('slash discovery and runtime share the same exact-pin fail-closed selection', () => {
  const pins = [
    {
      skillId: 'skill-1',
      skillKey: 'data/dashboard',
      versionId: 'version-1',
      semanticVersion: '2.4.0',
      manifestHash: 'manifest-1',
      available: true,
    },
    {
      skillId: 'skill-2',
      skillKey: 'documents/pdf',
      versionId: 'version-2',
      semanticVersion: '1.0.0',
      manifestHash: 'manifest-2',
      available: false,
    },
  ];
  assert.deepEqual(
    resolveRuntimeSkillAccess(
      ['data/dashboard', 'documents/pdf', 'spreadsheets/excel'],
      pins,
      'private',
    ).skillAllowIds,
    ['data/dashboard', 'spreadsheets/excel'],
  );
  assert.deepEqual(
    resolveRuntimeSkillAccess(
      ['data/dashboard', 'documents/pdf', 'spreadsheets/excel'],
      pins,
      'published_read_only',
    ).skillAllowIds,
    ['data/dashboard'],
  );
});
