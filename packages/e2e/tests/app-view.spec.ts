/**
 * App view exposes parameters as a form-style
 * projection of the SAME document. The specs pin the end-to-end story:
 * expose a widget from the canvas context menu, switch the tab to the app
 * editor kind, edit the value through the form control, and observe the
 * identical document write a canvas widget edit would produce - then the
 * stale/remove recovery path and the round trip back to the graph editor.
 */
import { expect, appViewTest as test, type Page } from './fixtures.js'

const REMOTE_ROUTE = '/api/choices/dinkster-test-app-view-options'

const activeDoc = (page: Page) => page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.doc)

const exposedList = async (page: Page) =>
  (await activeDoc(page)).ext?.['dinkster.exposed'] as { nodeId: string; inputId: string; label?: string }[] | undefined

async function widgetPoint(page: Page, inputId: string): Promise<{ x: number; y: number }> {
  return page.evaluate((inputId) => {
    const node = window.__dinksterTest!.renderer!.getScene().nodes.find((item) => item.id === 'widgets')!
    const row = node.layout.rows.find((item) => item.kind === 'widget' && item.inputId === inputId)!
    const rect = document.querySelector('[data-testid=graph-canvas]')!.getBoundingClientRect()
    const viewport = window.__dinksterTest!.renderer!.getViewport()
    return {
      x: rect.left + (node.x + node.layout.width / 2) * viewport.scale + viewport.x,
      y: rect.top + (node.y + row.y + row.height / 2) * viewport.scale + viewport.y,
    }
  }, inputId)
}

async function exposureAffordancePoint(page: Page, inputId: string): Promise<{ x: number; y: number }> {
  return page.evaluate((inputId) => {
    const node = window.__dinksterTest!.renderer!.getScene().nodes.find((item) => item.id === 'widgets')!
    const row = node.layout.rows.find((item) => item.kind === 'widget' && item.inputId === inputId)!
    const rect = document.querySelector('[data-testid=graph-canvas]')!.getBoundingClientRect()
    const viewport = window.__dinksterTest!.renderer!.getViewport()
    const numeric = inputId === 'count'
    return {
      x: rect.left + (node.x + node.layout.width - (row.inset ?? 0) - (numeric ? 25 : 13)) * viewport.scale + viewport.x,
      y: rect.top + (node.y + row.y + row.height / 2) * viewport.scale + viewport.y,
    }
  }, inputId)
}

const menuItem = (page: Page, id: string) => page.locator(`[data-item-id="${id}"]`)

async function selectView(page: Page, name: 'Graph' | 'App view'): Promise<void> {
  await page.getByTestId('views-switcher').click()
  await page.getByRole('menuitemradio', { name }).click()
}

async function enterArrange(page: Page): Promise<void> {
  await page.getByTestId('app-view-arrange-toggle').click()
  await expect(page.getByTestId('app-view-arrange-toggle')).toHaveAttribute('aria-pressed', 'true')
}

async function exposeViaMenu(page: Page, inputId: string): Promise<void> {
  const point = await widgetPoint(page, inputId)
  await page.mouse.click(point.x, point.y, { button: 'right' })
  await expect(menuItem(page, 'core.widget.expose.toggle')).toContainText('Expose in app view')
  await menuItem(page, 'core.widget.expose.toggle').click()
}

