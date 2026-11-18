import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './test',
  workers: 1,
  retries: 0,
  use: {
    baseURL: 'http://127.0.0.1:5287',
    browserName: 'chromium',
    viewport: { width: 1280, height: 900 },
  },
  webServer: {
    command:
      'pnpm build && pnpm exec vite preview --host 127.0.0.1 --port 5287 --strictPort',
    url: 'http://127.0.0.1:5287/account-view.js',
    reuseExistingServer: false,
  },
})
