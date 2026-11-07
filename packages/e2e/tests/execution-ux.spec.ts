/**
 * execution UX suite: frozen snapshot views, live/frozen sync status,
 * runtime error badges with exact tracebacks, and partial-execution scope
 * (preview highlight + queue-selection submission). Runs against a REAL
 * backend; the only synthetic piece is an injected runtime-error event,
 * pushed through the SAME ExecutionStore.apply path the connection uses.
 */
import { expect, test, type Page } from './fixtures.js'

const xy = (p: { x: number; y: number }): [number, number] => [p.x, p.y]

/** Reset the viewport to identity so world coords == canvas CSS pixels. */
async function identityViewport(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.__dinksterTest!.renderer!.setViewport({ x: 0, y: 0, scale: 1 })
  })
}

type Part = { kind: 'header' } | { kind: 'widget'; inputId: string } | { kind: 'badge'; index: number }

const settlePaint = (page: Page): Promise<void> => page.evaluate(() =>
  new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))

/** Page coordinates of a feature of a scene node (assumes identity viewport). */
async function pointOn(page: Page, nodeId: string, part: Part): Promise<{ x: number; y: number }> {
  return page.evaluate(
    ({ nodeId, part }) => {
      const r = window.__dinksterTest!.renderer!
      const vp = r.getViewport()
      const node = r.getScene().nodes.find((n) => n.id === nodeId)
      if (!node) throw new Error(`no scene node '${nodeId}'`)
      const rect = document.querySelector('[data-testid=graph-canvas]')!.getBoundingClientRect()
      const toPage = (wx: number, wy: number) => ({
        x: rect.left + wx * vp.scale + vp.x,
        y: rect.top + wy * vp.scale + vp.y,
      })
      const l = node.layout
      switch (part.kind) {
        case 'header':
          return toPage(node.x + l.width / 2, node.y + l.headerHeight / 2)
        case 'widget': {
          const row = l.rows.find((r) => r.kind === 'widget' && r.inputId === part.inputId)
          if (!row) throw new Error(`no widget row '${part.inputId}' on '${nodeId}'`)
          return toPage(node.x + l.width / 2, node.y + row.y + row.height / 2)
        }
        case 'badge':
          // Runtime badges use the left-aligned lane below the node.
          return toPage(node.x + 8 + part.index * 18, node.y + l.height + 7)
      }
    },
    { nodeId, part },
  )
}

async function toolboxButtonPoint(page: Page, buttonId: string): Promise<{ x: number; y: number }> {
  return page.evaluate((buttonId) => {
    const renderer = window.__dinksterTest!.renderer!
    const layout = renderer.getToolboxLayout()!
    const button = layout.buttons.find((entry) => entry.button.id === buttonId)
    if (!button) throw new Error(`no toolbox button '${buttonId}'`)
    const viewport = renderer.getViewport()
    const rect = document.querySelector<HTMLCanvasElement>('[data-testid="graph-canvas"]')!.getBoundingClientRect()
    return {
      x: rect.left + (button.x + button.size / 2) * viewport.scale + viewport.x,
      y: rect.top + (button.y + button.size / 2) * viewport.scale + viewport.y,
    }
  }, buttonId)
}

/** Queue the active tab and wait for the newest execution row to complete. */
async function queueAndComplete(page: Page): Promise<void> {
  await expect(page.getByTestId('queue-button')).toBeEnabled({ timeout: 15_000 })
  await page.getByTestId('queue-button').click()
  const row = page.getByTestId('execution-row').first()
  await expect(row).toBeVisible({ timeout: 10_000 })
  await expect(row.locator('.execution-status')).toHaveText('Completed', { timeout: 30_000 })
}

const latestExecution = (page: Page) =>
  page.evaluate(() => {
    const execs = [...window.__dinksterTest!.app.store.executions.get().values()]
    const latest = execs.sort((a, b) => b.queuedAt - a.queuedAt)[0]
    if (!latest) throw new Error('no executions')
    return {
      ref: latest.ref,
      status: latest.status,
      scopeKind: latest.artifact?.scope.kind,
      partialTargets: latest.artifact?.partialTargets ?? null,
      promptIds: Object.keys(latest.artifact?.prompt ?? {}).sort(),
    }
  })

