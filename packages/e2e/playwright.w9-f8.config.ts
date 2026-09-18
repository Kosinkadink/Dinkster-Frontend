import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './tests',
  testMatch: 'w9-f8-media-upload.spec.ts',
  timeout: 60_000,
  workers: 1,
  use: {
    baseURL: 'http://127.0.0.1:5362',
    viewport: { width: 1440, height: 900 },
  },
  webServer: {
    command: 'pnpm --filter @dinkster/app dev --host 127.0.0.1 --port 5362 --strictPort',
    url: 'http://127.0.0.1:5362',
    reuseExistingServer: false,
    cwd: '../..',
  },
})
