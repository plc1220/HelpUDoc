import { test, expect, type Page } from '@playwright/test';
test.use({ timezoneId: 'Asia/Kuala_Lumpur' });

async function setup(page: Page, baseURL: string, mobile = false, secondMeeting = false) {
  await page.clock.setFixedTime(new Date('2026-11-05T04:00:00Z'));
  const calls: Array<{ method: string; path: string; body: Record<string, unknown>; etag?: string }> = [];
  let conflict = false;
  const event = { id: 'meeting:test', kind: 'MEETING', title: 'Customer project review', start: '2026-11-05T02:00:00Z', end: '2026-11-05T03:00:00Z', time_zone: 'Asia/Kuala_Lumpur', calendar_id: 'primary', calendar_name: 'Personal', etag: '"v1"', attendees: [{ email: 'customer@example.com', responseStatus: 'accepted' }], description: 'Review the revised proposal and confirm next steps.', capabilities: { can_edit: true, can_delete: true } };
  const otherEvent = { ...event, id: 'meeting:other', title: 'Partner follow-up', start: '2026-11-05T04:00:00Z', end: '2026-11-05T05:00:00Z' };
  await page.addInitScript(() => { localStorage.setItem('helpudoc-color-mode', 'light'); });
  await page.route('**/api/v1/**', async route => {
    const req = route.request(), url = new URL(req.url()), path = url.pathname.replace('/api/v1', '');
    const headers = { 'access-control-allow-origin': baseURL, 'access-control-allow-credentials': 'true', 'access-control-allow-methods': '*', 'access-control-allow-headers': '*' };
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
    const data = req.postData() ? req.postDataJSON() : {};
    calls.push({ method: req.method(), path, body: data, etag: req.headers()['if-match'] });
    let result: unknown = {};
    if (path === '/calendar/connections') result = { connected: true, configured: true, can_edit: true, drive_enabled: true, accounts: [{ id: 'calendar:fixture', principal: 'fixture@example.com', can_edit: true, drive_enabled: true }] };
    else if (path === '/drive/picker') result = { access_token: 'test-access-token', developer_key: 'test-browser-key', app_id: 'test-project' };
    else if (path === '/calendar/review-follow-ups') result = [];
    else if (path === '/calendar/sources') result = [{ id: 'primary', summary: 'Personal', accessRole: 'owner', visible: true, can_edit: true, timeZone: 'Asia/Kuala_Lumpur', sync_state: 'HEALTHY' }];
    else if (path === '/calendar/timeline') result = { items: [event, ...(secondMeeting ? [otherEvent] : []), { id: 'automation:1', kind: 'AUTOMATION', title: 'Prepare weekly report', start: '2026-11-05T01:00:00Z', time_zone: 'Asia/Kuala_Lumpur', status: 'active', workspace_name: 'Client work', capabilities: { can_edit: false, can_delete: false } }], partial_sources: [] };
    else if (path === '/context/links') result = { confirmed: [{ file_ref: 'file-1', link_id: 'link-1', title: 'Revised proposal', url: 'https://drive.google.com/file/d/1/view' }], suggested: [] };
    else if (path === '/drive/files/search') result = [{ file_ref: 'file-2', title: 'Delivery tracker', reason: 'Name matches your search' }];
    else if (path.startsWith('/calendar/events/')) {
      if (req.method() === 'PATCH' && conflict) return route.fulfill({ headers, status: 409, json: { code: 'CALENDAR_CONFLICT', error: 'This event changed in Google. Reload latest.' } });
      const selectedEvent = decodeURIComponent(path).includes('meeting:other') ? otherEvent : event;
      result = req.method() === 'PATCH' ? { ...selectedEvent, ...data, etag: '"v2"' } : selectedEvent;
    } else if (path === '/calendar/events') result = { ...event, ...data, id: 'meeting:new' };
    return route.fulfill({ headers, json: result });
  });
  await page.route('**/__calendar*', route => route.fulfill({ contentType: 'text/html', body: `<html><head><script type="module">import RefreshRuntime from '/@react-refresh';RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;</script></head><body style="margin:0"><div id="root"></div><script type="module">
    import React from '/node_modules/.vite/deps/react.js';import ReactDOM from '/node_modules/.vite/deps/react-dom_client.js';
    import {AppThemeRoot} from '/src/AppThemeRoot.tsx';import Calendar from '/src/features/calendar/CalendarWorkspace.tsx';import '/src/index.css';
    function Harness(){const [target,setTarget]=React.useState(null);const [compact,setCompact]=React.useState(false);const [open,setOpen]=React.useState(true);return React.createElement(AppThemeRoot,{},!open&&React.createElement('button',{onClick:()=>setOpen(true)},'Reopen Calendar'),React.createElement('div',{ref:setTarget,style:{height:'100dvh'}},null),React.createElement(Calendar,{open,compact,canvasTarget:target,isMobile:${mobile},onClose:()=>setOpen(false),onOpenCalendar:()=>setCompact(false),onAgentContext:(context,eventRef,calendarSourceId)=>{window.agentContext=context;window.agentEventRef=eventRef;window.agentCalendarSourceId=calendarSourceId;},onOpenAutomations:()=>{},onEditAutomation:()=>{}}));}
    ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(Harness));
  </script></body></html>` }));
  await page.goto('/__calendar');
  await expect(page.getByRole('button', { name: /Customer project review/ }).first()).toBeVisible();
  return { calls, event, setConflict: (value: boolean) => { conflict = value; } };
}