/** Root-graph widget values of a tab's document (by tab id, or active tab). */
const rootValues = (page: Page, tabId?: string) =>
  page.evaluate((tabId) => {
    const app = window.__dinksterTest!.app
    const tab = tabId ? app.tabs.get().find((t) => t.id === tabId) : app.activeTab()
    if (!tab) throw new Error(`no tab '${tabId ?? '<active>'}'`)
    const root = tab.graphStack.get()[0]!
    const out: Record<string, Record<string, unknown>> = {}
    for (const [id, n] of Object.entries(tab.store.doc.graphs[root]!.nodes)) out[id] = n.values
    return out
  }, tabId)

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await expect(page.getByTestId('queue-button')).toBeEnabled({ timeout: 15_000 })
})

test('execution row opens a frozen view pinned to that execution', async ({ page }) => {
  await queueAndComplete(page)
  await page.getByTestId('execution-row').first().locator('.execution-open').click()

  // A third, frozen tab opened and became active.
  const tabs = page.getByTestId('tab-bar').locator('.tab')
  await expect(tabs).toHaveCount(3)
  await expect(page.getByTestId('tab-bar').locator('.tab.frozen.active')).toHaveCount(1)

  const banner = page.getByTestId('frozen-banner')
  await expect(banner).toBeVisible()
  await expect(banner).toHaveAttribute('data-sync', 'in-sync')
  await expect(banner).toContainText('completed')

  // Frozen views never queue and never edit.
  await expect(page.getByTestId('queue-button')).toBeDisabled()
  await identityViewport(page)
  await page.mouse.click(...xy(await pointOn(page, 'n0', { kind: 'widget', inputId: 'width' })))
  await expect(page.getByTestId('widget-editor')).not.toBeVisible()

  // Reopening the same execution reuses the tab instead of stacking another.
  await page.getByTestId('frozen-go-live').click()
  await expect(page.getByTestId('tab-bar').locator('.tab.frozen.active')).toHaveCount(0)
  await page.getByTestId('execution-row').first().locator('.execution-open').click()
  await expect(tabs).toHaveCount(3)
})

test('frozen snapshot survives live edits and both sides report divergence', async ({ page }) => {
  await queueAndComplete(page)
  await page.getByTestId('execution-row').first().locator('.execution-open').click()
  const frozenTabId = await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.id)

  // Back to live; the sync chip matches the execution before any edit.
  await page.getByTestId('frozen-go-live').click()
  await expect(page.getByTestId('sync-chip')).toHaveAttribute('data-sync', 'in-sync')

  // Edit a semantic value on the live workflow.
  await identityViewport(page)
  await page.mouse.click(...xy(await pointOn(page, 'n0', { kind: 'widget', inputId: 'width' })))
  const editor = page.getByTestId('widget-editor').locator('input')
  await expect(editor).toBeVisible()
  await editor.fill('128')
  await editor.press('Enter')

  await expect(page.getByTestId('sync-chip')).toHaveAttribute('data-sync', 'diverged')
  expect((await rootValues(page))['n0']!['width']).toBe(128)
  // The frozen document is the compile-time snapshot: untouched by the edit.
  expect((await rootValues(page, frozenTabId))['n0']!['width']).toBe(64)

  // The chip links to the SAME frozen tab, now reporting divergence too.
  await page.getByTestId('sync-chip-open').click()
  await expect(page.getByTestId('tab-bar').locator('.tab')).toHaveCount(3)
  await expect(page.getByTestId('frozen-banner')).toHaveAttribute('data-sync', 'diverged')

  // Closing the frozen tab lands back on a live tab.
  const frozenTab = page.getByTestId('tab-bar').locator('.tab.frozen')
  await frozenTab.hover()
  await frozenTab.getByTestId('tab-close').click()
  await expect(page.getByTestId('tab-bar').locator('.tab')).toHaveCount(2)
  await expect(page.getByTestId('frozen-banner')).not.toBeVisible()
})

