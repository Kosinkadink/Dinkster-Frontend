import { defineConfig } from '@playwright/test'

const port = (name: string, fallback: number): number => {
  const value = Number(process.env[name] ?? fallback)
  if (!Number.isSafeInteger(value) || value < 1024 || value > 65535 || value === 5199 || value === 8765) {
    throw new Error(`${name} must be a valid unprotected port`)
  }
  return value
}

const frontendPort = port('DINKSTER_PERF_FRONTEND_PORT', 5429)
const fixturePort = port('DINKSTER_PERF_FIXTURE_PORT', 5439)
if (frontendPort === fixturePort) throw new Error('performance frontend and fixture ports must differ')

export default defineConfig({
  testDir: './tests',
  testMatch: 'perf.spec.ts',
  timeout: 60_000,
  workers: 1,
  projects: [{ name: 'backend-serial' }],
  use: {
    baseURL: `http://127.0.0.1:${frontendPort}`,
    viewport: { width: 1440, height: 900 },
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
