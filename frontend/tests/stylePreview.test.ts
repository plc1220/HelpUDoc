import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveStylePreviewSource } from '../src/utils/stylePreview.ts';

test('embedded preview HTML wins over a workspace URL', () => {
  let resolvedPath = '';
  const source = resolveStylePreviewSource(
    {
      html: '<!doctype html><title>Fallback preview</title>',
      path: '.frontend-slides/slide-previews/style-a.html',
    },
    (path) => {
      resolvedPath = path;
      return `https://example.test/${path}`;
    },
  );

  assert.deepEqual(source, { html: '<!doctype html><title>Fallback preview</title>' });
  assert.equal(resolvedPath, '');
});

test('workspace URL is used when embedded HTML is unavailable', () => {
  assert.deepEqual(
    resolveStylePreviewSource(
      { path: 'style-b-preview.html' },
      (path) => `https://example.test/${path}`,
    ),
    { url: 'https://example.test/style-b-preview.html' },
  );
});
