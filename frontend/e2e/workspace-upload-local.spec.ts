import { test, expect, type Page } from '@playwright/test';

type DropItem = { name: string; body?: string; children?: DropItem[]; unreadable?: boolean };

async function drop(page: Page, selector: string, items: DropItem[]) {
  await page.locator(selector).evaluate((target, payload) => {
    const transfer = new DataTransfer();
    const makeEntry = (item: DropItem): unknown => ({
      name: item.name,
      isDirectory: Boolean(item.children),
      file: (done: (file: File) => void, fail: (error: Error) => void) =>
        item.unreadable
          ? fail(new Error('Cannot read file'))
          : done(new File([item.body ?? item.name], item.name)),
      createReader: () => {
        let offset = 0;
        return {
          readEntries: (done: (entries: unknown[]) => void) => {
            const entries = (item.children || []).slice(offset, offset + 100).map(makeEntry);
            offset += 100;
            done(entries);
          },
        };
      },
    });
    const entries = new Map(payload.map((item) => [item.name, makeEntry(item)]));
    for (const item of payload) transfer.items.add(new File([item.body ?? item.name], item.name));
    // Browser item wrappers are recreated when iterating DataTransfer.items.
    const original = DataTransferItem.prototype.webkitGetAsEntry;
    DataTransferItem.prototype.webkitGetAsEntry = function () {
      return entries.get(this.getAsFile()?.name || '') as FileSystemEntry;
    };
    try {
      target.dispatchEvent(
        new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: transfer }),
      );
      target.dispatchEvent(
        new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }),
      );
    } finally {
      DataTransferItem.prototype.webkitGetAsEntry = original;
    }
  }, items);
}

async function setup(page: Page) {
  const calls: { method: string; path: string; body: string }[] = [];
  const files = [{ id: '1', name: 'old.txt', version: 1, mimeType: 'text/plain' }];
  const folders = ['Reports', 'target'];
  let failFile = '';
  let holdUpload: (() => void) | undefined;
  let hold = false;
  await page.route('**/api/workspaces/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() === 'GET')
      return route.fulfill({ json: path.endsWith('/folders') ? { folders } : files });
    calls.push({ method: request.method(), path, body: request.postData() || '' });
    if (path.endsWith('/folders')) {
      const folder = request.postDataJSON().path;
      if (!folders.includes(folder)) folders.push(folder);
      return route.fulfill({ status: 201, json: { path: folder } });
    }
    const body = request.postData() || '';
    const destination = /name="path"\r\n\r\n([^\r]+)/.exec(body)?.[1] || '';
    if (hold) {
      hold = false;
      await new Promise<void>((resolve) => {
        holdUpload = resolve;
      });
    }
    if (destination.endsWith(failFile) && failFile)
      return route.fulfill({ status: 409, json: { error: 'Test upload failure' } });
    const saved = {
      id: String(files.length + 1),
      name: destination,
      version: 1,
      mimeType: 'text/plain',
    };
    files.push(saved);
    return route.fulfill({ status: 201, json: saved });
  });
  await page.route('**/__workspace-upload', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: `<!doctype html><html><head><script type="module">import RefreshRuntime from '/@react-refresh';RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;</script></head><body><div id="root"></div><script type="module">
    import React from '/node_modules/.vite/deps/react.js';import ReactDOM from '/node_modules/.vite/deps/react-dom_client.js';
    import {AppThemeRoot} from '/src/AppThemeRoot.tsx';import DropZone from '/src/components/WorkspaceFileDropZone.tsx';import Tree from '/src/components/WorkspaceFileTree.tsx';import {getFiles,getFolders} from '/src/services/fileApi.ts';import '/src/index.css';
    window.moves=[];window.folderMoves=[];
    function Fixture(){const [id,setId]=React.useState('upload-one');const [readOnly,setReadOnly]=React.useState(false);const [files,setFiles]=React.useState(${JSON.stringify(files)});const [folders,setFolders]=React.useState(${JSON.stringify(folders)});
      return React.createElement(AppThemeRoot,{},React.createElement('button',{onClick:()=>setReadOnly(value=>!value)},'Toggle read-only'),React.createElement('button',{onClick:()=>setId('upload-two')},'Switch workspace'),React.createElement('div',{style:{width:460,height:650}},React.createElement(DropZone,{key:id,workspaceId:id,readOnly,onUploaded:async workspaceId=>{const [f,d]=await Promise.all([getFiles(workspaceId),getFolders(workspaceId)]);setFiles(f);setFolders(d);}},target=>React.createElement(Tree,{files,folderPaths:folders,colorMode:'light',readOnly,uploadDropTargetPath:target,selectedFileId:null,selectedFiles:new Set(),copiedPublicUrlFileId:null,isDraftWorkspaceFile:()=>false,onSelectFile:()=>{},onToggleFileSelection:()=>{},onCopyPublicUrl:()=>{},onRenameFile:()=>{},onRenameFolder:()=>{},onDeleteFile:()=>{},onDeleteFolder:()=>{},onMoveFiles:(items,destination)=>window.moves.push({items:items.map(item=>item.id),destination}),onMoveFolder:(source,destination)=>window.folderMoves.push({source:source.path,destination})}))));}
    ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(Fixture));
    </script></body></html>`,
    }),
  );
  await page.goto('/__workspace-upload');
  await expect(page.locator('[data-workspace-upload-zone]')).toBeVisible();
  return {
    calls,
    files,
    folders,
    fail: (name: string) => {
      failFile = name;
    },
    hold: () => {
      hold = true;
    },
    release: () => holdUpload?.(),
  };
}