test.beforeEach(async ({ page }, testInfo) => {
  const mockRename = testInfo.annotations.some((annotation) => annotation.type === 'mock-rename-dispatch')
  if (mockRename) {
    await page.route('**/api/**', (route) => route.fulfill({ status: 503, json: {} }))
    await page.route('**/api/nodes*', (route) => route.fulfill({ json: {
      schemaVersion: 1, epoch: 1, dinkster: { version: 'rename-fixture', schemaWire: 1 }, nodes: {},
    } }))
    await page.routeWebSocket('**/api/events?*', () => {})
  }
  await page.goto('/')
  if (mockRename) {
    await expect.poll(() => page.evaluate(() => window.__dinksterTest?.app.backends.get()[0]?.registry.get() !== undefined)).toBe(true)
  } else {
    await expect(page.getByTestId('status-bar')).toContainText(/\d+ node schemas/, { timeout: 15_000 })
    await expect.poll(() => page.evaluate(() => {
      const backend = window.__dinksterTest!.app.backends.get()[0]!
      return backend.schemaState.get().status === 'ready' && backend.workerCatalog.get().status === 'ready'
    })).toBe(true)
  }
  await page.evaluate((remoteRoute) => {
    const widget = (id: string, widgetType: string, defaultValue: unknown, options: Record<string, unknown> = {}) => ({
      kind: 'input', id, type: { kind: 'concrete', name: widgetType === 'COMBO' ? 'COMBO' : widgetType }, optional: false,
      widget: { widgetType, options, default: defaultValue },
    })
    window.__dinksterTest!.app.registerSchemas([{
      type: 'AppViewTest', displayName: 'App View Test', category: 'test', source: 'v3', isOutputNode: false,
      items: [
        widget('count', 'INT', 5, { min: 0, max: 100, step: 5 }),
        widget('title', 'STRING', 'old'),
        widget('enabled', 'BOOLEAN', false),
        widget('choice', 'COMBO', 'alpha', { options: ['alpha', 'beta', 'gamma'] }),
        widget('color', 'COLOR', '#112233'),
        {
          ...widget('remoteChoice', 'COMBO', 'old'),
          widget: { widgetType: 'COMBO', options: {}, default: 'old', remote: { route: remoteRoute } },
        },
        widget('asset', 'ASSET', null, { accept: ['image/png'] }),
      ],
    }])
    window.__dinksterTest!.app.openDocument({
      format: 'dinkster-workflow', formatVersion: 1, lineage: 'app-view-test', root: 'g0',
      graphs: { g0: { id: 'g0', name: 'root', nodes: { widgets: { id: 'widgets', type: 'AppViewTest', values: {} } }, links: {}, nets: {}, reroutes: {}, nextOrdinal: 2 } },
      view: { graphs: { g0: { nodes: { widgets: { position: { x: 100, y: 100 } } } } } },
    }, 'App View Test')
    window.__dinksterTest!.renderer!.setViewport({ x: 0, y: 0, scale: 1 })
  }, REMOTE_ROUTE)
  // openDocument returns a local tab that the workspace authority promotes
  // asynchronously; the promotion replaces the tab and rebuilds the canvas
  // scene, which closes context menus and drops writes made to the replaced
  // store. Wait for the shared-session store before interacting.
  await page.waitForFunction(() => {
    const tab = window.__dinksterTest!.app.tabs.get().find((candidate) => candidate.id === 'app-view-test')
    return tab !== undefined && 'status' in tab.store
  })
})

test('expose -> app view -> edit -> the same document write; remove restores empty state', async ({ page }) => {
  // Expose from the canvas widget context menu.
  await exposeViaMenu(page, 'count')
  expect(await exposedList(page)).toEqual([{ graphId: 'g0', nodeId: 'widgets', inputId: 'count' }])

  // The menu toggles: a second open offers removal, checked.
  const point = await widgetPoint(page, 'count')
  await page.mouse.click(point.x, point.y, { button: 'right' })
  await expect(menuItem(page, 'core.widget.expose.toggle')).toContainText('Remove from app view')
  await expect(menuItem(page, 'core.widget.expose.toggle')).toHaveClass(/checked/)
  await page.keyboard.press('Escape')

  // Switch the tab to the app projection: same tab, no canvas.
  await selectView(page, 'App view')
  await expect(page.getByTestId('app-view')).toBeVisible()
  await expect(page.getByTestId('graph-canvas')).toHaveCount(0)
  await expect(page.getByTestId('app-view-row')).toHaveCount(1)
  await expect(page.getByTestId('app-view-label')).toContainText('count')

  // Editing the form control lands as the SAME node.setValue write.
  const revision = await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.revision)
  await page.getByTestId('app-view-number').fill('35')
  await page.getByTestId('app-view-number').blur()
  expect((await activeDoc(page)).graphs.g0!.nodes.widgets!.values.count).toBe(35)
  expect(await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.revision)).toBe(revision + 1)

  // Undo reaches the document through the app view too (document command,
  // not a form-local edit).
  await page.keyboard.press('Control+z')
  expect((await activeDoc(page)).graphs.g0!.nodes.widgets!.values.count).toBeUndefined()

  // Remove from the app view itself (arrange mode holds the row tools);
  // the empty-state hint returns.
  await enterArrange(page)
  await page.getByTestId('app-view-remove').click()
  expect(await exposedList(page)).toEqual([])
  await expect(page.getByTestId('app-view-empty')).toBeVisible()

  // Round trip back to the graph editor.
  await selectView(page, 'Graph')
  await expect(page.getByTestId('graph-canvas')).toBeVisible()
  await expect(page.getByTestId('app-view')).toHaveCount(0)
})

