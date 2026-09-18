import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './tests',
  testMatch: 'widget-picker-facets-logical-model.spec.ts',
  timeout: 60_000,
  workers: 1,
  reporter: 'line',
  use: { baseURL: 'http://127.0.0.1:5384', headless: true },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
  webServer: {
    command: 'pnpm --filter @dinkster/app dev --host 127.0.0.1 --port 5384 --strictPort',
    url: 'http://127.0.0.1:5384',
    cwd: '../..',
    reuseExistingServer: false,
    env: {
      VITE_DINKSTER_FEDERATED_CATALOG_PATH: '/api/catalog',
      VITE_DINKSTER_FEDERATED_CANDIDATES_PATH: '/api/catalog/candidates',
    },
  },
})
