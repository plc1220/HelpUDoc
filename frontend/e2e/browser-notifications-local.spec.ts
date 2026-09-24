import { test, expect, type BrowserContext, type Page } from '@playwright/test';
async function mockBrowser(context: BrowserContext, permission = 'default') {
  await context.addInitScript((initial) => {
    const alerts: unknown[] = [];
    Object.assign(window, { desktopAlerts: alerts, permissionRequests: 0 });
    class MockNotification {
      static permission = initial;
      static async requestPermission() {
        (window as unknown as { permissionRequests: number }).permissionRequests++;
        MockNotification.permission = 'granted'; return 'granted';
      }
      closed = false;
      onclick = null;
      constructor(public title: string, public options: NotificationOptions) { alerts.push(this); }
      close() { this.closed = true; }
    }
    Object.defineProperty(window, 'Notification', { value: MockNotification, configurable: true });
  }, permission);
}
const event = (id: string, eventType = 'agent.completed') => ({ id, eventType, readAt: null as string | null, createdAt: new Date().toISOString(), payload: { title: `${eventType} ${id}`, workspaceId: 'workspace-a', conversationId: 'conversation-a', messageId: eventType.startsWith('chat.') ? 'message-a' : undefined } });
const count = (page: Page) => page.evaluate(() => (window as unknown as { desktopAlerts: unknown[] }).desktopAlerts.length);
const refresh = (page: Page) => page.evaluate(() => window.dispatchEvent(new Event('focus')));

test('opt-in filters events, delivers each task, clicks through, clears read alerts and persists mute', async ({ context, page }) => {
  await mockBrowser(context);
  let notifications = [event('history')];
  await page.route('**/api/notifications**', (route) => {
    if (route.request().method() === 'POST') {
      const path = new URL(route.request().url()).pathname;
      notifications = notifications.map((item) => path.endsWith('/read-all') || path.includes(item.id) ? { ...item, readAt: new Date().toISOString() } : item);
      return route.fulfill({ status: 204 });
    }
    return route.fulfill({ json: { notifications, unreadCount: notifications.filter((item) => !item.readAt).length } });
  });
  await page.goto('/e2e/fixtures/notifications.html');
  await page.getByRole('button', { name: 'Notifications, 1 unread', exact: true }).click();
  expect(await page.evaluate(() => (window as unknown as { permissionRequests: number }).permissionRequests)).toBe(0);
  await page.getByRole('button', { name: 'Enable browser alerts', exact: true }).click();
  await expect(page.getByRole('radio', { name: 'Mentions & tasks', exact: true })).toBeChecked();
  expect(await count(page)).toBe(0);
  notifications.unshift(event('task'), event('feedback', 'agent.feedback_required'), event('mention', 'chat.mentioned'), event('chat', 'chat.message'));
  await refresh(page);
  await expect.poll(() => count(page)).toBe(3);
  await page.getByRole('radio', { name: 'All messages & tasks', exact: true }).click();
  await page.screenshot({ path: '/tmp/helpudoc-browser-alert-settings.png' });
  notifications.unshift(event('chat2', 'chat.message'));
  await refresh(page);
  await expect.poll(() => count(page)).toBe(4);
  await page.evaluate(() => (window as unknown as { desktopAlerts: Array<{ onclick: () => void }> }).desktopAlerts[3].onclick());
  await expect(page.getByLabel('Destination')).toContainText('messageId=message-a');
  await page.waitForTimeout(75); // Astryx's dismissal guard is 50ms.
  await page.getByRole('button', { name: /Notifications, .* unread/ }).click();
  await page.getByRole('button', { name: 'Mark all read', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { desktopAlerts: Array<{ closed: boolean }> }).desktopAlerts.every((a) => a.closed))).toBe(true);
  await page.getByRole('button', { name: 'Disable browser alerts', exact: true }).click();
  notifications.unshift(event('muted'));
  await refresh(page);
  await expect(page.getByRole('button', { name: 'Notifications, 1 unread', exact: true })).toBeVisible();
  expect(await count(page)).toBe(4);
  await page.goto('/e2e/fixtures/notifications.html');
  await page.getByRole('button', { name: 'Notifications, 1 unread', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Enable browser alerts', exact: true })).toBeVisible();
});

test('blocked permission shows recovery guidance without prompting again', async ({ context, page }) => {
  await mockBrowser(context, 'denied');
  await page.route('**/api/notifications', (route) => route.fulfill({ json: { notifications: [], unreadCount: 0 } }));
  await page.goto('/e2e/fixtures/notifications.html');
  await page.getByRole('button', { name: 'Notifications', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Enable browser alerts', exact: true })).toBeDisabled();
  await expect(page.getByText('Notifications are blocked.', { exact: false })).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { permissionRequests: number }).permissionRequests)).toBe(0);
});

test('unsupported browser keeps inbox and sound usable', async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(window, 'Notification', { value: undefined, configurable: true }));
  await page.route('**/api/notifications', (route) => route.fulfill({ json: { notifications: [], unreadCount: 0 } }));
  await page.goto('/e2e/fixtures/notifications.html');
  await page.getByRole('button', { name: 'Notifications', exact: true }).click();
  await expect(page.getByText('Browser alerts are unavailable in this browser.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Enable sound', exact: true })).toBeEnabled();
});

test('multiple tabs deliver once without replaying history after reload', async ({ context, page }) => {
  await mockBrowser(context, 'granted');
  await context.addInitScript(() => localStorage.setItem('helpudoc.notifications.browser.alice', JSON.stringify({ enabled: true, scope: 'all' })));
  let notifications = [event('history')];
  await context.route('**/api/notifications', (route) => route.fulfill({ json: { notifications, unreadCount: notifications.length } }));
  const second = await context.newPage();
  for (const tab of [page, second]) {
    await tab.goto('/e2e/fixtures/notifications.html');
    await expect(tab.getByRole('button', { name: 'Notifications, 1 unread', exact: true })).toBeVisible();
  }
  expect(await count(page) + await count(second)).toBe(0);
  notifications = [event('new'), ...notifications];
  await Promise.all([refresh(page), refresh(second)]);
  for (const tab of [page, second]) await expect(tab.getByRole('button', { name: 'Notifications, 2 unread', exact: true })).toBeVisible();
  await expect.poll(async () => await count(page) + await count(second)).toBe(1);
  await page.reload();
  await expect(page.getByRole('button', { name: 'Notifications, 2 unread', exact: true })).toBeVisible();
  expect(await count(page)).toBe(0);
});
