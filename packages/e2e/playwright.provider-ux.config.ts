import { defineConfig } from '@playwright/test'

const frontendPort = Number(process.env['DINKSTER_E2E_PORT'] ?? 5417)

export default defineConfig({
  testDir: './tests',
  testMatch: ['provider-ux.spec.ts', 'execution-arm-visibility.spec.ts'],
  timeout: 30_000,
  workers: 1,
  use: {
    baseURL: `http://127.0.0.1:${frontendPort}`,
    viewport: { width: 1440, height: 900 },
  },
  webServer: {
    command: `DINKSTER_NATIVE_BACKEND=http://127.0.0.1:9 pnpm --filter @dinkster/app dev --host 127.0.0.1 --port ${frontendPort} --strictPort`,
    url: `http://127.0.0.1:${frontendPort}`,
    reuseExistingServer: false,
    cwd: '../..',
  },
})
