import { defineConfig } from '@playwright/test'

/**
 * Runs against the standing :5199 dev server through the LAN entry point
 * (http://192.168.1.58:5199), not loopback, so the browser origin and
 * transport match what the user reports seeing. No webServer block: the
 * standing service must already be up (observation-only boundary).
 */
export default defineConfig({
  testDir: './tests',
  testMatch: ['audit-noodle-live.spec.ts', 'audit-float-paste-live.spec.ts'],
  timeout: 120_000,
  workers: 1,
  use: {
    baseURL: 'http://192.168.1.58:5199',
    viewport: { width: 1440, height: 900 },
  },
})