test('use mode is the default clean form; arrange mode reveals the row tools per tab', async ({ page }) => {
  await exposeViaMenu(page, 'count')
  await selectView(page, 'App view')

  // Use mode by default: no authoring tools, values still editable.
  await expect(page.getByTestId('app-view-arrange-toggle')).toHaveAttribute('aria-pressed', 'false')
  await expect(page.getByTestId('app-view-row')).toHaveCount(1)
  await expect(page.getByTestId('app-view-drag-handle')).toHaveCount(0)
  await expect(page.getByTestId('app-view-move-up')).toHaveCount(0)
  await expect(page.getByTestId('app-view-move-down')).toHaveCount(0)
  await expect(page.getByTestId('app-view-rename-start')).toHaveCount(0)
  await expect(page.getByTestId('app-view-remove')).toHaveCount(0)
  await page.getByTestId('app-view-number').fill('42')
  await page.getByTestId('app-view-number').blur()
  expect((await activeDoc(page)).graphs.g0!.nodes.widgets!.values.count).toBe(42)

  // Arrange mode reveals the tools.
  await enterArrange(page)
  await expect(page.getByTestId('app-view-drag-handle')).toHaveCount(1)
  await expect(page.getByTestId('app-view-remove')).toHaveCount(1)

  // The mode is tab state, not layout data: it survives an editor-kind
  // round trip and never lands in the document.
  await selectView(page, 'Graph')
  await selectView(page, 'App view')
  await expect(page.getByTestId('app-view-arrange-toggle')).toHaveAttribute('aria-pressed', 'true')
  expect(Object.keys((await activeDoc(page)).ext ?? {})).toEqual(['dinkster.exposed'])

  // An open rename does not survive leaving arrange mode.
  await page.getByTestId('app-view-rename-start').click()
  await expect(page.getByTestId('app-view-rename')).toBeVisible()
  await page.getByTestId('app-view-arrange-toggle').click()
  await page.getByTestId('app-view-arrange-toggle').click()
  await expect(page.getByTestId('app-view-arrange-toggle')).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByTestId('app-view-rename')).toHaveCount(0)

  // The mode is per tab: a second tab opens in use mode while the first
  // keeps arrange mode.
  await page.evaluate(() => {
    window.__dinksterTest!.app.openDocument({
      format: 'dinkster-workflow', formatVersion: 1, lineage: 'app-view-second', root: 'g0',
      graphs: { g0: { id: 'g0', name: 'root', nodes: {}, links: {}, nets: {}, reroutes: {}, nextOrdinal: 1 } },
      view: { graphs: {} },
    }, 'Second')
  })
  await page.waitForFunction(() => {
    const tab = window.__dinksterTest!.app.tabs.get().find((candidate) => candidate.id === 'app-view-second')
    return tab !== undefined && 'status' in tab.store
  })
  await selectView(page, 'App view')
  await expect(page.getByTestId('app-view-arrange-toggle')).toHaveAttribute('aria-pressed', 'false')
  await page.evaluate(() => window.__dinksterTest!.app.activeTabId.set('app-view-test'))
  await expect(page.getByTestId('app-view-arrange-toggle')).toHaveAttribute('aria-pressed', 'true')

  // Toggling back to use mode hides the tools again.
  await page.getByTestId('app-view-arrange-toggle').click()
  await expect(page.getByTestId('app-view-arrange-toggle')).toHaveAttribute('aria-pressed', 'false')
  await expect(page.getByTestId('app-view-drag-handle')).toHaveCount(0)
  await expect(page.getByTestId('app-view-remove')).toHaveCount(0)
})

test('exposure lens marks the exposed set and toggles App view rows', async ({ page }) => {
  await exposeViaMenu(page, 'count')
  await page.getByTestId('lens-switcher').click()
  await page.getByRole('menuitemradio', { name: /Exposure/ }).click()
  await expect(page.getByTestId('graph-canvas')).toHaveAttribute('data-lens', 'exposure')

  const indicators = await page.evaluate(() => {
    const renderer = window.__dinksterTest!.renderer! as unknown as {
      getScene(): { nodes: Array<{ id: string; layout: { rows: Array<{ kind: string; inputId?: string }> } }> }
      getLensCapabilities(): {
        widgetRowAffordance?: (node: unknown, row: unknown) => { active: boolean } | undefined
      }
    }
    const node = renderer.getScene().nodes.find((item) => item.id === 'widgets')!
    const capability = renderer.getLensCapabilities().widgetRowAffordance!
    return Object.fromEntries(node.layout.rows
      .filter((row) => row.kind === 'widget')
      .map((row) => [row.inputId!, capability(node, row)?.active]))
  })
  expect(indicators.count).toBe(true)
  expect(indicators.title).toBe(false)

  const titleToggle = page.getByTestId('canvas-exposure-a11y').filter({ hasText: 'title' })
  await expect(titleToggle).toHaveAttribute('aria-pressed', 'false')
  await titleToggle.focus()
  await titleToggle.press('Enter')
  expect((await exposedList(page))!.map((entry) => entry.inputId)).toEqual(['count', 'title'])
  await selectView(page, 'App view')
  await expect(page.getByTestId('app-view-row')).toHaveCount(2)

  await selectView(page, 'Graph')
  const point = await exposureAffordancePoint(page, 'title')
  await page.mouse.click(point.x, point.y)
  expect((await exposedList(page))!.map((entry) => entry.inputId)).toEqual(['count'])
  await selectView(page, 'App view')
  await expect(page.getByTestId('app-view-row')).toHaveCount(1)
})

