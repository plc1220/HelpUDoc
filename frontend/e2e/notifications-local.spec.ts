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
  await expect(page.locator('.notification-toast').filter({ hasText: 'Agent finished your task' })).toBeVisible();
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
  const panel = await page.getByRole('dialog', { name: 'Notifications', exact: true }).boundingBox();
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

for (const mode of ['light', 'dark'] as const) {
  test(`notification rail position and readable Astryx ${mode} theme`, async ({ page }) => {
    await page.setViewportSize({ width: 900, height: 680 });
    await page.addInitScript((mode) => localStorage.setItem('helpudoc-color-mode', mode), mode);
    await page.route('**/api/notifications', (route) => route.fulfill({ json: {
      unreadCount: 1,
      notifications: [{ id: 'review', eventType: 'skill_review.approve', readAt: null, createdAt: '2026-08-04T04:31:52Z', payload: { description: 'The updated research skill is ready to use.' } }],
    } }));
    await page.goto('/e2e/fixtures/notifications.html');
    const bell = page.getByRole('button', { name: 'Notifications, 1 unread', exact: true });
    const bellBox = await bell.boundingBox();
    const settingsBox = await page.getByRole('button', { name: 'Settings', exact: true }).boundingBox();
    expect(bellBox!.y).toBeGreaterThan(550);
    expect(settingsBox!.y - (bellBox!.y + bellBox!.height)).toBeLessThanOrEqual(16);
    await bell.click();
    await expect(page.getByRole('button', { name: /Skill review approved/ })).toBeVisible();
    const ratios = await page.locator('.notification-inbox').evaluate((panel) => {
      const luminance = (color: string) => {
        const values = color.match(/[\d.]+/g)!.slice(0, 3).map(Number).map((value) => {
          const channel = value / 255;
          return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
        });
        return values[0] * 0.2126 + values[1] * 0.7152 + values[2] * 0.0722;
      };
      const background = luminance(getComputedStyle(panel).backgroundColor);
      return ['.notification-title', '.notification-description'].map((selector) => {
        const foreground = luminance(getComputedStyle(panel.querySelector(selector)!).color);
        return (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05);
      });
    });
    ratios.forEach((ratio) => expect(ratio).toBeGreaterThanOrEqual(4.5));
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: 'Notifications', exact: true })).not.toBeVisible();
    await expect(bell).toBeFocused();
  });
}

test('mark all read clears Unread and retains history in All', async ({ page }) => {
  let readAt: string | null = null;
  await page.route('**/api/notifications**', (route) => {
    if (route.request().method() === 'POST') { readAt = new Date().toISOString(); return route.fulfill({ status: 204 }); }
    return route.fulfill({ json: { unreadCount: readAt ? 0 : 1, notifications: [{ id: '11111111-1111-5111-a111-111111111111', eventType: 'agent.completed', readAt, createdAt: new Date().toISOString(), payload: { title: 'Report completed' } }] } });
  });
  await page.goto('/e2e/fixtures/notifications.html');
  await page.getByRole('button', { name: 'Notifications, 1 unread', exact: true }).click();
  await expect(page.getByRole('radio', { name: 'Unread', exact: true })).toBeChecked();
  await expect(page.getByRole('button', { name: /Report completed/ })).toBeVisible();
  await page.getByRole('button', { name: 'Mark all read', exact: true }).click();
  await expect(page.getByText('You’re all caught up.')).toBeVisible();
  await expect(page.getByRole('button', { name: /Report completed/ })).toHaveCount(0);
  await page.getByRole('radio', { name: 'All', exact: true }).click();
  await expect(page.getByRole('button', { name: /Report completed/ })).toBeVisible();
  await expect(page.locator('.notification-unread-dot')).toHaveCount(0);
  await page.getByRole('button', { name: 'Close notifications', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Notifications', exact: true })).not.toBeVisible();
  // Astryx suppresses trigger clicks for 50ms after dismissal to avoid reopening on the same event.
  await page.waitForTimeout(75);
  await page.getByRole('button', { name: 'Notifications', exact: true }).click();
  await expect(page.getByRole('radio', { name: 'Unread', exact: true })).toBeChecked();
  await expect(page.getByText('You’re all caught up.')).toBeVisible();
});
