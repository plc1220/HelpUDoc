import { expect, test } from '@playwright/test';
import JSZip from 'jszip';
import type { WorkspaceCollaborationObject } from '../src/services/workspaceCollaborationApi';

async function fixture(format: string) {
  if (format === 'pdf') {
    const objects = [
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 300] /Resources << /Font << /F1 5 0 R >> >> /Contents 6 0 R >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 300] /Resources << /Font << /F1 5 0 R >> >> /Contents 7 0 R >>',
      '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
      ...['First page', 'Selected passage'].map(text => { const stream = `BT /F1 18 Tf 30 240 Td (${text}) Tj ET`; return `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`; }),
    ];
    let pdf = '%PDF-1.4\n'; const offsets = [0];
    objects.forEach((object, index) => { offsets.push(pdf.length); pdf += `${index + 1} 0 obj\n${object}\nendobj\n`; });
    const xref = pdf.length;
    pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` + offsets.slice(1).map(n => `${String(n).padStart(10, '0')} 00000 n \n`).join('');
    pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
    return Buffer.from(pdf).toString('base64');
  }
  const zip = new JSZip();
  if (format === 'docx') {
    zip.file('[Content_Types].xml', '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
    zip.file('_rels/.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="r1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
    zip.file('word/document.xml', '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Selected passage</w:t></w:r></w:p></w:body></w:document>');
  } else {
    for (let i = 1; i <= 2; i++) zip.file(`ppt/slides/slide${i}.xml`, `<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>Slide title</a:t></a:r></a:p><a:p><a:r><a:t>${i === 2 ? 'Selected passage' : 'First slide'}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`);
  }
  return zip.generateAsync({ type: 'base64' });
}

for (const format of ['pdf', 'pptx', 'docx']) {
  test(`${format}: text highlights and page pins persist in the document preview`, async ({ page, baseURL }) => {
    test.skip(!baseURL || !/^http:\/\/(localhost|127\.0\.0\.1):/.test(baseURL), 'Local Vite required');
    const data = await fixture(format);
    const pdf = await fixture('pdf');
    const scope = format === 'pdf' ? 'document:pdf:page:2' : format === 'pptx' ? 'document:pptx:slide:2' : 'document:docx:page:2';
    const objects: WorkspaceCollaborationObject[] = [];
    await page.route('**/api/workspaces/qc/files/12/office-preview', route => route.fulfill({ json: { pdf, revision: 'a'.repeat(64), version: 1, canEdit: false }, headers: { 'access-control-allow-origin': baseURL!, 'access-control-allow-credentials': 'true' } }));
    await page.route('**/api/workspaces/qc/files/12/preview', route => route.fulfill({ body: Buffer.from(pdf, 'base64'), contentType: 'application/pdf', headers: { 'access-control-allow-origin': baseURL!, 'access-control-allow-credentials': 'true' } }));

    await page.route('**/api/workspaces/qc/collaboration/objects**', async route => {
      const request = route.request();
      const headers = { 'access-control-allow-origin': baseURL!, 'access-control-allow-credentials': 'true', 'access-control-allow-methods': '*', 'access-control-allow-headers': '*' };
      if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
      let result;
      if (request.method() === 'POST') { result = { id: `comment${objects.length}`, authorName: 'Reviewer', status: 'open', messageCount: 0, ...request.postDataJSON() }; objects.push(result); }
      else if (request.url().includes('/objects/comment')) result = { object: objects.find(item => request.url().endsWith(item.id)), messages: [] };
      else result = { objects };
      await route.fulfill({ json: result, headers });
    });
    await page.route('**/__document-annotations', route => route.fulfill({ contentType: 'text/html', body: `<html><head><script type="module">
      import RefreshRuntime from '/@react-refresh';RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;
      </script></head><body><div id="root"></div><script type="module">
      import React from '/node_modules/.vite/deps/react.js';import ReactDOM from '/node_modules/.vite/deps/react-dom_client.js';
      import { AppThemeRoot } from '/src/AppThemeRoot.tsx';import CanvasAnnotations from '/src/components/CanvasAnnotations.tsx';import FileRenderer from '/src/components/FileRenderer.tsx';import '/src/index.css';
      function Harness(){const [prompt,setPrompt]=React.useState('');return React.createElement(AppThemeRoot,{},React.createElement('pre',{'data-testid':'prompt'},prompt),React.createElement('div',{style:{height:640}},React.createElement(CanvasAnnotations,{workspace:{id:'qc',visibility:'team',role:'owner'},filePath:'review.${format}',anchorVersionId:'anchor-fixture-uuid',fileId:12,onAgentChat:setPrompt},React.createElement(FileRenderer,{file:{id:'12',name:'review.${format}'},fileContent:'${data}',workspaceId:'qc'}))));}
      ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(Harness));</script></body></html>` }));
    await page.goto('/__document-annotations');
    const surface = page.locator(`[data-annotation-surface="${scope}"]`);
    const text = surface.getByText('Selected passage', { exact: true });
    await expect(text).toBeVisible({ timeout: 30000 });
    await page.getByRole('button', { name: 'Annotate', exact: true }).click();
    await text.evaluate(el => { const range = document.createRange(); range.selectNodeContents(el); const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range); el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })); });
    await page.getByRole('textbox', { name: 'Annotation comment' }).fill('Text comment');
    await page.getByRole('button', { name: 'Post comment', exact: true }).click();
    await expect(page.getByText('Text comment', { exact: true })).toBeVisible();
    expect(objects[0].blockId).toBe(scope);
    expect(objects[0].anchorText).toBe('Selected passage');
    await page.getByRole('button', { name: 'Add to agent chat' }).click();
    await expect(page.getByTestId('prompt')).toContainText(scope);
    await page.getByRole('button', { name: 'Close comments' }).click();
    await page.evaluate(() => window.getSelection()?.removeAllRanges());
    await surface.click({ position: { x: 20, y: 15 } });
    await page.getByRole('textbox', { name: 'Annotation comment' }).fill('Page pin comment');
    await page.getByRole('button', { name: 'Post comment', exact: true }).click();
    await expect(page.getByText('Page pin comment', { exact: true })).toBeVisible();
    expect(objects[1].blockId).toBe(scope);
    expect(JSON.parse(objects[1].anchorFingerprint).kind).toBe('document-pin');
    await page.reload();
    await expect(surface).toBeVisible({ timeout: 30000 });
    await expect(page.locator('.canvas-annotations-mark')).toHaveCount(1);
    await expect(page.locator('.canvas-annotations-pin')).toHaveCount(1);
    await surface.scrollIntoViewIfNeeded();
    await page.locator('.canvas-annotations-pin').click();
    await expect(page.getByText('Page pin comment', { exact: true })).toBeVisible();
    await page.screenshot({ path: test.info().outputPath(`${format}-annotations.png`) });
  });
}
