import { accessSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { defineConfig } from '@playwright/test'
import baseConfig from './playwright.config.js'

const argumentProject = process.argv
  .find((arg) => arg.startsWith('--project='))
  ?.slice('--project='.length)
if (argumentProject) process.env['DINKSTER_E2E_PROJECT'] = argumentProject
const selectedProject =
  argumentProject ?? process.env['DINKSTER_E2E_PROJECT']
const stubV1Entry = selectedProject === 'native-without-v1' ? '1' : '0'
const stockV1Only = selectedProject === 'v1-compatibility'
const probeV1 = stubV1Entry === '1' ? '0' : '1'
// Route-mocked specs normally stay on v1 even when live native coverage is enabled.
// The native dependency-boundary project must keep every page on the native path.
process.env['DINKSTER_E2E_FIXTURE_MODE'] =
  stubV1Entry === '1' ? 'native' : 'legacy'
const nativePackSelection = stubV1Entry === '1' ? ['--no-default-packs'] : []

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
const comfyRoot = requiredDirectory('DINKSTER_E2E_COMFY_ROOT')
const dinksterRoot = requiredDirectory('DINKSTER_E2E_DINKSTER_ROOT')
const nativeLibrary = resolve(frontendRoot, '.ci/native-library')
const nativeOutput = resolve(nativeLibrary, 'output')
if (selectedProject === 'native-without-v1') {
  rmSync(nativeLibrary, { recursive: true, force: true })
  mkdirSync(nativeOutput, { recursive: true })
  mkdirSync(resolve(nativeLibrary, 'vault'), { recursive: true })
  writeFileSync(
    resolve(nativeLibrary, 'mounts.toml'),
    `[settings]\noutput-mount = "output"\n\n[mounts.output]\npath = ${JSON.stringify(nativeOutput)}\nmode = "readwrite"\n`,
  )
}
const checkpointFixture = resolve(
  comfyRoot,
  'models/checkpoints/audit-local-checkpoint.safetensors',
)
mkdirSync(resolve(comfyRoot, 'models/checkpoints'), { recursive: true })
writeFileSync(checkpointFixture, 'Dinkster hosted E2E checkpoint fixture\n')
const nativeComfySelection =
  stubV1Entry === '1'
    ? []
    : [
        `--comfy-root ${JSON.stringify(comfyRoot)}`,
        `--execution-python ${JSON.stringify(resolve(comfyRoot, 'venv/bin/python'))}`,
      ]
const frontendPort = port('DINKSTER_E2E_PORT', 5410)
const comfyPort = port('DINKSTER_E2E_COMFY_PORT', 5411)
const nativePort = port('DINKSTER_E2E_NATIVE_PORT', 5412)
const nativeFrontendPort = port(
  'DINKSTER_E2E_NATIVE_FRONTEND_PORT',
  frontendPort + 3,
)
if (
  new Set([frontendPort, comfyPort, nativePort, nativeFrontendPort]).size !== 4
)
  throw new Error('hosted E2E ports must differ')
const nativeBackend = `http://127.0.0.1:${nativePort}`
process.env['DINKSTER_E2E_NATIVE_FRONTEND'] =
  `http://127.0.0.1:${nativeFrontendPort}`

export default defineConfig({
  ...baseConfig,
  ...(stockV1Only ? {} : { globalSetup: './hosted-global-setup.ts' }),
  use: {
    ...baseConfig.use,
    baseURL: `http://127.0.0.1:${stubV1Entry === '1' ? nativeFrontendPort : frontendPort}`,
  },
  webServer: [
    {
      command: `${JSON.stringify(resolve(comfyRoot, 'venv/bin/python'))} main.py --cpu --listen 127.0.0.1 --port ${comfyPort} --disable-auto-launch`,
      cwd: comfyRoot,
      env: { ...process.env, CUDA_VISIBLE_DEVICES: '' },
      url: `http://127.0.0.1:${comfyPort}/system_stats`,
      reuseExistingServer: false,
      timeout: 180_000,
    },
    {
      command: [
        JSON.stringify(resolve(dinksterRoot, '.venv/bin/dinkster-serve')),
        '--host 127.0.0.1',
        `--port ${nativePort}`,
        '--disable-p2p',
        ...nativePackSelection,
        `--pack ${JSON.stringify(resolve(dinksterRoot, 'packages/dinkster-nodes-dev/dinkster-pack.toml'))}`,
        `--allow-origin http://127.0.0.1:${frontendPort}`,
        `--allow-origin http://127.0.0.1:${nativeFrontendPort}`,
        `--library-root ${JSON.stringify(nativeLibrary)}`,
        '--execution-cache-mode memory',
        '--allow-mount-changes',
        ...nativeComfySelection,
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
        DINKSTER_BACKEND: `http://127.0.0.1:${comfyPort}`,
        DINKSTER_NATIVE_BACKEND: nativeBackend,
        DINKSTER_STUB_V1_ENTRY: stubV1Entry,
        VITE_DINKSTER_E2E_PROBE_V1: probeV1,
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
        DINKSTER_STUB_V1_ENTRY: stubV1Entry,
        VITE_DINKSTER_E2E_PROBE_V1: '0',
      },
      url: `http://127.0.0.1:${nativeFrontendPort}`,
      reuseExistingServer: false,
      timeout: 180_000,
    },
  ],
})
