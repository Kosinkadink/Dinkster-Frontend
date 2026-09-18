import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './tests',
  testMatch: ['widget-editors.spec.ts', 'editing.spec.ts'],
  grep: /tap companions|stale\/unproven companion|upside-down T/,
  timeout: 60_000,
  workers: 1,
  reporter: 'line',
  use: {
    baseURL: 'http://127.0.0.1:5391',
    headless: true,
    viewport: { width: 1440, height: 900 },
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
  webServer: {
    command: 'pnpm --filter @dinkster/app dev --host 127.0.0.1 --port 5391 --strictPort',
    url: 'http://127.0.0.1:5391',
    cwd: '../..',
    reuseExistingServer: false,
  },
})
