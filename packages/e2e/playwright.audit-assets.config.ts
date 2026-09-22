import { accessSync } from 'node:fs'
import { resolve } from 'node:path'
import { defineConfig } from '@playwright/test'

const requiredDirectory = (name: string): string => {
  const value = process.env[name]
  if (!value) throw new Error(`${name} must point to a checkout`)
  const directory = resolve(value)
  accessSync(directory)
  return directory
}

const port = Number(process.env['DINKSTER_E2E_PORT'] ?? '5376')
if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid DINKSTER_E2E_PORT')
const nativePort = Number(process.env['DINKSTER_E2E_NATIVE_PORT'] ?? '5377')
if (!Number.isSafeInteger(nativePort) || nativePort < 1024 || nativePort > 65535 || nativePort === port) {
  throw new Error('Invalid DINKSTER_E2E_NATIVE_PORT')
}
const frontendRoot = resolve(import.meta.dirname, '../..')
const dinksterRoot = requiredDirectory('DINKSTER_E2E_DINKSTER_ROOT')
const nativeBackend = `http://127.0.0.1:${nativePort}`
process.env['DINKSTER_NATIVE_BACKEND'] = nativeBackend

export default defineConfig({
  globalSetup: './hosted-global-setup.ts',
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
  webServer: [
    {
      command: [
        JSON.stringify(resolve(dinksterRoot, '.venv/bin/dinkster-serve')),
        '--host 127.0.0.1',
        `--port ${nativePort}`,
        '--disable-p2p',
        `--pack ${JSON.stringify(resolve(dinksterRoot, 'packages/dinkster-nodes-dev/dinkster-pack.toml'))}`,
        `--library-root ${JSON.stringify(resolve(frontendRoot, '.ci/native-library'))}`,
      ].join(' '),
      cwd: dinksterRoot,
      url: `${nativeBackend}/api/health`,
      reuseExistingServer: false,
      timeout: 180_000,
    },
    {
      command: `pnpm --filter @dinkster/app dev --host 127.0.0.1 --port ${port} --strictPort`,
      url: `http://127.0.0.1:${port}`,
      cwd: frontendRoot,
      reuseExistingServer: false,
      env: {
        DINKSTER_NATIVE_BACKEND: nativeBackend,
        VITE_DINKSTER_E2E_PROBE_V1: '0',
        VITE_DINKSTER_FEDERATED_CATALOG_PATH: '/api/catalog',
        VITE_DINKSTER_FEDERATED_CANDIDATES_PATH: '/api/catalog/candidates',
      },
    },
  ],
})
