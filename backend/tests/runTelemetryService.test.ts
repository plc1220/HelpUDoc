import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeToolEventJson } from '../src/services/runTelemetryService';

test('normalizeToolEventJson parses stringified output file entries', () => {
  const normalized = normalizeToolEventJson({
    outputFiles: [
      '{"path":"docs/implementation_plan_v2.md","mimeType":"text/markdown"}' as unknown as Record<string, unknown>,
      { path: 'slides.pdf', mimeType: 'application/pdf', size: 42 },
      'not-json' as unknown as Record<string, unknown>,
    ],
    payload: {
      type: 'tool_end',
      outputFiles: '[{"path":"docs/implementation_plan_v2.md","mimeType":"text/markdown"}]',
    },
  });

  assert.deepEqual(normalized.outputFiles, [
    { path: 'docs/implementation_plan_v2.md', mimeType: 'text/markdown' },
    { path: 'slides.pdf', mimeType: 'application/pdf', size: 42 },
  ]);
  assert.deepEqual(normalized.payload, {
    type: 'tool_end',
    outputFiles: [
      { path: 'docs/implementation_plan_v2.md', mimeType: 'text/markdown' },
    ],
  });
});
