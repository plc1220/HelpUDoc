import { expect, test } from '@playwright/test';

for (const mode of ['text', 'html', 'source']) {
  test(`canvas annotations: ${mode} selection, persistence, replies and agent context`, async ({ page, baseURL }) => {
    test.skip(!baseURL || !/^http:\/\/(localhost|127\.0\.0\.1):/.test(baseURL), 'Local Vite required');
    const filePath = mode === 'html' ? 'preview.html' : mode === 'source' ? 'notes.txt' : 'notes.md';
    const objects: Record<string, unknown>[] = [];
    const messages: Record<string, unknown>[] = [];
    await page.route('**/api/workspaces/qc/collaboration/objects**', async route => {
      const request = route.request();
      if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': baseURL!, 'access-control-allow-credentials': 'true', 'access-control-allow-methods': '*', 'access-control-allow-headers': '*' } });
      let result: unknown;
      if (request.method() === 'POST' && request.url().endsWith('/messages')) {
        const item = { id: 'reply1', authorName: 'Teammate', ...request.postDataJSON() }; messages.push(item); result = item;
      } else if (request.method() === 'POST') {
        const item = { id: 'annotation1', authorName: 'Reviewer', status: 'open', messageCount: 0, ...request.postDataJSON() }; objects.push(item); result = item;
      } else if (request.url().endsWith('/annotation1')) result = { object: objects[0], messages };
      else result = { objects };
      await route.fulfill({ json: result, headers: { 'access-control-allow-origin': baseURL!, 'access-control-allow-credentials': 'true' } });
    });
    await page.route('**/__annotations**', route => route.fulfill({ contentType: 'text/html', body: `<html data-astryx-theme="neutral" data-theme="light"><head><script type="module">
      import RefreshRuntime from '/@react-refresh'; RefreshRuntime.injectIntoGlobalHook(window);
      window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;
      </script></head><body><div id="root"></div><script type="module">
      import React from '/node_modules/.vite/deps/react.js';
      import ReactDOM from '/node_modules/.vite/deps/react-dom_client.js';
      import { AppThemeRoot } from '/src/AppThemeRoot.tsx';
      import CanvasAnnotations from '/src/components/CanvasAnnotations.tsx';
      import FileEditor from '/src/components/FileEditor.tsx';
      import WorkspaceHtmlPreviewFrame from '/src/components/WorkspaceHtmlPreviewFrame.tsx';
      import '/src/index.css';
      function Harness(){const [prompt,setPrompt]=React.useState('');const [content,setContent]=React.useState('Selected passage');return React.createElement('div',{},
        React.createElement('pre',{'data-testid':'prompt'},prompt),
        React.createElement('div',{style:{height:600}},React.createElement(CanvasAnnotations,{workspace:{id:'qc',visibility:'team',role:'owner'},filePath:'${filePath}',anchorVersionId:'anchor-fixture-uuid',fileId:101,onAgentChat:setPrompt},
          ${mode === 'source' ? "React.createElement(FileEditor,{file:{id:'101',name:'notes.txt'},fileContent:content,onContentChange:setContent,workspaceId:'qc',colorMode:'light'})" : mode === 'html' ? "React.createElement(WorkspaceHtmlPreviewFrame,{html:'<html><body style=\"background:white;color:black\"><h1 id=\"title\">Selected passage</h1></body></html>',title:'Preview',className:'w-full h-full'})" : "React.createElement('p',{'data-testid':'passage'},'Selected passage')"}
        )));}
      ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(AppThemeRoot,{},React.createElement(Harness)));
      </script></body></html>` }));
    await page.goto('/__annotations');
    await page.getByRole('button', { name: 'Annotate', exact: true }).click();
    if (mode === 'html') await page.frameLocator('iframe').locator('#title').click();
    else if (mode === 'source') {
      await expect(page.getByRole('textbox', { name: 'Editor content' })).toBeVisible();
      const passage = page.locator('.view-line').getByText('Selected passage', { exact: true });
      await expect(passage).toBeVisible();
      const bounds = (await passage.boundingBox())!;
      // Exercise Monaco's actual pointer selection and mouse-up handling. A
      // synthetic mouse-up after Select All can race the editor's selection update.
      await page.mouse.move(bounds.x + 1, bounds.y + bounds.height / 2);
      await page.mouse.down();
      await page.mouse.move(bounds.x + bounds.width + 4, bounds.y + bounds.height / 2, { steps: 10 });
      await page.mouse.up();
    } else {
      await page.getByTestId('passage').evaluate(el => { const range = document.createRange(); range.selectNodeContents(el); const selection = window.getSelection(); selection?.removeAllRanges(); selection?.addRange(range); el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })); });
    }
    await page.getByRole('textbox', { name: 'Annotation comment' }).fill('Please clarify this passage');
    await page.getByRole('button', { name: 'Post comment', exact: true }).click();
    await expect(page.getByText('Please clarify this passage', { exact: true })).toBeVisible();
    expect(objects[0].filePath).toBe(filePath);
    expect(objects[0].anchorText).toBe('Selected passage');
    if (mode === 'html') expect(objects[0].blockId).toBe('#title');
    else expect(objects[0].anchorStart).toBe(0);
    await page.getByRole('textbox', { name: 'Reply to annotation' }).fill('Add a source too');
    await page.getByRole('button', { name: 'Reply', exact: true }).click();
    await expect(page.getByText('Add a source too', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Add to agent chat' }).click();
    await expect(page.getByTestId('prompt')).toContainText('Please clarify this passage');
    await expect(page.getByTestId('prompt')).toContainText('Add a source too');
    await page.reload();
    if (mode === 'html') await page.frameLocator('iframe').getByRole('button', { name: 'Open annotation 1' }).click();
    else if (mode === 'source') {
      await expect(page.locator('.canvas-annotation-highlight').first()).toBeVisible();
      await page.locator('.canvas-annotation-highlight').first().click();
    } else await page.getByRole('button', { name: 'Open annotation', exact: true }).first().click();
    await expect(page.getByText('Please clarify this passage', { exact: true })).toBeVisible();
    await page.goto('/__annotations?annotationId=annotation1');
    await expect(page.getByText('Please clarify this passage', { exact: true })).toBeVisible();
    await page.screenshot({ path: test.info().outputPath(`${mode}-annotation.png`) });
    const panel = page.getByRole('complementary', { name: 'Canvas comments' });
    const lightBackground = await panel.evaluate(el => getComputedStyle(el).backgroundColor);
    await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; document.documentElement.style.colorScheme = 'dark'; window.dispatchEvent(new CustomEvent('helpudoc-color-mode-change', {detail:'dark'})); });
    await expect.poll(() => panel.evaluate(el => getComputedStyle(el).backgroundColor)).not.toBe(lightBackground);
    await expect.poll(() => page.getByRole('button', {name:'All comments', exact:true}).evaluate(el => getComputedStyle(el).color)).toBe('rgb(250, 250, 250)');
    await page.screenshot({ path: test.info().outputPath(`${mode}-annotation-dark.png`) });
  });
}
