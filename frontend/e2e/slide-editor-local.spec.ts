import { expect, test } from '@playwright/test';

// Runs against a local Vite server; no production login, file mutation, or AI call.
test('HTML source editing supports replace, undo, find, and file isolation', async ({ page, baseURL }) => {
  test.skip(!baseURL || !/^http:\/\/(localhost|127\.0\.0\.1):/.test(baseURL), 'Local Vite server required');
  const requests: string[] = [];
  page.on('request', request => requests.push(request.url()));
  await page.route('**/__slide-editor-qc', route => route.fulfill({
    contentType: 'text/html',
    body: `<html><head><script type="module">
      import RefreshRuntime from '/@react-refresh';
      RefreshRuntime.injectIntoGlobalHook(window);
      window.$RefreshReg$ = () => {};
      window.$RefreshSig$ = () => type => type;
      window.__vite_plugin_react_preamble_installed__ = true;
    </script></head><body><div id="root"></div><script type="module">
      import React from '/node_modules/.vite/deps/react.js';
      import ReactDOM from '/node_modules/.vite/deps/react-dom_client.js';
      import FileEditor from '/src/components/FileEditor.tsx';
      import '/src/index.css';
      function Harness() {
        const [content, setContent] = React.useState('<section class="slide">Original title</section>');
        const [id, setId] = React.useState('draft:first');
        return React.createElement('div', {},
          React.createElement('button', {onClick: () => { setId('draft:second'); setContent('<section>Second file</section>'); }}, 'Switch file'),
          React.createElement('pre', {'data-testid':'content'}, content),
          React.createElement('div', {style:{height:500,width:'100%'}}, React.createElement(FileEditor, {
            file:{id,name:'qc.html'}, fileContent:content, onContentChange:setContent, workspaceId:'qc', colorMode:'light'
          })));
      }
      ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(Harness));
    </script></body></html>`,
  }));
  const started = Date.now();
  await page.goto('/__slide-editor-qc');
  const input = page.getByRole('textbox', { name: 'Editor content' });
  await expect(input).toBeVisible({ timeout: 30000 });
  await test.info().attach('editor-ready-ms', { body: String(Date.now() - started), contentType: 'text/plain' });
  await page.locator('.view-lines').click({ position: { x: 20, y: 10 } });
  // Playwright's Desktop Chrome profile can advertise Windows on a macOS host.
  // Match Monaco's browser platform, rather than Playwright's host OS mapping.
  const selectAll = await page.evaluate(() => /Macintosh/.test(navigator.userAgent) ? 'Meta+a' : 'Control+a');
  await page.keyboard.press(selectAll);
  await page.keyboard.press('Backspace');
  await expect(page.getByTestId('content')).toHaveText('');
  await page.keyboard.insertText('<section class="slide">Updated title</section>');
  await expect(page.getByTestId('content')).toHaveText('<section class="slide">Updated title</section>');
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(page.getByTestId('content')).not.toHaveText('<section class="slide">Updated title</section>');
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await expect(page.getByTestId('content')).toHaveText('<section class="slide">Updated title</section>');
  await page.getByRole('button', { name: 'Find', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Find', exact: true })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 750 });
  await page.getByRole('button', { name: 'Switch file', exact: true }).click();
  await expect(page.getByTestId('content')).toHaveText('<section>Second file</section>');
  await expect(input).toBeVisible();
  expect(requests.some(url => /cdn\.jsdelivr\.net/.test(url))).toBe(false);
  expect(requests.some(url => url.includes('/src/components/FileRenderer.tsx'))).toBe(false);
  await page.screenshot({ path: test.info().outputPath('narrow-editor.png') });
});