test('Calendar uses Astryx and Cozy Owl; direct edits preserve draft on conflict', async ({ page, baseURL }, info) => {
  test.skip(!baseURL?.startsWith('http://127.0.0.1:'), 'Local Vite required');
  await page.setViewportSize({ width: 1440, height: 1000 });
  const state = await setup(page, baseURL!);
  await page.getByRole('button', { name: /Customer project review/ }).first().click();
  await expect(page.getByRole('heading', { name: 'Related files' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Revised proposal' })).toBeVisible();
  const color = await page.locator('.calendar-workspace').evaluate(el => ({ background: getComputedStyle(el).backgroundColor, text: getComputedStyle(el).color }));
  expect(color).toEqual({ background: 'rgb(249, 238, 217)', text: 'rgb(66, 42, 30)' });
  await page.screenshot({ path: info.outputPath('calendar-week-light.png'), fullPage: true });
  await page.getByRole('button', { name: 'Edit event', exact: true }).click();
  await page.getByRole('textbox', { name: 'Title Required', exact: true }).fill('Revised customer review');
  state.setConflict(true);
  await page.getByRole('button', { name: 'Save to Google' }).click();
  await expect(page.getByRole('textbox', { name: 'Title Required', exact: true })).toHaveValue('Revised customer review');
  await expect(page.getByRole('button', { name: 'Resolve conflict first' })).toBeDisabled();
  expect(state.calls.some(call => call.path === '/calendar/activity' && call.body.signal === 'ui_conflict_resolved')).toBe(false);
  const patch = state.calls.find(call => call.method === 'PATCH');
  expect(patch?.etag).toBe('"v1"'); expect(patch?.body.title).toBe('Revised customer review');
  await page.getByRole('button', { name: 'Reload latest for comparison' }).click();
  state.setConflict(false);
  await page.getByRole('button', { name: 'Save to Google' }).click();
  await expect(page.getByRole('dialog', { name: 'Edit event', exact: true })).not.toBeVisible();
  await expect.poll(() => state.calls.filter(call => call.path === '/calendar/activity' && call.body.signal === 'ui_conflict_resolved').length).toBe(1);
  await page.getByRole('button', { name: 'Discuss with Agent' }).click();
  expect(await page.evaluate(() => (window as unknown as { agentContext: string }).agentContext)).toContain('Revised customer review');
  expect(await page.evaluate(() => (window as unknown as { agentEventRef: string }).agentEventRef)).toBe('meeting:test');
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('helpudoc-color-mode-change', { detail: 'dark' })));
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  const dark = await page.locator('.calendar-workspace').evaluate(el => getComputedStyle(el).backgroundColor);
  expect(dark).toBe('rgb(30, 20, 16)');
  await expect(page.locator('.calendar-event-meeting').first()).toHaveCSS('background-color', 'rgb(30, 20, 16)');
  await expect(page.locator('.calendar-event-meeting').first()).toHaveCSS('color', 'rgb(249, 238, 217)');
  await page.screenshot({ path: info.outputPath('calendar-week-dark.png'), fullPage: true, animations: 'disabled' });
});

test('Mobile defaults to Agenda, opens details and links suggestions explicitly', async ({ page, baseURL }, info) => {
  test.skip(!baseURL?.startsWith('http://127.0.0.1:'), 'Local Vite required');
  await page.setViewportSize({ width: 390, height: 844 });
  const { calls } = await setup(page, baseURL!, true);
  await expect(page.locator('.calendar-agenda')).toBeVisible();
  await page.getByRole('button', { name: /Customer project review/ }).first().click();
  await page.getByRole('textbox', { name: 'Find a Drive file' }).fill('Delivery');
  await page.getByRole('button', { name: 'Find', exact: true }).click();
  await expect(page.getByText('Delivery tracker', { exact: true })).toBeVisible();
  expect(calls.some(call => call.method === 'POST' && call.path === '/context/links')).toBe(false);
  await page.getByRole('button', { name: 'Link', exact: true }).click();
  await expect.poll(() => calls.some(call => call.method === 'POST' && call.path === '/context/links')).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath('calendar-agenda-mobile.png'), fullPage: true });
});

