import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './tests',
  testMatch: 'file-drop.spec.ts',
  timeout: 60_000,
  workers: 1,
  reporter: 'line',
  use: {
    baseURL: 'http://127.0.0.1:5386',
    viewport: { width: 1440, height: 900 },
    headless: true,
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
  webServer: {
    command: 'pnpm --filter @dinkster/app dev --host 127.0.0.1 --port 5386 --strictPort',
    url: 'http://127.0.0.1:5386',
    cwd: '../..',
    reuseExistingServer: false,
  },
})
