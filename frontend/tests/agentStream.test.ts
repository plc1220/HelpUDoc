import assert from 'node:assert/strict';
import test from 'node:test';

import {
  normalizeAgentStreamChunk,
  toLangChainStreamProjection,
} from '@helpudoc/contracts/agentStream';

test('workspace file changes remain semantic custom stream events', () => {
  const chunk = normalizeAgentStreamChunk({
    type: 'workspace_files_changed',
    workspaceId: 'workspace-123',
    paths: ['slides/final.pptx', 'previews/final.png'],
  });

  assert.deepEqual(toLangChainStreamProjection(chunk), {
    custom: [{ name: 'workspace_files_changed', data: chunk }],
  });
});
