/**
 * Node preview panels: output thumbnails come from a REAL backend execution
 * (executed -> outputs -> /view -> decode -> panel). Live sampling frames are
 * injected through the SAME ExecutionStore.apply path the metadata preview
 * protocol uses, because the CPU fixture workflow finishes too fast to catch
 * a real sampler frame deterministically.
 *
 * Remote combos: the option route is intercepted at the network layer, so
 * specs assert the real scoped-client behavior (dedupe, cache, refresh,
 * failure) without depending on any particular backend endpoint.
 */
import { expect, test, type Page } from './fixtures.js'

const xy = (p: { x: number; y: number }): [number, number] => [p.x, p.y]

/** Reset the viewport to identity so world coords == canvas CSS pixels. */
async function identityViewport(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.__dinksterTest!.renderer!.setViewport({ x: 0, y: 0, scale: 1 })
  })
}

/** Page coordinates of a widget row's center (assumes identity viewport). */
async function widgetPoint(page: Page, nodeId: string, inputId: string): Promise<{ x: number; y: number }> {
  return page.evaluate(
    ({ nodeId, inputId }) => {
      const r = window.__dinksterTest!.renderer!
      const vp = r.getViewport()
      const node = r.getScene().nodes.find((n) => n.id === nodeId)
      if (!node) throw new Error(`no scene node '${nodeId}'`)
      const row = node.layout.rows.find((row) => row.kind === 'widget' && row.inputId === inputId)
      if (!row) throw new Error(`no widget row '${inputId}' on '${nodeId}'`)
      const rect = document.querySelector('[data-testid=graph-canvas]')!.getBoundingClientRect()
      return {
        x: rect.left + (node.x + node.layout.width / 2) * vp.scale + vp.x,
        y: rect.top + (node.y + row.y + row.height / 2) * vp.scale + vp.y,
      }
    },
    { nodeId, inputId },
  )
}

/** Queue the active tab and wait for the newest execution row to complete. */
async function queueAndComplete(page: Page): Promise<void> {
  await expect(page.getByTestId('queue-button')).toBeEnabled({ timeout: 15_000 })
  await page.getByTestId('queue-button').click()
  const row = page.getByTestId('execution-row').first()
  await expect(row).toBeVisible({ timeout: 10_000 })
  await expect(row.locator('.execution-status')).toHaveText('Completed', { timeout: 30_000 })
}

/** node id -> decoded panel dimensions currently held by the renderer. */
const panels = (page: Page) =>
  page.evaluate(() => {
    const out: Record<string, { width: number; height: number }> = {}
    for (const [id, p] of Object.entries(window.__dinksterTest!.renderer!.getNodePreviews())) {
      if (typeof p.width === 'number' && typeof p.height === 'number') {
        out[id] = { width: p.width, height: p.height }
      }
    }
    return out
  })

/** Inject an attributed live frame (encoded PNG) for the latest execution. */
async function injectFrame(page: Page, runtimeNodeId: string, width: number, height: number): Promise<void> {
  await page.evaluate(
    async ({ runtimeNodeId, width, height }) => {
      const canvas = new OffscreenCanvas(width, height)
      const g = canvas.getContext('2d')!
      g.fillStyle = '#c00'
      g.fillRect(0, 0, width, height)
      const blob = await canvas.convertToBlob({ type: 'image/png' })
      const payload = await blob.arrayBuffer()
      const store = window.__dinksterTest!.app.store
      const latest = [...store.executions.get().values()].sort((a, b) => b.queuedAt - a.queuedAt)[0]!
      store.apply({
        kind: 'preview',
        execution: latest.ref,
        timestamp: Date.now(),
        runtimeNodeId,
        channel: 'comfy/preview-image',
        payload,
      })
    },
    { runtimeNodeId, width, height },
  )
}

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await expect(page.getByTestId('queue-button')).toBeEnabled({ timeout: 15_000 })
})

// ---------------------------------------------------------------------------
// Node preview panels
// ---------------------------------------------------------------------------

test('completed execution shows the output thumbnail on the producing node only', async ({ page }) => {
  await queueAndComplete(page)
  // n1 (PreviewImage) produced an image; the panel decodes from /view.
  await expect.poll(() => panels(page).then((p) => Object.keys(p).sort()), { timeout: 10_000 }).toEqual(['n1'])
  const p = await panels(page)
  expect(p['n1']!.width).toBeGreaterThan(0)
  expect(p['n1']!.height).toBeGreaterThan(0)
})

