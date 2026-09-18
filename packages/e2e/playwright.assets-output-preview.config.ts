import { defineConfig } from '@playwright/test'

process.env['DINKSTER_E2E_USE_NATIVE'] = '1'

export default defineConfig({
  testDir: './tests',
  testMatch: 'assets-output-preview.spec.ts',
  timeout: 90_000,
  workers: 1,
  use: {
    baseURL: 'http://127.0.0.1:5382',
    viewport: { width: 1920, height: 1080 },
  },
  webServer: {
    command: 'pnpm --filter @dinkster/app dev --host 127.0.0.1 --port 5382 --strictPort',
    url: 'http://127.0.0.1:5382',
    reuseExistingServer: false,
    cwd: '../..',
  },
})
