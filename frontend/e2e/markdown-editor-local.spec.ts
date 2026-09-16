import { expect, test, type Page } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';

const markdown = '# Commercial proposal\n\nReview the scope and investment below.\n\n| Milestone | Description |\n| --- | --- |\n| Discovery | Workshops<br>Stakeholder interviews |\n| Delivery | Implementation<br>Knowledge transfer |\n\nAdd a project photo here.\n\n```html\n<br>\n```\n\nInline example: `<br>`.\n';
const imageBytes = readFileSync(new URL('../public/slide-styles/blue-professional.jpg', import.meta.url));
const imageContent = imageBytes.toString('base64');

function contrastRatio(foreground: string, background: string): number {
  const luminance = (color: string) => {
    const rgb = color.match(/^rgba?\((\d+),\s*(\d+),\s*(\d+)/);
    if (!rgb) throw new Error(`Expected computed RGB color, received ${color}`);
    const linear = rgb.slice(1, 4).map(value => Number(value) / 255).map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
    return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
  };
  const values = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return (values[0] + 0.05) / (values[1] + 0.05);
}

async function setup(page: Page, baseURL: string, initialMarkdown = markdown) {
  const saves: string[] = [];
  const requests: { method: string; url: string }[] = [];
  let storedMarkdown = initialMarkdown;
  const headers = { 'access-control-allow-origin': baseURL, 'access-control-allow-credentials': 'true' };
  await page.route('**/api/workspaces/markdown-editor/files**', async route => {
    const request = route.request();
    const method = request.method();
    const url = new URL(request.url());
    if (method === 'OPTIONS') return route.fulfill({ status: 204, headers: { ...headers, 'access-control-allow-methods': '*', 'access-control-allow-headers': '*' } });
    requests.push({ method, url: url.pathname });
    if (url.pathname.endsWith('/41/content')) {
      if (method === 'PUT') {
        storedMarkdown = request.postDataJSON().content;
        saves.push(storedMarkdown);
      }
      return route.fulfill({ json: { id: '41', name: '07_commercials.md', content: storedMarkdown, version: saves.length + 1, mimeType: 'text/markdown' }, headers });
    }
    if (url.pathname.endsWith('/42/content') || url.pathname.endsWith('/43/content')) {
      return route.fulfill({ json: { content: imageContent, mimeType: 'image/jpeg', isBase64: true }, headers });
    }
    if (method === 'POST' && url.pathname.endsWith('/files')) {
      return route.fulfill({ json: { id: '43', name: 'uploaded-photo.jpg', mimeType: 'image/jpeg' }, headers });
    }
    return route.fulfill({ status: 404, json: { error: 'Unexpected file request' }, headers });
  });
  await page.route('**/__markdown-editor', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html data-astryx-theme="neutral" data-theme="light"><head><script type="module">
    import RefreshRuntime from '/@react-refresh'; RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$=()=>{}; window.$RefreshSig$=()=>type=>type; window.__vite_plugin_react_preamble_installed__=true;
    </script><style>body{margin:0}.editor-harness{height:100vh;display:flex;flex-direction:column;background:var(--color-background-surface);color:var(--color-text-primary)}.editor-harness header{padding:12px 16px;display:flex;align-items:center;gap:12px;border-bottom:1px solid var(--color-border-subtle)}.editor-harness header strong{flex:1}.editor-workspace{display:flex;flex:1;min-height:0}.editor-files{width:220px;flex-shrink:0;border-right:1px solid var(--color-border-subtle);padding:10px}.editor-document{flex:1;min-width:0}@media(max-width:600px){.editor-files{display:none}.editor-harness header{padding:8px;gap:6px;flex-wrap:wrap}.editor-harness header strong{font-size:12px;flex-basis:100%}}</style></head><body><div id="root"></div><script type="module">
    import React from '/node_modules/.vite/deps/react.js'; import ReactDOM from '/node_modules/.vite/deps/react-dom_client.js';
    import {AppThemeRoot} from '/src/AppThemeRoot.tsx'; import FileEditor from '/src/components/FileEditor.tsx'; import FileRenderer from '/src/components/FileRenderer.tsx'; import WorkspaceFileTree from '/src/components/WorkspaceFileTree.tsx';
    import {Button} from '/node_modules/.vite/deps/@astryxdesign_core_Button.js'; import {applyColorModeToDocument} from '/src/colorMode.ts';
    import {getFileContent,updateFileContent} from '/src/services/fileApi.ts'; import '/src/index.css';
    const files=[{id:'41',name:'07_commercials.md',path:'07_commercials.md',mimeType:'text/markdown',version:1},{id:'42',name:'Project photo.jpg',path:'Project photo.jpg',mimeType:'image/jpeg',version:1}];
    window.markdownChanges=[];window.fileMoves=[];window.fileSelections=[];
    function Harness(){const [content,setContent]=React.useState(${JSON.stringify(initialMarkdown).replace(/</g, '\u003c')});const [mode,setMode]=React.useState('light');const [generation,setGeneration]=React.useState(0);const [dirty,setDirty]=React.useState(false);const [preview,setPreview]=React.useState(false);
      return React.createElement(AppThemeRoot,{},React.createElement('div',{className:'editor-harness'},
        React.createElement('header',{},React.createElement('strong',{},'07_commercials.md'),React.createElement(Button,{label:preview?'Edit file':'Preview file',variant:'secondary',size:'sm',onClick:()=>setPreview(value=>!value)}),React.createElement(Button,{label:'Toggle theme',variant:'tertiary',size:'sm',onClick:()=>{const next=mode==='light'?'dark':'light';applyColorModeToDocument(next);setMode(next)}}),React.createElement(Button,{label:'Reopen saved',variant:'secondary',size:'sm',onClick:async()=>{const saved=await getFileContent('markdown-editor','41');setContent(saved.content);setGeneration(n=>n+1);setDirty(false)}}),React.createElement(Button,{label:'Save',size:'sm',isDisabled:!dirty,onClick:async()=>{await updateFileContent('markdown-editor',41,content);setDirty(false)}})),
        React.createElement('div',{className:'editor-workspace'},React.createElement('aside',{className:'editor-files','aria-label':'Workspace files'},React.createElement(WorkspaceFileTree,{files,colorMode:mode,selectedFileId:'41',selectedFiles:new Set(),copiedPublicUrlFileId:null,isDraftWorkspaceFile:()=>false,onSelectFile:file=>window.fileSelections.push(file.id),onToggleFileSelection:()=>{},onCopyPublicUrl:()=>{},onRenameFile:()=>{},onRenameFolder:()=>{},onDeleteFile:()=>{},onDeleteFolder:()=>{},onMoveFiles:(items,destination)=>window.fileMoves.push({items,destination}),onMoveFolder:()=>{}})),
          React.createElement('main',{className:'editor-document'},preview?React.createElement('section',{'aria-label':'File preview'},React.createElement(FileRenderer,{file:files[0],fileContent:content,workspaceId:'markdown-editor'})):React.createElement(FileEditor,{key:generation,file:files[0],fileContent:content,onContentChange:value=>{window.markdownChanges.push(value);setContent(value);setDirty(true)},workspaceId:'markdown-editor',colorMode:mode})))));}
    ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(Harness));
    </script></body></html>` }));
  await page.goto('/__markdown-editor');
  return { saves, requests };
}

test('Markdown tables with HTML line breaks stay editable and preserve code examples after save', async ({ page, baseURL }, testInfo) => {
  test.skip(!baseURL?.startsWith('http://127.0.0.1:'), 'Requires local Vite');
  const { saves } = await setup(page, baseURL!);
  const editor = page.getByRole('textbox', { name: 'editable markdown', exact: true });
  await expect(editor.getByRole('table')).toBeVisible({ timeout: 30000 });
  await expect(page.getByText(/Error parsing markdown/)).toHaveCount(0);
  await expect(editor.getByRole('cell', { name: /Workshops.*Stakeholder interviews/ })).toBeVisible();
  await expect(editor.locator('td br')).toHaveCount(2);
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
  const paragraph = editor.getByText('Review the scope and investment below.', { exact: true });
  await paragraph.click();
  await page.keyboard.press('Home');
  await page.keyboard.type('Updated: ');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  expect(saves).toHaveLength(1);
  expect(saves[0]).toContain('Updated: Review the scope');
  expect(saves[0]).toMatch(/Workshops<br\s*\/?>Stakeholder interviews/);
  expect(saves[0]).toContain('```html\n<br>\n```');
  expect(saves[0]).toContain('`<br>`');
  await page.getByRole('button', { name: 'Reopen saved', exact: true }).click();
  await expect(editor.getByText('Updated: Review the scope and investment below.', { exact: true })).toBeVisible();
  await expect(editor.locator('td br')).toHaveCount(2);
  await page.getByRole('button', { name: 'Preview file', exact: true }).click();
  await expect(page.getByRole('region', { name: 'File preview', exact: true }).locator('td br')).toHaveCount(2);
  await page.getByRole('button', { name: 'Edit file', exact: true }).click();
  await expect(editor.getByRole('table')).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { markdownChanges: string[] }).markdownChanges.some(value => value === ''))).toBe(false);
  await page.screenshot({ path: testInfo.outputPath('markdown-editor-light.png'), fullPage: true });
  await page.getByRole('button', { name: 'Toggle theme', exact: true }).click();
  await expect(page.locator('.helpudoc-mdxeditor-dark').first()).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('markdown-editor-dark.png'), fullPage: true });
  await editor.getByText('Updated: Review the scope and investment below.', { exact: true }).click();
  await page.getByRole('combobox').first().click();
  await expect(page.getByRole('option', { name: 'Heading 1', exact: true })).toBeVisible();
  const darkStyles = await page.evaluate(() => {
    const selectors = ['.helpudoc-markdown-editor-shell', '.helpudoc-mdxeditor', '.mdxeditor-popup-container', '[role="listbox"]', '[role="option"]', '[role="combobox"]', '.cm-editor', '.cm-content', '.helpudoc-markdown-editor code'];
    return selectors.map(selector => {
      const element = document.querySelector(selector);
      if (!element) return { selector, missing: true };
      const styles = getComputedStyle(element);
      return { selector, className: element.className, background: styles.backgroundColor, color: styles.color,
        basePageBg: styles.getPropertyValue('--basePageBg'), surface: styles.getPropertyValue('--color-background-surface'), border: styles.getPropertyValue('--color-border'),
        theme: element.closest('[data-astryx-theme]')?.getAttribute('data-astryx-theme'), themes: document.querySelectorAll('[data-astryx-theme]').length,
        ancestors: Array.from((function* () { let parent: Element | null = element; while (parent) { yield { tag: parent.tagName, className: parent.className, attrs: Array.from(parent.attributes).filter(attr => attr.name.startsWith('data-')).map(attr => [attr.name, attr.value]) }; parent = parent.parentElement; } })()),
      };
    });
  });
  writeFileSync(testInfo.outputPath('markdown-dark-styles.json'), JSON.stringify(darkStyles, null, 2));
  for (const selector of ['[role="listbox"]', '.cm-editor', '.helpudoc-markdown-editor code']) {
    const styles = darkStyles.find(item => item.selector === selector)!;
    expect(styles.background, `${selector} uses a dark surface`).not.toBe('rgb(255, 255, 255)');
    expect(contrastRatio(styles.color!, styles.background!), `${selector} text contrast`).toBeGreaterThanOrEqual(4.5);
  }
  await page.screenshot({ path: testInfo.outputPath('markdown-editor-dark-menu.png'), fullPage: true });
  await page.keyboard.press('Escape');
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(editor.getByRole('table')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.getByRole('button', { name: 'Insert image', exact: true }).scrollIntoViewIfNeeded();
  await expect(page.getByRole('button', { name: 'Insert image', exact: true })).toBeInViewport();
  await page.screenshot({ path: testInfo.outputPath('markdown-editor-mobile.png'), fullPage: true });
});

test('Dragging a workspace photo inserts an embedded image without moving the source file', async ({ page, baseURL }, testInfo) => {
  test.skip(!baseURL?.startsWith('http://127.0.0.1:'), 'Requires local Vite');
  const { saves, requests } = await setup(page, baseURL!, '# Project overview\n\nDrop a project photo below.\n\nEnd of document.\n');
  const editor = page.getByRole('textbox', { name: 'editable markdown', exact: true });
  await expect(editor).toBeVisible();
  await page.locator('[draggable="true"][title="Project photo.jpg"]').dragTo(editor.getByText('End of document.', { exact: true }), { targetPosition: { x: 1, y: 10 } });
  const picture = editor.locator('img[src^="data:image/jpeg;base64,"]');
  await expect(picture).toBeVisible();
  expect(await picture.evaluate(element => (element as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
  expect(await page.evaluate(() => (window as unknown as { fileMoves: unknown[] }).fileMoves)).toEqual([]);
  expect(await page.evaluate(() => (window as unknown as { fileSelections: unknown[] }).fileSelections)).toEqual([]);
  await expect(page.getByRole('button', { name: 'Project photo.jpg', exact: true })).toBeVisible();
  expect(requests.filter(request => request.method === 'POST' || request.method === 'PATCH' || request.method === 'DELETE')).toEqual([]);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  expect(saves).toHaveLength(1);
  expect(saves[0]).toContain('data:image/jpeg;base64,');
  expect(saves[0]).not.toMatch(/(^|\n)42(\n|$)/);
  expect(saves[0]).toContain('End of document.');
  await page.getByRole('button', { name: 'Reopen saved', exact: true }).click();
  await expect(picture).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('markdown-workspace-photo.png'), fullPage: true });
  await page.getByRole('button', { name: 'Preview file', exact: true }).click();
  const previewImage = page.getByRole('region', { name: 'File preview', exact: true }).locator('img');
  await expect(previewImage).toHaveAttribute('src', /^data:image\/jpeg;base64,/);
  await expect.poll(() => previewImage.evaluate(element => (element as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
  await page.screenshot({ path: testInfo.outputPath('markdown-photo-preview.png'), fullPage: true });
});

test('Unsupported Markdown opens exact source without emitting blank content', async ({ page, baseURL }) => {
  test.skip(!baseURL?.startsWith('http://127.0.0.1:'), 'Requires local Vite');
  const source = '# Preserve this draft\n\n<Widget value={broken>\n\nUnclosed component and **valuable content**.\n';
  const { saves } = await setup(page, baseURL!, source);
  const sourceEditor = page.getByRole('textbox', { name: 'Markdown source', exact: true });
  await expect(sourceEditor).toBeVisible({ timeout: 30000 });
  await expect(sourceEditor).toHaveValue(source);
  expect(await page.evaluate(() => (window as unknown as { markdownChanges: string[] }).markdownChanges)).toEqual([]);
  await sourceEditor.fill(source + '\nAdded safely in source.\n');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  expect(saves).toEqual([source + '\nAdded safely in source.\n']);
  await page.getByRole('button', { name: 'Reopen saved', exact: true }).click();
  await expect(sourceEditor).toHaveValue(saves[0]);
});

test('Image picker and clipboard paste upload photos and retain them when reopened', async ({ page, baseURL }) => {
  test.skip(!baseURL?.startsWith('http://127.0.0.1:'), 'Requires local Vite');
  const { saves, requests } = await setup(page, baseURL!, '# Project photos\n\nKeep this description.\n');
  const editor = page.getByRole('textbox', { name: 'editable markdown', exact: true });
  await expect(editor).toBeVisible();
  await editor.getByText('Keep this description.', { exact: true }).click();
  const chooserPromise = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Insert image', exact: true }).click();
  await (await chooserPromise).setFiles({ name: 'uploaded-photo.jpg', mimeType: 'image/jpeg', buffer: imageBytes });
  const pictures = editor.locator('img[src^="data:image/jpeg;base64,"]');
  await expect(pictures).toHaveCount(1);
  await editor.getByText('Keep this description.', { exact: true }).click();
  await page.keyboard.press('End');
  const paste = await editor.evaluate((element, content) => {
    const bytes = Uint8Array.from(atob(content), char => char.charCodeAt(0));
    const clipboardData = new DataTransfer();
    clipboardData.items.add(new File([bytes], 'pasted-photo.jpg', { type: 'image/jpeg' }));
    const event = new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true });
    element.dispatchEvent(event);
    return { handled: event.defaultPrevented, files: clipboardData.files.length, contentEditable: (element as HTMLElement).contentEditable };
  }, imageContent);
  expect(paste).toMatchObject({ handled: true, files: 1, contentEditable: 'true' });
  await expect(pictures).toHaveCount(2);
  expect(requests.filter(request => request.method === 'POST' && request.url.endsWith('/files'))).toHaveLength(2);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  expect(saves).toHaveLength(1);
  expect(saves[0].match(/data:image\/jpeg;base64,/g)).toHaveLength(2);
  expect(saves[0].replace(/!\[[^\]]*\]\(data:image\/[^)]+\)/g, '')).toContain('Keep this description.');
  await page.getByRole('button', { name: 'Reopen saved', exact: true }).click();
  await expect(pictures).toHaveCount(2);
  expect(await pictures.evaluateAll(elements => elements.every(element => (element as HTMLImageElement).naturalWidth > 0))).toBe(true);
});

test('A failed workspace image fetch leaves the document and source file unchanged', async ({ page, baseURL }) => {
  test.skip(!baseURL?.startsWith('http://127.0.0.1:'), 'Requires local Vite');
  const original = '# Protected draft\n\nKeep every word here.\n';
  await setup(page, baseURL!, original);
  await page.route('**/api/workspaces/markdown-editor/files/42/content', route => route.fulfill({
    status: 403,
    headers: { 'access-control-allow-origin': baseURL!, 'access-control-allow-credentials': 'true' },
    json: { error: 'Image access is no longer available.' },
  }));
  const editor = page.getByRole('textbox', { name: 'editable markdown', exact: true });
  await expect(editor).toBeVisible();
  await page.locator('[draggable="true"][title="Project photo.jpg"]').dragTo(editor.getByText('Keep every word here.', { exact: true }));
  await expect(page.getByRole('alert')).toContainText('Failed to fetch file content');
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
  await expect(editor.locator('img')).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as { markdownChanges: string[] }).markdownChanges)).toEqual([]);
  expect(await page.evaluate(() => (window as unknown as { fileMoves: unknown[] }).fileMoves)).toEqual([]);
  await page.getByRole('button', { name: 'Markdown source', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Markdown source', exact: true })).toHaveValue(original);
});

test('Typing while an image loads keeps the new text and asks for a fresh insertion point', async ({ page, baseURL }) => {
  test.skip(!baseURL?.startsWith('http://127.0.0.1:'), 'Requires local Vite');
  await setup(page, baseURL!, '# Project notes\n\nKeep every word here.\n');
  let release: () => void = () => {};
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/workspaces/markdown-editor/files/42/content', async route => {
    await gate;
    await route.fulfill({ headers: { 'access-control-allow-origin': baseURL!, 'access-control-allow-credentials': 'true' }, json: { content: imageContent, mimeType: 'image/jpeg', isBase64: true } });
  });
  const editor = page.getByRole('textbox', { name: 'editable markdown', exact: true });
  await expect(editor).toBeVisible();
  try {
    await page.locator('[draggable="true"][title="Project photo.jpg"]').dragTo(editor.getByText('Keep every word here.', { exact: true }));
    await expect(page.getByText('Adding image…', { exact: true })).toBeVisible();
    await editor.getByText('Keep every word here.', { exact: true }).click();
    await page.keyboard.press('End');
    await page.keyboard.type(' Updated while loading.');
  } finally { release(); }
  await expect(page.getByRole('alert')).toContainText('The document changed while the image was loading.');
  await expect(editor.locator('img')).toHaveCount(0);
  await expect(editor).toContainText('Keep every word here. Updated while loading.');
  expect(await page.evaluate(() => (window as unknown as { fileMoves: unknown[] }).fileMoves)).toEqual([]);
});

test('Dragging a non-image file cannot insert its internal identifier into Markdown', async ({ page, baseURL }) => {
  test.skip(!baseURL?.startsWith('http://127.0.0.1:'), 'Requires local Vite');
  const original = '# Project notes\n\nKeep every word here.\n';
  await setup(page, baseURL!, original);
  const editor = page.getByRole('textbox', { name: 'editable markdown', exact: true });
  await expect(editor).toBeVisible();
  await page.locator('[draggable="true"][title="07_commercials.md"]').dragTo(editor.getByText('Keep every word here.', { exact: true }));
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
  expect(await page.evaluate(() => (window as unknown as { markdownChanges: string[] }).markdownChanges)).toEqual([]);
  // The native browser rejects a non-image move before drop. Also exercise the
  // editor's guard for a malformed internal image payload received from a pane.
  await editor.evaluate(element => {
    const dataTransfer = new DataTransfer();
    dataTransfer.setData('application/x-helpudoc-workspace-file-id', '41');
    dataTransfer.setData('application/x-helpudoc-workspace-image', '{bad-json');
    dataTransfer.setData('text/plain', '41');
    element.dispatchEvent(new DragEvent('drop', { dataTransfer, bubbles: true, cancelable: true }));
  });
  await expect(page.getByRole('alert')).toContainText('Choose a PNG, JPEG, GIF, or WebP image from Files.');
  expect(await page.evaluate(() => (window as unknown as { markdownChanges: string[] }).markdownChanges)).toEqual([]);
  await page.getByRole('button', { name: 'Markdown source', exact: true }).click();
  const sourceEditor = page.getByRole('textbox', { name: 'Markdown source', exact: true });
  await expect(sourceEditor).toHaveValue(original);
  await page.locator('[draggable="true"][title="Project photo.jpg"]').dragTo(sourceEditor);
  await expect(page.getByRole('alert')).toContainText('Switch to Write to insert an image.');
  await expect(sourceEditor).toHaveValue(original);
  expect(await page.evaluate(() => (window as unknown as { markdownChanges: string[] }).markdownChanges)).toEqual([]);
});