test.beforeEach(async ({ baseURL }) => {
  test.skip(!baseURL?.startsWith('http://127.0.0.1:'), 'Local Vite only; never targets production');
});

test('multiple files upload to root and direct folder drops upload only once', async ({ page }) => {
  const state = await setup(page);
  await drop(page, '[data-workspace-upload-zone]', [
    { name: 'first.txt', body: 'FIRST' },
    { name: 'second.txt' },
  ]);
  await expect(page.getByRole('status')).toContainText('Uploaded 2 files');
  await drop(page, '[data-workspace-folder-path="target"] > div', [{ name: 'inside.txt' }]);
  await expect(page.getByRole('status')).toContainText('Uploaded 1 file');
  expect(state.files.map((file) => file.name)).toEqual([
    'old.txt',
    'first.txt',
    'second.txt',
    'target/inside.txt',
  ]);
  expect(state.calls).toHaveLength(3);
});

test('external drag highlights its destination, clears on exit, and ignores plain text', async ({
  page,
}) => {
  const state = await setup(page);
  const target = page.locator('[data-workspace-folder-path="target"] > div').first();
  await target.evaluate((element) => {
    const transfer = new DataTransfer();
    transfer.items.add(new File(['test'], 'test.txt'));
    element.dispatchEvent(
      new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: transfer }),
    );
  });
  await expect(page.getByText('Drop to upload into target', { exact: true })).toBeVisible();
  await page
    .locator('[data-workspace-upload-zone]')
    .dispatchEvent('dragleave', { relatedTarget: null });
  await expect(page.getByText('Drop to upload into target', { exact: true })).toHaveCount(0);
  await target.evaluate((element) => {
    const transfer = new DataTransfer();
    transfer.setData('text/plain', 'ordinary text');
    element.dispatchEvent(
      new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }),
    );
  });
  expect(state.calls).toHaveLength(0);
  await expect(page.getByRole('status')).toHaveCount(0);
});

