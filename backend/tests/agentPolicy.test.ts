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

const draftPinUserService = (workspaceMode: EffectiveAgentPolicy['workspaceMode']) => ({
  getWorkspaceSkillRuntimePins: async () => [],
  getWorkspaceSkillDraftRuntimePins: async (workspaceId: string, userId: string) => {
    assert.equal(workspaceId, 'workspace-1');
    assert.equal(userId, 'user-1');
    return [{
      skillKey: 'my-private-skill',
      draftId: 'draft-1',
      versionId: '11111111-2222-3333-4444-555555555555',
      manifestHash: 'a'.repeat(64),
      displayName: 'My private skill',
      description: null,
    }];
  },
  workspaceMode,
});

test('a private workspace runs the owner\'s own skill draft as an exact pin', async () => {
  const api = createAgentPolicyApi({} as any, draftPinUserService('private') as any);
  const token = await api.buildAgentAuthToken({
    userId: 'user-1',
    workspaceId: 'workspace-1',
    policy,
    skipPlanApprovals: false,
  });

  assert.ok(token);
  const payload = decodePayload(token) as {
    skillAllowIds: string[];
    skillVersionPins: Record<string, { versionId: string; manifestHash: string }>;
  };
  assert.deepEqual(payload.skillAllowIds, ['data/dashboard', 'my-private-skill']);
  assert.deepEqual(payload.skillVersionPins['my-private-skill'], {
    skillId: 'draft-1',
    versionId: '11111111-2222-3333-4444-555555555555',
    semanticVersion: '0.0.0-draft',
    manifestHash: 'a'.repeat(64),
  });
});

test('a shared workspace never inherits a private skill draft', async () => {
  const api = createAgentPolicyApi({} as any, draftPinUserService('shared_live') as any);
  const token = await api.buildAgentAuthToken({
    userId: 'user-1',
    workspaceId: 'workspace-1',
    policy: { ...policy, workspaceMode: 'shared_live' },
    skipPlanApprovals: false,
  });

  assert.ok(token);
  const payload = decodePayload(token) as {
    skillAllowIds: string[];
    skillVersionPins: Record<string, unknown>;
  };
  assert.deepEqual(payload.skillAllowIds, ['data/dashboard']);
  assert.deepEqual(payload.skillVersionPins, {});
});

test('the private skill runtime kill switch withholds draft pins from the token', async () => {
  const previous = process.env.ENABLE_PRIVATE_SKILL_RUNTIME;
  process.env.ENABLE_PRIVATE_SKILL_RUNTIME = 'false';
  try {
    const api = createAgentPolicyApi({} as any, draftPinUserService('private') as any);
    const token = await api.buildAgentAuthToken({
      userId: 'user-1',
      workspaceId: 'workspace-1',
      policy,
      skipPlanApprovals: false,
    });

    assert.ok(token);
    const payload = decodePayload(token) as {
      skillAllowIds: string[];
      skillVersionPins: Record<string, unknown>;
    };
    assert.deepEqual(payload.skillAllowIds, ['data/dashboard']);
    assert.deepEqual(payload.skillVersionPins, {});
  } finally {
    if (previous === undefined) delete process.env.ENABLE_PRIVATE_SKILL_RUNTIME;
    else process.env.ENABLE_PRIVATE_SKILL_RUNTIME = previous;
  }
});
