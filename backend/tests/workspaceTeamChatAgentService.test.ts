import assert from 'node:assert/strict';
import test from 'node:test';

import { createAgentPolicyApi } from '../src/api/agent/policy';
import {
  buildSharedChannelTokenRequest,
  extractAgentReplyText,
} from '../src/services/workspaceTeamChatAgentService';

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

/**
 * What the shared channel asks for when it signs a token.
 *
 * Shared Chat and private chat must offer and accept the same skills: the `/`
 * menu in both is fed by `/slash-metadata`, which answers with the member's
 * entitlement set. Shared Chat used to sign its own token from workspace skill
 * pins instead, and an empty pin list denies every skill rather than none.
 */

const sharedRequest = (overrides: Partial<Parameters<typeof buildSharedChannelTokenRequest>[0]> = {}) =>
  buildSharedChannelTokenRequest({
    entitledSkillIds: ['research', 'data/analyze'],
    workspaceRole: 'contributor',
    canWriteSharedWorkspace: true,
    deniedMcpServerIds: ['google-workspace'],
    ...overrides,
  });

test('the shared channel asks for the entitlement set, not the workspace pins', () => {
  assert.deepEqual(sharedRequest().policy.skillAllowIds, ['research', 'data/analyze']);
});

test('the shared channel reaches no connection', () => {
  const { policy } = sharedRequest();
  assert.deepEqual(policy.mcpServerAllowIds, []);
  assert.deepEqual(policy.mcpServerDenyIds, ['google-workspace']);
});

test('the shared channel is always shared_live, which is what keeps drafts out', () => {
  // `buildAgentAuthToken` merges a private skill draft only for `private`, so
  // this one field is the whole exclusion. Asserted here so a later edit that
  // reaches for `workspaceMode` has to notice.
  assert.equal(sharedRequest().policy.workspaceMode, 'shared_live');
});

test('a Review-mode member is read-only even when their role could edit', () => {
  assert.equal(sharedRequest({ canWriteSharedWorkspace: false }).policy.canWriteWorkspace, false);
});

test('a plan gate is skipped, because the channel cannot ask', () => {
  assert.equal(sharedRequest().skipPlanApprovals, true);
  assert.equal(sharedRequest().sharedTeamChannel, true);
});

test('the signed token carries the approved skill and not the owner draft', async () => {
  const api = createAgentPolicyApi({} as any, {
    getWorkspaceSkillRuntimePins: async () => [],
    getWorkspaceSkillDraftRuntimePins: async () => [{
      skillKey: 'my-private-skill',
      draftId: 'draft-1',
      versionId: '11111111-2222-3333-4444-555555555555',
      manifestHash: 'a'.repeat(64),
      displayName: 'My private skill',
      description: null,
    }],
  } as any);

  const token = await api.buildAgentAuthToken({
    userId: 'user-1',
    workspaceId: 'workspace-1',
    ...sharedRequest(),
  });

  assert.ok(token);
  const payload = JSON.parse(
    Buffer.from(token.split('.')[1], 'base64url').toString('utf-8'),
  ) as { skillAllowIds: string[]; skipPlanApprovals: boolean; sharedTeamChannel: boolean };
  // `buildAgentAuthToken` normalises and sorts the ids.
  assert.deepEqual(payload.skillAllowIds, ['data/analyze', 'research']);
  assert.equal(payload.skipPlanApprovals, true);
  assert.equal(payload.sharedTeamChannel, true);
});
