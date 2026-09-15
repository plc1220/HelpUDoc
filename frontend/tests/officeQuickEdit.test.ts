import { test } from 'node:test';
import assert from 'node:assert/strict';
import { officeSelectionTargets, officeSelectionNeedsConfirmation, selectedOfficeFormat, officeEditRequest, type OfficeDocument, type OfficeParagraph } from '../src/utils/officeQuickEdit.ts';

const paragraph = (id: string, text: string, editable = true): OfficeParagraph => ({ id, text, editable, styleId: 'Body', runs: [] });
const doc = (...paragraphs: OfficeParagraph[]): OfficeDocument => ({ paragraphs, styles: [] });

test('PDF ligatures, wrapped lines, and Unicode map to exact source codepoints', () => {
  const source = doc(paragraph('p:0', 'Hello 😀 office\u00a0review'));
  const [match] = officeSelectionTargets(source, '😀 ofﬁce\nreview');
  assert.equal(match.start, 6);
  assert.equal(match.end, 21);
  assert.equal(match.quote, '😀 office\u00a0review');
  assert.deepEqual(officeEditRequest(match, 'bold', true), { paragraphId: 'p:0', start: 6, end: 21, quote: match.quote, action: 'bold', value: true });
});

test('duplicate selections cannot silently select the first paragraph', () => {
  assert.equal(officeSelectionTargets(doc(paragraph('p:0', 'Same text'), paragraph('p:1', 'Same text', false)), 'Same text').length, 2);
  assert.equal(officeSelectionTargets(doc(paragraph('p:0', 'echo echo')), 'echo').length, 2);
});

test('adjacent PDF paragraphs cannot trick matching into choosing another source paragraph', () => {
  const source = doc(paragraph('p:0', 'Please review this contract'), paragraph('p:1', 'Please review'), paragraph('p:2', 'this contract'));
  assert.equal(officeSelectionTargets(source, 'this contract').length, 2);
});

test('partial ligatures and absent or whitespace selections have no editable match', () => {
  const source = doc(paragraph('p:0', 'ﬁrst'));
  assert.equal(officeSelectionTargets(source, 'f').length, 0);
  assert.equal(officeSelectionTargets(source, 'missing').length, 0);
  assert.equal(officeSelectionTargets(source, ' \n ').length, 0);
});

test('mixed formatting toggles to on; all-bold selection toggles to off', () => {
  const p = paragraph('p:0', 'Bold plain');
  p.runs = [{ start: 0, end: 4, bold: true, italic: false, fontSize: 12 }, { start: 4, end: 10, bold: false, italic: false, fontSize: 12 }];
  assert.equal(selectedOfficeFormat(officeSelectionTargets(doc(p), 'Bold')[0], 'bold'), true);
  assert.equal(selectedOfficeFormat(officeSelectionTargets(doc(p), 'Bold plain')[0], 'bold'), false);
});

test('header and chart text cannot be mistaken for a unique body selection', () => {
  const source = { ...doc(paragraph('p:0', 'Quarterly plan')), protectedTexts: ['Quarterly plan'] };
  assert.equal(officeSelectionTargets(source, 'Quarterly plan').length, 2);
});

test('generated fields and short labels require an explicit source passage choice', () => {
  const source = { ...doc(paragraph('p:0', 'Quarterly plan for the new regional launch in 2026.')), hasDynamicFields: true };
  assert.equal(officeSelectionNeedsConfirmation(source, 'Quarterly plan'), true);
  assert.equal(officeSelectionNeedsConfirmation(doc(), '2026'), true);
  assert.equal(officeSelectionNeedsConfirmation(doc(), 'iv'), true);
  assert.equal(officeSelectionNeedsConfirmation(doc(), 'Quarterly plan'), false);
});