test('drop highlight remains translucent and its label is readable in both themes', async ({
  page,
}, info) => {
  await setup(page);
  for (const mode of ['light', 'dark']) {
    await page.evaluate((value) => {
      document.documentElement.dataset.astryxTheme = 'neutral';
      document.documentElement.dataset.theme = value;
    }, mode);
    await page.locator('[data-workspace-upload-zone]').evaluate((element) => {
      const transfer = new DataTransfer();
      transfer.items.add(new File(['test'], 'test.txt'));
      element.dispatchEvent(
        new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: transfer }),
      );
    });
    const colours = await page.locator('[data-workspace-upload-overlay]').evaluate((element) => {
      const label = element.querySelector('[data-workspace-upload-label]')!;
      const pixel = (colour: string) => {
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = 1;
        const context = canvas.getContext('2d')!;
        context.fillStyle = colour;
        context.fillRect(0, 0, 1, 1);
        return Array.from(context.getImageData(0, 0, 1, 1).data);
      };
      const luminance = (rgba: number[]) => {
        const linear = rgba.slice(0, 3).map((value) => {
          const s = value / 255;
          return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
        });
        return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
      };
      const style = getComputedStyle(label);
      const foreground = luminance(pixel(style.color)),
        background = luminance(pixel(style.backgroundColor));
      return {
        contrast:
          (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05),
        overlayAlpha: pixel(getComputedStyle(element).backgroundColor)[3] / 255,
      };
    });
    expect(colours.contrast, `${mode} label contrast`).toBeGreaterThanOrEqual(4.5);
    expect(colours.overlayAlpha, `${mode} overlay must not obscure the file list`).toBeGreaterThan(
      0,
    );
    expect(colours.overlayAlpha).toBeLessThanOrEqual(0.2);
    await page.screenshot({
      path: info.outputPath(`drop-highlight-${mode}.png`),
      animations: 'disabled',
    });
  }
});

test('nested folder drops read beyond 100 entries, preserve empty folders, and show errors', async ({
  page,
}) => {
  const state = await setup(page);
  state.fail('bad.txt');
  await drop(page, '[data-workspace-upload-zone]', [
    {
      name: 'Folder',
      children: [
        ...Array.from({ length: 101 }, (_, i) => ({ name: `item-${i}.txt` })),
        { name: 'empty', children: [] },
        { name: 'nested', children: [{ name: '日本語.txt' }] },
        { name: 'bad.txt' },
      ],
    },
  ]);
  await expect(page.getByRole('status')).toContainText('Uploaded 102 files', { timeout: 30000 });
  await expect(page.getByRole('alert')).toContainText('Folder/bad.txt: Test upload failure');
  expect(state.folders).toContain('Folder/empty');
  expect(state.files.some((file) => file.name === 'Folder/nested/日本語.txt')).toBe(true);
});

