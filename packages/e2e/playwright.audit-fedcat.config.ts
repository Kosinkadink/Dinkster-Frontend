import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './tests',
  testMatch: 'audit-fedcat.spec.ts',
  workers: 1,
  use: { baseURL: 'http://127.0.0.1:5364' },
  webServer: {
    command: 'pnpm --filter @dinkster/app dev --host 127.0.0.1 --port 5364 --strictPort',
    url: 'http://127.0.0.1:5364',
    cwd: '../..',
    reuseExistingServer: false,
    env: {
      VITE_DINKSTER_FEDERATED_CATALOG_PATH: '/api/catalog',
      VITE_DINKSTER_FEDERATED_CANDIDATES_PATH: '/api/catalog/candidates',
    },
  },
})
