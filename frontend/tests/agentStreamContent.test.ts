import assert from 'node:assert/strict';
import test from 'node:test';

import { isInternalStreamContent } from '@helpudoc/contracts/agentStream';

test('line-numbered read_file output is hidden from assistant prose', () => {
  assert.equal(isInternalStreamContent([
    '1\t/* mandatory base styles */',
    '2\thtml, body { width: 100%; }',
    '3\t.deck-stage { position: absolute; }',
  ].join('\n')), true);
});

test('normal numbered Markdown remains user-facing', () => {
  assert.equal(isInternalStreamContent([
    '1. Review the outline',
    '2. Choose a visual style',
    '3. Generate the final deck',
  ].join('\n')), false);
});
