import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './tests',
  testMatch: 'subgraph-lifecycle.spec.ts',
  grep: /creates an empty subgraph|region occurrence flatten refusal/,
  timeout: 60_000,
  workers: 1,
  use: {
    baseURL: 'http://127.0.0.1:5367',
    viewport: { width: 1440, height: 900 },
  },
  webServer: {
    command: 'DINKSTER_NATIVE_BACKEND=http://127.0.0.1:8765 pnpm --filter @dinkster/app dev --host 127.0.0.1 --port 5367 --strictPort',
    url: 'http://127.0.0.1:5367',
    reuseExistingServer: false,
    cwd: '../..',
  },
})
