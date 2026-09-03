import assert from 'node:assert/strict';
import test from 'node:test';

import { describeActivityEvent } from '../src/lib/activityLabels';

test('names the file for a status change', () => {
  const d = describeActivityEvent({
    action: 'file.status.approved',
    resourceType: 'file',
    filePath: 'reports/2026/q3.md',
    workspaceName: 'Research pack',
  });
  assert.equal(d.title, 'Approved q3.md');
  assert.equal(d.meta, 'Research pack · file');
});

test('uses the leaf name, not the whole path', () => {
  const d = describeActivityEvent({
    action: 'file.status.submitted',
    resourceType: 'file',
    filePath: 'a/b/c/deep.md',
  });
  assert.equal(d.title, 'Submitted deep.md');
});

test('normalizes backslash paths', () => {
  const d = describeActivityEvent({
    action: 'file.status.published',
    resourceType: 'file',
    filePath: 'reports\\q3.md',
  });
  assert.equal(d.title, 'Published q3.md');
});

test('falls back when a file event carries no path', () => {
  const d = describeActivityEvent({ action: 'file.status.reverted', resourceType: 'file' });
  assert.equal(d.title, 'Reverted a file');
});

test('names the workspace for a workspace event', () => {
  const d = describeActivityEvent({
    action: 'workspace.version_published',
    resourceType: 'workspace',
    workspaceName: 'Research pack',
  });
  assert.equal(d.title, 'Published a version of Research pack');
  assert.equal(d.meta, 'Workspace');
});

test('surfaces an admin override read as what it is', () => {
  // This event is recorded precisely so somebody can see it. It must not be
  // flattened into a generic "accessed" line.
  const d = describeActivityEvent({
    action: 'admin.workspace.accessed',
    resourceType: 'workspace',
    workspaceName: 'Research pack',
  });
  assert.equal(d.title, 'Viewed Research pack as an admin');
  assert.equal(d.meta, 'Platform override');
});

test('an unknown action degrades to a readable sentence', () => {
  // New verbs are added to the audit tables constantly. The feed must not be
  // the thing that breaks when one appears.
  assert.equal(
    describeActivityEvent({ action: 'skill.retired', resourceType: 'skill' }).title,
    'Retired',
  );
  assert.equal(
    describeActivityEvent({ action: 'workspace.some_new_thing', resourceType: 'workspace' }).title,
    'Some new thing',
  );
});

test('an unknown action on a file still names the file', () => {
  const d = describeActivityEvent({
    action: 'file.something_new',
    resourceType: 'file',
    filePath: 'notes.md',
  });
  assert.equal(d.title, 'Something new notes.md');
});

test('never throws or returns an empty title on junk input', () => {
  for (const action of ['', '.', '...', 'x']) {
    const d = describeActivityEvent({ action, resourceType: '' });
    assert.ok(d.title.length > 0, `empty title for action ${JSON.stringify(action)}`);
    assert.ok(d.meta.length > 0);
  }
});

test('omits the workspace from meta when there is none', () => {
  const d = describeActivityEvent({ action: 'file.status.approved', resourceType: 'file', filePath: 'a.md' });
  assert.equal(d.meta, 'File');
});
