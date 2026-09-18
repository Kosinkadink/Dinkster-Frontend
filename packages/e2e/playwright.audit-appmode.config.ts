import { defineConfig } from '@playwright/test'

process.env['DINKSTER_E2E_USE_NATIVE'] = '1'

export default defineConfig({
  testDir: './tests',
  timeout: 60_000,
  workers: 1,
  use: {
    baseURL: 'http://127.0.0.1:5372',
    viewport: { width: 1440, height: 900 },
  },
  webServer: {
    command: 'DINKSTER_NATIVE_BACKEND=http://127.0.0.1:8765 pnpm --filter @dinkster/app dev --host 127.0.0.1 --port 5372 --strictPort',
    url: 'http://127.0.0.1:5372',
    reuseExistingServer: false,
    cwd: '../..',
  },
})
