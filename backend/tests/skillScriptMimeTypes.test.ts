import assert from 'node:assert/strict';
import test from 'node:test';

import { isTextMime, mimeTypeForPath } from '../src/services/governance/skillGovernanceModel';

test('JavaScript and TypeScript skill scripts are text, so drafts and reviews show their code', () => {
  for (const file of ['scripts/run.js', 'scripts/run.mjs', 'scripts/run.cjs']) {
    assert.equal(mimeTypeForPath(file), 'text/javascript', file);
    assert.equal(isTextMime(mimeTypeForPath(file)), true, file);
  }
  for (const file of ['scripts/report.ts', 'scripts/report.mts', 'scripts/REPORT.CTS']) {
    assert.equal(mimeTypeForPath(file), 'text/x-typescript', file);
    assert.equal(isTextMime(mimeTypeForPath(file)), true, file);
  }
});

test('existing types are unchanged', () => {
  assert.equal(mimeTypeForPath('scripts/recalc.py'), 'text/x-python');
  assert.equal(mimeTypeForPath('assets/logo.png'), 'image/png');
  assert.equal(isTextMime(mimeTypeForPath('assets/tool.wasm')), false);
});
