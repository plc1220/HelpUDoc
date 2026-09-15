import { createHash } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import type { OfficeEdit } from '../src/utils/officeQuickEdit';
import type { WorkspaceCollaborationObject } from '../src/services/workspaceCollaborationApi';

const quote = 'Selected passage';
const paragraph = `Before ${quote} after.`;

// A real, self-contained PDF text layer exercises selection mapping through PDF.js.
// Office conversion/native XML patching have separate service tests; REST is mocked here.
function pdfFixture(text: string): string {
  const escaped = text.replace(/([\\()])/g, '\\$1');
  const stream = `BT /F1 18 Tf 30 240 Td (${escaped}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 500 300] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
  ];
  let pdf = '%PDF-1.4\n'; const offsets = [0];
  objects.forEach((object, index) => { offsets.push(pdf.length); pdf += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` + offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(pdf).toString('base64');
}

async function mount(page: Page, baseURL: string, { canEdit = true, hasDynamicFields = false, duplicateParagraph = false, text = paragraph } = {}) {
  let version = 1;
  let state = { text, bold: false, italic: false, fontSize: 12, styleId: 'Normal' };
  const history = new Map([[version, { ...state }]]);
  const edits: Array<{ version: number; revision: string; edit: OfficeEdit }> = [];
  const undos: Array<{ version: number; restoreVersion: number }> = [];
  const comments: WorkspaceCollaborationObject[] = [];
  let rejectNext = false;
  const content = () => Buffer.from(`PK mocked DOCX version ${version}`).toString('base64');
  const revision = () => createHash('sha256').update(Buffer.from(content(), 'base64')).digest('hex');
  const file = () => ({ id: '12', name: 'review.docx', version, content: content() });
  const initialFile = file();
  const initialRevision = revision();
  const headers = {
    'access-control-allow-origin': baseURL,
    'access-control-allow-credentials': 'true',
    'access-control-allow-methods': 'GET, POST, PATCH, OPTIONS',
    'access-control-allow-headers': 'Content-Type, X-User-Id, X-User-Name, X-User-Email',
  };
  await page.route('**/api/workspaces/office-qc/files/**', async route => {
    const request = route.request();
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
    if (request.url().endsWith('/office-preview')) return route.fulfill({ headers, json: {
      pdf: pdfFixture(state.text), revision: revision(), version, canEdit,
      document: {
        paragraphs: Array.from({ length: duplicateParagraph ? 2 : 1 }, (_, index) => ({ id: `p:${index}`, text: state.text, styleId: state.styleId, editable: true, runs: [{ start: 0, end: state.text.length, bold: state.bold, italic: state.italic, fontSize: state.fontSize }] })),
        styles: [{ id: 'Normal', name: 'Normal' }, { id: 'Heading1', name: 'Heading 1' }],
        hasDynamicFields,
      },
    } });
    const payload = request.postDataJSON();
    if (request.url().endsWith('/quick-edit/undo')) {
      undos.push(payload);
      expect(payload.version).toBe(version);
      const restored = history.get(payload.restoreVersion);
      expect(restored).toBeDefined();
      state = { ...restored! }; version += 1; history.set(version, { ...state });
      return route.fulfill({ headers, json: { file: file() } });
    }
    if (request.url().endsWith('/quick-edit')) {
      edits.push(payload);
      if (rejectNext) { rejectNext = false; return route.fulfill({ status: 409, headers, json: { error: 'File version mismatch' } }); }
      expect(payload.version).toBe(version);
      expect(payload.revision).toBe(revision());
      const edit = payload.edit;
      expect(state.text.slice(edit.start, edit.end)).toBe(edit.quote);
      const previousVersion = version;
      if (edit.action === 'replaceText') state.text = state.text.slice(0, edit.start) + edit.value + state.text.slice(edit.end);
      else if (edit.action === 'style') state.styleId = edit.value;
      else if (edit.action === 'bold') state.bold = edit.value;
      else if (edit.action === 'italic') state.italic = edit.value;
      else if (edit.action === 'fontSize') state.fontSize = edit.value;
      version += 1; history.set(version, { ...state });
      return route.fulfill({ headers, json: { file: file(), previousVersion } });
    }
    return route.fulfill({ status: 404, headers, json: { error: 'Unexpected request' } });
  });
  await page.route('**/api/workspaces/office-qc/collaboration/objects**', async route => {
    const request = route.request();
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
    let response: unknown;
    if (request.method() === 'POST') {
      response = { id: `comment-${comments.length + 1}`, authorName: 'Reviewer', status: 'open', messageCount: 0, ...request.postDataJSON() };
      comments.push(response);
    } else if (/\/objects\/comment-/.test(request.url())) response = { object: comments.find(item => request.url().endsWith(item.id)), messages: [] };
    else response = { objects: comments };
    return route.fulfill({ headers, json: response });
  });
  await page.route('**/__office-quick-edit', route => route.fulfill({ contentType: 'text/html', body: `<html><head><script type="module">
    import RefreshRuntime from '/@react-refresh';RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;
    </script></head><body><div id="root"></div><script type="module">
    import React from '/node_modules/.vite/deps/react.js';import ReactDOM from '/node_modules/.vite/deps/react-dom_client.js';
    import { AppThemeRoot } from '/src/AppThemeRoot.tsx';import CanvasAnnotations from '/src/components/CanvasAnnotations.tsx';
    import OfficeDocumentPreview from '/src/components/OfficeDocumentPreview.tsx';import { OfficeDocumentContext } from '/src/components/OfficeDocumentContext.ts';import '/src/index.css';
    function Harness(){const [file,setFile]=React.useState(${JSON.stringify(initialFile)});const [prompt,setPrompt]=React.useState('');return React.createElement(AppThemeRoot,{},
      React.createElement('pre',{'data-testid':'agent-prompt'},prompt),React.createElement('output',{'data-testid':'saved-version'},file.version),
      React.createElement('div',{style:{height:650}},React.createElement(OfficeDocumentContext.Provider,{value:{canEdit:${canEdit},onSaved:setFile,onAgentChat:setPrompt}},
        React.createElement(CanvasAnnotations,{workspace:{id:'office-qc',visibility:'team',role:${JSON.stringify(canEdit ? 'owner' : 'commenter')}},filePath:'review.docx',onAgentChat:setPrompt},
          React.createElement(OfficeDocumentPreview,{file,fileContent:file.content,workspaceId:'office-qc'})))));}
    ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(Harness));</script></body></html>` }));
  await page.goto('/__office-quick-edit');
  await expect(page.locator('[data-annotation-surface="document:docx:page:1"]').getByText(text, { exact: true })).toBeVisible({ timeout: 30000 });
  return {
    edits, undos, comments, initialRevision, rejectNext: () => { rejectNext = true; },
    advanceVersion: (nextText: string) => {
      state = { ...state, text: nextText }; version += 1; history.set(version, { ...state });
      return { version, revision: revision() };
    },
  };
}

