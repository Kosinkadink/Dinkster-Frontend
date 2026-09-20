import { accessSync } from 'node:fs'
import { resolve } from 'node:path'
import { defineConfig } from '@playwright/test'
import baseConfig from './playwright.config.js'

const requiredDirectory = (name: string): string => {
  const value = process.env[name]
  if (!value) throw new Error(`${name} must point to a checkout`)
  const directory = resolve(value)
  accessSync(directory)
  return directory
}

const port = (name: string, fallback: number): number => {
  const value = Number(process.env[name] ?? fallback)
  if (!Number.isSafeInteger(value) || value < 1024 || value > 65535) {
    throw new Error(`${name} must be a valid unprotected port`)
  }
  return value
}

const frontendRoot = resolve(import.meta.dirname, '../..')
const dinksterRoot = requiredDirectory('DINKSTER_E2E_DINKSTER_ROOT')
const python =
  process.env['DINKSTER_E2E_DINKSTER_PYTHON'] ??
  resolve(
    dinksterRoot,
    process.platform === 'win32'
      ? '.venv/Scripts/python.exe'
      : '.venv/bin/python',
  )
accessSync(python)
const frontendPort = port('DINKSTER_E2E_PORT', 5420)
const nativePort = port('DINKSTER_E2E_NATIVE_PORT', 5421)
if (frontendPort === nativePort)
  throw new Error('extension contract ports must differ')
const nativeBackend = `http://127.0.0.1:${nativePort}`
process.env['DINKSTER_NATIVE_BACKEND'] = nativeBackend
const pack = resolve(
  dinksterRoot,
  'packages/dinkster-nodes-dev/extension-contract-pack.toml',
)
accessSync(pack)

export default defineConfig({
  testDir: './tests',
  testMatch: ['extension-contract-pack.spec.ts'],
  timeout: 90_000,
  workers: 1,
  use: {
    ...baseConfig.use,
    baseURL: `http://127.0.0.1:${frontendPort}`,
  },
  globalSetup: './hosted-global-setup.ts',
  webServer: [
    {
      command: [
        JSON.stringify(python),
        '-m dinkster.serve',
        '--host 127.0.0.1',
        `--port ${nativePort}`,
        '--no-default-packs',
        `--pack ${JSON.stringify(pack)}`,
        '--disable-p2p',
        `--allow-origin http://127.0.0.1:${frontendPort}`,
        `--library-root ${JSON.stringify(resolve(frontendRoot, '.ci/extension-contract-library'))}`,
      ].join(' '),
      cwd: dinksterRoot,
      env: { ...process.env, DINKSTER_SERVING_PYTHON: python },
      url: `${nativeBackend}/api/health`,
      reuseExistingServer: false,
      timeout: 180_000,
    },
    {
      command: `pnpm --filter @dinkster/app dev --host 127.0.0.1 --port ${frontendPort} --strictPort`,
      cwd: frontendRoot,
      env: { ...process.env, DINKSTER_NATIVE_BACKEND: nativeBackend },
      url: `http://127.0.0.1:${frontendPort}`,
      reuseExistingServer: false,
      timeout: 180_000,
    },
  ],
})
