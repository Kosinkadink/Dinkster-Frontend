import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './tests',
  testMatch: 'selection-outline-clipping.spec.ts',
  timeout: 60_000,
  workers: 1,
  reporter: 'line',
  use: {
    baseURL: 'http://127.0.0.1:5380',
    headless: true,
    viewport: { width: 1600, height: 950 },
  },
  projects: [
    { name: 'chromium-dpr1', use: { browserName: 'chromium', deviceScaleFactor: 1 } },
    { name: 'chromium-dpr2', use: { browserName: 'chromium', deviceScaleFactor: 2 } },
  ],
  webServer: {
    command: 'pnpm --filter @dinkster/app dev --host 127.0.0.1 --port 5380 --strictPort',
    url: 'http://127.0.0.1:5380',
    cwd: '../..',
    reuseExistingServer: false,
  },
})
