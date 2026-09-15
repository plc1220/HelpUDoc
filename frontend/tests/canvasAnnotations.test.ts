import { test } from 'node:test';
import assert from 'node:assert/strict';
import { locateAnnotationText, annotationChatPrompt } from '../src/utils/canvasAnnotations.ts';

test('text anchors retain exact offsets and recover only unambiguous moved quotes', () => {
  assert.deepEqual(locateAnnotationText('same same', { anchorText: 'same', anchorStart: 5 }), [5, 9]);
  assert.deepEqual(locateAnnotationText('new Selected passage', { anchorText: 'Selected', anchorStart: 0 }), [4, 12]);
  assert.equal(locateAnnotationText('same same', { anchorText: 'same', anchorStart: 3 }), null);
  assert.equal(locateAnnotationText('changed', { anchorText: 'original' }), null);
});

test('agent context preserves file, quote, comment and replies as quoted data', () => {
  const prompt = annotationChatPrompt('proposal.md', { anchorText: 'Selected passage' }, 'Please clarify', ['Reviewer: add a source']);
  const context = JSON.parse(prompt.slice(prompt.indexOf('{')));
  assert.equal(context.filePath, 'proposal.md');
  assert.equal(context.selection, 'Selected passage');
  assert.deepEqual(context.replies, ['Reviewer: add a source']);
});
