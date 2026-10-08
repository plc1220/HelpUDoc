import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveWorkspaceFileExportActions } from '../src/utils/workspaceFileExport.ts';

test('office files download the stored original and cannot be printed', () => {
  for (const fileName of ['Q3-review.pptx', 'report.docx', 'data.xlsx', 'scan.pdf', 'logo.png']) {
    assert.deepEqual(
      resolveWorkspaceFileExportActions({ fileName, isDraft: false }),
      { canPrint: false, downloadSource: 'stored' },
      fileName,
    );
  }
});

test('markdown and html download what the canvas shows and can be printed', () => {
  for (const fileName of ['notes.md', 'page.html', 'PAGE.HTM']) {
    assert.deepEqual(
      resolveWorkspaceFileExportActions({ fileName, isDraft: false }),
      { canPrint: true, downloadSource: 'canvas' },
      fileName,
    );
  }
});

test('a draft markdown file still downloads from the canvas', () => {
  assert.deepEqual(
    resolveWorkspaceFileExportActions({ fileName: 'draft.md', isDraft: true }),
    { canPrint: true, downloadSource: 'canvas' },
  );
});

test('a draft binary file has no stored copy to download', () => {
  assert.deepEqual(
    resolveWorkspaceFileExportActions({ fileName: 'draft.pptx', isDraft: true }),
    { canPrint: false, downloadSource: null },
  );
});

test('no file means no export actions', () => {
  assert.deepEqual(
    resolveWorkspaceFileExportActions({ fileName: '', isDraft: false }),
    { canPrint: false, downloadSource: null },
  );
});