test('Workspace calendar opens from existing navigation and occupies the center Canvas', async ({ page, baseURL }, info) => {
  test.skip(!baseURL?.startsWith('http://127.0.0.1:'), 'Local Vite required');
  await page.setViewportSize({ width: 1480, height: 980 });
  await setup(page, baseURL!);
  const fixture = { id: '11111111-1111-4111-8111-111111111111', name: 'Calendar workspace', role: 'owner', visibility: 'private', workspaceType: 'private', status: 'active', createdAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-05T00:00:00Z', contentRevision: 1 };
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path.startsWith('/api/v1/')) return route.fallback();
    const headers = { 'access-control-allow-origin': baseURL!, 'access-control-allow-credentials': 'true', 'access-control-allow-methods': '*', 'access-control-allow-headers': '*' };
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
    let json: unknown = {};
    if (path === '/api/auth/me') json = { authenticated: true, authMode: 'hybrid', googleConfigured: true, user: { userId: fixture.id, externalId: 'calendar-fixture', displayName: 'Calendar tester', isAdmin: false } };
    else if (path === '/api/workspaces') json = [fixture];
    else if (path.endsWith('/slash-metadata')) json = { skills: [], mcpServers: [], plugins: [] };
    else if (path.endsWith('/notifications')) json = { notifications: [], unreadCount: 0 };
    else if (path.endsWith('/files') || path.endsWith('/conversations') || path.endsWith('/recent')) json = [];
    else if (path.endsWith('/folders')) json = { folders: [] };
    else if (path.endsWith('/schedules')) json = { schedules: [] };
    else if (path === `/api/workspaces/${fixture.id}`) json = fixture;
    return route.fulfill({ headers, json });
  });
  await page.goto('/');
  await page.getByRole('complementary', { name: 'Workspace controls', exact: true }).getByRole('button', { name: 'Open calendar', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Calendar agenda', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Open Calendar', exact: true }).last().click();
  await expect(page.locator('.calendar-canvas-slot .calendar-workspace')).toBeVisible();
  await expect(page.getByRole('dialog', { name: 'Calendar agenda', exact: true })).not.toBeVisible();
  expect(await page.locator('.calendar-canvas-slot').evaluate(element => element.getBoundingClientRect().width)).toBeGreaterThan(500);
  await page.screenshot({ path: info.outputPath('calendar-workspace-canvas.png'), fullPage: true });
  await page.getByRole('button', { name: 'Open workspace menu', exact: true }).click();
  await page.getByRole('button', { name: 'Switch to dark mode', exact: true }).click();
  await page.getByRole('button', { name: 'Close workspace menu', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(page.locator('.calendar-event-meeting').first()).toHaveCSS('background-color', 'rgb(30, 20, 16)');
  await expect(page.getByRole('heading', { name: 'Files', exact: true })).toHaveCSS('color', 'rgb(249, 238, 217)');
  await page.screenshot({ path: info.outputPath('calendar-workspace-canvas-dark.png'), fullPage: true, animations: 'disabled' });
  expect(errors).toEqual([]);
});

test('Week reschedule and resize preview before a conditional provider save', async ({ page, baseURL }) => {
  test.skip(!baseURL?.startsWith('http://127.0.0.1:'), 'Local Vite required');
  await page.setViewportSize({ width: 1440, height: 1100 });
  const { calls } = await setup(page, baseURL!);
  const event = page.getByRole('button', { name: /Customer project review/ }).first();
  const slot = page.getByRole('button', { name: 'Create event 2026-11-05 at 12:00', exact: true });
  await event.dragTo(slot);
  await expect(page.getByRole('dialog', { name: 'Confirm reschedule' })).toBeVisible();
  expect(calls.some(call => call.method === 'PATCH')).toBe(false);
  await page.getByRole('button', { name: 'Save new time' }).click();
  await expect.poll(() => calls.filter(call => call.method === 'PATCH').length).toBe(1);
  expect(calls.find(call => call.method === 'PATCH')?.body.start).toBe('2026-11-05T04:00:00.000Z');
  const handle = page.getByRole('button', { name: /Resize Customer project review/ });
  await handle.scrollIntoViewIfNeeded(); const box = await handle.boundingBox(); expect(box).not.toBeNull();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2); await page.mouse.down();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2 + 36, { steps: 5 }); await page.mouse.up();
  await expect(page.getByRole('dialog', { name: 'Confirm reschedule' })).toBeVisible();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  expect(calls.filter(call => call.method === 'PATCH')).toHaveLength(1);
});

test('Drive Picker can open from a mobile detail sheet without a native modal blocking it', async ({ page, baseURL }) => {
  test.skip(!baseURL?.startsWith('http://127.0.0.1:'), 'Local Vite required');
  await page.addInitScript(() => {
    class PickerBuilder {
      callback: (response: unknown) => void = () => {};
      setDeveloperKey() { return this; } setAppId() { return this; } setOAuthToken() { return this; } setOrigin() { return this; } addView() { return this; }
      setCallback(callback: (response: unknown) => void) { this.callback = callback; return this; }
      build() { return { setVisible: () => { (window as unknown as { pickerBlocked: boolean }).pickerBlocked = document.querySelectorAll('dialog[open]').length > 0; this.callback({ action: 'picked', docs: [{ id: 'picked-file' }] }); } }; }
    }
    Object.assign(window, { gapi: { load: (_module: string, config: { callback: () => void }) => config.callback() }, google: { picker: { PickerBuilder, ViewId: { DOCS: 'docs' } } } });
  });
  await page.setViewportSize({ width: 390, height: 844 }); const { calls } = await setup(page, baseURL!, true);
  await page.getByRole('button', { name: /Customer project review/ }).first().click();
  await page.getByRole('button', { name: 'Choose from Google Drive' }).click();
  await expect.poll(() => calls.some(call => call.path === '/context/links' && call.method === 'POST')).toBe(true);
  expect(await page.evaluate(() => (window as unknown as { pickerBlocked: boolean }).pickerBlocked)).toBe(false);
  await expect(page.getByRole('dialog', { name: 'Calendar item details' })).toBeVisible();
});

