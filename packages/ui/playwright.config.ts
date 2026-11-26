import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './test',
  fullyParallel: false,
  workers: 2,
  retries: 0,
  use: {
    baseURL: 'http://127.0.0.1:5277',
    browserName: 'chromium',
    // Keep canvas pixels independent of Chromium's cold/warm raster backend.
    launchOptions: { args: ['--disable-accelerated-2d-canvas'] },
    viewport: { width: 1280, height: 900 },
    contextOptions: { reducedMotion: 'reduce' },
  },
  webServer: {
    command:
      'pnpm build && pnpm exec vite preview --host 127.0.0.1 --port 5277 --strictPort',
    url: 'http://127.0.0.1:5277',
    reuseExistingServer: false,
  },
})
