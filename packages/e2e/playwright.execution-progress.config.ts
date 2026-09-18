import { defineConfig } from '@playwright/test'

const frontendPort = Number(process.env['DINKSTER_E2E_PORT'] ?? 5309)
const fixturePort = Number(process.env['DINKSTER_E2E_FIXTURE_PORT'] ?? 5319)

export default defineConfig({
  testDir: './tests',
  testMatch: 'execution-progress.spec.ts',
  timeout: 30_000,
  workers: 1,
  projects: [{ name: 'chromium' }],
  use: {
    baseURL: `http://127.0.0.1:${frontendPort}`,
    viewport: { width: 1600, height: 950 },
  },
  webServer: [
    {
      command: `node packages/e2e/bench/local-comfy-fixture.mjs --port ${fixturePort}`,
      url: `http://127.0.0.1:${fixturePort}/system_stats`,
      reuseExistingServer: false,
      cwd: '../..',
    },
    {
      command: `pnpm --filter @dinkster/app dev --host 127.0.0.1 --port ${frontendPort} --strictPort`,
      env: {
        ...process.env,
        DINKSTER_BACKEND: `http://127.0.0.1:${fixturePort}`,
        DINKSTER_NATIVE_BACKEND: 'http://127.0.0.1:9',
      },
      url: `http://127.0.0.1:${frontendPort}`,
      reuseExistingServer: false,
      cwd: '../..',
    },
  ],
})
