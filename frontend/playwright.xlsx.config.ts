import { defineConfig, devices } from '@playwright/test';

// XLSX preview browser tests (issue #106). Starts its own Vite dev server in CI;
// locally it reuses one already running on the port (default 5173).
const port = Number(process.env.XLSX_E2E_PORT) || 5173;
const baseURL = `http://localhost:${port}`;

export default defineConfig({
  testDir: './e2e',
  testMatch: 'xlsx-preview-local.spec.ts',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: `npx vite --port ${port} --strictPort`,
    url: `${baseURL}/e2e/fixtures/xlsx-preview.html`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
