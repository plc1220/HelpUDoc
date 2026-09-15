import { test, expect } from '@playwright/test';

test('notification badge, inbox, read actions, live alerts and deep links', async ({ page }) => {
  let notifications = [
    { id: '11111111-1111-5111-a111-111111111111', eventType: 'agent.feedback_required', readAt: null as string | null, createdAt: new Date().toISOString(), payload: { title: 'Agent needs your feedback', description: 'Choose a format', workspaceId: 'workspace-a', conversationId: 'conversation-a' } },
    { id: '22222222-2222-5222-a222-222222222222', eventType: 'chat.mentioned', readAt: null as string | null, createdAt: new Date().toISOString(), payload: { title: 'You were mentioned in team chat', description: 'Please review', workspaceId: 'workspace-b', messageId: 'message-b' } },
  ];
  await page.route('**/notifications**', async (route) => {
    const url = new URL(route.request().url());
    if (!url.pathname.includes('/api/')) return route.continue();
    if (route.request().method() === 'POST') {
      notifications = notifications.map((item) => url.pathname.endsWith('/read-all') || url.pathname.includes(item.id) ? { ...item, readAt: new Date().toISOString() } : item);
      return route.fulfill({ status: 204 });
    }
    return route.fulfill({ json: { notifications, unreadCount: notifications.filter((item) => !item.readAt).length } });
  });
  await page.goto('/e2e/fixtures/notifications.html');
  await page.getByRole('button', { name: 'Notifications, 2 unread', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Notifications' })).toBeVisible();
  await page.getByRole('button', { name: /Agent needs your feedback Choose a format/ }).click();
  await expect(page.getByLabel('Destination')).toContainText('conversationId=conversation-a');
  await page.getByRole('button', { name: 'Notifications, 1 unread', exact: true }).click();
  await page.getByRole('button', { name: /You were mentioned in team chat Please review/ }).click();
  await expect(page.getByLabel('Destination')).toContainText('messageId=message-b');
  notifications.unshift({ ...notifications[0], id: '33333333-3333-5333-a333-333333333333', readAt: null, payload: { title: 'Agent finished your task', description: 'Ready', workspaceId: 'workspace-a' } });
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.locator('.MuiSnackbarContent-message').filter({ hasText: 'Agent finished your task' })).toBeVisible();
  await page.getByRole('button', { name: 'Notifications, 1 unread', exact: true }).click();
  await page.getByRole('button', { name: 'Mark all read' }).click();
  await expect(page.getByRole('button', { name: 'Mark all read' })).toBeDisabled();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Notifications', exact: true })).toBeVisible();
});

test('notification inbox recovers from an API error and fits a mobile viewport', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  let fail = true;
  await page.route('**/api/notifications', async (route) => route.fulfill(fail
    ? { status: 500, json: { error: 'Unavailable' } }
    : { json: { notifications: [], unreadCount: 0 } }));
  await page.goto('/e2e/fixtures/notifications.html');
  await page.getByRole('button', { name: 'Notifications', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Could not load notifications');
  fail = false;
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(page.getByText('You’re all caught up.')).toBeVisible();
  const panel = await page.locator('.MuiPopover-paper').boundingBox();
  expect(panel).not.toBeNull();
  expect(panel!.x).toBeGreaterThanOrEqual(0);
  expect(panel!.x + panel!.width).toBeLessThanOrEqual(390);
  await page.screenshot({ path: '/tmp/helpudoc-notifications-mobile.png' });
});

test('sound plays once for new alerts, stays silent for history, and remembers mute', async ({ page }) => {
  await page.addInitScript(() => {
    const original = AudioContext.prototype.createOscillator;
    Object.assign(window, { notificationToneCount: 0 });
    AudioContext.prototype.createOscillator = function (...args) {
      const oscillator = original.apply(this, args);
      const start = oscillator.start.bind(oscillator);
      oscillator.start = (when?: number) => {
        const state = window as unknown as { notificationToneCount: number };
        state.notificationToneCount += 1;
        start(when);
      };
      return oscillator;
    };
  });
  const notifications = [{ id: 'old', eventType: 'agent.completed', readAt: null, createdAt: new Date().toISOString(), payload: { title: 'An old task' } }];
  await page.route('**/api/notifications', (route) => route.fulfill({ json: { notifications, unreadCount: notifications.length } }));
  const toneCount = () => page.evaluate(() => (window as unknown as { notificationToneCount: number }).notificationToneCount);
  await page.goto('/e2e/fixtures/notifications.html');
  await page.getByRole('button', { name: 'Notifications, 1 unread', exact: true }).click();
  expect(await toneCount()).toBe(0);
  await page.getByRole('button', { name: 'Enable sound', exact: true }).click();
  await expect.poll(toneCount).toBe(2); // Two notes in the preview chime.
  await page.reload();
  await page.getByRole('button', { name: 'Notifications, 1 unread', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Mute sound', exact: true })).toBeVisible();
  expect(await toneCount()).toBe(0); // A saved preference does not replay old notifications.
  await page.getByRole('button', { name: 'Test sound', exact: true }).click();
  await expect.poll(toneCount).toBe(2);
  await page.keyboard.press('Escape');
  let expectedTones = 2;
  for (const eventType of ['agent.completed', 'agent.feedback_required', 'chat.mentioned']) {
    notifications.unshift({ ...notifications[0], id: eventType, eventType });
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    expectedTones += 2;
    await expect.poll(toneCount).toBe(expectedTones);
  }
  await page.getByRole('button', { name: 'Notifications, 4 unread', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Notifications' })).toBeVisible();
  expect(await toneCount()).toBe(expectedTones); // Refreshing the same alerts is silent.
  await page.getByRole('button', { name: 'Mute sound', exact: true }).click();
  notifications.unshift({ ...notifications[0], id: 'muted-alert' });
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Notifications, 5 unread', exact: true })).toBeVisible();
  expect(await toneCount()).toBe(expectedTones);
  await page.reload();
  await page.getByRole('button', { name: 'Notifications, 5 unread', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Enable sound', exact: true })).toBeVisible();
  expect(await toneCount()).toBe(0);
});

test('unavailable audio leaves the notification inbox usable', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'AudioContext', { value: function () { throw new Error('Audio is blocked'); } });
  });
  await page.route('**/api/notifications', (route) => route.fulfill({ json: { notifications: [], unreadCount: 0 } }));
  await page.goto('/e2e/fixtures/notifications.html');
  await page.getByRole('button', { name: 'Notifications', exact: true }).click();
  await page.getByRole('button', { name: 'Enable sound', exact: true }).click();
  await expect(page.getByText('Sound is unavailable or paused. Try Test sound again.')).toBeVisible();
  await expect(page.getByText('You’re all caught up.')).toBeVisible();
  await page.getByRole('button', { name: 'Mute sound', exact: true }).click();
  await expect(page.getByText('Sound is unavailable or paused. Try Test sound again.')).toHaveCount(0);
});
