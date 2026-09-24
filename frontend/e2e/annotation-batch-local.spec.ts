import { expect, test, type Page } from '@playwright/test';

type Thread = { id: string; body: string; anchorText: string; anchorStart: number; anchorEnd: number; visibility: string; authorName: string; status: string; messageCount: number; filePath: string; type: string; workspaceId: string };

async function setup(page: Page, baseURL: string, role = 'owner', visibility = 'private') {
  const objects: Thread[] = ['First', 'Second', 'Third'].map((name, index) => ({
    id: `comment-${index + 1}`, body: `${name} review note`, anchorText: `${name} passage`, anchorStart: index * 14, anchorEnd: index * 14 + 13,
    visibility: visibility === 'team' ? 'workspace_audience' : 'private', authorName: 'Reviewer', status: 'open', messageCount: 1,
    filePath: 'review.md', type: 'annotation', workspaceId: 'personal',
  }));
  const state = { failedThread: '', detailRequests: [] as string[], detailGate: null as Promise<void> | null };
  await page.route('**/api/workspaces/personal/collaboration/objects**', async route => {
    const request = route.request();
    const headers = { 'access-control-allow-origin': baseURL, 'access-control-allow-credentials': 'true' };
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { ...headers, 'access-control-allow-methods': '*', 'access-control-allow-headers': '*' } });
    const id = request.url().split('/').pop()!;
    if (request.method() === 'POST') {
      const item = { ...objects[0], ...request.postDataJSON(), id: 'new-comment', messageCount: 0 };
      objects.push(item);
      return route.fulfill({ json: item, headers });
    }
    if (id === 'objects') return route.fulfill({ json: { objects }, headers });
    state.detailRequests.push(id);
    if (state.detailGate) await state.detailGate;
    if (state.failedThread === id) return route.fulfill({ status: 403, json: { error: 'This comment is no longer accessible.' }, headers });
    return route.fulfill({ json: { object: objects.find(object => object.id === id), messages: [{ id: `reply-${id}`, authorName: 'Teammate', body: `Full latest reply for ${id}`, createdAt: '2026-09-16T00:00:00Z' }] }, headers });
  });
  await page.route('**/__annotation-batch', route => route.fulfill({ contentType: 'text/html', body: `<html data-astryx-theme="neutral" data-theme="light"><head><script type="module">
    import RefreshRuntime from '/@react-refresh'; RefreshRuntime.injectIntoGlobalHook(window);
    window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;
    </script></head><body><div id="root"></div><script type="module">
    import React from '/node_modules/.vite/deps/react.js';
    import ReactDOM from '/node_modules/.vite/deps/react-dom_client.js';
    import { AppThemeRoot } from '/src/AppThemeRoot.tsx';
    import CanvasAnnotations from '/src/components/CanvasAnnotations.tsx';
    import '/src/index.css';
    function Harness(){const [prompt,setPrompt]=React.useState('');const [draft,setDraft]=React.useState('');return React.createElement(AppThemeRoot,{},
      React.createElement('input',{'aria-label':'Agent chat draft',value:draft,onChange:event=>setDraft(event.target.value)}),
      React.createElement('pre',{'data-testid':'prompt',style:{maxHeight:80,overflow:'auto',fontSize:11}},prompt),
      React.createElement('div',{style:{height:640}},React.createElement(CanvasAnnotations,{workspace:{id:'personal',visibility:'${visibility}',role:'${role}'},filePath:'review.md',onAgentChat:next=>setPrompt(draft?draft+'\\n\\n'+next:next)},
        React.createElement('p',{'data-testid':'passage'},'First passage Second passage Third passage'))));}
    ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(Harness));
    </script></body></html>` }));
  await page.goto('/__annotation-batch');
  await expect(page.getByRole('button', { name: 'Comments (3)', exact: true })).toBeVisible();
  return { objects, state };
}

