import { expect, test } from '@playwright/test';

// Office preview selections create annotations; editing is exclusively in Edit file.
test('selecting Office preview text offers Annotate without disabled editing controls', async ({ page, baseURL }) => {
  test.skip(!baseURL?.startsWith('http://127.0.0.1:'), 'Local Vite required');
  const stream = 'BT /F1 18 Tf 30 240 Td (Selected passage) Tj ET';
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 500 300] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`];
  let pdf = '%PDF-1.4\n'; const offsets = [0];
  objects.forEach((object, index) => { offsets.push(pdf.length); pdf += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = pdf.length;
  pdf += `xref\n0 6\n0000000000 65535 f \n` + offsets.slice(1).map(n => `${String(n).padStart(10, '0')} 00000 n \n`).join('') + `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  await page.route('**/api/workspaces/office-qc/files/12/office-preview', route => route.fulfill({ json: { pdf: Buffer.from(pdf).toString('base64'), revision: 'a'.repeat(64), version: 1, canEdit: true }, headers: { 'access-control-allow-origin': baseURL!, 'access-control-allow-credentials': 'true' } }));
  await page.route('**/__office-annotation-selection', route => route.fulfill({ contentType: 'text/html', body: `<html><head><script type="module">import RefreshRuntime from '/@react-refresh';RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;</script></head><body><div id="root"></div><script type="module">
    import React from '/node_modules/.vite/deps/react.js';import ReactDOM from '/node_modules/.vite/deps/react-dom_client.js';
    import {AppThemeRoot} from '/src/AppThemeRoot.tsx';import OfficeDocumentPreview from '/src/components/OfficeDocumentPreview.tsx';import {CanvasAnnotationContext} from '/src/components/CanvasAnnotationContext.ts';import '/src/index.css';
    ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(AppThemeRoot,{},React.createElement('div',{style:{height:'100vh'}},React.createElement(CanvasAnnotationContext.Provider,{value:{active:false,canComment:true,annotations:[],select:anchor=>{window.selectedAnchor=anchor},open:()=>{}}},React.createElement(OfficeDocumentPreview,{file:{id:'12',name:'review.docx'},workspaceId:'office-qc',fileContent:''})))));
  </script></body></html>` }));
  await page.goto('/__office-annotation-selection');
  const passage = page.locator('.textLayer').getByText('Selected passage', { exact: true });
  await expect(passage).toBeVisible();
  await passage.evaluate(el => { const range = document.createRange(); range.selectNodeContents(el); const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range); el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })); });
  const toolbar = page.getByRole('region', { name: 'Annotate selection' });
  await expect(toolbar).toBeVisible();
  await expect(toolbar.getByRole('button', { name: 'Bold', exact: true })).toHaveCount(0);
  await expect(toolbar.getByRole('button', { name: 'Edit text', exact: true })).toHaveCount(0);
  await toolbar.getByRole('button', { name: 'Annotate', exact: true }).click();
  expect(await page.evaluate(() => (window as unknown as {selectedAnchor: {anchorText: string; blockId: string}}).selectedAnchor)).toMatchObject({anchorText:'Selected passage',blockId:'document:docx:page:1'});
  await expect(toolbar).toHaveCount(0);
});
