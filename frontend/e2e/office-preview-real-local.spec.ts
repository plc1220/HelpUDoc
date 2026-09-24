import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';

test('real Office conversion keeps document pages inside Astryx light and dark chrome', async ({ page, baseURL }) => {
  test.skip(!process.env.OFFICE_PREVIEW_FIXTURE || !baseURL?.startsWith('http://127.0.0.1:'), 'Requires a locally rendered Office fixture');
  const fixture = JSON.parse(readFileSync(process.env.OFFICE_PREVIEW_FIXTURE!, 'utf8'));
  await page.route('**/api/workspaces/review/files/42/office-preview', route => route.fulfill({
    json: { ...fixture, version: 1, canEdit: true },
    headers: { 'access-control-allow-origin': baseURL!, 'access-control-allow-credentials': 'true' },
  }));
  await page.route('**/api/workspaces/review/collaboration/objects', route => route.fulfill({
    json: { objects: [] }, headers: { 'access-control-allow-origin': baseURL!, 'access-control-allow-credentials': 'true' },
  }));
  await page.route('**/__office-real-preview', route => route.fulfill({ contentType: 'text/html', body: `<html><head><script type="module">
    import RefreshRuntime from '/@react-refresh';RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;
    </script></head><body><div id="root"></div><script type="module">
    import React from '/node_modules/.vite/deps/react.js';import ReactDOM from '/node_modules/.vite/deps/react-dom_client.js';
    import { AppThemeRoot } from '/src/AppThemeRoot.tsx';import { OfficeDocumentContext } from '/src/components/OfficeDocumentContext.ts';
    import CanvasAnnotations from '/src/components/CanvasAnnotations.tsx';import FileRenderer from '/src/components/FileRenderer.tsx';import '/src/index.css';
    function Harness(){return React.createElement(AppThemeRoot,{},React.createElement('div',{style:{height:'100vh'}},React.createElement(OfficeDocumentContext.Provider,{value:{canEdit:true,onSaved:()=>{},onAgentChat:()=>{}}},React.createElement(CanvasAnnotations,{workspace:{id:'review',visibility:'team',role:'owner'},filePath:'Quarterly plan.docx',onAgentChat:()=>{}},React.createElement(FileRenderer,{file:{id:'42',name:'Quarterly plan.docx'},fileContent:'',workspaceId:'review'})))));}
    ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(Harness));</script></body></html>` }));
  await page.goto('/__office-real-preview');
  const title = page.locator('.textLayer').getByText('Quarterly plan', { exact: true });
  await expect(title).toBeVisible({ timeout: 30000 });
  await expect(page.locator('[data-annotation-surface]')).toHaveCount(2);
  await title.evaluate(el => { const range = document.createRange(); range.selectNodeContents(el); const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range); el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })); });
  await expect(page.getByRole('region', { name: 'Annotate selection' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Annotate selection' }).getByRole('button', { name: 'Annotate', exact: true })).toBeEnabled();
  await page.screenshot({ path: test.info().outputPath('office-preview-light.png'), animations: 'disabled' });
  await page.evaluate(() => { localStorage.setItem('helpudoc-color-mode', 'dark'); window.dispatchEvent(new CustomEvent('helpudoc-color-mode-change', { detail: 'dark' })); });
  await expect(page.locator('[data-theme="dark"]').first()).toBeVisible();
  await page.screenshot({ path: test.info().outputPath('office-preview-dark.png'), animations: 'disabled' });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(async () => page.locator('[data-annotation-surface]').first().evaluate(el => el.getBoundingClientRect().width)).toBeLessThan(390);
  await expect(title).toBeVisible();
  await page.screenshot({ path: test.info().outputPath('office-preview-mobile.png'), animations: 'disabled' });
  await page.getByRole('button', { name: 'Close annotation selection', exact: true }).click();
  await page.setViewportSize({ width: 1100, height: 720 });
  await expect.poll(async () => page.locator('[data-annotation-surface]').first().evaluate(el => el.getBoundingClientRect().width)).toBeGreaterThan(800);
  const secondPage = page.locator('[data-annotation-surface="document:docx:page:2"]');
  await secondPage.evaluate(el => {
    const scroller = el.closest('.document-pdf-preview')!.firstElementChild!;
    scroller.scrollTop += el.getBoundingClientRect().top - scroller.getBoundingClientRect().top + 30;
  });
  await page.getByRole('button', { name: 'Comments (0)' }).click();
  // The comment panel overlays the page; resizing the workspace reflows it.
  await page.setViewportSize({ width: 850, height: 720 });
  await expect.poll(async () => page.locator('[data-annotation-surface]').first().evaluate(el => el.getBoundingClientRect().width)).toBeLessThan(900);
  await expect.poll(async () => secondPage.evaluate(el => {
    const scroller = el.closest('.document-pdf-preview')!.firstElementChild!;
    return Math.abs(el.getBoundingClientRect().top - scroller.getBoundingClientRect().top);
  })).toBeLessThan(60);
});
