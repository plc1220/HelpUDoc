import { expect, test } from '@playwright/test';

test('review follow-up requires explicit consent, preserves destination, and exposes delivery history and disable', async ({ page, baseURL }) => {
  test.skip(!baseURL?.startsWith('http://127.0.0.1:'), 'Local Vite required');
  const workspaceId = '11111111-1111-4111-8111-111111111111';
  const threadId = '22222222-2222-4222-8222-222222222222';
  const eventRef = 'meeting:fixture';
  const calls: Array<{ method: string; path: string; body: Record<string, unknown> }> = [];
  let rules: Array<Record<string, unknown>> = [];
  await page.route('**/api/**', async route => {
    const req = route.request(), path = new URL(req.url()).pathname;
    const headers = { 'access-control-allow-origin': baseURL!, 'access-control-allow-credentials': 'true', 'access-control-allow-methods': '*', 'access-control-allow-headers': '*' };
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
    const body = req.postData() ? req.postDataJSON() : {};
    calls.push({ method: req.method(), path, body });
    let json: unknown = {};
    if (path === `/api/workspaces/${workspaceId}/files`) json = [{ id: '1', name: 'proposal.docx' }];
    else if (path.endsWith('/team-chat/threads')) json = { threads: [{ id: threadId, title: 'Proposal review', status: 'open' }], nextCursor: null };
    else if (path.endsWith('/audit')) json = [{ id: 'audit-1', outcome: 'posted', created_at: '2026-11-17T02:00:00Z' }];
    else if (path.endsWith('/review-follow-ups/rule-1')) { rules = rules.map(rule => ({ ...rule, enabled: false })); json = rules[0]; }
    else if (path.endsWith('/review-follow-ups')) {
      if (req.method() === 'POST') { rules = [{ id: 'rule-1', ...body, enabled: true }]; json = rules[0]; }
      else json = rules;
    }
    return route.fulfill({ headers, json });
  });
  await page.route('**/__review-follow-up', route => route.fulfill({ contentType: 'text/html', body: `<html><head><script type="module">import RefreshRuntime from '/@react-refresh';RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;</script></head><body><div id="root"></div><script type="module">
    import React from '/node_modules/.vite/deps/react.js';import ReactDOM from '/node_modules/.vite/deps/react-dom_client.js';
    import {AppThemeRoot} from '/src/AppThemeRoot.tsx';import FollowUps from '/src/features/calendar/CalendarReviewFollowUps.tsx';import '/src/index.css';import '/src/features/calendar/calendar.css';
    ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(AppThemeRoot,{},React.createElement('div',{className:'calendar-workspace'},React.createElement(FollowUps,{eventRef:'${eventRef}',workspaceId:'${workspaceId}'}))));
  </script></body></html>` }));
  await page.goto('/__review-follow-up');
  await page.getByRole('button', { name: 'Set up a review follow-up' }).click();
  await page.getByRole('button', { name: 'Shared artifact', exact: true }).click();
  await page.getByRole('option', { name: 'proposal.docx', exact: true }).click();
  await page.getByRole('button', { name: 'Destination Team Chat thread', exact: true }).click();
  await page.getByRole('option', { name: 'Proposal review', exact: true }).click();
  const submit = page.getByRole('button', { name: 'Enable follow-up', exact: true });
  await expect(submit).toBeDisabled();
  expect(calls.filter(call => call.method === 'POST')).toHaveLength(0);
  await page.getByRole('checkbox', { name: 'Enable this follow-up', exact: true }).check();
  await submit.click();
  await expect(page.getByText('Enabled · 60 minutes before this occurrence')).toBeVisible();
  expect(calls.find(call => call.method === 'POST')?.body).toEqual({ event_ref: eventRef, workspace_id: workspaceId, file_path: 'proposal.docx', thread_id: threadId, lead_minutes: 60 });
  await page.getByRole('button', { name: 'Show delivery history' }).click();
  await expect(page.getByText(/Posted pending review items/)).toBeVisible();
  await page.getByRole('button', { name: 'Disable follow-up' }).click();
  await expect(page.getByText('Disabled · 60 minutes before this occurrence')).toBeVisible();
  expect(calls.filter(call => call.method === 'DELETE')).toHaveLength(1);
  expect(calls.some(call => call.path.includes('/calendar/events'))).toBe(false);
});