test('a frozen view without its compile-time schemas warns instead of borrowing others', async ({ page }) => {
  await queueAndComplete(page)

  // A run registered AROUND the compile path (store.register directly) whose
  // recorded schema hash matches no registry this session ever held: the
  // frozen view must show the visible warning, never silently resolve with
  // the backend's current schemas (AP5).
  await page.evaluate(() => {
    const app = window.__dinksterTest!.app
    const tab = app.activeTab()!
    const result = app.compileTab(tab)
    if (!result?.ok) throw new Error('compile failed')
    const artifact = { ...result.artifact, schemaHash: 'hash-never-held-this-session' }
    const ref = { connection: artifact.connection, prompt: 'synthetic-frozen-registry' }
    app.store.register(ref, artifact, Date.now())
    if (!app.openExecutionView(ref)) throw new Error('frozen view did not open')
  })
  await expect(page.getByTestId('frozen-banner')).toBeVisible()
  await expect(page.getByTestId('frozen-schema-missing')).toBeVisible()

  // The REAL run's frozen view resolves its retained compile-time registry:
  // banner present, no warning.
  await page.evaluate(() => {
    const app = window.__dinksterTest!.app
    const real = [...app.store.executions.get().values()].find(
      (e) => String(e.ref.prompt) !== 'synthetic-frozen-registry',
    )
    if (!real) throw new Error('no real execution')
    if (!app.openExecutionView(real.ref)) throw new Error('frozen view did not open')
  })
  await expect(page.getByTestId('frozen-banner')).toBeVisible()
  await expect(page.getByTestId('frozen-schema-missing')).not.toBeVisible()
})

test('runtime error surfaces as a node badge with the exact traceback', async ({ page }) => {
  await queueAndComplete(page)

  // Inject a runtime error through the normalized-event path (same shape the
  // connection produces from execution_error) so the failure is deterministic.
  // The error must land on a NON-terminal run: authoritative terminal states
  // are final by contract (a late error event after 'completed' is ignored),
  // so the error targets a fresh registered run, not the completed one.
  await page.evaluate(() => {
    const app = window.__dinksterTest!.app
    const store = app.store
    const result = app.compileTab(app.activeTab()!)
    if (!result?.ok) throw new Error('compile failed')
    const ref = { connection: result.artifact.connection, prompt: 'synthetic-runtime-error' }
    store.register(ref, result.artifact, Date.now())
    store.apply({
      kind: 'error',
      execution: ref,
      timestamp: Date.now(),
      runtimeNodeId: 'n1',
      detail: {
        exceptionType: 'BoomError',
        exceptionMessage: 'preview exploded',
        traceback: ['Traceback (most recent call last):', '  File "nodes.py", line 42, in preview', 'BoomError: preview exploded'],
        currentInputs: { images: '<tensor 1x64x64x3>' },
      },
    })
  })

  const row = page.getByTestId('execution-row').first()
  await expect(row).toHaveAttribute('data-status', 'error')
  await expect(row.locator('.execution-errors')).toHaveText('1 error')

  // The badge anchors to the failed node on the canvas.
  await expect
    .poll(() => page.evaluate(() => (window.__dinksterTest!.renderer!.getBadges()['n1'] ?? []).map((b) => b.id)))
    .toContain('core.error')

  await identityViewport(page)
  await settlePaint(page)
  await page.mouse.click(...xy(await pointOn(page, 'n1', { kind: 'badge', index: 0 })))
  const popover = page.getByTestId('badge-popover')
  await expect(popover).toBeVisible()
  await expect(popover).toHaveAttribute('data-badge', 'core.error')
  const detail = popover.getByTestId('badge-error-detail')
  await expect(detail).toContainText('BoomError: preview exploded')
  await expect(detail.locator('.traceback').first()).toContainText('File "nodes.py", line 42, in preview')
  await expect(detail).toContainText('images')

  // The same diagnostic is listed in Problems (execution-level view).
  await expect(page.getByTestId('problems-panel')).toContainText('preview exploded')
})

test('queue-up-to-here toolbox hover previews and click submits the partial closure', async ({ page }) => {
  const highlight = () =>
    page.evaluate(() => {
      const s = window.__dinksterTest!.renderer!.getScopeHighlight()
      return s ? [...s.nodes].sort() : null
    })

  await identityViewport(page)
  await page.evaluate(() => window.__dinksterTest!.controller!.setSelection(['n1']))
  await expect.poll(highlight).toBeNull()

  const queueButton = await toolboxButtonPoint(page, 'core.queueUpToHere')
  await page.mouse.move(queueButton.x, queueButton.y)
  await expect.poll(highlight).toEqual(['n0', 'n1'])

  await page.mouse.move(5, 5)
  await expect.poll(highlight).toBeNull()
  await page.mouse.click(queueButton.x, queueButton.y)

  const row = page.getByTestId('execution-row').first()
  await expect(row).toBeVisible({ timeout: 10_000 })
  await expect(row.locator('.execution-status')).toHaveText('Completed', { timeout: 30_000 })
  const exec = await latestExecution(page)
  expect(exec.scopeKind).toBe('partial')
  expect(exec.partialTargets).toEqual(['n1'])
  expect(exec.promptIds).toEqual(['n0', 'n1'])

  expect((await rootValues(page))['n0']!['width']).toBe(64)
})

