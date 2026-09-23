/**
 * Activity filters narrow the caller's scope and can never widen it.
 *
 * `resolveActivityScope` decides what a caller may see; a filter only subtracts
 * from that. These cover the decision directly, because it is the one place
 * where a mistake would turn a convenience into a disclosure.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  resolveFilteredWorkspaceScope,
  type ActivityScope,
} from '../src/services/activityService';

const leadScope: ActivityScope = {
  kind: 'teams',
  teamIds: ['team-a'],
  workspaceIds: ['ws-1', 'ws-2'],
};

const platformScope: ActivityScope = { kind: 'platform' };

test('no filter leaves the resolved scope untouched', () => {
  assert.deepEqual(resolveFilteredWorkspaceScope(leadScope, null), {
    workspaceIds: ['ws-1', 'ws-2'],
    includeTeamBranch: true,
  });
});

test('a filter inside scope narrows to that workspace', () => {
  assert.deepEqual(resolveFilteredWorkspaceScope(leadScope, 'ws-2'), {
    workspaceIds: ['ws-2'],
    includeTeamBranch: false,
  });
});

test('a filter outside scope matches nothing, it does not reach', () => {
  // The decisive case. Returning the unfiltered scope here, or an empty
  // predicate that a query builder then drops, would hand a lead a workspace
  // their teams have no grant on.
  assert.deepEqual(resolveFilteredWorkspaceScope(leadScope, 'ws-somebody-elses'), {
    workspaceIds: [],
    includeTeamBranch: false,
  });
});

test('an empty or blank filter reads as no filter, never as match-none', () => {
  for (const blank of ['', '   ', null, undefined]) {
    assert.deepEqual(
      resolveFilteredWorkspaceScope(leadScope, blank as string | null),
      { workspaceIds: ['ws-1', 'ws-2'], includeTeamBranch: true },
      `failed for ${JSON.stringify(blank)}`,
    );
  }
});

test('a platform admin filtering names exactly one workspace', () => {
  assert.deepEqual(resolveFilteredWorkspaceScope(platformScope, 'ws-9'), {
    workspaceIds: ['ws-9'],
    includeTeamBranch: false,
  });
});

test('an unfiltered platform admin needs no workspace list', () => {
  // Platform scope runs the unrestricted branch instead, so an id list here
  // would be dead weight the caller might mistake for a restriction.
  assert.deepEqual(resolveFilteredWorkspaceScope(platformScope, null), {
    workspaceIds: [],
    includeTeamBranch: true,
  });
});

test('a workspace filter always drops the team branch', () => {
  // Team events carry no workspace. Keeping the branch would leak team-level
  // rows into a result the reader believes is scoped to one workspace.
  for (const scope of [leadScope, platformScope]) {
    assert.equal(resolveFilteredWorkspaceScope(scope, 'ws-1').includeTeamBranch, false);
  }
});

test('a lead whose teams own nothing gains nothing by filtering', () => {
  const empty: ActivityScope = { kind: 'teams', teamIds: ['team-x'], workspaceIds: [] };
  assert.deepEqual(resolveFilteredWorkspaceScope(empty, 'ws-1').workspaceIds, []);
  assert.deepEqual(resolveFilteredWorkspaceScope(empty, null).workspaceIds, []);
});
