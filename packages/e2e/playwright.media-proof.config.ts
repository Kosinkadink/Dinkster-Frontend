import { defineConfig } from '@playwright/test'

process.env['DINKSTER_E2E_USE_NATIVE'] = '1'

const port = (name: string, fallback: number): number => {
  const value = Number(process.env[name] ?? fallback)
  if (!Number.isSafeInteger(value) || value < 1024 || value > 65535 || value === 5199 || value === 8765) {
    throw new Error(`${name} must be a valid unprotected port`)
  }
  return value
}

const frontendPort = port('DINKSTER_MEDIA_PROOF_FRONTEND_PORT', 5312)
const repoRoot = process.env['DINKSTER_MEDIA_PROOF_REPO_ROOT'] ?? '../..'

export default defineConfig({
  testDir: './tests',
  testMatch: 'media-overlay-proof.spec.ts',
  timeout: 60_000,
  workers: 1,
  use: {
    baseURL: `http://127.0.0.1:${frontendPort}`,
    viewport: { width: 1440, height: 900 },
  },
  webServer: {
    command: `DINKSTER_NATIVE_BACKEND=http://127.0.0.1:9 pnpm --filter @dinkster/app dev --host 127.0.0.1 --port ${frontendPort} --strictPort`,
    url: `http://127.0.0.1:${frontendPort}`,
    reuseExistingServer: false,
    cwd: repoRoot,
  },
})
