import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './tests',
  testMatch: 'collaboration-management.spec.ts',
  timeout: 60_000,
  workers: 1,
  use: {
    baseURL: 'http://127.0.0.1:5298',
    viewport: { width: 1440, height: 900 },
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'DINKSTER_NATIVE_BACKEND=http://127.0.0.1:8798 DINKSTER_V1_BACKEND=http://127.0.0.1:8798 pnpm --filter @dinkster/app dev --host 127.0.0.1 --port 5298 --strictPort',
    url: 'http://127.0.0.1:5298',
    reuseExistingServer: false,
    cwd: '../..',
  },
})
