import { defineConfig } from '@playwright/test'

// Runs against the standing deployment without mutating its services.
// Catalog routes are page-level mocks inside the spec.
export default defineConfig({
  testDir: './tests',
  testMatch: 'audit-f2-proof.spec.ts',
  timeout: 60_000,
  workers: 1,
  reporter: 'line',
  use: {
    baseURL: 'http://127.0.0.1:5199',
    headless: true,
    viewport: { width: 1440, height: 900 },
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
})
