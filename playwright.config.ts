import { defineConfig, devices } from '@playwright/test'

/**
 * The port the app runs on, matching `package.json`'s `dev` and `start` scripts.
 *
 * **Not 3000.** That port collects orphans — anything else a Node project on this machine
 * has left running claims it first, `next dev` then fails with `EADDRINUSE`, and because
 * `reuseExistingServer` is on below, Playwright cheerfully tests whatever *is* answering
 * there. That failure mode is silent and expensive: it looks exactly like passing tests.
 *
 * `PORT` overrides it in both places, so there is one source of truth and a way out if
 * 41733 is ever taken too.
 */
const PORT = process.env.PORT ?? '41733'
const BASE_URL = `http://127.0.0.1:${PORT}`

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: { baseURL: BASE_URL, trace: 'retain-on-failure' },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } },
    { name: 'board', use: { ...devices['Desktop Chrome'], viewport: { width: 1600, height: 600 } } },
    { name: 'mobile', use: { ...devices['iPhone 14 Pro Max'] } },
  ],
  webServer: {
    command: 'npm run dev',
    url: BASE_URL,
    // The spawned server inherits this, so an overridden PORT reaches the npm script too.
    env: { PORT },
    reuseExistingServer: true,
    timeout: 180_000,
  },
})