test('attributed live frame attaches to its node; other nodes stay clean', async ({ page }) => {
  await queueAndComplete(page)
  // n0 (EmptyImage) has no image outputs, so an attributed frame is its panel.
  await injectFrame(page, 'n0', 32, 16)
  await expect.poll(() => panels(page).then((p) => p['n0']), { timeout: 10_000 }).toEqual({ width: 32, height: 16 })
  // The output node keeps its own thumbnail; the frame did not leak onto it.
  await expect.poll(() => panels(page).then((p) => Object.keys(p).sort())).toEqual(['n0', 'n1'])
})

test('output thumbnail wins over a live frame once the node is finished', async ({ page }) => {
  await queueAndComplete(page)
  await expect.poll(() => panels(page).then((p) => p['n1']), { timeout: 10_000 }).toBeDefined()
  const before = (await panels(page))['n1']!
  // A late frame for the finished output node must NOT replace the output.
  await injectFrame(page, 'n1', 3, 3)
  await page.waitForTimeout(300)
  expect((await panels(page))['n1']).toEqual(before)
})

test('frozen tab shows its pinned execution imagery; other tabs stay clean', async ({ page }) => {
  await queueAndComplete(page)
  await injectFrame(page, 'n0', 32, 16)
  await expect.poll(() => panels(page).then((p) => Object.keys(p).sort()), { timeout: 10_000 }).toEqual(['n0', 'n1'])

  // The frozen view is pinned to the execution: same imagery.
  await page.getByTestId('execution-row').first().locator('.execution-open').click()
  await expect(page.getByTestId('frozen-banner')).toBeVisible()
  await expect.poll(() => panels(page).then((p) => Object.keys(p).sort()), { timeout: 10_000 }).toEqual(['n0', 'n1'])

  // A tab with no execution shows no panels.
  await page.getByTestId('tab-bar').locator('.tab', { hasText: 'Subgraph' }).click()
  await expect.poll(() => panels(page).then((p) => Object.keys(p))).toEqual([])
})

// ---------------------------------------------------------------------------
// Remote combo options
// ---------------------------------------------------------------------------

const REMOTE_ROUTE = '/api/choices/dinkster-test-remote-options'

/** Two nodes sharing one remote combo route, plus a static combo. */
async function openRemoteWorkflow(page: Page): Promise<void> {
  await page.evaluate((route) => {
    const app = window.__dinksterTest!.app
    const remoteCombo = (id: string) => ({
      kind: 'input',
      id,
      type: { kind: 'concrete', name: 'core.combo' },
      optional: false,
      widget: { widgetType: 'COMBO', options: {}, remote: { route, refreshButton: true } },
    })
    app.registerSchemas([
      {
        type: 'RemoteComboTest',
        displayName: 'Remote Combo Test',
        category: 'test',
        source: 'v3',
        isOutputNode: false,
        items: [remoteCombo('model'), { kind: 'output', id: 'out0', type: { kind: 'concrete', name: 'IMAGE' } }],
      },
      {
        type: 'StaticComboTest',
        displayName: 'Static Combo Test',
        category: 'test',
        source: 'v3',
        isOutputNode: false,
        items: [
          {
            kind: 'input',
            id: 'mode',
            type: { kind: 'concrete', name: 'core.combo' },
            optional: false,
            widget: { widgetType: 'COMBO', options: { options: ['alpha', 'beta'] } },
          },
        ],
      },
    ])
    app.openDocument(
      {
        format: 'dinkster-workflow',
        formatVersion: 1,
        lineage: 'lineage-remote',
        root: 'g0',
        graphs: {
          g0: {
            id: 'g0',
            name: 'root',
            nodes: {
              r0: { id: 'r0', type: 'RemoteComboTest', values: { model: 'old.safetensors' } },
              r1: { id: 'r1', type: 'RemoteComboTest', values: { model: 'old.safetensors' } },
              s0: { id: 's0', type: 'StaticComboTest', values: { mode: 'alpha' } },
            },
            links: {},
            nets: {},
            reroutes: {},
            nextOrdinal: 100,
          },
        },
        view: {
          graphs: {
            g0: {
              nodes: {
                r0: { position: { x: 60, y: 80 } },
                r1: { position: { x: 60, y: 300 } },
                s0: { position: { x: 420, y: 80 } },
              },
            },
          },
        },
      },
      'Remote',
    )
  }, REMOTE_ROUTE)
  await identityViewport(page)
}

