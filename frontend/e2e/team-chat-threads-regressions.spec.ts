import { expect, test, type Route } from '@playwright/test';

/**
 * Permanent regressions for two independently-confirmed defects in the real
 * Release A components:
 *  1. Composer must not clear a NEW destination's draft when a slow send for a
 *     PREVIOUS destination resolves (stale-clear).
 *  2. TeamThreadList: a remotely-resolved older row must disappear on refresh
 *     (no retain-forever under a filter), and a concurrent refresh must not
 *     strand loadMore's loading flag.
 *
 * Both mount the ACTUAL production components via inline modules that reuse the
 * dev server's optimized React (extracted from an existing fixture), matching
 * the independent probe methodology.
 */

const BASE = 'http://127.0.0.1:5179';
const only = (baseURL?: string) => !baseURL || !/^http:\/\/(localhost|127\.0\.0\.1):/.test(baseURL);

async function reactDeps() {
  const source = await (await fetch(`${BASE}/e2e/fixtures/team-chat-composer.tsx`)).text();
  const react = source.match(/from "([^"]*\/react\.js\?[^"]*)"/)![1];
  const dom = source.match(/from "([^"]*\/react-dom_client\.js\?[^"]*)"/)![1];
  return { react, dom };
}

test.describe('Release A regressions (real components)', () => {
  test.beforeEach(async ({ baseURL }) => {
    test.skip(only(baseURL), 'Local Vite required at 127.0.0.1:5179');
  });

  test('composer: a slow send for A does not wipe a draft the user started for B', async ({ page }) => {
    const { react, dom } = await reactDeps();
    const fixture = `import React from ${JSON.stringify(react)};import RD from ${JSON.stringify(dom)};import C from '/src/components/chat/TeamChatComposer.tsx';
      function Fixture(){
        const [key,setKey]=React.useState('A');
        const [drafts,setDrafts]=React.useState({A:{text:'A request',tokens:[]},B:{text:'B unsent draft',tokens:[]}});
        return React.createElement('main',{},
          React.createElement('button',{onClick:()=>setKey('B')},'Switch B'),
          React.createElement(C,{draftKey:key,value:drafts[key],onDraftChange:d=>setDrafts(o=>({...o,[key]:d})),disabled:false,sending:false,reply:false,options:[],onSend:()=>new Promise(r=>{window.releaseSend=r;})}));
      }
      RD.createRoot(document.getElementById('root')).render(React.createElement(Fixture));`;
    await page.route('**/e2e/fixtures/team-chat-composer.tsx*', (route: Route) => route.fulfill({ contentType: 'application/javascript', body: fixture }));
    await page.goto(`${BASE}/e2e/fixtures/team-chat-composer.html`);
    const box = page.getByRole('textbox', { name: 'Workspace Chat message' });
    await expect(box).toHaveValue('A request');
    await page.getByTestId('composer-send').click();
    await page.getByRole('button', { name: 'Switch B' }).click();
    await expect(box).toHaveValue('B unsent draft');
    // Resolve the slow A send AFTER switching to B.
    await page.evaluate(() => (window as unknown as { releaseSend: () => void }).releaseSend());
    await page.waitForTimeout(150);
    await expect(box).toHaveValue('B unsent draft');
  });

  test('list: remotely-resolved older row disappears on refresh; loadMore never stranded by a concurrent refresh', async ({ page }) => {
    const { react, dom } = await reactDeps();
    const fixture = `import React from ${JSON.stringify(react)};import RD from ${JSON.stringify(dom)};import {AppThemeRoot} from '/src/AppThemeRoot.tsx';import '/src/index.css';import List from '/src/components/chat/TeamThreadList.tsx';
      RD.createRoot(document.getElementById('root')).render(React.createElement(AppThemeRoot,{},React.createElement('div',{style:{height:600,width:340,display:'flex'}},
        React.createElement(List,{workspaceId:'fixture',isDarkMode:false,canCreate:true,activeThreadId:null,onOpenThread:()=>{},onNewThread:()=>{},onAccessLost:()=>{},registerRefresh:fn=>{window.reviewRefresh=fn;}}))));`;
    const row = (i: number) => ({
      id: 'thread-' + i, workspaceId: 'fixture', title: 'Topic ' + i, status: 'open', rootMessageId: 'root-' + i,
      rootPreview: 'preview', createdBy: 'review', replyCount: 0,
      lastActivityAt: new Date(Date.UTC(2026, 8, 20, 0, 0, 100 - i)).toISOString(), lastMessageSeq: 1,
      participants: [], unread: false, unreadCount: 0, following: false, runStatus: null,
      createdAt: '2026-09-20T00:00:00Z', updatedAt: '2026-09-20T00:00:00Z',
    });
    const cors = { 'access-control-allow-origin': BASE, 'access-control-allow-credentials': 'true' };
    let first = 0;
    let resolved = false;
    let held: Route | undefined;
    await page.route('**/e2e/fixtures/team-chat-composer.tsx*', (route: Route) => route.fulfill({ contentType: 'application/javascript', body: fixture }));
    await page.route('**/workspaces/fixture/collaboration/team-chat/threads?*', (route: Route) => {
      const url = new URL(route.request().url());
      if (url.searchParams.has('cursor')) {
        // Hold the FIRST cursor request to simulate a delayed loadMore; serve
        // later cursor requests (from refresh) normally.
        if (!held) { held = route; return; }
        return route.fulfill({ headers: cors, contentType: 'application/json', body: JSON.stringify({ threads: resolved ? [row(32)] : [row(31), row(32)], nextCursor: null }) });
      }
      first += 1;
      return route.fulfill({ headers: cors, contentType: 'application/json', body: JSON.stringify({ threads: Array.from({ length: 30 }, (_, i) => row(i + 1)), nextCursor: 'page2' }) });
    });
    await page.goto(`${BASE}/e2e/fixtures/team-chat-composer.html`);
    await page.getByRole('button', { name: 'Open', exact: true }).click();
    await expect(page.getByTestId('thread-item-thread-1')).toBeVisible();
    await page.getByRole('button', { name: 'Load older threads' }).click();
    await expect(page.getByRole('button', { name: 'Loading…', exact: true })).toBeVisible();
    // A refresh runs while the loadMore request is held.
    await page.evaluate(() => (window as unknown as { reviewRefresh: () => void }).reviewRefresh());
    await expect.poll(() => first).toBeGreaterThan(1);
    // Now resolve thread-31 remotely and release the held loadMore.
    resolved = true;
    await held!.fulfill({ headers: cors, contentType: 'application/json', body: JSON.stringify({ threads: [row(31), row(32)], nextCursor: 'page3' }) });
    await page.waitForTimeout(150);
    // loadMore must not be stranded.
    await expect(page.getByRole('button', { name: 'Loading…', exact: true })).toHaveCount(0);
    // Trigger another refresh; the resolved older row must disappear (no retain-forever).
    await page.evaluate(() => (window as unknown as { reviewRefresh: () => void }).reviewRefresh());
    await expect(page.getByTestId('thread-item-thread-31')).toHaveCount(0);
  });
});
