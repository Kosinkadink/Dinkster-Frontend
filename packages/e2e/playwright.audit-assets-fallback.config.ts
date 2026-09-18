import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './tests',
  testMatch: 'audit-assets-fallback.spec.ts',
  timeout: 60_000,
  workers: 1,
  reporter: 'line',
  use: {
    baseURL: 'http://127.0.0.1:5376',
    headless: true,
    viewport: { width: 1600, height: 950 },
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
  webServer: {
    command: 'pnpm --filter @dinkster/app dev --host 127.0.0.1 --port 5376 --strictPort',
    url: 'http://127.0.0.1:5376',
    cwd: '../..',
    reuseExistingServer: false,
  },
})
