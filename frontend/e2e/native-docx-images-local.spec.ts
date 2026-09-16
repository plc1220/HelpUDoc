import { expect, test } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import JSZip from 'jszip';

test('Word inserts photos from the file pane, picker and clipboard into the native DOCX', async ({ page, baseURL }) => {
  test.skip(!process.env.NATIVE_DOCX_FIXTURE || !baseURL?.startsWith('http://127.0.0.1:'), 'Requires local DOCX fixture');
  test.setTimeout(120_000);
  const original = readFileSync(process.env.NATIVE_DOCX_FIXTURE!);
  let saved = original;
  let version = 1;
  let photoContent = '';
  let imageRequestCount = 0;
  let holdImageRequest = false;
  let releaseImageRequest: (() => void) | undefined;
  const headers = { 'access-control-allow-origin': baseURL!, 'access-control-allow-credentials': 'true' };
  await page.route('**/api/workspaces/photos/files/42/docx-content', route => {
    if (route.request().method() === 'PUT') {
      const body = route.request().postDataJSON();
      expect(body.version).toBe(version);
      expect(body.revision).toBe(createHash('sha256').update(saved).digest('hex'));
      saved = Buffer.from(body.content, 'base64'); version++;
      return route.fulfill({ headers, json: { file: { id: '42', name: 'Photo review.docx', version }, revision: createHash('sha256').update(saved).digest('hex') } });
    }
    return route.fulfill({ headers, json: { content: saved.toString('base64'), version, revision: createHash('sha256').update(saved).digest('hex'), canEdit: true } });
  });
  await page.route('**/api/workspaces/photos/files/photo/content', async route => {
    imageRequestCount++;
    if (holdImageRequest) await new Promise<void>(resolve => { releaseImageRequest = resolve; });
    return route.fulfill({ headers, json: { mimeType: 'image/png', content: photoContent } });
  });
  await page.route('**/__native-docx-photos', route => route.fulfill({ contentType: 'text/html', body: `<html><head><script type="module">
    import RefreshRuntime from '/@react-refresh';RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;
    </script></head><body><div id="root"></div><script type="module">
    import React from '/node_modules/.vite/deps/react.js';import ReactDOM from '/node_modules/.vite/deps/react-dom_client.js';
    import { AppThemeRoot } from '/src/AppThemeRoot.tsx';import { OfficeDocumentContext } from '/src/components/OfficeDocumentContext.ts';
    import WorkspaceFileTree from '/src/components/WorkspaceFileTree.tsx';
    import NativeDocxEditor from '/src/components/NativeDocxEditor.tsx';import '/src/index.css';
    function Harness(){
      const ref=React.useRef(null);const [show,setShow]=React.useState(true);const [canEdit,setCanEdit]=React.useState(true);const [state,setState]=React.useState({dirty:false});const [moves,setMoves]=React.useState(0);
      const noop=()=>{};const files=[{id:'photo',name:'Workspace photo.png',type:'image/png'},{id:'42',name:'Photo review.docx',version:1}];
      return React.createElement(AppThemeRoot,{},React.createElement('div',{style:{height:'100vh',display:'flex',flexDirection:'column'}},
        React.createElement('style',{},'@media(max-width:640px){.test-file-pane{display:none}}'),
        React.createElement('div',{},React.createElement('button',{onClick:()=>ref.current?.save()},'Save document'),React.createElement('button',{onClick:()=>setShow(x=>!x)},'Toggle editor'),React.createElement('button',{onClick:()=>setCanEdit(x=>!x)},'Toggle permission'),React.createElement('span',{'data-testid':'status'},state.dirty?'Unsaved edits':'Saved'),React.createElement('span',{'data-testid':'moves'},moves)),
        React.createElement('div',{style:{display:'flex',flex:1,minHeight:0}},
          React.createElement('aside',{className:'test-file-pane',style:{width:220,padding:12}},React.createElement(WorkspaceFileTree,{files,colorMode:'light',selectedFileId:'42',selectedFiles:new Set(),copiedPublicUrlFileId:null,isDraftWorkspaceFile:()=>false,onSelectFile:noop,onToggleFileSelection:noop,onCopyPublicUrl:noop,onRenameFile:noop,onRenameFolder:noop,onDeleteFile:noop,onDeleteFolder:noop,onMoveFiles:()=>setMoves(n=>n+1),onMoveFolder:noop})),
          React.createElement('div',{style:{flex:1,minWidth:0}},show&&React.createElement(OfficeDocumentContext.Provider,{value:{canEdit,onSaved:noop,onAgentChat:noop}},React.createElement(NativeDocxEditor,{ref,workspaceId:'photos',file:files[1],onStateChange:setState}))))));
    }
    ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(Harness));</script></body></html>` }));
  await page.goto('/__native-docx-photos');
  await expect(page.getByText('Opening Word document…')).not.toBeVisible({ timeout: 60_000 });
  await expect(page.getByText('Quarterly plan', { exact: true }).first()).toBeVisible({ timeout: 30_000 });
  photoContent = await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 320; canvas.height = 180;
    const context = canvas.getContext('2d')!; context.fillStyle = '#204b5b'; context.fillRect(0, 0, 320, 180);
    context.fillStyle = '#fff'; context.font = '24px sans-serif'; context.fillText('Workspace photo', 48, 95);
    return canvas.toDataURL('image/png').split(',')[1];
  });
  // Move the caret to the title first. The drop must land in the body paragraph,
  // proving it uses the drop point instead of the previously selected position.
  await page.getByText('Quarterly plan', { exact: true }).first().click();
  const paragraph = page.getByText('Launch goals: Preserve the original document formatting.', { exact: true }).first();
  const box = await paragraph.boundingBox();
  const drop = await page.evaluateHandle(() => {
    const transfer = new DataTransfer();
    transfer.setData('application/x-helpudoc-workspace-image', JSON.stringify({ fileId: 'photo', name: 'Workspace photo.png' }));
    transfer.setData('application/x-helpudoc-workspace-file-id', 'photo');
    transfer.setData('text/plain', 'photo');
    return transfer;
  });
  await page.locator('[data-workspace-file-id="photo"]').dragTo(paragraph);
  await expect(page.getByTestId('status')).toHaveText('Unsaved edits');
  await expect(page.getByText('Inserting photo…')).not.toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
  expect(imageRequestCount).toBe(1);
  await expect(page.getByTestId('moves')).toHaveText('0');
  await expect(page.locator('[data-workspace-file-id="photo"]')).toBeVisible();
  await page.getByRole('button', { name: 'Save document' }).click();
  await expect(page.getByTestId('status')).toHaveText('Saved');
  const firstZip = await JSZip.loadAsync(saved);
  const documentXml = await firstZip.file('word/document.xml')!.async('string');
  const imageParagraph = await page.evaluate(xml => {
    const parsed = new DOMParser().parseFromString(xml, 'application/xml');
    return Array.from(parsed.getElementsByTagNameNS('http://schemas.openxmlformats.org/wordprocessingml/2006/main', 'p'))
      .filter(p => p.getElementsByTagNameNS('http://schemas.openxmlformats.org/wordprocessingml/2006/main', 'drawing').length).map(p => p.textContent);
  }, documentXml);
  expect(imageParagraph).toEqual(['Launch goals: Preserve the original document formatting.']);
  const mediaPaths = Object.keys(firstZip.files).filter(path => path.startsWith('word/media/') && !firstZip.files[path].dir);
  expect(await Promise.all(mediaPaths.map(path => firstZip.file(path)!.async('base64')))).toContain(photoContent);
  await page.screenshot({ path: test.info().outputPath('native-docx-workspace-photo.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole('button', { name: 'Photo', exact: true })).toBeInViewport();
  await page.screenshot({ path: test.info().outputPath('native-docx-photo-mobile.png') });
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.getByRole('button', { name: 'Toggle editor' }).click();
  await page.getByRole('button', { name: 'Toggle editor' }).click();
  await expect(page.getByText('Opening Word document…')).not.toBeVisible({ timeout: 30_000 });
  await expect(page.locator('.docx-paginated-surface img')).toHaveCount(mediaPaths.length);
  await page.getByText('A faithful preview keeps the uploaded document’s page settings, fonts, tables, and headers.', { exact: true }).first().click();
  const picker = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Photo', exact: true }).click();
  await (await picker).setFiles({ name: 'Picked photo.png', mimeType: 'image/png', buffer: Buffer.from(photoContent, 'base64') });
  await expect(page.getByTestId('status')).toHaveText('Unsaved edits');
  await expect(page.getByText('Inserting photo…')).not.toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await page.getByText('Business priorities', { exact: true }).first().click();
  await page.locator('.docx-paginated-surface').evaluate((element, content) => {
    const transfer = new DataTransfer();
    transfer.items.add(new File([Uint8Array.from(atob(content), char => char.charCodeAt(0))], 'Pasted photo.png', { type: 'image/png' }));
    element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: transfer }));
  }, photoContent);
  await expect(page.getByText('Inserting photo…')).not.toBeVisible();
  await page.getByRole('button', { name: 'Save document' }).click();
  await expect(page.getByTestId('status')).toHaveText('Saved');
  const finalZip = await JSZip.loadAsync(saved);
  const finalXml = await finalZip.file('word/document.xml')!.async('string');
  expect(await page.evaluate(xml => new DOMParser().parseFromString(xml, 'application/xml')
    .getElementsByTagNameNS('http://schemas.openxmlformats.org/wordprocessingml/2006/main', 'drawing').length, finalXml)).toBe(3);
  // External WebP photos are converted to a PNG native package part for Word.
  const externalPhoto = await page.evaluateHandle(() => {
    const canvas = document.createElement('canvas'); canvas.width = 120; canvas.height = 80;
    const context = canvas.getContext('2d')!; context.fillStyle = '#fa7341'; context.fillRect(0, 0, 120, 80);
    const transfer = new DataTransfer();
    transfer.items.add(new File([Uint8Array.from(atob(canvas.toDataURL('image/webp').split(',')[1]), char => char.charCodeAt(0))], 'External photo.webp', { type: 'image/webp' }));
    return transfer;
  });
  const pageTwo = page.getByText('This paragraph stays on page two. Users can make small edits and leave comments in the canvas.', { exact: true }).first();
  await pageTwo.scrollIntoViewIfNeeded();
  const secondBox = await pageTwo.boundingBox();
  await pageTwo.dispatchEvent('drop', { dataTransfer: externalPhoto, clientX: secondBox!.x + 5, clientY: secondBox!.y + 5 });
  await expect(page.getByTestId('status')).toHaveText('Unsaved edits');
  await expect(page.getByText('Inserting photo…')).not.toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await page.getByRole('button', { name: 'Save document' }).click();
  await expect(page.getByTestId('status')).toHaveText('Saved');
  const externalZip = await JSZip.loadAsync(saved);
  const externalXml = await externalZip.file('word/document.xml')!.async('string');
  expect(externalXml).toContain('External photo.webp');
  expect(Object.keys(externalZip.files).some(path => path.startsWith('word/media/') && path.endsWith('.png'))).toBe(true);
  writeFileSync(test.info().outputPath('native-docx-with-photos.docx'), saved);
  // Rejected files report an inline error and never dirty the document.
  await page.getByLabel('Insert photo into Word document').setInputFiles({ name: 'broken.png', mimeType: 'image/png', buffer: Buffer.from('not a PNG') });
  await expect(page.getByRole('alert')).toContainText('This photo could not be read');
  await expect(page.getByTestId('status')).toHaveText('Saved');
  await page.getByRole('alert').getByRole('button', { name: 'Dismiss', exact: true }).click();
  const multiple = await page.evaluateHandle(content => {
    const transfer = new DataTransfer();
    for (const name of ['one.png', 'two.png']) transfer.items.add(new File([Uint8Array.from(atob(content), char => char.charCodeAt(0))], name, { type: 'image/png' }));
    return transfer;
  }, photoContent);
  await pageTwo.dispatchEvent('drop', { dataTransfer: multiple, clientX: secondBox!.x + 5, clientY: secondBox!.y + 5 });
  await expect(page.getByRole('alert')).toContainText('Insert one photo at a time');
  await expect(page.getByTestId('status')).toHaveText('Saved');
  await page.getByRole('alert').getByRole('button', { name: 'Dismiss', exact: true }).click();
  await page.getByRole('button', { name: 'Toggle permission' }).click();
  await expect(page.getByRole('button', { name: 'Photo', exact: true })).toBeDisabled();
  await paragraph.dispatchEvent('drop', { dataTransfer: drop, clientX: box!.x + 20, clientY: box!.y + 5 });
  expect(imageRequestCount).toBe(1);
  await expect(page.getByTestId('status')).toHaveText('Saved');
  // Revoking access while the workspace image is loading must not write it later.
  await page.getByRole('button', { name: 'Toggle permission' }).click();
  holdImageRequest = true;
  await pageTwo.dispatchEvent('drop', { dataTransfer: drop, clientX: secondBox!.x + 5, clientY: secondBox!.y + 5 });
  await expect(page.getByText('Inserting photo…')).toBeVisible();
  await page.getByRole('button', { name: 'Toggle permission' }).click();
  await expect.poll(() => releaseImageRequest).toBeDefined();
  releaseImageRequest!();
  await expect(page.getByRole('alert')).toContainText('You no longer have permission');
  await expect(page.getByTestId('status')).toHaveText('Saved');
  await page.getByRole('alert').getByRole('button', { name: 'Dismiss', exact: true }).click();
  await page.getByRole('button', { name: 'Toggle permission' }).click();
  releaseImageRequest = undefined;
  await pageTwo.dispatchEvent('drop', { dataTransfer: drop, clientX: secondBox!.x + 5, clientY: secondBox!.y + 5 });
  await expect(page.getByText('Inserting photo…')).toBeVisible();
  await expect.poll(() => releaseImageRequest).toBeDefined();
  await page.getByRole('button', { name: 'Toggle editor' }).click();
  releaseImageRequest!();
  await page.getByRole('button', { name: 'Toggle editor' }).click();
  await expect(page.getByText('Opening Word document…')).not.toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('status')).toHaveText('Saved');
  await expect(page.locator('.docx-paginated-surface img')).toHaveCount(4);
});
