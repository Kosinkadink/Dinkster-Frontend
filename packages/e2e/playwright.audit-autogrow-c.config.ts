import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './tests',
  testMatch: 'audit-autogrow-c-proof.spec.ts',
  timeout: 60_000,
  workers: 1,
  reporter: 'line',
  use: {
    baseURL: 'http://127.0.0.1:5370',
    headless: true,
    viewport: { width: 1440, height: 900 },
  },
  webServer: {
    command: 'DINKSTER_NATIVE_BACKEND=http://127.0.0.1:9 pnpm --filter @dinkster/app dev --host 127.0.0.1 --port 5370 --strictPort',
    url: 'http://127.0.0.1:5370',
    reuseExistingServer: false,
    cwd: '../..',
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
})
