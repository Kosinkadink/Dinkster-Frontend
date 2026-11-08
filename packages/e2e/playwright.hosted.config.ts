import { accessSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { defineConfig } from '@playwright/test'
import baseConfig from './playwright.config.js'

const argumentProject = process.argv
  .find((arg) => arg.startsWith('--project='))
  ?.slice('--project='.length)
if (argumentProject) process.env['DINKSTER_E2E_PROJECT'] = argumentProject
const selectedProject = argumentProject ?? process.env['DINKSTER_E2E_PROJECT']
const nativeStartup = selectedProject === 'native-startup'

const requiredDirectory = (name: string): string => {
  const value = process.env[name]
  if (!value) throw new Error(`${name} must point to a checkout`)
  const directory = resolve(value)
  accessSync(directory)
  return directory
}

const port = (name: string, fallback: number): number => {
  const value = Number(process.env[name] ?? fallback)
  if (
    !Number.isSafeInteger(value) ||
    value < 1024 ||
    value > 65535 ||
    value === 5199 ||
    value === 8765
  ) {
    throw new Error(`${name} must be a valid unprotected port`)
  }
  return value
}

const frontendRoot = resolve(import.meta.dirname, '../..')
const dinksterRoot = requiredDirectory('DINKSTER_E2E_DINKSTER_ROOT')
const nativeLibrary = resolve(frontendRoot, '.ci/native-library')
const nativeOutput = resolve(nativeLibrary, 'output')
const nativeCheckpoints = resolve(nativeLibrary, 'checkpoints')
if (argumentProject) {
  // Catalog preparation creates pack environments and schema data here before
  // Playwright loads this config. Reset only mutable test state so the native
  // server can still compose those prepared default packs.
  rmSync(nativeOutput, { recursive: true, force: true })
  rmSync(resolve(nativeLibrary, 'vault'), { recursive: true, force: true })
  rmSync(resolve(nativeLibrary, 'project-folders.json'), { force: true })
  rmSync(resolve(nativeLibrary, 'value-store'), {
    recursive: true,
    force: true,
  })
  rmSync(resolve(nativeLibrary, 'worker-state'), {
    recursive: true,
    force: true,
  })
  mkdirSync(nativeOutput, { recursive: true })
  mkdirSync(resolve(nativeLibrary, 'vault'), { recursive: true })
  writeFileSync(
    resolve(nativeLibrary, 'settings.json'),
    JSON.stringify({ features: { templates: { enabled: true } } }),
  )
  writeFileSync(
    resolve(nativeLibrary, 'mounts.toml'),
    `[settings]\noutput-mount = "output"\n\n[mounts.output]\npath = ${JSON.stringify(nativeOutput)}\nmode = "readwrite"\n\n[mounts.checkpoints]\npath = ${JSON.stringify(nativeCheckpoints)}\nmode = "read"\nkind = "model/checkpoint"\n`,
  )
}
const checkpointFixture = resolve(
  nativeCheckpoints,
  'audit-local-checkpoint.safetensors',
)
mkdirSync(nativeCheckpoints, { recursive: true })
writeFileSync(checkpointFixture, 'Dinkster hosted E2E checkpoint fixture\n')
const frontendPort = port('DINKSTER_E2E_PORT', 5410)
const nativePort = port('DINKSTER_E2E_NATIVE_PORT', 5412)
const nativeFrontendPort = port(
  'DINKSTER_E2E_NATIVE_FRONTEND_PORT',
  frontendPort + 3,
)
if (new Set([frontendPort, nativePort, nativeFrontendPort]).size !== 3)
  throw new Error('hosted E2E ports must differ')
const nativeBackend = `http://127.0.0.1:${nativePort}`
process.env['DINKSTER_NATIVE_BACKEND'] = nativeBackend
process.env['DINKSTER_E2E_NATIVE_FRONTEND'] =
  `http://127.0.0.1:${nativeFrontendPort}`

export default defineConfig({
  ...baseConfig,
  globalSetup: nativeStartup
    ? './hosted-live-vitest-setup.ts'
    : './hosted-global-setup.ts',
  use: {
    ...baseConfig.use,
    baseURL: `http://127.0.0.1:${nativeStartup ? nativeFrontendPort : frontendPort}`,
  },
  webServer: [
    {
      command: [
        JSON.stringify(resolve(dinksterRoot, '.venv/bin/dinkster-serve')),
        '--host 127.0.0.1',
        '--allow-host localhost',
        `--port ${nativePort}`,
        '--engine-variant linux-cpu',
        `--pack ${JSON.stringify(resolve(dinksterRoot, 'packages/dinkster-nodes-dev/dinkster-pack.toml'))}`,
        `--allow-origin http://127.0.0.1:${frontendPort}`,
        `--allow-origin http://127.0.0.1:${nativeFrontendPort}`,
        `--library-root ${JSON.stringify(nativeLibrary)}`,
        '--execution-cache-mode memory',
        '--allow-mount-changes',
        `--execution-python ${JSON.stringify(resolve(dinksterRoot, '.venv-torch/bin/python'))}`,
      ].join(' '),
      cwd: dinksterRoot,
      env: { ...process.env, CUDA_VISIBLE_DEVICES: '' },
      url: `${nativeBackend}/api/health`,
      reuseExistingServer: false,
      timeout: 180_000,
    },
    {
      command: `pnpm --filter @dinkster/app dev --host 127.0.0.1 --port ${frontendPort} --strictPort`,
      cwd: frontendRoot,
      env: {
        ...process.env,
        DINKSTER_NATIVE_BACKEND: nativeBackend,
      },
      url: `http://127.0.0.1:${frontendPort}`,
      reuseExistingServer: false,
      timeout: 180_000,
    },
    {
      command: `pnpm --filter @dinkster/app dev --host 127.0.0.1 --port ${nativeFrontendPort} --strictPort`,
      cwd: frontendRoot,
      env: {
        ...process.env,
        DINKSTER_NATIVE_BACKEND: nativeBackend,
      },
      url: `http://127.0.0.1:${nativeFrontendPort}`,
      reuseExistingServer: false,
      timeout: 180_000,
    },
  ].map((server) => ({ ...server, stdout: 'pipe' as const })),
})