test('custom WidgetView drawCompact renders in the graph and App view adapter', async ({ page }) => {
  await page.evaluate(() => {
    ;(window as unknown as { __appViewDraws: number }).__appViewDraws = 0
    const app = window.__dinksterTest!.app
    const diagnostics = app.extensions.register({
      id: 'app-view-literal-proof',
      displayName: 'App view literal proof',
      contributions: [
        { id: 'app-view-literal-proof.kind', category: 'widgetKind' },
        { id: 'app-view-literal-proof.view', category: 'widgetView' },
      ],
    }, (api) => {
      api.widgetKind('app-view-literal-proof.kind', {
        type: 'app-view-literal-proof.kind',
        valueSchema: { version: 1, validate: (value: unknown) => typeof value === 'number' },
        defaultValue: () => 7,
        validate: () => [],
        defaultView: () => 'app-view-literal-proof.view',
      })
      api.widgetView('app-view-literal-proof.view', {
        id: 'app-view-literal-proof.view', kind: 'app-view-literal-proof.kind', isCompatible: () => true,
        measure: () => ({ rows: 1 }),
        drawCompact(builder: { text(x: number, y: number, text: string, style: object): void }) {
          ;(window as unknown as { __appViewDraws: number }).__appViewDraws++
          builder.text(0, 0, 'literal proof', {})
        },
      })
    })
    if (diagnostics.length > 0) throw new Error(JSON.stringify(diagnostics))
    app.registerSchemas([{
      type: 'AppViewLiteralTest', displayName: 'App View Literal Test', category: 'test', source: 'v3', isOutputNode: false,
      items: [{
        kind: 'input', id: 'literal', type: { kind: 'concrete', name: 'app-view-literal-proof.kind' }, optional: false,
        widget: { widgetType: 'app-view-literal-proof.kind', options: {}, default: 7 },
      }],
    }])
    app.openDocument({
      format: 'dinkster-workflow', formatVersion: 1, lineage: 'app-view-literal-test', root: 'g0',
      graphs: { g0: { id: 'g0', name: 'root', nodes: { widgets: { id: 'widgets', type: 'AppViewLiteralTest', values: {} } }, links: {}, nets: {}, reroutes: {}, nextOrdinal: 2 } },
      view: { graphs: { g0: { nodes: { widgets: { position: { x: 100, y: 100 } } } } } },
    }, 'App View Literal Test')
    window.__dinksterTest!.renderer!.setViewport({ x: 0, y: 0, scale: 1 })
  })
  // Wait out the async workspace-authority tab promotion (see beforeEach).
  await page.waitForFunction(() => {
    const tab = window.__dinksterTest!.app.tabs.get().find((candidate) => candidate.id === 'app-view-literal-test')
    return tab !== undefined && 'status' in tab.store
  })
  await expect.poll(() => page.evaluate(() => (window as unknown as { __appViewDraws: number }).__appViewDraws)).toBeGreaterThan(0)
  const graphDraws = await page.evaluate(() => (window as unknown as { __appViewDraws: number }).__appViewDraws)

  await exposeViaMenu(page, 'literal')
  await selectView(page, 'App view')
  await expect(page.getByTestId('app-view-widget-preview')).toHaveAttribute('data-widget-view', 'app-view-literal-proof.view')
  await expect.poll(() => page.evaluate(() => (window as unknown as { __appViewDraws: number }).__appViewDraws)).toBeGreaterThan(graphDraws)
  await page.evaluate(() => window.__dinksterTest!.app.extensions.setContributionEnabled('app-view-literal-proof.view', false))
  await expect(page.getByTestId('app-view-widget-preview')).toHaveCount(0)
  await page.evaluate(() => window.__dinksterTest!.app.extensions.setContributionEnabled('app-view-literal-proof.view', true))
  await expect(page.getByTestId('app-view-widget-preview')).toHaveAttribute('data-widget-view', 'app-view-literal-proof.view')
})

