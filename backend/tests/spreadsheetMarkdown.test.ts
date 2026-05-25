import assert from 'node:assert/strict';
import test from 'node:test';
import ExcelJS from 'exceljs';
import { workbookBufferToMarkdown } from '../src/utils/spreadsheetMarkdown';

test('workbookBufferToMarkdown renders workbook sheets as fenced csv blocks', async () => {
  const workbook = new ExcelJS.Workbook();
  const summary = workbook.addWorksheet('Summary');
  summary.addRows([
    ['Metric', 'Value'],
    ['Revenue', 1200],
    ['Notes', 'Includes, comma'],
  ]);
  const details = workbook.addWorksheet('Details');
  details.addRows([
    ['Region', 'Count'],
    ['MY', 10],
  ]);

  const arrayBuffer = await workbook.xlsx.writeBuffer();
  const markdown = await workbookBufferToMarkdown(Buffer.from(arrayBuffer), { title: 'sales.xlsx' });

  assert.match(markdown, /^# sales\.xlsx/m);
  assert.match(markdown, /^## Summary/m);
  assert.match(markdown, /Metric,Value/);
  assert.match(markdown, /Notes,"Includes, comma"/);
  assert.match(markdown, /^## Details/m);
  assert.match(markdown, /Region,Count/);
});