async function selectPassage(page: Page, selected = quote) {
  const text = page.locator('[data-annotation-surface="document:docx:page:1"] .textLayer span').filter({ hasText: selected }).first();
  await expect(text).toBeVisible();
  await text.evaluate((element, selectionText) => {
    const node = element.firstChild!;
    const start = node.textContent!.indexOf(selectionText);
    if (start < 0) throw new Error('Fixture selection is missing');
    const range = document.createRange(); range.setStart(node, start); range.setEnd(node, start + selectionText.length);
    const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range);
    element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  }, selected);
  await expect(page.getByRole('region', { name: 'Quick edit' })).toBeVisible();
}

test.beforeEach(async ({ baseURL }) => {
  test.skip(!baseURL || !/^http:\/\/(localhost|127\.0\.0\.1):/.test(baseURL), 'Requires local Vite modules');
});

test('DOCX quick edits submit exact source ranges, refresh the preview, and undo the last edit', async ({ page, baseURL }) => {
  const mock = await mount(page, baseURL!);
  await selectPassage(page);
  await page.getByRole('button', { name: 'Bold', exact: true }).click();
  await expect(page.getByTestId('saved-version')).toHaveText('2');
  expect(mock.edits[0]).toEqual({ version: 1, revision: mock.initialRevision, edit: { paragraphId: 'p:0', start: 7, end: 23, quote, action: 'bold', value: true } });

  await selectPassage(page);
  await expect(page.getByRole('button', { name: 'Bold', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: 'Italic', exact: true }).click();
  await expect(page.getByTestId('saved-version')).toHaveText('3');
  expect(mock.edits[1].edit).toMatchObject({ action: 'italic', value: true, start: 7, end: 23 });

  await selectPassage(page);
  await page.getByRole('spinbutton', { name: 'Font size' }).fill('16');
  await page.getByRole('button', { name: 'Apply font size', exact: true }).click();
  await expect(page.getByTestId('saved-version')).toHaveText('4');
  expect(mock.edits[2].edit).toMatchObject({ action: 'fontSize', value: 16 });

  await selectPassage(page);
  await page.getByRole('combobox', { name: 'Paragraph style' }).click();
  await page.getByRole('option', { name: 'Heading 1', exact: true }).click();
  await expect(page.getByTestId('saved-version')).toHaveText('5');
  expect(mock.edits[3].edit).toMatchObject({ action: 'style', value: 'Heading1' });

  await selectPassage(page);
  await page.getByRole('button', { name: 'Edit text', exact: true }).click();
  await page.getByRole('textbox', { name: 'Selected text', exact: true }).fill('Corrected passage');
  await page.getByRole('button', { name: 'Apply text edit', exact: true }).click();
  await expect(page.getByTestId('saved-version')).toHaveText('6');
  await expect(page.locator('.textLayer').getByText('Before Corrected passage after.', { exact: true })).toBeVisible();
  expect(mock.edits[4].edit).toMatchObject({ action: 'replaceText', quote, value: 'Corrected passage' });
  await page.getByRole('button', { name: 'Undo last edit', exact: true }).click();
  await expect(page.getByTestId('saved-version')).toHaveText('7');
  await expect(page.locator('.textLayer').getByText(paragraph, { exact: true })).toBeVisible();
  expect(mock.undos).toEqual([{ version: 6, restoreVersion: 5 }]);
  await expect(page.getByRole('button', { name: 'Undo last edit', exact: true })).toHaveCount(0);
});

test('a stale save preserves the replacement and displays a refresh instruction', async ({ page, baseURL }) => {
  const mock = await mount(page, baseURL!);
  await selectPassage(page);
  await page.getByRole('button', { name: 'Edit text', exact: true }).click();
  const replacement = page.getByRole('textbox', { name: 'Selected text', exact: true });
  await replacement.fill('Keep my correction');
  mock.rejectNext();
  await page.getByRole('button', { name: 'Apply text edit', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'This document has changed' })).toBeVisible();
  await expect(replacement).toHaveValue('Keep my correction');
  await expect(page.getByTestId('saved-version')).toHaveText('1');
  await expect(page.locator('.textLayer').getByText(paragraph, { exact: true })).toBeVisible();
});