function interceptRemote(page: Page, options: readonly string[]): { count: () => number } {
  let hits = 0
  void page.route(`**${REMOTE_ROUTE}*`, (route) => {
    hits++
    void route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(options) })
  })
  return { count: () => hits }
}

test('remote combo loads options through the scoped client and commits the pick', async ({ page }) => {
  const remote = interceptRemote(page, ['a.safetensors', 'b.safetensors'])
  await openRemoteWorkflow(page)

  await page.mouse.click(...xy(await widgetPoint(page, 'r0', 'model')))
  const dropdown = page.getByTestId('combo-dropdown')
  await expect(dropdown).toHaveAttribute('data-remote', 'ready')
  await dropdown.getByRole('option', { name: 'b.safetensors' }).click()

  const value = await page.evaluate(
    () => window.__dinksterTest!.app.activeTab()!.store.doc.graphs['g0']!.nodes['r0']!.values['model'],
  )
  expect(value).toBe('b.safetensors')
  expect(remote.count()).toBe(1)
})

test('nodes sharing one route cause one request; refresh bypasses the cache', async ({ page }) => {
  const remote = interceptRemote(page, ['a.safetensors'])
  await openRemoteWorkflow(page)

  await page.mouse.click(...xy(await widgetPoint(page, 'r0', 'model')))
  await expect(page.getByTestId('combo-dropdown')).toHaveAttribute('data-remote', 'ready')
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('combo-dropdown')).not.toBeVisible()

  // Second node, same route: served from the scoped-client cache.
  await page.mouse.click(...xy(await widgetPoint(page, 'r1', 'model')))
  await expect(page.getByTestId('combo-dropdown')).toHaveAttribute('data-remote', 'ready')
  expect(remote.count()).toBe(1)

  // Explicit refresh re-fetches.
  await page.getByTestId('remote-refresh').click()
  await expect.poll(() => remote.count()).toBe(2)
})

test('remote failure is visible and never corrupts the stored value', async ({ page }) => {
  await page.route(`**${REMOTE_ROUTE}*`, (route) => void route.fulfill({ status: 500, body: 'nope' }))
  await openRemoteWorkflow(page)

  await page.mouse.click(...xy(await widgetPoint(page, 'r0', 'model')))
  const dropdown = page.getByTestId('combo-dropdown')
  await expect(dropdown).toHaveAttribute('data-remote', 'unavailable')
  await expect(dropdown.getByText('remote options unavailable', { exact: true })).toBeVisible()

  await page.keyboard.press('Escape')
  const value = await page.evaluate(
    () => window.__dinksterTest!.app.activeTab()!.store.doc.graphs['g0']!.nodes['r0']!.values['model'],
  )
  expect(value).toBe('old.safetensors')
})

test('remote combo: type-to-filter plus Enter commits the highlighted option', async ({ page }) => {
  interceptRemote(page, ['alpha.safetensors', 'beta.safetensors', 'gamma.safetensors'])
  await openRemoteWorkflow(page)

  await page.mouse.click(...xy(await widgetPoint(page, 'r0', 'model')))
  await expect(page.getByTestId('combo-dropdown')).toHaveAttribute('data-remote', 'ready')
  const search = page.getByTestId('combo-search')
  // Typing resets the highlight to the first filtered option; Enter takes it.
  await search.fill('be')
  await search.press('Enter')
  let value = await page.evaluate(
    () => window.__dinksterTest!.app.activeTab()!.store.doc.graphs['g0']!.nodes['r0']!.values['model'],
  )
  expect(value).toBe('beta.safetensors')

  // Arrow keys move the highlight through the (cached) remote options.
  await page.mouse.click(...xy(await widgetPoint(page, 'r0', 'model')))
  await expect(page.getByTestId('combo-dropdown')).toHaveAttribute('data-remote', 'ready')
  await search.press('ArrowDown')
  await search.press('ArrowDown')
  await search.press('Enter')
  value = await page.evaluate(
    () => window.__dinksterTest!.app.activeTab()!.store.doc.graphs['g0']!.nodes['r0']!.values['model'],
  )
  expect(value).toBe('gamma.safetensors')
})

