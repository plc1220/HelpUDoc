import assert from 'node:assert/strict';
import test from 'node:test';

import { previewPayloadToHtml } from '../src/utils/workspaceHtmlPreview.ts';

test('workspace HTML preview preserves authenticated text responses', () => {
  const html = '<!doctype html><title>Style A</title>';
  assert.equal(previewPayloadToHtml({ content: html, encoding: 'text' }), html);
});

test('workspace HTML preview rejects missing content', () => {
  assert.equal(previewPayloadToHtml({ content: null, encoding: 'text' }), '');
});
