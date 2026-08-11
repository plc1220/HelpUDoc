import assert from 'node:assert/strict';
import test from 'node:test';

import { stripDeadFrontendSlidesUiReferences } from '../src/utils/chatMarkdown.ts';

test('preserves Markdown block boundaries and nested-list indentation', () => {
  const markdown = [
    'Intro paragraph.',
    '',
    '### Deliverable Overview',
    '- **Theme:** Cobalt Grid',
    '  - *Typography:* Newsreader',
    '',
    '---',
    '',
    '### Key Features',
  ].join('\n');

  assert.equal(stripDeadFrontendSlidesUiReferences(markdown), markdown);
});

test('removes stale chooser prose without flattening the following Markdown', () => {
  const markdown = [
    'I have created the Presentation Context form below.',
    '',
    '### Next section',
    '- Item',
  ].join('\n');

  assert.equal(
    stripDeadFrontendSlidesUiReferences(markdown),
    ['### Next section', '- Item'].join('\n'),
  );
});