test('remote combo: blur does not commit or close the anchored popover', async ({ page }) => {
  interceptRemote(page, ['alpha.safetensors', 'beta.safetensors'])
  await openRemoteWorkflow(page)

  await page.mouse.click(...xy(await widgetPoint(page, 'r0', 'model')))
  await expect(page.getByTestId('combo-dropdown')).toHaveAttribute('data-remote', 'ready')
  const search = page.getByTestId('combo-search')
  await search.fill('beta')
  await search.blur()
  await expect(page.getByTestId('combo-dropdown')).toBeVisible()
  const value = await page.evaluate(
    () => window.__dinksterTest!.app.activeTab()!.store.doc.graphs['g0']!.nodes['r0']!.values['model'],
  )
  expect(value).toBe('old.safetensors')
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('combo-dropdown')).not.toBeVisible()
})

test('a slow response for a closed remote editor never hijacks the next combo (stale-response race)', async ({ page }) => {
  // Hold the remote route open until the test releases it.
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  await page.route(`**${REMOTE_ROUTE}*`, async (route) => {
    await gate
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(['late.safetensors']) })
  })
  await openRemoteWorkflow(page)

  // Open the remote combo: stuck loading. Close it and open the STATIC one.
  await page.mouse.click(...xy(await widgetPoint(page, 'r0', 'model')))
  const dropdown = page.getByTestId('combo-dropdown')
  await expect(dropdown).toHaveAttribute('data-remote', 'loading')
  await page.keyboard.press('Escape')
  await page.mouse.click(...xy(await widgetPoint(page, 's0', 'mode')))
  await expect(dropdown).toHaveAttribute('data-remote', 'static')

  // The late response lands now. The request token was invalidated when the
  // static editor opened, so the result must be dropped, not published.
  release()
  await page.waitForTimeout(150)
  await expect(dropdown).toHaveAttribute('data-remote', 'static')
  await expect(dropdown.getByRole('option')).toHaveText(['alpha', 'beta'])
})

test('an empty remote payload is READY with zero options, not an error', async ({ page }) => {
  interceptRemote(page, [])
  await openRemoteWorkflow(page)

  await page.mouse.click(...xy(await widgetPoint(page, 'r0', 'model')))
  const dropdown = page.getByTestId('combo-dropdown')
  await expect(dropdown).toHaveAttribute('data-remote', 'ready')
  await expect(dropdown.getByRole('option', { name: 'old.safetensors' })).toBeVisible()
  await page.keyboard.press('Escape')
  const value = await page.evaluate(
    () => window.__dinksterTest!.app.activeTab()!.store.doc.graphs['g0']!.nodes['r0']!.values['model'],
  )
  expect(value).toBe('old.safetensors')
})

test('a malformed (non-array) remote payload is a visible failure that preserves the value', async ({ page }) => {
  await page.route(`**${REMOTE_ROUTE}*`, (route) =>
    void route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ not: 'an array' }) }))
  await openRemoteWorkflow(page)

  await page.mouse.click(...xy(await widgetPoint(page, 'r0', 'model')))
  const dropdown = page.getByTestId('combo-dropdown')
  await expect(dropdown).toHaveAttribute('data-remote', 'unavailable')
  await expect(dropdown.getByText('remote options unavailable', { exact: true })).toBeVisible()
  await page.keyboard.press('Escape')
  const value = await page.evaluate(
    () => window.__dinksterTest!.app.activeTab()!.store.doc.graphs['g0']!.nodes['r0']!.values['model'],
  )
  expect(value).toBe('old.safetensors')
})

test('static combos are untouched by remote state', async ({ page }) => {
  interceptRemote(page, ['a.safetensors'])
  await openRemoteWorkflow(page)

  // Open a remote combo first so stale remote state COULD leak, then a static one.
  await page.mouse.click(...xy(await widgetPoint(page, 'r0', 'model')))
  await expect(page.getByTestId('combo-dropdown')).toHaveAttribute('data-remote', 'ready')
  await page.keyboard.press('Escape')

  await page.mouse.click(...xy(await widgetPoint(page, 's0', 'mode')))
  const dropdown = page.getByTestId('combo-dropdown')
  await expect(dropdown).toHaveAttribute('data-remote', 'static')
  await expect(dropdown.getByRole('option')).toHaveText(['alpha', 'beta'])
})
