import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './tests',
  testMatch: 'audit-t6a-compaction.spec.ts',
  timeout: 30_000,
  workers: 1,
  reporter: 'line',
  use: {
    baseURL: 'http://127.0.0.1:5320',
    headless: true,
    viewport: { width: 1280, height: 900 },
  },
  webServer: {
    command: 'pnpm -C ../app exec vite --host 127.0.0.1 --port 5320 --strictPort',
    url: 'http://127.0.0.1:5320',
    reuseExistingServer: false,
    timeout: 30_000,
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
})