test('folder conflicts require confirmation, cancel writes nothing, and copy preserves structure', async ({
  page,
}) => {
  const state = await setup(page);
  const items = [{ name: 'Reports', children: [{ name: 'note.txt' }] }];
  await drop(page, '[data-workspace-upload-zone]', items);
  await expect(page.getByRole('dialog', { name: 'Folders already exist' })).toBeVisible();
  expect(state.calls).toHaveLength(0);
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('Upload cancelled.');
  expect(state.calls).toHaveLength(0);
  await drop(page, '[data-workspace-upload-zone]', items);
  await page.getByRole('button', { name: 'Upload', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Uploaded 1 file');
  expect(state.files.at(-1)?.name).toBe('Reports (2)/note.txt');
});

test('explicit merge uploads inside the existing folder', async ({ page }) => {
  const state = await setup(page);
  await drop(page, '[data-workspace-upload-zone]', [
    { name: 'Reports', children: [{ name: 'merged.txt' }] },
  ]);
  await page.getByRole('combobox', { name: 'Upload choice for Reports' }).selectOption('merge');
  await page.getByRole('button', { name: 'Upload', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Uploaded 1 file');
  expect(state.files.at(-1)?.name).toBe('Reports/merged.txt');
});

test('read-only drops are blocked and ordinary internal drags remain moves', async ({ page }) => {
  const state = await setup(page);
  await page.getByRole('button', { name: 'Toggle read-only' }).click();
  await drop(page, '[data-workspace-folder-path="target"] > div', [{ name: 'forbidden.txt' }]);
  await expect(page.getByRole('alert')).toContainText('read-only');
  expect(state.calls).toHaveLength(0);
  await page.getByRole('button', { name: 'Toggle read-only' }).click();
  await page
    .locator('[data-workspace-file-id="1"]')
    .dragTo(page.locator('[data-workspace-folder-path="target"] > div').first());
  expect(await page.evaluate(() => (window as unknown as { moves: unknown[] }).moves)).toEqual([
    { items: ['1'], destination: 'target' },
  ]);
  await page
    .locator('[data-workspace-folder-path="Reports"] > div[draggable="true"]')
    .dragTo(page.locator('[data-workspace-folder-path="target"] > div').first());
  expect(
    await page.evaluate(() => (window as unknown as { folderMoves: unknown[] }).folderMoves),
  ).toEqual([{ source: 'Reports', destination: 'target' }]);
  expect(state.calls).toHaveLength(0);
});

test('workspace switch cancels a pending confirmation before writes', async ({ page }) => {
  const state = await setup(page);
  await drop(page, '[data-workspace-upload-zone]', [
    { name: 'Reports', children: [{ name: 'never.txt' }] },
  ]);
  await expect(page.getByRole('dialog')).toBeVisible();
  // Simulate navigation while the modal is open (for example browser history).
  await page
    .locator('button')
    .filter({ hasText: 'Switch workspace' })
    .evaluate((button) => (button as HTMLButtonElement).click());
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(state.calls).toHaveLength(0);
});

test('an upload already started finishes in its original workspace after switching', async ({
  page,
}) => {
  const state = await setup(page);
  state.hold();
  await drop(page, '[data-workspace-upload-zone]', [{ name: 'one.txt' }, { name: 'two.txt' }]);
  await expect.poll(() => state.calls.length).toBe(1);
  await page.getByRole('button', { name: 'Switch workspace' }).click();
  state.release();
  await expect.poll(() => state.calls.length).toBe(2);
  expect(state.calls.every((call) => call.path.includes('/upload-one/'))).toBe(true);
  await expect(page.getByRole('status')).toHaveCount(0);
});

test('a file sharing a folder name gets a separate filename', async ({ page }) => {
  const state = await setup(page);
  await drop(page, '[data-workspace-upload-zone]', [
    { name: 'Reports', body: 'A standalone file' },
  ]);
  await expect(page.getByRole('status')).toContainText('Uploaded 1 file');
  expect(state.files.at(-1)?.name).toBe('Reports (2)');
  expect(state.folders).toContain('Reports');
});

test('failed destination checks do not create files or folders', async ({ page }) => {
  const state = await setup(page);
  await page.route('**/api/workspaces/upload-one/files/folders', (route) =>
    route.fulfill({ status: 503, json: { error: 'Unavailable' } }),
  );
  await drop(page, '[data-workspace-upload-zone]', [
    { name: 'new-folder', children: [{ name: 'file.txt' }] },
  ]);
  await expect(page.getByRole('alert')).toContainText('Failed to fetch folders');
  expect(state.calls).toHaveLength(0);
});

test('losing edit access during confirmation prevents uploads', async ({ page }) => {
  const state = await setup(page);
  await drop(page, '[data-workspace-upload-zone]', [
    { name: 'Reports', children: [{ name: 'file.txt' }] },
  ]);
  await expect(page.getByRole('dialog')).toBeVisible();
  await page
    .locator('button')
    .filter({ hasText: 'Toggle read-only' })
    .evaluate((button) => (button as HTMLButtonElement).click());
  await page.getByRole('button', { name: 'Upload', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('read-only');
  expect(state.calls).toHaveLength(0);
});

test('dropping twice during an upload does not start a second batch', async ({ page }) => {
  const state = await setup(page);
  state.hold();
  await drop(page, '[data-workspace-upload-zone]', [{ name: 'first.txt' }]);
  await expect.poll(() => state.calls.length).toBe(1);
  try {
    await drop(page, '[data-workspace-upload-zone]', [{ name: 'second.txt' }]);
    await expect(page.getByRole('alert')).toContainText('already in progress');
    expect(state.calls).toHaveLength(1);
  } finally {
    state.release();
  }
  await expect(page.getByRole('status')).toContainText('Uploaded 1 file');
  expect(state.files.some((file) => file.name === 'second.txt')).toBe(false);
});