test('Briefing results and document consent stay with the selected meeting', async ({ page, baseURL }) => {
  test.skip(!baseURL?.startsWith('http://127.0.0.1:'), 'Local Vite required');
  await page.setViewportSize({ width: 1440, height: 1100 });
  await setup(page, baseURL!, false, true);
  const headers = { 'access-control-allow-origin': baseURL!, 'access-control-allow-credentials': 'true' };
  let releaseStart!: () => void, started = false, firstConsent: boolean | undefined;
  const startGate = new Promise<void>(resolve => { releaseStart = resolve; });
  await page.route('**/api/v1/calendar/events/*/brief', async route => {
    firstConsent = route.request().postDataJSON().include_linked_content; started = true;
    await startGate;
    await route.fulfill({ headers, status: 202, json: { id: 'brief-customer', status: 'QUEUED' } });
  });
  await page.getByRole('button', { name: /Customer project review/ }).first().click();
  await page.getByRole('checkbox', { name: 'Include linked document text' }).check();
  await page.getByRole('button', { name: 'Prepare briefing', exact: true }).click();
  await expect.poll(() => started).toBe(true); expect(firstConsent).toBe(true);
  await page.getByRole('button', { name: /Partner follow-up/ }).first().click();
  await expect(page.getByRole('checkbox', { name: 'Include linked document text' })).not.toBeChecked();
  releaseStart();
  await expect(page.getByRole('button', { name: 'Prepare briefing', exact: true })).toBeEnabled();

  let secondConsent: boolean | undefined, polling = false, releasePoll!: () => void;
  const pollGate = new Promise<void>(resolve => { releasePoll = resolve; });
  await page.route('**/api/v1/calendar/events/*/brief', async route => {
    secondConsent = route.request().postDataJSON().include_linked_content;
    await route.fulfill({ headers, status: 202, json: { id: 'brief-partner', status: 'QUEUED' } });
  });
  await page.route('**/api/v1/calendar/briefs/brief-partner', async route => {
    polling = true; await pollGate;
    await route.fulfill({ headers, json: { id: 'brief-partner', status: 'READY', sections: { talking_points: 'Partner-only private briefing evidence' } } });
  });
  await page.getByRole('button', { name: 'Prepare briefing', exact: true }).click();
  await expect.poll(() => polling).toBe(true); expect(secondConsent).toBe(false);
  await page.getByRole('button', { name: /Customer project review/ }).first().click();
  const response = page.waitForResponse(url => url.url().includes('/briefs/brief-partner'));
  releasePoll(); await (await response).finished();
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await expect(page.getByText('Partner-only private briefing evidence', { exact: true })).not.toBeVisible();
  await expect(page.getByRole('button', { name: 'Prepare briefing', exact: true })).toBeEnabled();
});

