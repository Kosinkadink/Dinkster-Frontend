import { defineConfig } from '@playwright/test'

const devPort = Number(process.env['DINKSTER_E2E_PORT'] ?? '5199')
if (!Number.isSafeInteger(devPort) || devPort < 1024 || devPort > 65535) throw new Error('DINKSTER_E2E_PORT must be a valid non-privileged port')
const nativeFrontendPort = Number(
  process.env['DINKSTER_E2E_NATIVE_FRONTEND_PORT'] ?? devPort + 1,
)
if (!Number.isSafeInteger(nativeFrontendPort) || nativeFrontendPort < 1024 || nativeFrontendPort > 65535 || nativeFrontendPort === devPort) {
  throw new Error('DINKSTER_E2E_NATIVE_FRONTEND_PORT must be a distinct valid non-privileged port')
}
process.env['DINKSTER_E2E_NATIVE_FRONTEND'] = `http://127.0.0.1:${nativeFrontendPort}`

/**
 * smoke suite. Requires:
 * - a ComfyUI backend (default http://127.0.0.1:8199, override DINKSTER_BACKEND)
 * - a fresh isolated dev server is started automatically.
 */
/**
 * Specs that touch SHARED MUTABLE backend state (real V1 executions on
 * :8199 with one queue/history, native :8765 writes - run-history even
 * clears scope=local) or that measure timing budgets. These must run one
 * at a time; everything else is client-side or route-mocked and safe to
 * parallelize at file granularity (no spec uses beforeAll or
 * describe.serial). A NEW SPEC THAT EXECUTES PROMPTS OR WRITES SERVER
 * STATE MUST BE ADDED HERE - a missing entry shows up as cross-worker
 * flake in the parallel-safe project, not locally.
 */
const BACKEND_SERIAL_SPECS = [
  // V1 (:8199) execution writers: one shared queue and history.
  'collections.spec.ts',
  'execution-ux.spec.ts',
  'minimap.spec.ts',
  'multi-backend.spec.ts',
  'overlay-pins.spec.ts',
  'previews-remote.spec.ts',
  'reconnect.spec.ts',
  'reroutes.spec.ts',
  'seed-controller.spec.ts',
  'selectors.spec.ts',
  'smoke.spec.ts',
  'value-source.spec.ts',
  // Native (:8765) writers: library records, uploads, runs; run-history
  // clears the whole local scope.
  'workflow-library.spec.ts',
  'asset-widget.spec.ts',
  'run-history.spec.ts',
  'peek-preview.spec.ts',
  'native-imagery-live.spec.ts',
  'image-document-graph-live.spec.ts',
  'lora-conditioning-scheduling-live.spec.ts',
  'image-upload-byte-proof.spec.ts',
  'gallery-live.spec.ts',
  'starter-templates-live.spec.ts',
  'collab-noodle-presence.spec.ts',
  'dynamic-combo-native-live.spec.ts',
  'save-video-dynamic-native.spec.ts',
  'video-document-editor.spec.ts',
  'string-split-output-lifecycle.spec.ts',
  'curve-editor.spec.ts',
  'trellis2-official-workflow-live.spec.ts',
  'compositor-editor.spec.ts',
  'image-mask-graph-live.spec.ts',
  'audio-recording-live.spec.ts',
  'video-edit.spec.ts',
  'glsl-shader.spec.ts',
  'executable-examples-live.spec.ts',
  'app-view-queue-buttons-native.spec.ts',
  // Environment-conditional live discovery probe.
  'startup-discovery.spec.ts',
]

const PERFORMANCE_SPECS = ['perf.spec.ts']

export default defineConfig({
  testDir: './tests',
  timeout: 60_000,
  // SH3 (amended 2026-07-27): every worker shares ONE dev server and ONE
  // live backend per protocol. The dev server tolerates concurrent
  // clients, but specs that execute prompts or write server state
  // (BACKEND_SERIAL_SPECS above) and timing-budget specs do not. The
  // suite is therefore split into three projects:
  //   parallel-safe:  client-side/route-mocked specs; run with
  //                   --workers=10 (see the test:e2e package script).
  //   backend-serial: shared-state specs; MUST run --workers=1.
  //   performance:    timing budgets in a clean process; MUST run --workers=1.
  // The default worker count stays 1 so a bare `playwright test` is
  // exactly the old trustworthy serial run; parallelism is opted into by
  // the package scripts. Re-check any parallel-only failure serially
  // before acting on it, and if it reproduces only in parallel, the spec
  // belongs in BACKEND_SERIAL_SPECS.
  workers: 1,
  projects: [
    {
      name: 'parallel-safe',
      testIgnore: [...BACKEND_SERIAL_SPECS, ...PERFORMANCE_SPECS].map((f) => `tests/${f}`),
    },
    {
      name: 'backend-serial',
      testMatch: BACKEND_SERIAL_SPECS.map((f) => `tests/${f}`),
    },
    {
      name: 'performance',
      testMatch: PERFORMANCE_SPECS.map((f) => `tests/${f}`),
    },
  ],
  use: {
    baseURL: `http://127.0.0.1:${devPort}`,
    viewport: { width: 1440, height: 900 },
  },
  webServer: [
    {
      command: `pnpm --filter @dinkster/app dev --host 127.0.0.1 --port ${devPort} --strictPort`,
      url: `http://127.0.0.1:${devPort}`,
      reuseExistingServer: false,
      env: {
        DINKSTER_NATIVE_BACKEND: process.env['DINKSTER_NATIVE_BACKEND'] ?? 'http://127.0.0.1:8765',
        VITE_DINKSTER_E2E_PROBE_V1: '1',
      },
      cwd: '../..',
    },
    {
      command: `pnpm --filter @dinkster/app dev --host 127.0.0.1 --port ${nativeFrontendPort} --strictPort`,
      url: `http://127.0.0.1:${nativeFrontendPort}`,
      reuseExistingServer: false,
      env: {
        DINKSTER_NATIVE_BACKEND: process.env['DINKSTER_NATIVE_BACKEND'] ?? 'http://127.0.0.1:8765',
        VITE_DINKSTER_E2E_PROBE_V1: '0',
      },
      cwd: '../..',
    },
  ],
})