test('control coverage: string/boolean/combo edit inline; ASSET renders read-only with a hint', async ({ page }) => {
  await exposeViaMenu(page, 'title')
  await exposeViaMenu(page, 'enabled')
  await exposeViaMenu(page, 'choice')
  await exposeViaMenu(page, 'asset')
  await selectView(page, 'App view')
  await expect(page.getByTestId('app-view-row')).toHaveCount(4)

  // Initial combo selection shows the stored typed value before interaction.
  const combo = page.getByTestId('app-view-combo')
  await expect(combo).toHaveRole('combobox')
  await expect(combo).toHaveText(/alpha/)
  await expect(combo).toHaveAttribute('data-selected-id', '0')
  expect(await combo.evaluate((element) => element.tagName)).toBe('BUTTON')

  await page.getByTestId('app-view-text').fill('new text')
  await page.getByTestId('app-view-text').blur()
  const boolean = page.getByTestId('app-view-boolean')
  await expect(boolean).toHaveAttribute('aria-checked', 'false')
  const booleanRevision = await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.revision)
  await boolean.press('Space')
  await expect(boolean).toHaveAttribute('aria-checked', 'true')
  expect(await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.revision)).toBe(booleanRevision + 1)
  await combo.click()
  await page.getByRole('option', { name: 'gamma' }).click()

  const values = (await activeDoc(page)).graphs.g0!.nodes.widgets!.values
  expect(values.title).toBe('new text')
  expect(values.enabled).toBe(true)
  expect(values.choice).toBe('gamma')

  // Out-of-vocabulary stored value: the disabled placeholder renders it
  // as the initial selection (frontend-owned diagnostic surface).
  await page.evaluate(() => {
    window.__dinksterTest!.app.activeTab()!.store.dispatch({
      command: 'node.setValue',
      params: { graphId: 'g0', nodeId: 'widgets', inputId: 'choice', value: 'zeta' },
    })
  })
  await expect(combo).toHaveText(/zeta/)
  await expect(combo).toHaveAttribute('data-selected-id', 'oov')
  await combo.click()
  await expect(page.getByRole('option', { name: 'zeta' })).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByRole('option', { name: 'zeta' })).toHaveAttribute('aria-disabled', 'true')
  await combo.press('Escape')

  // ASSET is not form-editable in v1: read-only value + canvas hint.
  await expect(page.getByTestId('app-view-readonly')).toHaveCount(1)
  await expect(page.getByTestId('app-view-readonly')).toContainText('edit on the canvas')
  const readOnly = page.getByTestId('app-view-readonly')
  const hint = await readOnly.getAttribute('data-tooltip-label')
  expect(hint).toContain('edit on the canvas')
  await expect(readOnly).not.toHaveAttribute('title')
  const revision = await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.revision)
  await readOnly.hover()
  await expect(page.getByTestId('app-tooltip')).toHaveText(hint!, { timeout: 1_500 })
  await readOnly.focus()
  await expect(page.getByTestId('app-tooltip')).toHaveText(hint!)
  expect(await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.revision)).toBe(revision)
})

test('parameter and preview renames await acceptance and preserve refused or newer drafts', {
  annotation: { type: 'mock-rename-dispatch' },
}, async ({ page }, testInfo) => {
  await page.evaluate(() => {
    const app = window.__dinksterTest!.app
    app.registerSchemas([{
      type: 'AppViewTest', displayName: 'App View Test', category: 'test', source: 'v3', isOutputNode: false,
      emitsPreviews: true,
      items: [{ kind: 'input', id: 'count', type: { kind: 'concrete', name: 'INT' }, optional: false,
        widget: { widgetType: 'INT', options: { min: 0, max: 100, step: 5 }, default: 5 } }],
    }])
    const tab = app.activeTab()!
    app.dispatchTo(tab, { command: 'params.expose', params: { graphId: 'g0', nodeId: 'widgets', inputId: 'count' } })
    app.dispatchTo(tab, { command: 'previews.expose', params: { graphId: 'g0', nodeId: 'widgets' } })
  })
  await selectView(page, 'App view')
  await enterArrange(page)
  for (const kind of ['app-view', 'app-preview']) {
    await page.evaluate(() => {
      const app = window.__dinksterTest!.app as any
      const dispatch = app.dispatchTo.bind(app)
      ;(window as any).__renameOriginal ??= dispatch
      ;(window as any).__renamePending = []
      app.dispatchTo = (tab: any, invocation: any) => new Promise((resolve) => {
        ;(window as any).__renamePending.push((accepted: boolean) => resolve(accepted ? (window as any).__renameOriginal(tab, invocation) : {
          ok: false, diagnostics: [{ severity: 'error', origin: 'command', code: 'command.retention.refused', message: 'Label change refused for test' }],
        }))
      })
    })
    const input = page.getByTestId(`${kind}-rename`)
    const open = () => page.getByTestId(`${kind}-rename-start`).click()
    const settle = (index: number, accepted: boolean) => page.evaluate(({ index, accepted }) => {
      ;(window as any).__renamePending[index](accepted)
    }, { index, accepted })
    const label = async () => ((await activeDoc(page)).ext?.[kind === 'app-view' ? 'dinkster.exposed' : 'dinkster.exposedPreviews'] as { label?: string }[])[0]!.label
    await open()
    await page.screenshot({ path: testInfo.outputPath(`${kind}-default.png`) })
    await input.fill('  Exact label  ')
    await input.press('Enter')
    await expect(input).toHaveAttribute('readonly', '')
    await expect(input.locator('..')).toHaveAttribute('aria-busy', 'true')
    await input.press('Enter')
    expect(await page.evaluate(() => (window as any).__renamePending.length)).toBe(1)
    expect(await label()).toBeUndefined()
    await page.screenshot({ path: testInfo.outputPath(`${kind}-pending.png`) })
    await settle(0, false)
    await expect(input).not.toHaveAttribute('readonly')
    await expect(input).toHaveValue('  Exact label  ')
    await expect(input.locator('..').getByRole('alert')).toHaveText('Label change refused for test')
    await page.screenshot({ path: testInfo.outputPath(`${kind}-refused.png`) })
    await page.setViewportSize({ width: 760, height: 900 })
    await expect(input).toHaveValue('  Exact label  ')
    await page.screenshot({ path: testInfo.outputPath(`${kind}-refused-narrow.png`) })
    await page.setViewportSize({ width: 1280, height: 900 })
    await input.press('Enter')
    await settle(1, true)
    await expect(input).toHaveCount(0)
    expect(await label()).toBe('Exact label')
    await page.screenshot({ path: testInfo.outputPath(`${kind}-accepted.png`) })
    expect(await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.undo())).toBe(true)
    expect(await label()).toBeUndefined()
    await open()
    await input.fill('Old label')
    await input.press('Enter')
    await input.press('Escape')
    await open()
    await input.fill('New label')
    await input.press('Enter')
    await settle(2, true)
    await expect(input).toHaveValue('New label')
    await expect(input).toHaveAttribute('readonly', '')
    await settle(3, false)
    await expect(input).toHaveValue('New label')
    await expect(input.locator('..').getByRole('alert')).toBeVisible()
    await input.press('Enter')
    await page.getByTestId('app-view-arrange-toggle').click()
    await page.getByTestId('app-view-arrange-toggle').click()
    await expect(input).toHaveCount(0)
    await open()
    await input.fill('Next draft')
    await settle(4, false)
    await expect(input).toHaveValue('Next draft')
    await expect(input.locator('..').getByRole('alert')).toHaveCount(0)
    await input.fill('   ')
    await input.press('Enter')
    await settle(5, true)
    await expect(input).toHaveCount(0)
    expect(await label()).toBeUndefined()
  }
})

