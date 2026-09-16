import { expect, test } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import JSZip from 'jszip';

test('native DOCX editor edits the source and preserves untouched package content', async ({ page, baseURL }) => {
  test.skip(!process.env.NATIVE_DOCX_FIXTURE || !baseURL?.startsWith('http://127.0.0.1:'), 'Requires a local DOCX fixture');
  const original = readFileSync(process.env.NATIVE_DOCX_FIXTURE!);
  let saved: Buffer | undefined;
  let content = original.toString('base64');
  let version = 1;
  let revision = createHash('sha256').update(original).digest('hex');
  const requests: unknown[] = [];
  await page.route('**/api/workspaces/review/files/42/docx-content', async route => {
    if (route.request().method() === 'PUT') {
      const body = route.request().postDataJSON(); requests.push(body);
      if (body.version !== version || body.revision !== revision) return route.fulfill({ status: 409, json: { error: 'Version conflict' }, headers: { 'access-control-allow-origin': baseURL!, 'access-control-allow-credentials': 'true' } });
      saved = Buffer.from(body.content, 'base64'); content = body.content; version++;
      revision = createHash('sha256').update(saved).digest('hex');
      return route.fulfill({ json: { file: { id: '42', name: 'Quarterly plan.docx', version, content }, revision }, headers: { 'access-control-allow-origin': baseURL!, 'access-control-allow-credentials': 'true' } });
    }
    return route.fulfill({ json: { content, version, revision, canEdit: true, readOnlyReason: null }, headers: { 'access-control-allow-origin': baseURL!, 'access-control-allow-credentials': 'true' } });
  });
  if (!process.env.NATIVE_DOCX_PRODUCTION) await page.route('**/__native-docx', route => route.fulfill({ contentType: 'text/html', body: `<html><head><script type="module">
    import RefreshRuntime from '/@react-refresh';RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;
    </script></head><body><div id="root"></div><script type="module">
    import React from '/node_modules/.vite/deps/react.js';import ReactDOM from '/node_modules/.vite/deps/react-dom_client.js';
    import { AppThemeRoot } from '/src/AppThemeRoot.tsx';import { OfficeDocumentContext } from '/src/components/OfficeDocumentContext.ts';
    import NativeDocxEditor from '/src/components/NativeDocxEditor.tsx';import '/src/index.css';
    function Harness(){const ref=React.useRef(null);const [show,setShow]=React.useState(true);const [state,setState]=React.useState({dirty:false,saving:false});return React.createElement(AppThemeRoot,{},React.createElement('div',{style:{height:'100vh',display:'flex',flexDirection:'column'}},React.createElement('div',{},React.createElement('button',{onClick:()=>ref.current?.save()},'Save document'),React.createElement('button',{onClick:()=>setShow(x=>!x)},'Toggle editor'),React.createElement('span',{'data-testid':'status'},state.dirty?'Unsaved edits':'Saved')),React.createElement('div',{style:{flex:1,minHeight:0}},show&&React.createElement(OfficeDocumentContext.Provider,{value:{canEdit:true,onSaved:()=>{},onAgentChat:()=>{}}},React.createElement(NativeDocxEditor,{ref,workspaceId:'review',file:{id:'42',name:'Quarterly plan.docx',version:1},onStateChange:setState})))));}
    ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(Harness));</script></body></html>` }));
  await page.goto(process.env.NATIVE_DOCX_PRODUCTION ? '/native-docx-production.html' : '/__native-docx');
  await expect(page.getByLabel('Word document editor')).toBeVisible();
  await expect(page.getByText('Opening Word document…')).not.toBeVisible({ timeout: 60000 });
  const title = page.getByText('Quarterly plan', { exact: true }).first();
  await expect(title).toBeVisible({ timeout: 30000 });
  await page.screenshot({ path: test.info().outputPath('native-docx-before.png') });
  await title.dblclick();
  await page.keyboard.press('Home');
  await page.keyboard.type('Updated ');
  await page.keyboard.press('Shift+Home');
  await page.getByRole('button', { name: /^Bold \(/ }).click();
  await page.getByRole('button', { name: /^Italic \(/ }).click();
  await page.getByRole('combobox', { name: 'Font size', exact: true }).fill('18');
  await page.getByRole('combobox', { name: 'Font size', exact: true }).press('Enter');
  await expect(page.getByTestId('status')).toHaveText('Unsaved edits');
  await page.getByRole('button', { name: 'Toggle editor' }).click();
  await page.getByRole('button', { name: 'Toggle editor' }).click();
  await expect(page.getByText('Your unsaved edits have been restored.')).toBeVisible();
  await expect(page.getByTestId('status')).toHaveText('Unsaved edits');
  await page.getByRole('button', { name: 'Save document' }).click();
  await expect(page.getByTestId('status')).toHaveText('Saved');
  expect(requests).toHaveLength(1);
  expect(saved).toBeDefined();
  writeFileSync(test.info().outputPath('edited.docx'), saved!);
  const before = await JSZip.loadAsync(original);
  const after = await JSZip.loadAsync(saved!);
  const canonicalXml = async (xml: string) => page.evaluate(source => {
    const parsed = new DOMParser().parseFromString(source, 'application/xml');
    if (parsed.querySelector('parsererror')) throw new Error('Invalid exported XML');
    const canonical = (node: Node): unknown => node instanceof Element
      ? [node.namespaceURI, node.localName, Array.from(node.attributes).filter(attribute => attribute.namespaceURI !== 'http://www.w3.org/2000/xmlns/').map(attribute => [attribute.namespaceURI, attribute.localName, attribute.value]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))), Array.from(node.childNodes).filter(child => !(node.children.length && child.nodeType === Node.TEXT_NODE && !child.nodeValue?.trim() && !node.hasAttribute('xml:space'))).map(canonical)]
      : [node.nodeType, node.nodeValue];
    return canonical(parsed.documentElement);
  }, xml);
  expect(Object.keys(after.files).sort()).toEqual(Object.keys(before.files).sort());
  for (const [path, entry] of Object.entries(before.files)) {
    if (entry.dir || path === 'word/document.xml') continue;
    if (path.endsWith('.xml') || path.endsWith('.rels')) {
      expect(await canonicalXml(await after.file(path)!.async('string')), `${path} must retain every element and attribute`).toEqual(await canonicalXml(await entry.async('string')));
    } else expect(await after.file(path)!.async('base64'), `${path} must remain byte-identical`).toBe(await entry.async('base64'));
  }
  const originalXml = await before.file('word/document.xml')!.async('string');
  const updatedXml = await after.file('word/document.xml')!.async('string');
  expect(updatedXml).toContain('Updated ');
  expect(updatedXml).toContain('<w:sz w:val="36"');
  const tables = await page.evaluate(([originalSource, updatedSource]) => {
    const namespace = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
    const originals = Array.from(new DOMParser().parseFromString(originalSource, 'application/xml').getElementsByTagNameNS(namespace, 'tbl'));
    const updates = Array.from(new DOMParser().parseFromString(updatedSource, 'application/xml').getElementsByTagNameNS(namespace, 'tbl'));
    const identityNamespace = 'http://schemas.microsoft.com/office/word/2010/wordml';
    // The native engine adds paragraph identities when the upload did not have them.
    // Existing identities must still be compared; only newly assigned ones are ignored.
    updates.forEach((table, index) => {
      const beforeParagraphs = originals[index]?.getElementsByTagNameNS(namespace, 'p');
      Array.from(table.getElementsByTagNameNS(namespace, 'p')).forEach((paragraph, paragraphIndex) => {
        for (const name of ['paraId', 'textId']) if (!beforeParagraphs?.[paragraphIndex]?.hasAttributeNS(identityNamespace, name)) paragraph.removeAttributeNS(identityNamespace, name);
      });
    });
    const serialize = (elements: Element[]) => elements.map(element => new XMLSerializer().serializeToString(element));
    return [serialize(originals), serialize(updates)];
  }, [originalXml, updatedXml]);
  expect(await Promise.all(tables[1].map(canonicalXml))).toEqual(await Promise.all(tables[0].map(canonicalXml)));
  await page.screenshot({ path: test.info().outputPath('native-docx-light.png'), animations: 'disabled' });
  writeFileSync(test.info().outputPath('native-computed-fonts.json'), JSON.stringify(await page.getByLabel('Word document editor').locator('*').evaluateAll(elements => elements.filter(element => /docx-line|docx-run/.test(String(element.className))).slice(0, 10).map(element => ({ text: element.textContent, className: element.className, style: element.getAttribute('style'), font: getComputedStyle(element).fontFamily }))), null, 2));
  await page.evaluate(() => { localStorage.setItem('helpudoc-color-mode', 'dark'); window.dispatchEvent(new CustomEvent('helpudoc-color-mode-change', { detail: 'dark' })); });
  await expect(page.locator('[data-theme="dark"]').first()).toBeVisible();
  await page.screenshot({ path: test.info().outputPath('native-docx-dark.png'), animations: 'disabled' });
  await page.getByRole('button', { name: 'Select paragraph style' }).click();
  writeFileSync(test.info().outputPath('native-style-popup.html'), await page.locator('body').innerHTML());
  await page.screenshot({ path: test.info().outputPath('native-docx-dark-styles.png'), animations: 'disabled' });
  await page.keyboard.press('Escape');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: test.info().outputPath('native-docx-mobile.png'), animations: 'disabled' });
  await page.setViewportSize({ width: 1280, height: 720 });
  // A collaborator saves after we opened this version. Keep the local edit on 409.
  version++;
  await page.getByText('Updated ', { exact: true }).first().dblclick();
  await page.keyboard.press('Home'); await page.keyboard.type('Conflicted ');
  await page.getByRole('button', { name: 'Save document' }).click();
  await expect(page.getByRole('alert')).toContainText('A newer version is available');
  await expect(page.getByTestId('status')).toHaveText('Unsaved edits');
  await page.getByRole('button', { name: 'Load latest version' }).click();
  await expect(page.getByRole('alertdialog')).toBeVisible();
  await page.getByRole('button', { name: 'Keep editing', exact: true }).click();
  await expect(page.getByTestId('status')).toHaveText('Unsaved edits');
  await page.getByRole('button', { name: 'Load latest version' }).click();
  await page.getByRole('button', { name: 'Discard edits and load', exact: true }).click();
  await expect(page.getByTestId('status')).toHaveText('Saved');
  await expect(page.getByText('Conflicted ', { exact: true })).toHaveCount(0);
});
