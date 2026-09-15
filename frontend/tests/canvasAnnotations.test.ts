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

test('document pins reject changed content and invalid coordinates', async () => {
  const { documentPin, documentRevision } = await import('../src/utils/canvasAnnotations.ts');
  const revision = documentRevision('original');
  const anchor = { anchorFingerprint: JSON.stringify({ kind: 'document-pin', revision, x: 0.25, y: 0.75 }) };
  assert.deepEqual(documentPin(anchor, revision), { x: 0.25, y: 0.75 });
  assert.equal(documentPin(anchor, documentRevision('changed')), null);
  assert.equal(documentPin({ anchorFingerprint: JSON.stringify({ kind: 'document-pin', revision, x: 2, y: 0 }) }, revision), null);
  assert.equal(documentPin({ anchorFingerprint: 'malformed' }, revision), null);
});