test('authored text group and queue drafts await final outcomes', {
  annotation: { type: 'mock-rename-dispatch' },
}, async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 1200 })
  await page.evaluate(() => {
    const app = window.__dinksterTest!.app
    const tab = app.activeTab()!
    const added = app.dispatchTo(tab, { command: 'node.add', params: { graphId: 'g0', type: 'AppViewTest', title: 'Other queue target', position: { x: 450, y: 100 } } })
    if (!added.ok) throw new Error(JSON.stringify(added.diagnostics))
    for (const item of [
      { id: 'draft-text', kind: 'text', role: 'body', text: 'Original instructions' },
      { id: 'draft-group', kind: 'group', title: 'Original group', children: [] },
      { id: 'draft-queue', kind: 'queue', label: 'Original queue', targets: [{ graphId: 'g0', nodeId: 'widgets' }] },
    ]) {
      const outcome = app.dispatchTo(tab, { command: 'app.layout.add', params: { item } })
      if (!outcome.ok) throw new Error(JSON.stringify(outcome.diagnostics))
    }
  })
  await selectView(page, 'App view')
  await enterArrange(page)
  await page.evaluate(() => {
    const app = window.__dinksterTest!.app as any
    const dispatch = app.dispatchTo.bind(app)
    ;(window as any).__draftPending = []
    app.dispatchTo = (tab: any, invocation: any) => new Promise((resolve) => {
      ;(window as any).__draftPending.push((accepted: boolean) => resolve(accepted ? dispatch(tab, invocation) : {
        ok: false, diagnostics: [{ severity: 'error', origin: 'command', code: 'command.retention.refused', message: 'Authored edit refused for test' }],
      }))
    })
  })
  const text = page.getByTestId('app-layout-text-input')
  const group = page.getByTestId('app-layout-group-title')
  const queue = page.getByTestId('app-layout-queue-label')
  const controls = [text, group, queue]
  const draftValues = ['  **Exact instructions**  ', '  Exact group  ', '  Exact queue  ']
  const settle = (indices: number[], accepted: boolean) => page.evaluate(({ indices, accepted }) => {
    for (const index of indices) (window as any).__draftPending[index](accepted)
  }, { indices, accepted })
  const items = () => page.evaluate(() => (window.__dinksterTest!.app.activeTab()!.store.doc.ext?.['dinkster.appLayout'] as any).desktop.items)
  const submit = async () => {
    await text.press('Control+Enter')
    await group.focus()
    await group.press('Enter')
    await queue.focus()
    await queue.press('Enter')
  }
  await page.screenshot({ path: testInfo.outputPath('authored-default.png') })
  for (let index = 0; index < controls.length; index++) await controls[index]!.fill(draftValues[index]!)
  await submit()
  for (const control of controls) await expect(control).toHaveAttribute('readonly', '')
  await submit()
  expect(await page.evaluate(() => (window as any).__draftPending.length)).toBe(3)
  expect(await items()).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: 'draft-text', text: 'Original instructions' }),
    expect.objectContaining({ id: 'draft-group', title: 'Original group' }),
    expect.objectContaining({ id: 'draft-queue', label: 'Original queue' }),
  ]))
  await page.screenshot({ path: testInfo.outputPath('authored-pending.png') })
  await settle([0, 1, 2], false)
  for (let index = 0; index < controls.length; index++) {
    await expect(controls[index]!).not.toHaveAttribute('readonly')
    await expect(controls[index]!).toHaveValue(draftValues[index]!)
    await expect(controls[index]!).toHaveAttribute('aria-invalid', 'true')
  }
  await expect(page.getByRole('alert')).toHaveCount(3)
  await page.screenshot({ path: testInfo.outputPath('authored-refused.png') })
  await page.setViewportSize({ width: 760, height: 1200 })
  await page.screenshot({ path: testInfo.outputPath('authored-refused-narrow.png') })
  await page.getByTestId('app-layout-queue').scrollIntoViewIfNeeded()
  await page.screenshot({ path: testInfo.outputPath('authored-refused-narrow-queue.png') })
  await page.setViewportSize({ width: 1440, height: 1200 })
  await submit()
  await settle([3, 4, 5], true)
  for (const control of controls) await expect(control).not.toHaveAttribute('readonly')
  expect(await items()).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: 'draft-text', text: draftValues[0] }),
    expect.objectContaining({ id: 'draft-group', title: 'Exact group' }),
    expect.objectContaining({ id: 'draft-queue', label: 'Exact queue' }),
  ]))
  await expect(page.getByRole('alert')).toHaveCount(0)
  await page.screenshot({ path: testInfo.outputPath('authored-accepted.png') })
  await page.evaluate(() => { for (let index = 0; index < 3; index++) window.__dinksterTest!.app.activeTab()!.store.undo() })
  expect(await items()).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: 'draft-text', text: 'Original instructions' }),
    expect.objectContaining({ id: 'draft-group', title: 'Original group' }),
    expect.objectContaining({ id: 'draft-queue', label: 'Original queue' }),
  ]))
  await text.fill('Old pending text')
  await text.press('Control+Enter')
  await page.getByTestId('app-view-arrange-toggle').click()
  await page.getByTestId('app-view-arrange-toggle').click()
  await text.fill('New pending text')
  await text.press('Control+Enter')
  await settle([6], false)
  await expect(text).toHaveValue('New pending text')
  await expect(text).toHaveAttribute('readonly', '')
  await expect(page.getByRole('alert')).toHaveCount(0)
  await settle([7], true)
  await expect(text).not.toHaveAttribute('readonly')
  expect((await items()).find((item: any) => item.id === 'draft-text').text).toBe('New pending text')
  await text.focus()
  await text.press('Control+a')
  const bold = page.getByRole('button', { name: 'Bold', exact: true })
  const style = page.getByTestId('app-layout-text-role')
  await bold.click()
  await expect(text).toHaveValue('**New pending text**')
  await expect(bold).toBeDisabled()
  await expect(style).toBeDisabled()
  await settle([8], false)
  await expect(text).toHaveValue('**New pending text**')
  expect((await items()).find((item: any) => item.id === 'draft-text').text).toBe('New pending text')
  await text.press('Control+Enter')
  await settle([9], true)
  await expect(text).not.toHaveAttribute('readonly')
  expect((await items()).find((item: any) => item.id === 'draft-text').text).toBe('**New pending text**')
  await style.click()
  await page.getByRole('option', { name: 'Heading', exact: true }).click()
  await expect(style).toContainText('Body')
  await settle([10], false)
  await expect(style).toContainText('Body')
  await style.click()
  await page.getByRole('option', { name: 'Heading', exact: true }).click()
  await settle([11], true)
  await expect(style).toContainText('Heading')
  const target = page.getByRole('checkbox', { name: 'Other queue target', exact: true })
  await target.click()
  await expect(target).not.toBeChecked()
  await expect(target).toBeDisabled()
  await expect(queue).toHaveAttribute('readonly', '')
  await settle([12], false)
  await expect(target).not.toBeChecked()
  await expect(target).toBeEnabled()
  await target.click()
  await settle([13], true)
  await expect(target).toBeChecked()
  expect((await items()).find((item: any) => item.id === 'draft-queue').targets).toHaveLength(2)
  await group.fill('Old accepted group')
  await group.press('Enter')
  await queue.fill('Old accepted queue')
  await queue.press('Enter')
  await page.getByTestId('app-view-arrange-toggle').click()
  await page.getByTestId('app-view-arrange-toggle').click()
  await group.fill('Newer group draft')
  await queue.fill('Newer queue draft')
  await settle([14, 15], true)
  await expect(group).toHaveValue('Newer group draft')
  await expect(queue).toHaveValue('Newer queue draft')
  expect(await items()).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: 'draft-group', title: 'Old accepted group' }),
    expect.objectContaining({ id: 'draft-queue', label: 'Old accepted queue' }),
  ]))
})

