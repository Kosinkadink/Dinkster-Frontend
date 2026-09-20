import { defineConfig } from '@playwright/test'

const port = Number(process.env['DINKSTER_E2E_PORT'] ?? '5376')
if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid DINKSTER_E2E_PORT')

export default defineConfig({
  testDir: './tests',
  testMatch: ['audit-assets-surface.spec.ts', 'import-subgraphs.spec.ts', 'boundary-conditional.spec.ts', 'boundary-output-families.spec.ts', 'boundary-output-refusals.spec.ts', 'media-metadata.spec.ts', 'image-batch.spec.ts', 'video-preview-controls.spec.ts', 'video-edit.spec.ts', 'timeline-viewport.spec.ts', 'deprecation.spec.ts', 'audio-controls.spec.ts', 'image-document-graph.spec.ts', 'image-editor.spec.ts', 'schema41-stream.spec.ts', 'extensions.spec.ts', 'extension-panes.spec.ts', 'delegated-agents.spec.ts'],
  timeout: 60_000,
  workers: 1,
  reporter: 'line',
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    headless: true,
    viewport: { width: 1600, height: 950 },
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
  webServer: {
    command: `pnpm --filter @dinkster/app dev --host 127.0.0.1 --port ${port} --strictPort`,
    url: `http://127.0.0.1:${port}`,
    cwd: '../..',
    reuseExistingServer: false,
    env: {
      VITE_DINKSTER_FEDERATED_CATALOG_PATH: '/api/catalog',
      VITE_DINKSTER_FEDERATED_CANDIDATES_PATH: '/api/catalog/candidates',
      VITE_DINKSTER_DEFAULT_PROTOCOL: 'v1',
    },
  },
})
