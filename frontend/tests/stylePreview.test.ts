import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveStylePreviewSource } from '../src/utils/stylePreview.ts';

test('generated workspace preview wins over embedded fallback HTML', () => {
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

  assert.deepEqual(source, { url: 'https://example.test/.frontend-slides/slide-previews/style-a.html' });
  assert.equal(resolvedPath, '.frontend-slides/slide-previews/style-a.html');
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
