import assert from 'node:assert/strict';
import test from 'node:test';

import { currentTurnMultimodalMaxBytes, isUnreadablePdf, skipReason, skippedAttachmentsNote } from '../src/services/turnAttachments';

const MB = 1024 * 1024;
const pdf = Buffer.from('%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF');

test('the limit stays 8 MB unless it is set, and a bad value is ignored', () => {
  const before = process.env.CURRENT_TURN_MULTIMODAL_MAX_BYTES;
  delete process.env.CURRENT_TURN_MULTIMODAL_MAX_BYTES;
  assert.equal(currentTurnMultimodalMaxBytes(), 8 * MB);
  for (const bad of ['0', '-5', 'abc']) {
    process.env.CURRENT_TURN_MULTIMODAL_MAX_BYTES = bad;
    assert.equal(currentTurnMultimodalMaxBytes(), 8 * MB);
  }
  if (before === undefined) delete process.env.CURRENT_TURN_MULTIMODAL_MAX_BYTES;
  else process.env.CURRENT_TURN_MULTIMODAL_MAX_BYTES = before;
});

test('only files over the limit or that cannot be a PDF are held back', () => {
  assert.equal(skipReason(Buffer.alloc(8 * MB + 1), 'image/png', 8 * MB), 'too_large');
  assert.equal(skipReason(Buffer.alloc(8 * MB), 'image/png', 8 * MB), null);
  assert.equal(skipReason(pdf, 'application/pdf', 8 * MB), null);
  assert.equal(skipReason(Buffer.from('%PDF-1.7\ngarbage'), 'application/pdf', 8 * MB), 'unreadable');
  assert.equal(skipReason(Buffer.from('hello'), 'application/pdf', 8 * MB), 'unreadable');
  // A header after leading bytes, or a truncated file, still goes to the model.
  assert.equal(isUnreadablePdf(Buffer.concat([Buffer.from('\n\n'), pdf])), false);
  assert.equal(isUnreadablePdf(pdf.subarray(0, pdf.length - 5)), false);
});

test('the note says what happened and what to ask for; nothing skipped means no note', () => {
  assert.equal(skippedAttachmentsNote([], 8 * MB), '');
  const note = skippedAttachmentsNote([
    { name: 'scan.pdf', mimeType: 'application/pdf', bytes: 12.4 * MB, reason: 'too_large' },
    { name: 'bad.pdf', mimeType: 'application/pdf', bytes: 10, reason: 'unreadable' },
  ], 8 * MB);
  assert.match(note, /scan\.pdf \(12\.4 MB\)/);
  assert.match(note, /split or compress it to under 8\.0 MB/);
  assert.match(note, /bad\.pdf: the file is damaged/);
});