test('rename and reorder are document commands; stale rows stay removable', async ({ page }) => {
  await exposeViaMenu(page, 'count')
  await exposeViaMenu(page, 'title')
  await selectView(page, 'App view')
  await enterArrange(page)

  // Rename the first entry; the label override persists in the document.
  await page.getByTestId('app-view-rename-start').first().click()
  await page.getByTestId('app-view-rename').fill('Steps')
  await page.getByTestId('app-view-rename').press('Enter')
  await expect(page.getByTestId('app-view-label').first()).toContainText('Steps')
  expect((await exposedList(page))![0]).toMatchObject({ inputId: 'count', label: 'Steps' })

  // Reorder: move the first row down.
  await page.getByTestId('app-view-move-down').first().click()
  expect((await exposedList(page))!.map((e) => e.inputId)).toEqual(['title', 'count'])

  // Delete the node underneath: both rows go stale but stay removable.
  await page.evaluate(() => {
    window.__dinksterTest!.app.activeTab()!.store.dispatch({
      command: 'node.remove',
      params: { graphId: 'g0', nodeIds: ['widgets'] },
    })
  })
  await expect(page.getByTestId('app-view-stale')).toHaveCount(2)
  await expect(page.getByTestId('app-view-stale').first()).toContainText('node no longer exists')
  await page.getByTestId('app-view-remove').first().click()
  await expect(page.getByTestId('app-view-row')).toHaveCount(1)
})

