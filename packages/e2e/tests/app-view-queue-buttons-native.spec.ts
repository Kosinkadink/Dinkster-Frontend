import { writeFileSync } from 'node:fs'
import { expect, nativeAppViewTest as test } from './fixtures.js'
import { requireBackendNodes } from './required-nodes.js'

const nativeBackend = process.env['DINKSTER_NATIVE_BACKEND'] ?? 'http://127.0.0.1:8765'

test.beforeEach(async ({ page }, testInfo) => {
  let nodes: Record<string, unknown> | undefined
  try {
    const response = await fetch(`${nativeBackend}/api/nodes`, { signal: AbortSignal.timeout(2_000) })
    if (response.ok) nodes = (await response.json() as { nodes?: Record<string, unknown> }).nodes
  } catch { /* The skip below reports the unavailable backend. */ }
  test.skip(nodes === undefined, `no native Dinkster backend reachable at ${nativeBackend}`)
  requireBackendNodes(nodes!, ['dev.image.gradient'], testInfo)
})

test('an App View partial queue button completes against the native backend', async ({ page }, testInfo) => {
  await page.goto('/')
  await expect.poll(() => page.evaluate(() => window.__dinksterTest?.app !== undefined),
    { timeout: 15_000 }).toBe(true)

  const openDiagnostics = await page.evaluate(async () => {
    const app = window.__dinksterTest!.app
    const backend = app.backends.get()[0]
    const registry = backend?.registry.get()
    const before = {
      activeLineage: app.activeTab()?.store.doc.lineage ?? null,
      gradientAvailable: registry?.schemas.has('dev.image.gradient') === true,
      connectionStatus: backend?.connection.status.get() ?? null,
      problemCodes: app.problems.get().map((problem) => problem.code),
    }
    const diagnostics = await app.openDocument({
      format: 'dinkster-workflow', formatVersion: 1, lineage: 'app-view-native-queue', root: 'root',
      graphs: {
        root: {
          id: 'root', name: 'Workflow', links: {}, nets: {}, reroutes: {}, nextOrdinal: 2,
          nodes: {
            gradient: {
              id: 'gradient', type: 'dev.image.gradient', title: 'Base image',
              values: { width: 8, height: 8 },
            },
          },
        },
      },
      view: { graphs: { root: { nodes: { gradient: { position: { x: 120, y: 120 } } } } } },
      ext: {
        'dinkster.appLayout': {
          version: 1,
          desktop: {
            items: [{
              id: 'generate-base', kind: 'queue', label: 'Generate base',
              targets: [{ graphId: 'root', nodeId: 'gradient' }],
            }],
          },
          mobile: { customized: false, items: [] },
        },
      },
    } as never, 'Native queue button')
    return {
      before,
      diagnosticCount: diagnostics.length,
      diagnosticCodes: diagnostics.flatMap((diagnostic) =>
        typeof diagnostic === 'object' && diagnostic !== null && 'code' in diagnostic &&
        typeof diagnostic.code === 'string' ? [diagnostic.code] : []),
      after: {
        activeLineage: app.activeTab()?.store.doc.lineage ?? null,
        gradientAvailable: app.backends.get()[0]?.registry.get()?.schemas.has('dev.image.gradient') === true,
        connectionStatus: backend?.connection.status.get() ?? null,
        registryUnchanged: registry === backend?.registry.get(),
        problemCodes: app.problems.get().map((problem) => problem.code),
      },
    }
  })
  const observations: (typeof openDiagnostics.before)[] = []
  try {
    await expect.poll(async () => {
      const observed = await page.evaluate(() => {
        const app = window.__dinksterTest!.app
        const backend = app.backends.get()[0]
        return {
          activeLineage: app.activeTab()?.store.doc.lineage ?? null,
          gradientAvailable: backend?.registry.get()?.schemas.has('dev.image.gradient') === true,
          connectionStatus: backend?.connection.status.get() ?? null,
          problemCodes: app.problems.get().map((problem) => problem.code),
        }
      })
      observations.push(observed)
      return observed.activeLineage === 'app-view-native-queue' && observed.gradientAvailable
    }).toBe(true)
  } catch (error) {
    try {
      const path = testInfo.outputPath('app-view-native-startup.json')
      writeFileSync(path, JSON.stringify({ open: openDiagnostics, observations }, null, 2))
      await testInfo.attach('app-view-native-startup', {
        path,
        contentType: 'application/json',
      })
    } catch { /* Preserve the original startup failure if diagnostic recording fails. */ }
    throw error
  }

  await page.getByTestId('views-switcher').click()
  await page.getByRole('menuitemradio', { name: 'App view' }).click()
  const queue = page.getByRole('button', { name: 'Generate base' })
  await expect(queue).toBeEnabled({ timeout: 15_000 })
  await expect(queue).toHaveAccessibleDescription('Ready')
  await queue.click()

  await expect(page.getByTestId('app-layout-queue-state')).toHaveText('Completed', { timeout: 30_000 })
  const execution = await page.evaluate(() => {
    const run = [...window.__dinksterTest!.app.store.executions.get().values()].at(-1)!
    return { status: run.status, scope: run.artifact?.scope }
  })
  expect(execution).toEqual({
    status: 'completed',
    scope: { kind: 'partial', targets: [{ instancePath: [], node: 'gradient' }] },
  })
})
