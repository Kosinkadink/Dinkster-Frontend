import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './tests',
  testMatch: 'audit-tabs-proof.spec.ts',
  timeout: 30_000,
  workers: 1,
  reporter: 'line',
  use: {
    baseURL: 'http://127.0.0.1:5371',
    headless: true,
    viewport: { width: 1000, height: 700 },
  },
  webServer: {
    command: 'pnpm --filter @dinkster/app dev --host 127.0.0.1 --port 5371 --strictPort',
    url: 'http://127.0.0.1:5371/tabs-proof.html',
    reuseExistingServer: false,
    cwd: '../..',
    timeout: 30_000,
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
})
