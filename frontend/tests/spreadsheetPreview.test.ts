import assert from 'node:assert/strict';
import test from 'node:test';
import * as XLSX from 'xlsx';

import { buildXlsxFixture, type XlsxFixtureName } from '../e2e/fixtures/xlsxFixtures.ts';
import { buildWorkbookPreview, type SheetPreview } from '../src/utils/spreadsheetPreview.ts';

const LIMITS = { maxRows: 100, maxColumns: 20 };

const preview = async (name: XlsxFixtureName) => buildWorkbookPreview(XLSX, await buildXlsxFixture(name), LIMITS);

const sheetNamed = (sheets: SheetPreview[], name: string) => {
  const sheet = sheets.find(item => item.name === name);
  assert.ok(sheet, `sheet ${name} exists`);
  return sheet;
};

/** Look a cell up by its A1 address, checking the grid position agrees with the address. */
const cell = (sheet: SheetPreview, address: string) => {
  const { r, c } = XLSX.utils.decode_cell(address);
  const found = sheet.rows[r]?.[c];
  assert.ok(found, `${sheet.name}!${address} is in the grid`);
  assert.equal(found.address, address);
  return found;
};

test('every sheet is returned by name, in workbook order, with hidden sheets flagged', async () => {
  const { sheets } = await preview('multi');
  assert.deepEqual(sheets.map(sheet => sheet.name), ['Alpha', 'Beta', 'Secret', 'Big']);
  assert.deepEqual(sheets.map(sheet => sheet.hidden), [false, false, true, false]);
});

test('blank rows and columns keep neighbouring values at their real addresses', async () => {
  const alpha = sheetNamed((await preview('multi')).sheets, 'Alpha');
  assert.equal(cell(alpha, 'A1').text, 'Name');
  assert.equal(cell(alpha, 'C1').text, 'Score');
  assert.equal(cell(alpha, 'A2').text, 'Ann');
  assert.equal(cell(alpha, 'A4').text, 'Bob');
  assert.equal(cell(alpha, 'C4').text, '20');
  for (const address of ['A3', 'B3', 'C3', 'B1', 'B2', 'B4']) assert.equal(cell(alpha, address).text, '', address);
  assert.deepEqual(alpha.columnLabels, ['A', 'B', 'C']);
  assert.equal(alpha.totalRows, 7);
  assert.equal(alpha.rows.length, 7);
  assert.equal(alpha.totalColumns, 3);
});

test('data away from A1 stays at its address on every sheet', async () => {
  const beta = sheetNamed((await preview('multi')).sheets, 'Beta');
  assert.equal(cell(beta, 'B3').text, 'hello from Beta');
  for (const address of ['A1', 'B1', 'A2', 'B2', 'A3']) assert.equal(cell(beta, address).text, '', address);

  const offset = sheetNamed((await preview('offset')).sheets, 'Sheet1');
  assert.equal(cell(offset, 'C3').text, 'C3 here');
  assert.equal(offset.totalRows, 3);
  assert.equal(offset.totalColumns, 3);
  for (const row of offset.rows.slice(0, 2)) for (const item of row) assert.equal(item.text, '', item.address);
});

test('an empty first sheet does not hide later sheets', async () => {
  const { sheets } = await preview('emptyFirst');
  assert.deepEqual(sheets.map(sheet => sheet.name), ['Blank', 'Data']);
  const blank = sheetNamed(sheets, 'Blank');
  assert.equal(blank.isEmpty, true);
  assert.equal(blank.rows.length, 0);
  const data = sheetNamed(sheets, 'Data');
  assert.equal(data.isEmpty, false);
  assert.equal(cell(data, 'A1').text, 'x');
});

test('saved formula results are shown and formulas without one are flagged, never calculated', async () => {
  const alpha = sheetNamed((await preview('multi')).sheets, 'Alpha');
  assert.deepEqual(cell(alpha, 'C5'), { address: 'C5', text: '30', formula: 'C2+C4' });
  // C6 stores an empty <v></v> (openpyxl style); C7 stores no <v>. SheetJS reads both as 0.
  assert.deepEqual(cell(alpha, 'C6'), { address: 'C6', text: '', formula: 'C2*2', missingValue: true });
  assert.deepEqual(cell(alpha, 'C7'), { address: 'C7', text: '', formula: 'C4*2', missingValue: true });
});

test('large sheets report their real size and are cut at the preview limits', async () => {
  const big = sheetNamed((await preview('multi')).sheets, 'Big');
  assert.equal(big.totalRows, 150);
  assert.equal(big.totalColumns, 25);
  assert.equal(big.lastColumnLabel, 'Y');
  assert.equal(big.rows.length, 100);
  assert.ok(big.rows.every(row => row.length === 20));
  assert.equal(big.columnLabels.at(-1), 'T');
  assert.equal(big.truncatedRows, true);
  assert.equal(big.truncatedColumns, true);
  assert.equal(cell(big, 'T100').text, 'T100');

  const alpha = sheetNamed((await preview('multi')).sheets, 'Alpha');
  assert.equal(alpha.truncatedRows, false);
  assert.equal(alpha.truncatedColumns, false);
});

test('parsing does not change the workbook bytes', async () => {
  const bytes = await buildXlsxFixture('multi');
  const before = Buffer.from(bytes).toString('base64');
  buildWorkbookPreview(XLSX, bytes, LIMITS);
  assert.equal(Buffer.from(bytes).toString('base64'), before);
});
