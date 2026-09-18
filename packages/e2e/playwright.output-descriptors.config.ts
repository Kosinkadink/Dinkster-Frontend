import { defineConfig } from '@playwright/test'

const port = Number(process.env['DINKSTER_E2E_PORT'] ?? '5487')
if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid DINKSTER_E2E_PORT')

export default defineConfig({
  testDir: './tests', testMatch: 'output-descriptors.spec.ts', workers: 1, timeout: 60_000,
  use: { baseURL: `http://127.0.0.1:${port}`, headless: true, viewport: { width: 1600, height: 950 } },
  webServer: {
    command: `pnpm --filter @dinkster/app preview --host 127.0.0.1 --port ${port} --strictPort`,
    url: `http://127.0.0.1:${port}`, cwd: '../..', reuseExistingServer: false,
  },
})