test('drag reorder dispatches params.move with the dragged row and drop index', async ({ page }) => {
  await exposeViaMenu(page, 'count')
  await exposeViaMenu(page, 'title')
  await exposeViaMenu(page, 'enabled')
  await selectView(page, 'App view')
  await enterArrange(page)

  await page.getByTestId('app-view-drag-handle').nth(2).dragTo(page.getByTestId('app-view-row').first())
  expect((await exposedList(page))!.map((entry) => entry.inputId)).toEqual(['enabled', 'count', 'title'])

  // The button path remains available and keyboard-focusable.
  await expect(page.getByTestId('app-view-move-down').first()).toBeEnabled()
  await page.getByTestId('app-view-move-down').first().focus()
  await page.keyboard.press('Enter')
  expect((await exposedList(page))!.map((entry) => entry.inputId)).toEqual(['count', 'enabled', 'title'])
})

test('COLOR edits inline through the shared document commit path', async ({ page }) => {
  await exposeViaMenu(page, 'color')
  await selectView(page, 'App view')

  await page.getByTestId('app-view-color').click()
  await page.getByRole('textbox', { name: 'Hex color' }).fill('#336699')
  await page.getByRole('button', { name: 'Apply color' }).click()
  expect((await activeDoc(page)).graphs.g0!.nodes.widgets!.values.color).toBe('#336699')
  await page.keyboard.press('Control+z')
  expect((await activeDoc(page)).graphs.g0!.nodes.widgets!.values.color).toBeUndefined()
})

test('remote COMBO fetches on open, preserves an OOV placeholder, and commits a fetched option', async ({ page }) => {
  await page.route(`**${REMOTE_ROUTE}*`, (route) =>
    void route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(['alpha', 'beta']) }))
  await exposeViaMenu(page, 'remoteChoice')
  await selectView(page, 'App view')

  const combo = page.getByTestId('app-view-combo')
  await combo.click()
  await expect(combo).toHaveAttribute('aria-expanded', 'true')
  await expect(combo).toHaveAttribute('data-remote', 'ready')
  await expect(combo).toHaveAttribute('aria-expanded', 'true')
  await expect(page.getByRole('option', { name: 'old' })).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByRole('option', { name: 'old' })).toHaveAttribute('aria-disabled', 'true')
  const revision = await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.revision)
  await page.getByRole('option', { name: 'beta' }).click()
  expect((await activeDoc(page)).graphs.g0!.nodes.widgets!.values.remoteChoice).toBe('beta')
  expect(await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.revision)).toBe(revision + 1)
})

test('remote COMBO failure stays editable with the authoritative OOV value and fetch error', async ({ page }) => {
  await page.route(`**${REMOTE_ROUTE}*`, (route) => void route.fulfill({ status: 500, body: 'nope' }))
  await exposeViaMenu(page, 'remoteChoice')
  await selectView(page, 'App view')

  const combo = page.getByTestId('app-view-combo')
  await combo.click()
  await expect(combo).toHaveAttribute('aria-expanded', 'true')
  await expect(combo).toHaveAttribute('data-remote', 'unavailable')
  await expect(combo).toHaveAttribute('aria-expanded', 'true')
  await expect(page.getByRole('option', { name: 'old' })).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByRole('option', { name: 'old' })).toHaveAttribute('aria-disabled', 'true')
  await expect(page.getByTestId('app-view-remote-error')).toBeVisible()
  expect((await activeDoc(page)).graphs.g0!.nodes.widgets!.values.remoteChoice).toBeUndefined()
})
