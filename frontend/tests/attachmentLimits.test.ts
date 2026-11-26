import assert from 'node:assert/strict';
import test from 'node:test';

import { oversizeAttachmentNotice, setAttachmentMaxBytes } from '../src/utils/attachmentLimits.ts';

const MB = 1024 * 1024;

test('a large scan gets a notice with its size and what to do', () => {
  const notice = oversizeAttachmentNotice([{ name: 'scan.pdf', mimeType: 'application/pdf', bytes: 12.4 * MB }]);
  assert.match(notice || '', /scan\.pdf \(12\.4 MB\)/);
  assert.match(notice || '', /8\.0 MB/);
  assert.match(notice || '', /split or compress/);
});

test('files at or under the limit, other types and unknown sizes get no notice', () => {
  assert.equal(oversizeAttachmentNotice([{ name: 'a.pdf', bytes: 8 * MB }]), null);
  assert.equal(oversizeAttachmentNotice([{ name: 'big.xlsx', bytes: 40 * MB }]), null);
  assert.equal(oversizeAttachmentNotice([{ name: 'a.pdf', bytes: null }]), null);
  assert.equal(oversizeAttachmentNotice([]), null);
});

test('drive sizes arrive as text, and images get their own advice', () => {
  assert.match(oversizeAttachmentNotice([{ name: 'p.PNG', bytes: String(9 * MB) }]) || '', /smaller version/);
});

test('the limit follows the server, and a bad value is ignored', () => {
  setAttachmentMaxBytes(2 * MB);
  assert.ok(oversizeAttachmentNotice([{ name: 'a.pdf', bytes: 3 * MB }]));
  setAttachmentMaxBytes(undefined);
  assert.ok(oversizeAttachmentNotice([{ name: 'a.pdf', bytes: 3 * MB }]));
  setAttachmentMaxBytes(8 * MB);
});
