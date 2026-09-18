import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './tests',
  testMatch: 'asset-browser.spec.ts',
  grep: /selected image assets preview/,
  timeout: 60_000,
  workers: 1,
  reporter: 'line',
  use: {
    baseURL: 'http://127.0.0.1:5379',
    headless: true,
    viewport: { width: 1920, height: 1080 },
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
  webServer: {
    command: 'pnpm --filter @dinkster/app dev --host 127.0.0.1 --port 5379 --strictPort',
    url: 'http://127.0.0.1:5379',
    cwd: '../..',
    reuseExistingServer: false,
    env: { DINKSTER_NATIVE_BACKEND: 'http://asset-browser.test' },
  },
})
