import { defineConfig } from '@playwright/test'

/**
 * Isolated native-browser proofs. Run from packages/e2e with:
 * pnpm exec playwright test --config=playwright.isolated.config.ts <specs>
 *
 * This owns :5299 for the duration of the run and never reuses :5199.
 */
process.env['DINKSTER_E2E_USE_NATIVE'] = '1'

export default defineConfig({
  testDir: './tests',
  timeout: 60_000,
  workers: 1,
  use: {
    baseURL: 'http://127.0.0.1:5299',
    viewport: { width: 1440, height: 900 },
  },
  webServer: {
    command: 'pnpm --filter @dinkster/app dev --host 127.0.0.1 --port 5299 --strictPort',
    url: 'http://127.0.0.1:5299',
    reuseExistingServer: false,
    env: { DINKSTER_NATIVE_BACKEND: process.env['DINKSTER_NATIVE_BACKEND'] ?? 'http://127.0.0.1:8765' },
    cwd: '../..',
  },
})
