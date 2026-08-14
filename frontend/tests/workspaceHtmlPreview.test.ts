import assert from 'node:assert/strict';
import test from 'node:test';

import {
  hydrateWorkspaceHtmlAssets,
  previewPayloadToHtml,
} from '../src/utils/workspaceHtmlPreview.ts';

test('workspace HTML preview preserves authenticated text responses', () => {
  const html = '<!doctype html><title>Style A</title>';
  assert.equal(previewPayloadToHtml({ content: html, encoding: 'text' }), html);
});

test('workspace HTML preview rejects missing content', () => {
  assert.equal(previewPayloadToHtml({ content: null, encoding: 'text' }), '');
});

test('workspace HTML preview embeds root-relative and sibling assets', async () => {
  const requested: string[] = [];
  const hydrated = await hydrateWorkspaceHtmlAssets(
    '<img src="/images/hero.png"><div style="background:url(../shared/grid.svg)"></div><img src="https://cdn.test/logo.png">',
    'decks/demo/deck.html',
    async (path) => {
      requested.push(path);
      return path.endsWith('.svg')
        ? { mimeType: 'image/svg+xml', encoding: 'text', content: '<svg></svg>' }
        : { mimeType: 'image/png', encoding: 'base64', content: 'aW1hZ2U=' };
    },
  );

  assert.deepEqual(requested.sort(), ['decks/shared/grid.svg', 'images/hero.png']);
  assert.match(hydrated, /src="data:image\/png;base64,aW1hZ2U="/);
  assert.match(hydrated, /url\(data:image\/svg\+xml;charset=utf-8,/);
  assert.match(hydrated, /src="https:\/\/cdn\.test\/logo\.png"/);
});