test('Related files show permitted suggestions and require explicit series-wide linking', async ({ page, baseURL }) => {
  test.skip(!baseURL?.startsWith('http://127.0.0.1:'), 'Local Vite required');
  const { calls } = await setup(page, baseURL!);
  const headers = { 'access-control-allow-origin': baseURL!, 'access-control-allow-credentials': 'true' };
  await page.route('**/api/v1/context/links?*', route => route.fulfill({ headers, json: {
    supports_series: true,
    confirmed: [{ file_ref: 'series-file', link_id: 'series-link', title: 'Series reference', scope: 'series', inherited: true, provenance: 'MANUAL', url: 'https://drive.google.com/file/d/series-file/view' }],
    suggested: [{ file_ref: 'referenced-file', title: 'Meeting proposal', provenance: 'EXPLICIT_SOURCE', reason: 'Document URL appears in the event', url: 'https://drive.google.com/file/d/referenced-file/view' }, { file_ref: 'dismiss-file', title: 'Older notes', provenance: 'INFERRED', reason: 'Similar title' }],
  } }));
  await page.getByRole('button', { name: /Customer project review/ }).first().click();
  await expect(page.getByRole('complementary', { name: 'Selected calendar item' }).getByText('Linked to entire meeting series · reused for this occurrence')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Meeting proposal' })).toBeVisible();
  await expect(page.getByRole('complementary', { name: 'Selected calendar item' }).getByText(/Referenced in meeting · Document URL/)).toBeVisible();
  expect(calls.some(call => call.path === '/context/links' && call.method === 'POST')).toBe(false);
  await page.getByRole('button', { name: 'Dismiss suggestion Older notes', exact: true }).click();
  await expect(page.getByRole('complementary', { name: 'Selected calendar item' }).getByText('Older notes', { exact: true })).not.toBeVisible();
  await page.getByRole('combobox', { name: 'Link files to', exact: true }).click();
  await page.getByRole('option', { name: 'Entire meeting series', exact: true }).click();
  await page.getByRole('button', { name: 'Link', exact: true }).click();
  await expect.poll(() => calls.filter(call => call.path === '/context/links' && call.method === 'POST').length).toBe(1);
  expect(calls.find(call => call.path === '/context/links' && call.method === 'POST')?.body).toEqual({ subject_ref: 'meeting:test', file_ref: 'referenced-file', scope: 'series' });
});

test('Agent event proposals open for human review and commit only after explicit Save', async ({ page, baseURL }) => {
  test.skip(!baseURL?.startsWith('http://127.0.0.1:'), 'Local Vite required');
  const { event } = await setup(page, baseURL!);
  const headers = { 'access-control-allow-origin': baseURL!, 'access-control-allow-credentials': 'true' };
  const commits: Record<string, unknown>[] = [];
  await page.route('**/api/v1/calendar/proposals/proposal-edit', route => route.fulfill({ headers, json: { id: 'proposal-edit', method: 'PATCH', selected_event_ref: event.id, event_ref: event.id, before: event, input: { title: 'Agent proposed review' }, event_etag: event.etag, status: 'PENDING', expires_at: '2026-11-05T05:00:00Z' } }));
  await page.route('**/api/v1/calendar/proposals/proposal-edit/commit', async route => { const body = route.request().postDataJSON(); commits.push(body); await route.fulfill({ headers, json: { ...event, ...body.input, etag: '"approved"' } }); });
  await page.goto('/__calendar?calendar=open&calendar_proposal=proposal-edit');
  await expect(page.getByRole('dialog', { name: 'Edit event', exact: true })).toBeVisible();
  await expect(page.getByText(/Agent proposal · review every field/)).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Title Required', exact: true })).toHaveValue('Agent proposed review');
  expect(commits).toHaveLength(0);
  await page.getByRole('textbox', { name: 'Title Required', exact: true }).fill('Human reviewed title');
  await page.getByRole('button', { name: 'Save to Google', exact: true }).click();
  await expect.poll(() => commits.length).toBe(1);
  expect(commits[0].etag).toBe(event.etag); expect((commits[0].input as Record<string, unknown>).title).toBe('Human reviewed title');
  await expect(page.getByRole('dialog', { name: 'Edit event', exact: true })).not.toBeVisible();
  expect(new URL(page.url()).searchParams.has('calendar_proposal')).toBe(false);
});

test('Create and delete agent proposals require separate human review with accurate notifications', async ({ page, baseURL }) => {
  test.skip(!baseURL?.startsWith('http://127.0.0.1:'), 'Local Vite required');
  const { event } = await setup(page, baseURL!);
  const headers = { 'access-control-allow-origin': baseURL!, 'access-control-allow-credentials': 'true' };
  const commits: Array<{ path: string; body: Record<string, unknown> }> = [];
  await page.route('**/api/v1/calendar/proposals/*', async route => {
    const id = new URL(route.request().url()).pathname.split('/').at(-1);
    const create = id === 'proposal-create';
    await route.fulfill({ headers, json: { id, method: create ? 'POST' : 'DELETE', selected_event_ref: event.id, event_ref: create ? undefined : event.id, before: event, input: create ? { title: 'Separate follow-up', start: event.start, end: event.end, calendar_id: 'primary' } : { scope: 'single', send_updates: 'none' }, event_etag: event.etag, status: 'PENDING', expires_at: '2026-11-05T05:00:00Z' } });
  });
  await page.route('**/api/v1/calendar/proposals/*/commit', async route => { commits.push({ path: new URL(route.request().url()).pathname, body: route.request().postDataJSON() }); await route.fulfill({ headers, json: { deleted: true } }); });
  await page.goto('/__calendar?calendar=open&calendar_proposal=proposal-create');
  await expect(page.getByRole('dialog', { name: 'New event', exact: true })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Attendees', exact: true })).toHaveValue('');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  expect(commits).toHaveLength(0);
  await page.goto('/__calendar?calendar=open&calendar_proposal=proposal-delete');
  await expect(page.getByRole('dialog', { name: 'Delete meeting', exact: true })).toBeVisible();
  await expect(page.getByText('No attendee notifications will be sent.', { exact: false })).toBeVisible();
  expect(commits).toHaveLength(0);
  await page.getByRole('button', { name: 'Delete event', exact: true }).click();
  await expect.poll(() => commits.length).toBe(1);
  expect(commits[0].path).toContain('/proposal-delete/commit');
  expect(commits[0].body).toEqual({ input: { scope: 'single', send_updates: 'none' }, etag: event.etag });
  await expect(page.getByRole('dialog', { name: 'Delete meeting', exact: true })).not.toBeVisible();
});

test('Revoked source access removes selected meeting details and stale write controls', async ({ page, baseURL }) => {
  test.skip(!baseURL?.startsWith('http://127.0.0.1:'), 'Local Vite required');
  await setup(page, baseURL!);
  await page.getByRole('button', { name: /Customer project review/ }).first().click();
  await expect(page.getByRole('button', { name: 'Edit event', exact: true })).toBeEnabled();
  const headers = { 'access-control-allow-origin': baseURL!, 'access-control-allow-credentials': 'true' };
  await page.route('**/api/v1/calendar/sources', route => route.fulfill({ headers, status: 403, json: { code: 'PERMISSION_DENIED', error: 'Google no longer permits this calendar.' } }));
  await page.getByRole('button', { name: 'Refresh calendar', exact: true }).click();
  await expect(page.getByRole('button', { name: /Customer project review/ })).toHaveCount(0);
  await expect(page.getByRole('complementary', { name: 'Selected calendar item' })).not.toBeVisible();
  await expect(page.getByRole('button', { name: 'New event', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: /Prepare weekly report/ }).first()).toBeVisible();
});

test('Provider outages downgrade an already open meeting to read-only and show source health', async ({ page, baseURL }) => {
  test.skip(!baseURL?.startsWith('http://127.0.0.1:'), 'Local Vite required');
  const { event } = await setup(page, baseURL!);
  await page.getByRole('button', { name: /Customer project review/ }).first().click();
  await expect(page.getByRole('button', { name: 'Edit event', exact: true })).toBeEnabled();
  const headers = { 'access-control-allow-origin': baseURL!, 'access-control-allow-credentials': 'true' };
  await page.route('**/api/v1/calendar/sources', route => route.fulfill({ headers, json: [{ id: 'primary', summary: 'Personal', accessRole: 'owner', visible: true, can_edit: false, timeZone: 'Asia/Kuala_Lumpur', sync_state: 'STALE', last_sync_at: '2026-11-05T03:00:00Z' }] }));
  await page.route('**/api/v1/calendar/timeline?*', route => route.fulfill({ headers, json: { items: [{ ...event, sync_state: 'STALE', capabilities: { can_edit: false, can_delete: false } }], partial_sources: [{ reason: 'Google is temporarily unavailable' }] } }));
  await page.getByRole('button', { name: 'Refresh calendar', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Edit event', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Delete', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'New event', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Calendar filters', exact: true }).click();
  await expect(page.getByText(/Stale · cached, read-only · Last checked/)).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Customer project review', exact: true })).toBeVisible();
});

test('Gmail briefing context uses only explicitly searched and selected threads', async ({ page, baseURL }) => {
  test.skip(!baseURL?.startsWith('http://127.0.0.1:'), 'Local Vite required');
  await page.setViewportSize({ width: 1440, height: 1100 });
  const { calls } = await setup(page, baseURL!, false, true);
  const headers = { 'access-control-allow-origin': baseURL!, 'access-control-allow-credentials': 'true' };
  const searches: string[] = [], briefs: Record<string, unknown>[] = [];
  await page.route('**/api/v1/calendar/context/gmail/search?*', async route => {
    searches.push(new URL(route.request().url()).searchParams.get('q') || '');
    await route.fulfill({ headers, json: [{ id: 'a1b2c3', title: 'Revised review agenda', from: 'Alex <alex@example.com>', date: '4 Nov' }, { id: 'd4e5f6', title: 'Approved proposal', from: 'Jo <jo@example.com>' }] });
  });
  await page.route('**/api/v1/calendar/events/*/brief', async route => { briefs.push(route.request().postDataJSON()); await route.fulfill({ headers, status: 202, json: { id: 'email-brief', status: 'READY', sections: { gaps: 'No other mail was reviewed.' } } }); });
  await page.getByRole('button', { name: /Customer project review/ }).first().click();
  expect(searches).toHaveLength(0); expect(briefs).toHaveLength(0);
  await page.getByRole('checkbox', { name: 'Choose Gmail context', exact: true }).check();
  expect(searches).toHaveLength(0);
  await page.getByRole('textbox', { name: 'Find email threads', exact: true }).fill('proposal after:2026/10/01');
  await page.getByRole('button', { name: 'Search email', exact: true }).click();
  await expect(page.getByRole('checkbox', { name: 'Approved proposal', exact: true })).toBeVisible();
  expect(searches).toEqual(['proposal after:2026/10/01']);
  await page.getByRole('checkbox', { name: 'Approved proposal', exact: true }).check();
  expect(briefs).toHaveLength(0);
  expect(calls.some(call => call.path.includes('/gmail/') && !call.path.endsWith('/search'))).toBe(false);
  await page.getByRole('button', { name: 'Prepare briefing', exact: true }).click();
  await expect.poll(() => briefs.length).toBe(1);
  expect(briefs[0].gmail_thread_ids).toEqual(['d4e5f6']);
  await page.getByRole('button', { name: /Partner follow-up/ }).first().click();
  await expect(page.getByRole('checkbox', { name: 'Choose Gmail context', exact: true })).not.toBeChecked();
  await expect(page.getByRole('checkbox', { name: 'Approved proposal', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Prepare briefing', exact: true }).click();
  await expect.poll(() => briefs.length).toBe(2);
  expect(briefs[1].gmail_thread_ids).toEqual([]);
});

test('Missing Gmail access stays actionable while event-only briefing remains available', async ({ page, baseURL }) => {
  test.skip(!baseURL?.startsWith('http://127.0.0.1:'), 'Local Vite required');
  await setup(page, baseURL!);
  const headers = { 'access-control-allow-origin': baseURL!, 'access-control-allow-credentials': 'true' };
  let briefInput: Record<string, unknown> | undefined;
  await page.route('**/api/v1/calendar/context/gmail/search?*', route => route.fulfill({ headers, status: 403, json: { code: 'GMAIL_NOT_CONNECTED', error: 'Gmail is not connected for meeting briefs. Prepare without Gmail or review your existing Google connection.' } }));
  await page.route('**/api/v1/calendar/events/*/brief', async route => { briefInput = route.request().postDataJSON(); await route.fulfill({ headers, status: 202, json: { id: 'event-only', status: 'READY', sections: { gaps: 'Gmail was not reviewed.' } } }); });
  await page.getByRole('button', { name: /Customer project review/ }).first().click();
  await page.getByRole('checkbox', { name: 'Choose Gmail context', exact: true }).check();
  await page.getByRole('textbox', { name: 'Find email threads', exact: true }).fill('review');
  await page.getByRole('button', { name: 'Search email', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'Gmail is not connected for meeting briefs.' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Prepare briefing', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Prepare briefing', exact: true }).click();
  await expect.poll(() => briefInput?.gmail_thread_ids).toEqual([]);
});

test('Abandoning a pending proposal load does not leave Calendar busy or reopen stale review', async ({ page, baseURL }) => {
  test.skip(!baseURL?.startsWith('http://127.0.0.1:'), 'Local Vite required');
  const { event } = await setup(page, baseURL!);
  const headers = { 'access-control-allow-origin': baseURL!, 'access-control-allow-credentials': 'true' };
  let requested = false, release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/v1/calendar/proposals/slow-review', async route => { requested = true; await gate; await route.fulfill({ headers, json: { id: 'slow-review', method: 'PATCH', selected_event_ref: event.id, event_ref: event.id, before: event, input: { title: 'Stale proposal response' }, event_etag: event.etag, status: 'PENDING', expires_at: '2026-11-05T05:00:00Z' } }); });
  await page.goto('/__calendar?calendar=open&calendar_proposal=slow-review');
  await expect.poll(() => requested).toBe(true);
  await page.getByRole('button', { name: 'Close calendar', exact: true }).click();
  await page.evaluate(() => window.history.replaceState(window.history.state, '', '/__calendar'));
  await page.getByRole('button', { name: 'Reopen Calendar', exact: true }).click();
  await expect(page.getByRole('button', { name: 'New event', exact: true })).toBeEnabled();
  const response = page.waitForResponse(result => result.url().includes('/proposals/slow-review'));
  release(); await (await response).finished();
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await expect(page.getByRole('dialog', { name: 'Edit event', exact: true })).not.toBeVisible();
  await expect(page.getByRole('button', { name: 'New event', exact: true })).toBeEnabled();
});

test('Previously approved uncertain proposals retry only their exact approved payload and ETag', async ({ page, baseURL }) => {
  test.skip(!baseURL?.startsWith('http://127.0.0.1:'), 'Local Vite required');
  const { event } = await setup(page, baseURL!);
  const headers = { 'access-control-allow-origin': baseURL!, 'access-control-allow-credentials': 'true' };
  const approved = { title: 'Already approved title', start: event.start, end: event.end, time_zone: event.time_zone, calendar_id: 'primary', scope: 'single', send_updates: 'none' };
  const commits: Record<string, unknown>[] = [];
  await page.route('**/api/v1/calendar/proposals/applying-review', route => route.fulfill({ headers, json: { id: 'applying-review', method: 'PATCH', selected_event_ref: event.id, event_ref: event.id, before: { ...event, etag: '"newer-provider-value"' }, input: approved, event_etag: '"approved-value"', status: 'APPLYING', expires_at: '2026-11-05T05:00:00Z' } }));
  await page.route('**/api/v1/calendar/proposals/applying-review/commit', async route => { commits.push(route.request().postDataJSON()); await route.fulfill({ headers, json: { ...event, ...approved, etag: '"saved"' } }); });
  await page.goto('/__calendar?calendar=open&calendar_proposal=applying-review');
  await expect(page.getByRole('dialog', { name: 'Edit event', exact: true })).toBeVisible();
  await expect(page.getByRole('dialog', { name: 'Edit event', exact: true }).getByText(/Previously approved change awaiting confirmation/)).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Title Required', exact: true })).toBeDisabled();
  expect(commits).toHaveLength(0);
  await page.getByRole('button', { name: 'Retry approved change', exact: true }).click();
  await expect.poll(() => commits.length).toBe(1);
  expect(commits[0]).toEqual({ input: approved, etag: '"approved-value"' });
});

test('An uncertain approved deletion can be confirmed without disclosing removed event details', async ({ page, baseURL }) => {
  test.skip(!baseURL?.startsWith('http://127.0.0.1:'), 'Local Vite required');
  const { event } = await setup(page, baseURL!);
  const headers = { 'access-control-allow-origin': baseURL!, 'access-control-allow-credentials': 'true' };
  const approved = { calendar_id: 'primary', scope: 'single', send_updates: 'none' }, commits: Record<string, unknown>[] = [];
  await page.route('**/api/v1/calendar/proposals/applying-delete', route => route.fulfill({ headers, json: { id: 'applying-delete', method: 'DELETE', selected_event_ref: event.id, event_ref: event.id, input: approved, event_etag: '"approved-deletion"', status: 'APPLYING', expires_at: '2026-11-05T05:00:00Z' } }));
  await page.route('**/api/v1/calendar/proposals/applying-delete/commit', async route => { commits.push(route.request().postDataJSON()); await route.fulfill({ headers, json: { deleted: true } }); });
  await page.goto('/__calendar?calendar=open&calendar_proposal=applying-delete');
  const dialog = page.getByRole('dialog', { name: 'Delete meeting', exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText(/Previously approved event will be removed/)).toBeVisible();
  expect(commits).toHaveLength(0);
  await page.getByRole('button', { name: 'Retry approved deletion', exact: true }).click();
  await expect.poll(() => commits.length).toBe(1);
  expect(commits[0]).toEqual({ input: approved, etag: '"approved-deletion"' });
});

test('Agent calendar-wide reads require a separate explicit selection that resets with the meeting', async ({ page, baseURL }) => {
  test.skip(!baseURL?.startsWith('http://127.0.0.1:'), 'Local Vite required');
  await page.setViewportSize({ width: 1440, height: 1100 });
  const { calls } = await setup(page, baseURL!, false, true);
  await page.getByRole('button', { name: /Customer project review/ }).first().click();
  await expect(page.getByRole('checkbox', { name: 'Allow Agent to read this calendar', exact: true })).not.toBeChecked();
  await page.getByRole('button', { name: 'Discuss with Agent', exact: true }).click();
  expect(await page.evaluate(() => (window as unknown as { agentCalendarSourceId?: string }).agentCalendarSourceId)).toBeUndefined();
  await page.getByRole('checkbox', { name: 'Allow Agent to read this calendar', exact: true }).check();
  await page.getByRole('button', { name: 'Discuss with Agent', exact: true }).click();
  expect(await page.evaluate(() => (window as unknown as { agentCalendarSourceId?: string }).agentCalendarSourceId)).toBe('primary');
  await page.getByRole('button', { name: /Partner follow-up/ }).first().click();
  await expect(page.getByRole('checkbox', { name: 'Allow Agent to read this calendar', exact: true })).not.toBeChecked();
  await page.getByRole('button', { name: 'Discuss with Agent', exact: true }).click();
  expect(await page.evaluate(() => (window as unknown as { agentCalendarSourceId?: string }).agentCalendarSourceId)).toBeUndefined();
  expect(calls.some(call => call.path !== '/calendar/activity' && ['POST', 'PATCH', 'DELETE'].includes(call.method))).toBe(false);
});

test('Aggregate Calendar activity contains only fixed signal names and never blocks actions', async ({ page, baseURL }) => {
  test.skip(!baseURL?.startsWith('http://127.0.0.1:'), 'Local Vite required');
  await page.setViewportSize({ width: 1440, height: 1100 });
  await setup(page, baseURL!);
  const headers = { 'access-control-allow-origin': baseURL!, 'access-control-allow-credentials': 'true' };
  const activity: Record<string, unknown>[] = [];
  await page.route('**/api/v1/calendar/activity', async route => { activity.push(route.request().postDataJSON()); await route.fulfill({ headers, status: 503, json: { error: 'Synthetic telemetry outage' } }); });
  await page.route('**/api/v1/calendar/events/*/brief', route => route.fulfill({ headers, status: 202, json: { id: 'activity-brief', status: 'READY', sections: { gaps: 'Fixture evidence only' }, citations: [{ title: 'Approved source', url: 'https://source.example/brief-source', retrieved_at: '2026-11-05T04:00:00Z' }] } }));
  await page.context().route('https://source.example/**', route => route.fulfill({ contentType: 'text/html', body: '<p>Citation fixture</p>' }));
  await page.reload();
  await page.getByRole('button', { name: /Customer project review/ }).first().click();
  await page.getByRole('button', { name: 'Edit event', exact: true }).click();
  await page.getByRole('textbox', { name: 'Title Required', exact: true }).fill('Edited while metrics unavailable');
  await page.getByRole('button', { name: 'Save to Google', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Edit event', exact: true })).not.toBeVisible();
  await page.getByRole('button', { name: 'Prepare briefing', exact: true }).click();
  const popup = page.waitForEvent('popup');
  await page.getByRole('link', { name: 'Approved source', exact: true }).click();
  await (await popup).close();
  await page.getByRole('button', { name: 'Calendar filters', exact: true }).click();
  await page.getByRole('button', { name: 'Add commitment', exact: true }).click();
  await page.getByRole('textbox', { name: 'Commitment', exact: true }).fill('Synthetic commitment');
  await page.getByRole('button', { name: 'Confirm commitment', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Add commitment', exact: true })).not.toBeVisible();
  await expect.poll(() => activity.map(item => item.signal)).toEqual(expect.arrayContaining(['ui_open', 'ui_editor_open', 'ui_brief_requested', 'ui_citation_open', 'ui_commitment_confirmed']));
  for (const item of activity) expect(Object.keys(item)).toEqual(['signal']);
  expect(activity.some(item => item.signal === 'ui_conflict_resolved')).toBe(false);
  await expect(page.getByRole('alert').filter({ hasText: 'Synthetic telemetry outage' })).toHaveCount(0);
});

test('Previous recurring occurrence is read only after explicit briefing selection and resets with context', async ({ page, baseURL }) => {
  test.skip(!baseURL?.startsWith('http://127.0.0.1:'), 'Local Vite required');
  await page.setViewportSize({ width: 1440, height: 1100 });
  const { event } = await setup(page, baseURL!, false, true);
  const headers = { 'access-control-allow-origin': baseURL!, 'access-control-allow-credentials': 'true' };
  const briefs: Record<string, unknown>[] = [];
  await page.route('**/api/v1/calendar/events/*', async route => {
    if (decodeURIComponent(new URL(route.request().url()).pathname).endsWith('/meeting:test')) await route.fulfill({ headers, json: { ...event, recurring_event_id: 'selected-series' } });
    else await route.fallback();
  });
  await page.route('**/api/v1/calendar/events/*/brief', async route => { briefs.push(route.request().postDataJSON()); await route.fulfill({ headers, status: 202, json: { id: 'prior-brief', status: 'READY', gaps: ['No previous occurrence was available within the selected series window.'] } }); });
  await page.getByRole('button', { name: /Customer project review/ }).first().click();
  await expect(page.getByRole('checkbox', { name: 'Include previous occurrence', exact: true })).not.toBeChecked();
  await page.getByRole('checkbox', { name: 'Include previous occurrence', exact: true }).check();
  expect(briefs).toHaveLength(0);
  await page.getByRole('button', { name: 'Prepare briefing', exact: true }).click();
  await expect.poll(() => briefs.length).toBe(1);
  expect(briefs[0].include_prior_occurrence).toBe(true);
  await expect(page.getByRole('complementary', { name: 'Selected calendar item' }).getByText('No previous occurrence was available within the selected series window.')).toBeVisible();
  await page.getByRole('button', { name: /Partner follow-up/ }).first().click();
  await expect(page.getByRole('checkbox', { name: 'Include previous occurrence', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Prepare briefing', exact: true }).click();
  await expect.poll(() => briefs.length).toBe(2);
  expect(briefs[1].include_prior_occurrence).toBe(false);
  await page.getByRole('button', { name: /Customer project review/ }).first().click();
  await expect(page.getByRole('checkbox', { name: 'Include previous occurrence', exact: true })).not.toBeChecked();
});
