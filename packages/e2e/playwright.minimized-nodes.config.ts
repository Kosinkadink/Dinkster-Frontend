import { defineConfig } from '@playwright/test'

const port = Number(process.env['DINKSTER_E2E_PORT'] ?? '5387')
if (!Number.isSafeInteger(port) || port < 1024 || port > 65535 || port === 5199 || port === 8765) {
  throw new Error('DINKSTER_E2E_PORT must be a valid unprotected port')
}

export default defineConfig({
  testDir: './tests',
  testMatch: 'minimized-nodes.spec.ts',
  timeout: 60_000,
  workers: 1,
  reporter: 'line',
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    headless: true,
    viewport: { width: 1440, height: 900 },
  },
  projects: [
    { name: 'chromium-dpr1', use: { browserName: 'chromium', deviceScaleFactor: 1 } },
    { name: 'chromium-dpr2', use: { browserName: 'chromium', deviceScaleFactor: 2 } },
  ],
  webServer: {
    command: `pnpm --filter @dinkster/app dev --host 127.0.0.1 --port ${port} --strictPort`,
    url: `http://127.0.0.1:${port}`,
    cwd: '../..',
    reuseExistingServer: false,
  },
})