test('refresh retains a typed correction and requires selecting its target in the new version', async ({ page, baseURL }) => {
  const mock = await mount(page, baseURL!);
  await selectPassage(page);
  await page.getByRole('button', { name: 'Edit text', exact: true }).click();
  const replacement = page.getByRole('textbox', { name: 'Selected text', exact: true });
  await replacement.fill('Retained correction');
  const changedParagraph = `Updated ${paragraph}`;
  const changed = mock.advanceVersion(changedParagraph);
  await page.getByRole('button', { name: 'Refresh document preview', exact: true }).click();
  await expect(page.locator('.textLayer').getByText(changedParagraph, { exact: true })).toBeVisible();
  await expect(replacement).toHaveValue('Retained correction');
  await expect(page.getByText('The document changed. Select the passage again before applying an edit. Your typed correction will be kept.', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Apply text edit', exact: true })).toBeDisabled();
  expect(mock.edits).toHaveLength(0);
  await selectPassage(page);
  await expect(replacement).toHaveValue('Retained correction');
  await expect(page.getByRole('button', { name: 'Apply text edit', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Apply text edit', exact: true }).click();
  await expect(page.getByTestId('saved-version')).toHaveText('3');
  const start = changedParagraph.indexOf(quote);
  expect(mock.edits).toEqual([{ ...changed, edit: {
    paragraphId: 'p:0', start, end: start + quote.length, quote, action: 'replaceText', value: 'Retained correction',
  } }]);
  await expect(page.locator('.textLayer').getByText('Updated Before Retained correction after.', { exact: true })).toBeVisible();
});

test('read-only document selections support comments and agent context without formatting controls', async ({ page, baseURL }) => {
  const mock = await mount(page, baseURL!, { canEdit: false });
  await selectPassage(page);
  await expect(page.getByRole('button', { name: 'Bold', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Edit text', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Ask agent', exact: true }).click();
  await expect(page.getByTestId('agent-prompt')).toContainText('"paragraphId": "p:0"');
  await expect(page.getByTestId('agent-prompt')).toContainText(quote);
  await page.getByRole('button', { name: 'Comment on selection', exact: true }).click();
  await page.getByRole('textbox', { name: 'Annotation comment', exact: true }).fill('Please clarify this passage.');
  await page.getByRole('button', { name: 'Post comment', exact: true }).click();
  await expect(page.getByText('Please clarify this passage.', { exact: true })).toBeVisible();
  expect(mock.comments[0]).toMatchObject({ filePath: 'review.docx', blockId: 'document:docx:page:1', anchorText: quote });
  expect(JSON.parse(mock.comments[0].anchorFingerprint)).toEqual({ kind: 'document-text', revision: mock.initialRevision });
  await page.getByRole('button', { name: 'Add to agent chat', exact: true }).click();
  await expect(page.getByTestId('agent-prompt')).toContainText('Please clarify this passage.');
  await expect(page.getByTestId('agent-prompt')).toContainText('document:docx:page:1');
  expect(mock.edits).toHaveLength(0);
  await page.screenshot({ path: test.info().outputPath('office-readonly-annotation.png') });
});

for (const example of [
  { name: 'dynamic-field document', text: paragraph, selected: quote, hasDynamicFields: true },
  { name: 'short numeric selection', text: 'This paragraph has 42 review points.', selected: '42', hasDynamicFields: false },
]) {
  test(`${example.name} requires choosing the displayed source passage before editing`, async ({ page, baseURL }) => {
    const mock = await mount(page, baseURL!, { text: example.text, hasDynamicFields: example.hasDynamicFields });
    await selectPassage(page, example.selected);
    await expect(page.locator('.office-source-choice')).toContainText(example.text);
    await expect(page.getByRole('button', { name: 'Bold', exact: true })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Italic', exact: true })).toBeDisabled();
    await expect(page.getByRole('spinbutton', { name: 'Font size' })).toBeDisabled();
    await expect(page.getByRole('combobox', { name: 'Paragraph style' })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Edit text', exact: true })).toBeDisabled();
    expect(mock.edits).toHaveLength(0);
    await page.getByRole('button', { name: 'Use this source passage', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Bold', exact: true })).toBeEnabled();
    await page.getByRole('button', { name: 'Bold', exact: true }).click();
    await expect(page.getByTestId('saved-version')).toHaveText('2');
    const start = example.text.indexOf(example.selected);
    expect(mock.edits).toEqual([{ version: 1, revision: mock.initialRevision, edit: {
      paragraphId: 'p:0', start, end: start + example.selected.length, quote: example.selected, action: 'bold', value: true,
    } }]);
    // A prior source choice must not carry over to a new selection or revision.
    await selectPassage(page, example.selected);
    await expect(page.getByRole('button', { name: 'Use this source passage', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Bold', exact: true })).toBeDisabled();
  });
}

test('duplicate source paragraphs keep direct edits disabled despite matching page context', async ({ page, baseURL }) => {
  const mock = await mount(page, baseURL!, { duplicateParagraph: true });
  await selectPassage(page);
  await expect(page.getByText('This text appears in several places. Select a longer passage to edit it.', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Bold', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Italic', exact: true })).toBeDisabled();
  await expect(page.getByRole('spinbutton', { name: 'Font size' })).toBeDisabled();
  await expect(page.getByRole('combobox', { name: 'Paragraph style' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Edit text', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Use this source passage', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Comment on selection', exact: true })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Ask agent', exact: true })).toBeEnabled();
  expect(mock.edits).toHaveLength(0);
});
