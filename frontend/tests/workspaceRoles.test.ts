/**
 * Role predicates behind every "changes for review" cue.
 *
 * These were duplicated: `WorkspaceCollaborationDialog` held them as
 * module-local consts and `WorkspaceList` spelled `roleCanPropose` out inline.
 * The tests below are the reason a second copy must not come back — a drift
 * between them shows a button the server then refuses.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { roleCanComment, roleCanModerate, roleCanPropose } from '../src/utils/workspaceRoles.ts';
import type { Workspace } from '@helpudoc/contracts/types';

const ROLES: Array<Workspace['role']> = ['owner', 'editor', 'contributor', 'commenter', 'viewer'];

test('only owner and editor may approve', () => {
  assert.deepEqual(
    ROLES.filter(roleCanModerate),
    ['owner', 'editor'],
  );
});

test('contributor and above may submit changes', () => {
  assert.deepEqual(
    ROLES.filter(roleCanPropose),
    ['owner', 'editor', 'contributor'],
  );
});

test('commenter and above may join a discussion', () => {
  assert.deepEqual(
    ROLES.filter(roleCanComment),
    ['owner', 'editor', 'contributor', 'commenter'],
  );
});

test('a contributor may submit but must not be shown a review cue', () => {
  // The case the whole gate exists for. A contributor can file changes and can
  // see the queue, but cannot apply anything in it, so an "awaiting review"
  // prompt would send them to a pane with no button they can press.
  assert.equal(roleCanPropose('contributor'), true);
  assert.equal(roleCanModerate('contributor'), false);
});

test('a viewer is refused every one of them', () => {
  assert.equal(roleCanComment('viewer'), false);
  assert.equal(roleCanPropose('viewer'), false);
  assert.equal(roleCanModerate('viewer'), false);
});

test('an absent role is treated as no access', () => {
  // `workspace?.role` is optional at every call site, so undefined reaches
  // these. It must not fall through to a permissive default.
  for (const predicate of [roleCanComment, roleCanPropose, roleCanModerate]) {
    assert.equal(predicate(undefined as unknown as Workspace['role']), false);
  }
});