test('execute-between toolbox hover previews and submits the selected sinks', async ({ page }) => {
  const highlight = () =>
    page.evaluate(() => {
      const scope = window.__dinksterTest!.renderer!.getScopeHighlight()
      return scope ? [...scope.nodes].sort() : null
    })

  await identityViewport(page)
  await page.evaluate(() => window.__dinksterTest!.controller!.setSelection(['n0', 'n1']))
  const betweenButton = await toolboxButtonPoint(page, 'core.queueBetween')
  await page.mouse.move(betweenButton.x, betweenButton.y)
  await expect.poll(highlight).toEqual(['n0', 'n1'])
  await page.mouse.click(betweenButton.x, betweenButton.y)

  const row = page.getByTestId('execution-row').first()
  await expect(row).toBeVisible({ timeout: 10_000 })
  await expect(row.locator('.execution-status')).toHaveText('Completed', { timeout: 30_000 })
  const exec = await latestExecution(page)
  expect(exec.scopeKind).toBe('partial')
  expect(exec.partialTargets).toEqual(['n1'])
  expect(exec.promptIds).toEqual(['n0', 'n1'])
})

test('queue-selection menu action submits a real partial prompt', async ({ page }) => {
  // Target the OUTPUT node (the server only counts OUTPUT_NODE classes as
  // partial targets); the submitted prompt is its upstream closure.
  await identityViewport(page)
  await page.mouse.click(...xy(await pointOn(page, 'n1', { kind: 'header' })), { button: 'right' })
  const item = page
    .getByTestId('context-menu')
    .locator('[data-item-id="core.node.queueSelection"]')
  await expect(item).toBeVisible()
  await item.click()

  const row = page.getByTestId('execution-row').first()
  await expect(row).toBeVisible({ timeout: 10_000 })
  await expect(row.locator('.execution-scope')).toHaveText('Partial run - 1 target')
  await expect(row.locator('.execution-status')).toHaveText('Completed', { timeout: 30_000 })

  const exec = await latestExecution(page)
  expect(exec.scopeKind).toBe('partial')
  expect(exec.partialTargets).toEqual(['n1'])
  expect(exec.promptIds).toEqual(['n0', 'n1'])
})

test('data lens toggles via the lens menu and D hotkey; panels are presentation only', async ({ page }) => {
  await queueAndComplete(page)

  const panels = () => page.evaluate(() => {
    const renderer = window.__dinksterTest!.renderer!
    const content = renderer.getLensCapabilities().nodeBodyContent
    if (!content) return null
    return Object.fromEntries(renderer.getScene().nodes.flatMap((node) => {
      const rows = content(node)
      return rows == null ? [] : [[node.id, rows]]
    }))
  })
  // Off by default: no panels and the menu reports Standard.
  await expect(page.getByTestId('lens-toggle')).toHaveCount(0)
  await expect(page.getByTestId('lens-switcher')).toContainText('Standard')
  expect(await panels()).toBeNull()
  const revisionBefore = await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.revision)

  // Menu on: every non-subgraph scene node gets a panel.
  await page.getByTestId('lens-switcher').click()
  await page.getByRole('menuitemradio', { name: /Data/ }).click()
  await expect(page.getByTestId('lens-switcher')).toContainText('Data')
  await expect.poll(async () => Object.keys((await panels()) ?? {}).sort()).toEqual(['n0', 'n1'])

  // The document never changed: lens is view state only.
  expect(await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.revision)).toBe(
    revisionBefore,
  )

  // D hotkey off again (canvas focus, not a text field).
  await page.getByTestId('graph-canvas').click({ position: { x: 5, y: 5 } })
  await page.keyboard.press('d')
  await expect(page.getByTestId('lens-switcher')).toContainText('Standard')
  await expect.poll(panels).toBeNull()
})