test('personal workspace annotations support private comments and multiple complete threads in one agent draft', async ({ page, baseURL }) => {
  test.skip(!baseURL || !/^http:\/\/(localhost|127\.0\.0\.1):/.test(baseURL), 'Local Vite required');
  const { objects, state } = await setup(page, baseURL!);
  await page.getByRole('button', { name: 'Annotate', exact: true }).click();
  await page.getByTestId('passage').evaluate(el => {
    const range = document.createRange(); range.selectNodeContents(el);
    const selection = window.getSelection(); selection?.removeAllRanges(); selection?.addRange(range);
    el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  });
  await expect(page.getByText('Private comment. Only you can see this thread.', { exact: true })).toBeVisible();
  await page.getByRole('textbox', { name: 'Annotation comment' }).fill('My personal annotation');
  await page.getByRole('button', { name: 'Post comment', exact: true }).click();
  await expect(page.getByText('My personal annotation', { exact: true })).toBeVisible();
  expect(objects.at(-1)?.visibility).toBe('private');
  await page.getByRole('button', { name: 'All comments', exact: true }).click();
  await page.getByRole('checkbox', { name: 'Select comment 1: First review note', exact: true }).check();
  await page.getByRole('checkbox', { name: 'Select comment 3: Third review note', exact: true }).check();
  await expect(page.getByText('2 selected', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Add 2 comments to agent chat', exact: true }).click();
  await expect(page.getByTestId('prompt')).toContainText('2 canvas annotations together');
  const prompt = await page.getByTestId('prompt').textContent();
  const context = JSON.parse(prompt!.slice(prompt!.indexOf('{')));
  expect(context.annotations.map((item: { id: string }) => item.id)).toEqual(['comment-1', 'comment-3']);
  expect(context.annotations[0]).toMatchObject({ filePath: 'review.md', selection: 'First passage', start: 0, end: 13 });
  expect(context.annotations[1].replies[0].comment).toBe('Full latest reply for comment-3');
  expect(state.detailRequests).toEqual(expect.arrayContaining(['comment-1', 'comment-3']));
  await expect(page.getByText('2 comments added to the agent chat draft. Review it before sending.', { exact: true })).toBeVisible();
  await page.getByRole('checkbox', { name: 'Select all comments', exact: true }).check();
  await expect(page.getByText('4 selected', { exact: true })).toBeVisible();
  await page.getByRole('checkbox', { name: 'Select all comments', exact: true }).uncheck();
  await expect(page.getByRole('button', { name: 'Add comments to agent chat', exact: true })).toBeDisabled();
});

test('failed thread fetch keeps the batch selected and never drafts incomplete context', async ({ page, baseURL }) => {
  test.skip(!baseURL || !/^http:\/\/(localhost|127\.0\.0\.1):/.test(baseURL), 'Local Vite required');
  const { state } = await setup(page, baseURL!, 'viewer', 'team');
  await expect(page.getByRole('button', { name: 'Annotate', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Comments (3)', exact: true }).click();
  await page.getByRole('checkbox', { name: 'Select all comments', exact: true }).check();
  state.failedThread = 'comment-2';
  await page.getByRole('button', { name: 'Add 3 comments to agent chat', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('This comment is no longer accessible.');
  await expect(page.getByTestId('prompt')).toBeEmpty();
  await expect(page.getByText('3 selected', { exact: true })).toBeVisible();
  state.failedThread = '';
  await page.getByRole('button', { name: 'Add 3 comments to agent chat', exact: true }).click();
  await expect(page.getByTestId('prompt')).toContainText('3 canvas annotations together');
  await page.screenshot({ path: test.info().outputPath('annotation-batch-light.png'), animations: 'disabled' });
  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; document.documentElement.style.colorScheme = 'dark'; window.dispatchEvent(new CustomEvent('helpudoc-color-mode-change', { detail: 'dark' })); });
  await page.screenshot({ path: test.info().outputPath('annotation-batch-dark.png'), animations: 'disabled' });
});

test('annotation batch preserves agent composer edits typed while replies are loading', async ({ page, baseURL }) => {
  test.skip(!baseURL || !/^http:\/\/(localhost|127\.0\.0\.1):/.test(baseURL), 'Local Vite required');
  const { state } = await setup(page, baseURL!);
  let release: () => void = () => {};
  state.detailGate = new Promise<void>(resolve => { release = resolve; });
  await page.getByRole('button', { name: 'Comments (3)', exact: true }).click();
  await page.getByRole('checkbox', { name: 'Select all comments', exact: true }).check();
  await page.getByRole('button', { name: 'Add 3 comments to agent chat', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Adding comments…', exact: true })).toBeDisabled();
  await page.getByRole('textbox', { name: 'Agent chat draft', exact: true }).fill('Preserve this request typed while loading.');
  release();
  await expect(page.getByTestId('prompt')).toContainText('Preserve this request typed while loading.');
  await expect(page.getByTestId('prompt')).toContainText('3 canvas annotations together');
});
