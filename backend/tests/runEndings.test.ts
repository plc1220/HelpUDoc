import assert from 'node:assert/strict';
import test from 'node:test';

import { buildTerminalConversationSummary, skillSandboxFailureLimit } from '../src/services/agent-runs/lifecycle';

test('an empty run says so, unless it produced something the user can see', () => {
  assert.match(buildTerminalConversationSummary('completed'), /without writing a reply/);
  const file = { toolEvents: [{ id: '1', name: 'write_file', status: 'completed', startedAt: '', outputFiles: [{ path: '/a.md' }] }] };
  for (const visible of [file, { workflowActions: [{}] }, { pendingInterrupt: {} }]) {
    assert.equal(buildTerminalConversationSummary('completed', undefined, visible as never), 'Completed successfully.');
  }
  assert.equal(buildTerminalConversationSummary('cancelled'), 'The run was stopped.');
  assert.equal(buildTerminalConversationSummary('failed', 'x'), 'The run failed: x');
});

test('a missing skill is tolerated longer than other sandbox errors', () => {
  assert.equal(skillSandboxFailureLimit('SANDBOX_JOB_FAILED'), 2);
  assert.ok(skillSandboxFailureLimit('Load a skill before running a skill script. If no') > 2);
});
