import assert from 'node:assert/strict';
import test from 'node:test';

import {
  canCreateWorkspaceCollaborationObject,
  canModerateWorkspaceCollaboration,
  canPostWorkspaceTeamMessage,
  getWorkspaceRoleCapabilities,
} from '../src/services/workspaceCollaborationPolicy';

test('viewers keep private notes but cannot create shared collaboration', () => {
  assert.equal(canCreateWorkspaceCollaborationObject('viewer', 'sticky_note', 'private'), true);
  assert.equal(
    canCreateWorkspaceCollaborationObject('viewer', 'sticky_note', 'workspace_audience'),
    false,
  );
});

test('commenters can annotate and create tasks without proposing content changes', () => {
  assert.equal(
    canCreateWorkspaceCollaborationObject('commenter', 'annotation', 'workspace_audience'),
    true,
  );
  assert.equal(
    canCreateWorkspaceCollaborationObject('commenter', 'task', 'workspace_audience'),
    true,
  );
  assert.equal(
    canCreateWorkspaceCollaborationObject('commenter', 'change_proposal', 'workspace_audience'),
    false,
  );
});

test('contributors can create proposals but cannot publish or manage access', () => {
  const capabilities = getWorkspaceRoleCapabilities('contributor');
  assert.equal(capabilities.canPropose, true);
  assert.equal(capabilities.canPublish, false);
  assert.equal(capabilities.canManageAccess, false);
  assert.equal(
    canCreateWorkspaceCollaborationObject('contributor', 'change_proposal', 'private'),
    true,
  );
});

test('only publishers and owners moderate shared collaboration', () => {
  assert.equal(canModerateWorkspaceCollaboration('viewer'), false);
  assert.equal(canModerateWorkspaceCollaboration('commenter'), false);
  assert.equal(canModerateWorkspaceCollaboration('contributor'), false);
  assert.equal(canModerateWorkspaceCollaboration('editor'), true);
  assert.equal(canModerateWorkspaceCollaboration('owner'), true);
});

test('Team Chat is readable by viewers but writable from Commenter access', () => {
  assert.equal(canPostWorkspaceTeamMessage('viewer'), false);
  assert.equal(canPostWorkspaceTeamMessage('commenter'), true);
  assert.equal(canPostWorkspaceTeamMessage('contributor'), true);
  assert.equal(canPostWorkspaceTeamMessage('editor'), true);
  assert.equal(canPostWorkspaceTeamMessage('owner'), true);
});
