import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './tests',
  testMatch: 'audit-f7-proof.spec.ts',
  timeout: 60_000,
  workers: 1,
  use: {
    baseURL: 'http://127.0.0.1:5360',
    viewport: { width: 1440, height: 900 },
  },
  webServer: {
    command: 'DINKSTER_NATIVE_BACKEND=http://127.0.0.1:9 pnpm --filter @dinkster/app dev --host 127.0.0.1 --port 5360 --strictPort',
    url: 'http://127.0.0.1:5360',
    reuseExistingServer: false,
    cwd: '../..',
  },
})
