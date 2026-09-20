import { expect, nativeTest as test } from './fixtures.js'

const nativeBackend = process.env['DINKSTER_NATIVE_BACKEND'] ?? 'http://127.0.0.1:8765'

test.beforeEach(async ({ page }) => {
  let nodes: Record<string, unknown> | undefined
  try {
    const response = await fetch(`${nativeBackend}/api/nodes`, { signal: AbortSignal.timeout(2_000) })
    if (response.ok) nodes = (await response.json() as { nodes?: Record<string, unknown> }).nodes
  } catch { /* The skip below reports the unavailable backend. */ }
  test.skip(nodes === undefined, `no native Dinkster backend reachable at ${nativeBackend}`)
  test.skip(!('dev.image.gradient' in nodes!),
    `native backend at ${nativeBackend} lacks dev.image.gradient - run dinkster-serve with --dev`)
})

test('an App View partial queue button completes against the native backend', async ({ page }) => {
  await page.goto('/')
  await expect.poll(() => page.evaluate(() => window.__dinksterTest?.app !== undefined),
    { timeout: 15_000 }).toBe(true)

  await page.evaluate(() => {
    window.__dinksterTest!.app.openDocument({
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
  })
  await expect.poll(() => page.evaluate(() =>
    window.__dinksterTest!.app.activeTab()?.store.doc.lineage === 'app-view-native-queue' &&
    window.__dinksterTest!.app.backends.get()[0]?.registry.get()?.schemas.has('dev.image.gradient') === true,
  )).toBe(true)

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
