import { defineConfig } from '@playwright/test'

// Served-app proof: runs against the standing deployment on :5199 (which
// proxies the live native backend on :8765). No webServer and no route
// mocks - this intentionally exercises the real deployed stack.
export default defineConfig({
  testDir: './tests',
  testMatch: 'audit-served-proof.spec.ts',
  timeout: 45_000,
  workers: 1,
  reporter: 'line',
  use: {
    baseURL: 'http://127.0.0.1:5199',
    headless: true,
    viewport: { width: 1280, height: 900 },
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
})
