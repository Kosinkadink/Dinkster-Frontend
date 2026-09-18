import { defineConfig } from '@playwright/test'

const port = 5397

export default defineConfig({
  testDir: './tests',
  testMatch: 'backend-runtime-management.spec.ts',
  timeout: 60_000,
  workers: 1,
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    viewport: { width: 1440, height: 900 },
    hasTouch: true,
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: `DINKSTER_NATIVE_BACKEND=http://127.0.0.1:5398 pnpm --filter @dinkster/app dev --host 127.0.0.1 --port ${port} --strictPort`,
    url: `http://127.0.0.1:${port}`,
    reuseExistingServer: false,
    cwd: '../..',
  },
})
