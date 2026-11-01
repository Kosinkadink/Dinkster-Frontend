/**
 * App view exposes parameters as a form-style
 * projection of the SAME document. The specs pin the end-to-end story:
 * expose a widget from the canvas context menu, switch the tab to the app
 * editor kind, edit the value through the form control, and observe the
 * identical document write a canvas widget edit would produce - then the
 * stale/remove recovery path and the round trip back to the graph editor.
 */
import { expect, openRailPanel, appViewTest as test, type Page } from './fixtures.js'

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

test('control surface group binding waits for final acceptance', {
  annotation: { type: 'mock-rename-dispatch' },
}, async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 1000 })
  const { surfaceId, groupId } = await page.evaluate(() => {
    const app = window.__dinksterTest!.app as any
    app.settings.set('features.controlSurfaces.enabled', true)
    const tab = app.activeTab()!
    for (const invocation of [
      { command: 'view.createGroup', params: { graphId: 'g0', title: 'Binding target', bounds: { x: 100, y: 100, width: 250, height: 200 } } },
      { command: 'surface.add', params: { type: 'core.modePanel', config: { title: 'Mode panel', bindings: [] } } },
    ]) {
      const outcome = app.dispatchTo(tab, invocation)
      if (!outcome.ok) throw new Error(JSON.stringify(outcome.diagnostics))
    }
    const dispatch = app.dispatchTo.bind(app)
    ;(window as any).__surfaceGroupPending = []
    app.dispatchTo = (owner: any, invocation: any) => invocation.command !== 'surface.update'
      ? dispatch(owner, invocation)
      : new Promise((resolve, reject) => {
        ;(window as any).__surfaceGroupPending.push((result: string) => result === 'throw'
          ? reject(new Error('Group transport refused for test'))
          : resolve(result === 'accept' ? dispatch(owner, invocation) : {
              ok: false, diagnostics: [{ severity: 'error', phase: 'command', code: 'test.refused', message: 'Group binding refused for test' }],
            }))
      })
    return { surfaceId: Object.keys(tab.store.doc.surfaces!)[0]!, groupId: Object.keys(tab.store.doc.view.graphs.g0.groups)[0]! }
  })
  await openRailPanel(page, 'Control surfaces')
  const trigger = page.getByTestId(`surface-bind-group-${surfaceId}`)
  const option = page.getByRole('option', { name: 'Binding target', exact: true })
  const listbox = page.getByRole('listbox', { name: 'Bind group to surface' })
  const error = page.getByTestId('surface-group-error')
  const settle = (result: string) => page.evaluate((result) => (window as any).__surfaceGroupPending.shift()(result), result)
  const bindings = () => page.evaluate((id) => (window.__dinksterTest!.app.activeTab()!.store.doc.surfaces![id]!.config as any).bindings, surfaceId)
  await trigger.click()
  await page.screenshot({ path: testInfo.outputPath('surface-group-default.png') })
  await option.click()
  await page.screenshot({ path: testInfo.outputPath('surface-group-before-pending.png') })
  await expect(trigger).toHaveAttribute('aria-busy', 'true')
  await expect(listbox).toBeVisible()
  await expect(option).toHaveAttribute('aria-disabled', 'true')
  await expect(page.getByTestId('surface-add')).toBeDisabled()
  expect(await bindings()).toEqual([])
  await page.screenshot({ path: testInfo.outputPath('surface-group-pending.png') })
  await settle('refuse')
  await expect(error).toHaveText('Group binding refused for test')
  await expect(listbox).toBeVisible()
  expect(await bindings()).toEqual([])
  await page.screenshot({ path: testInfo.outputPath('surface-group-refused.png') })
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(error).toBeInViewport()
  await expect(option).toBeInViewport()
  await page.screenshot({ path: testInfo.outputPath('surface-group-refused-narrow.png') })
  await page.setViewportSize({ width: 1440, height: 1000 })
  await option.click()
  await settle('accept')
  await expect(listbox).toBeHidden()
  await expect(trigger).toBeFocused()
  await expect(error).toBeHidden()
  expect(await bindings()).toEqual([{ kind: 'group', graphId: 'g0', groupId }])
  await page.screenshot({ path: testInfo.outputPath('surface-group-accepted.png') })

  await page.getByTestId(`surface-unbind-${surfaceId}-0`).click()
  await settle('accept')
  await trigger.click()
  await option.click()
  await trigger.press('Escape')
  await trigger.click()
  await expect(option).toHaveAttribute('aria-disabled', 'true')
  await settle('refuse')
  await expect(option).toHaveAttribute('aria-disabled', 'false')
  await expect(error).toBeHidden()
  await expect(listbox).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('surface-group-dismissed.png') })
  await option.click()
  await settle('throw')
  await expect(error).toHaveText('Group transport refused for test')
  await expect(listbox).toBeVisible()
  await option.click()
  await page.evaluate(() => {
    const app = window.__dinksterTest!.app
    const tab = app.activeTab()!
    tab.graphStack.set([...tab.graphStack.get()])
  })
  await settle('refuse')
  await expect(error).toBeHidden()
  await expect(listbox).toBeVisible()
  expect(await bindings()).toEqual([])
})

test('shell named-net display changes await final acceptance', {
  annotation: { type: 'mock-rename-dispatch' },
}, async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.getByRole('button', { name: /^Toggle right rail/ }).click()
  const netId = await page.evaluate(() => {
    const app = window.__dinksterTest!.app as any
    const tab = app.activeTab()!
    app.registerSchemas([{
      type: 'NetDisplayTest', displayName: 'Net Display Test', category: 'test', source: 'v3', isOutputNode: false,
      items: [{ kind: 'output', id: 'value', type: { kind: 'concrete', name: 'INT' } }],
    }])
    const nodeId = tab.store.predictedNodeId('g0')!
    for (const invocation of [
      { command: 'node.add', params: { graphId: 'g0', type: 'NetDisplayTest', position: { x: 450, y: 100 } } },
      { command: 'net.create', params: { graphId: 'g0', name: 'Display test', source: { node: nodeId, port: 'value' } } },
    ]) {
      const outcome = app.dispatchTo(tab, invocation)
      if (!outcome.ok) throw new Error(JSON.stringify(outcome.diagnostics))
    }
    const dispatch = app.dispatchTo.bind(app)
    ;(window as any).__netDisplayPending = []
    ;(app as any).dispatchTo = (owner: any, invocation: any) => invocation.command !== 'view.setAllNetsDisplay'
      ? dispatch(owner, invocation)
      : new Promise((resolve, reject) => {
        ;(window as any).__netDisplayPending.push((result: string) => result === 'throw'
          ? reject(new Error('Display transport failed for test'))
          : resolve(result === 'accept' ? dispatch(owner, invocation) : {
            ok: false, diagnostics: [{ severity: 'error', origin: 'command', code: 'command.retention.refused', message: 'Net display refused for test' }],
          }))
      })
    return Object.keys(tab.store.doc.graphs.g0!.nets!)[0]!
  })
  const trigger = page.getByTestId('views-switcher')
  const menu = page.locator('.view-menu')
  const tags = page.getByTestId('net-display-all-tags')
  const notice = page.getByTestId('net-display-error')
  const state = () => page.evaluate(() => {
    const view = window.__dinksterTest!.app.activeTab()!.store.doc.view.graphs.g0!
    return { collapsed: view.collapsedNets ?? [], guides: view.guideNets ?? [] }
  })
  const settle = (index: number, result: string) => page.evaluate(({ index, result }) => {
    ;(window as any).__netDisplayPending[index](result)
  }, { index, result })
  await trigger.click()
  await page.screenshot({ path: testInfo.outputPath('net-display-default.png') })
  await tags.click()
  await expect(menu).toHaveAttribute('aria-busy', 'true')
  await expect(tags).toBeDisabled()
  await tags.evaluate((element: HTMLButtonElement) => element.click())
  expect(await page.evaluate(() => (window as any).__netDisplayPending.length)).toBe(1)
  expect(await state()).toEqual({ collapsed: [], guides: [] })
  await page.screenshot({ path: testInfo.outputPath('net-display-pending.png') })
  await settle(0, 'refuse')
  await expect(notice).toHaveText('Net display refused for test')
  await expect(tags).toBeEnabled()
  expect(await state()).toEqual({ collapsed: [], guides: [] })
  await page.screenshot({ path: testInfo.outputPath('net-display-refused.png') })
  await page.setViewportSize({ width: 390, height: 1000 })
  await expect(notice).toBeInViewport()
  await page.screenshot({ path: testInfo.outputPath('net-display-refused-narrow.png') })
  await tags.click()
  await settle(1, 'accept')
  await expect(menu).toHaveCount(0)
  await expect(trigger).toBeFocused()
  expect(await state()).toEqual({ collapsed: [netId], guides: [] })
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.screenshot({ path: testInfo.outputPath('net-display-accepted.png') })
  await trigger.click()
  await page.getByTestId('net-display-all-guide').click()
  await page.keyboard.press('Escape')
  await trigger.click()
  await expect(tags).toBeDisabled()
  await settle(2, 'refuse')
  await expect(tags).toBeEnabled()
  await expect(notice).toHaveCount(0)
  await expect(menu).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('net-display-dismissed.png') })
  await page.getByTestId('net-display-all-guide').click()
  await settle(3, 'throw')
  await expect(notice).toHaveText('Display transport failed for test')
  await page.getByTestId('net-display-all-guide').click()
  await settle(4, 'accept')
  await expect(menu).toHaveCount(0)
  expect(await state()).toEqual({ collapsed: [netId], guides: [netId] })
  await trigger.click()
  await tags.click()
  await page.evaluate(() => {
    const app = window.__dinksterTest!.app as any
    app.setTabEditorKind(app.activeTab()!.id, 'app')
  })
  await expect(page.getByTestId('app-view')).toBeVisible()
  await settle(5, 'refuse')
  await expect(notice).toHaveCount(0)
  await expect(menu).toBeVisible()
  await page.getByTestId('net-display-all-noodle').click()
  await settle(6, 'accept')
  await expect(menu).toHaveCount(0)
  expect(await state()).toEqual({ collapsed: [], guides: [] })
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

test('shared widget commits await acceptance and retain refused drafts', {
  annotation: { type: 'mock-rename-dispatch' },
}, async ({ page }, testInfo) => {
  await page.evaluate(() => {
    const app = window.__dinksterTest!.app as any
    const tab = app.activeTab()
    const schema = app.registryForTab(tab).resolve('AppViewTest')
    app.registerSchemas([{ ...schema, items: [...schema.items, {
      kind: 'input', id: 'notes', type: { kind: 'concrete', name: 'STRING' }, optional: false,
      widget: { widgetType: 'STRING', default: 'Original notes', options: { multiline: true } },
    }] }])
    app.dispatchTo(tab, { command: 'node.setValue', params: { graphId: 'g0', nodeId: 'widgets', inputId: 'title', value: 'Original title' } })
    app.dispatchTo(tab, { command: 'node.setValue', params: { graphId: 'g0', nodeId: 'widgets', inputId: 'notes', value: 'Original notes' } })
    const dispatch = app.dispatchTo.bind(app)
    ;(window as any).__widgetPending = []
    app.dispatchTo = (owner: any, invocation: any) => new Promise((resolve) => {
      ;(window as any).__widgetPending.push((accepted: boolean) => resolve(accepted ? dispatch(owner, invocation) : {
        ok: false, diagnostics: [{ severity: 'error', origin: 'command', code: 'command.retention.refused', message: 'Widget edit refused for test' }],
      }))
    })
  })
  const settle = (index: number, accepted: boolean) => page.evaluate(({ index, accepted }) => (window as any).__widgetPending[index](accepted), { index, accepted })
  const value = (input: string) => page.evaluate((input) => window.__dinksterTest!.app.activeTab()!.store.doc.graphs.g0!.nodes.widgets!.values[input], input)
  const open = async (input: string) => {
    const point = await widgetPoint(page, input)
    await page.mouse.click(point.x, point.y)
  }
  await open('title')
  const editor = page.getByTestId('widget-editor')
  const input = editor.locator('input')
  await expect(input).toHaveValue('Original title')
  await page.screenshot({ path: testInfo.outputPath('widget-default.png') })
  await input.fill('  Exact title draft  ')
  await input.press('Enter')
  await expect(page.locator('.widget-commit-content')).toHaveAttribute('inert', '')
  expect(await value('title')).toBe('Original title')
  await page.evaluate(() => document.querySelector<HTMLButtonElement>('[data-testid=widget-editor-commit]')!.click())
  expect(await page.evaluate(() => (window as any).__widgetPending.length)).toBe(1)
  await page.screenshot({ path: testInfo.outputPath('widget-pending.png') })
  await settle(0, false)
  await expect(page.locator('.widget-commit-content')).not.toHaveAttribute('inert')
  await expect(input).toHaveValue('  Exact title draft  ')
  await expect(page.getByTestId('widget-commit-error')).toContainText('Widget edit refused for test')
  await page.screenshot({ path: testInfo.outputPath('widget-refused.png') })
  await page.setViewportSize({ width: 760, height: 900 })
  await page.screenshot({ path: testInfo.outputPath('widget-refused-narrow.png') })
  await page.setViewportSize({ width: 1440, height: 900 })
  await input.press('Enter')
  await settle(1, true)
  await expect(editor).toHaveCount(0)
  expect(await value('title')).toBe('  Exact title draft  ')
  await page.screenshot({ path: testInfo.outputPath('widget-accepted.png') })
  await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.undo())
  expect(await value('title')).toBe('Original title')
  await open('title')
  await input.fill('Old pending draft')
  await input.press('Enter')
  await page.keyboard.press('Escape')
  await expect(editor).toHaveCount(0)
  await open('title')
  await input.fill('New pending draft')
  await input.press('Enter')
  await settle(2, false)
  await expect(input).toHaveValue('New pending draft')
  await expect(page.locator('.widget-commit-content')).toHaveAttribute('inert', '')
  await expect(page.getByTestId('widget-commit-error')).toHaveCount(0)
  await settle(3, true)
  await expect(editor).toHaveCount(0)
  expect(await value('title')).toBe('New pending draft')
  await open('choice')
  await page.getByTestId('combo-option').filter({ hasText: 'beta' }).click()
  expect(await value('choice')).toBeUndefined()
  await settle(4, false)
  await expect(page.getByTestId('combo-dropdown')).toBeVisible()
  await expect(page.getByTestId('widget-commit-error')).toBeVisible()
  await page.getByTestId('combo-option').filter({ hasText: 'beta' }).click()
  await settle(5, true)
  await expect(page.getByTestId('combo-dropdown')).toHaveCount(0)
  expect(await value('choice')).toBe('beta')
  await open('notes')
  const notes = editor.locator('textarea')
  await notes.fill('Exact multiline\n  draft')
  await notes.press('Control+Enter')
  expect(await value('notes')).toBe('Original notes')
  await settle(6, false)
  await expect(notes).toHaveValue('Exact multiline\n  draft')
  await expect(page.getByTestId('widget-commit-error')).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('widget-in-node-refused.png') })
  await notes.press('Control+Enter')
  await settle(7, true)
  await expect(editor).toHaveCount(0)
  expect(await value('notes')).toBe('Exact multiline\n  draft')
  await open('asset')
  await expect(page.getByTestId('widget-modal-surface')).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('widget-modal-default.png') })
  await page.getByTestId('asset-apply').click()
  await expect(page.locator('.widget-commit-content')).toHaveAttribute('inert', '')
  await page.screenshot({ path: testInfo.outputPath('widget-modal-pending.png') })
  await settle(8, false)
  await expect(page.getByTestId('widget-commit-error')).toBeVisible()
  await page.getByTestId('asset-apply').scrollIntoViewIfNeeded()
  await page.screenshot({ path: testInfo.outputPath('widget-modal-refused.png') })
  await page.getByTestId('asset-apply').click()
  await settle(9, true)
  await expect(page.getByTestId('widget-modal-surface')).toHaveCount(0)
  expect(await value('asset')).toBeNull()
})

test('combo authored menus and refresh selections await final outcomes', {
  annotation: { type: 'mock-rename-dispatch' },
}, async ({ page }, info) => {
  await page.route(`**${REMOTE_ROUTE}*`, (route) => route.fulfill({ json: ['fresh-a', 'fresh-z'] }))
  await page.evaluate(() => {
    const app = window.__dinksterTest!.app as any
    const tab = app.activeTab()
    const schema = app.registryForTab(tab).resolve('AppViewTest')
    app.registerSchemas([{ ...schema, items: schema.items.map((item: any) => item.id === 'choice'
      ? { ...item, widget: { ...item.widget, editableOptions: true } }
      : item.id === 'remoteChoice' ? { ...item, widget: { ...item.widget, remote: { ...item.widget.remote, refreshButton: true, controlAfterRefresh: 'last' } } } : item) }])
    const dispatch = app.dispatchTo.bind(app)
    ;(window as any).__comboPending = []
    app.dispatchTo = (owner: any, invocation: any) => new Promise((resolve) => {
      ;(window as any).__comboPending.push((accepted: boolean) => resolve(accepted ? dispatch(owner, invocation) : {
        ok: false, diagnostics: [{ severity: 'error', origin: 'command', code: 'command.retention.refused', message: 'Combo edit refused for test' }],
      }))
    })
  })
  const settle = (index: number, accepted: boolean) => page.evaluate(({ index, accepted }) => (window as any).__comboPending[index](accepted), { index, accepted })
  const open = async (id: string) => { const point = await widgetPoint(page, id); await page.mouse.click(point.x, point.y) }
  await open('choice')
  await page.getByTestId('combo-menu-draft').fill('[false, "exact draft", false]')
  await page.screenshot({ path: info.outputPath('combo-authoring-default.png') })
  await page.getByTestId('combo-menu-apply').click()
  await expect(page.locator('.widget-commit-content')).toHaveAttribute('inert', '')
  await page.evaluate(() => document.querySelector<HTMLButtonElement>('[data-testid=combo-menu-apply]')!.click())
  expect(await page.evaluate(() => (window as any).__comboPending.length)).toBe(1)
  expect((await activeDoc(page)).graphs.g0!.nodes.widgets!.dynamic?.choice).toBeUndefined()
  await page.screenshot({ path: info.outputPath('combo-authoring-pending.png') })
  await settle(0, false)
  await expect(page.getByTestId('widget-commit-error')).toHaveText('Combo edit refused for test')
  await expect(page.getByTestId('combo-menu-draft')).toHaveValue('[false, "exact draft", false]')
  await expect(page.getByTestId('widget-commit-error')).toBeInViewport()
  await page.screenshot({ path: info.outputPath('combo-authoring-refused.png') })
  await page.setViewportSize({ width: 760, height: 900 })
  await expect(page.getByTestId('widget-commit-error')).toBeInViewport()
  await page.screenshot({ path: info.outputPath('combo-authoring-narrow.png') })
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.getByTestId('combo-menu-apply').click()
  await settle(1, true)
  await expect(page.getByTestId('combo-dropdown')).toHaveCount(0)
  expect((await activeDoc(page)).graphs.g0!.nodes.widgets!.dynamic?.choice).toEqual(expect.objectContaining({ options: [false, 'exact draft', false] }))
  await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.undo())
  expect((await activeDoc(page)).graphs.g0!.nodes.widgets!.dynamic?.choice).toBeUndefined()
  await open('remoteChoice')
  await expect(page.getByTestId('combo-dropdown')).toHaveAttribute('data-remote', 'ready')
  await page.getByTestId('remote-refresh').click()
  await expect(page.locator('.widget-commit-content')).toHaveAttribute('inert', '')
  await settle(2, false)
  await expect(page.getByTestId('widget-commit-error')).toBeVisible()
  expect((await activeDoc(page)).graphs.g0!.nodes.widgets!.values.remoteChoice).toBeUndefined()
  await page.screenshot({ path: info.outputPath('combo-refresh-refused.png') })
  await page.getByTestId('remote-refresh').click()
  await expect(page.locator('.widget-commit-content')).toHaveAttribute('inert', '')
  await settle(3, true)
  await expect(page.getByTestId('combo-dropdown')).toHaveCount(0)
  expect((await activeDoc(page)).graphs.g0!.nodes.widgets!.values.remoteChoice).toBe('fresh-z')
  await open('remoteChoice')
  await expect(page.getByTestId('combo-dropdown')).toBeVisible()
  await expect(page.locator('.widget-commit-content')).not.toHaveAttribute('inert')
  await expect(page.getByTestId('widget-commit-error')).toHaveCount(0)
  await page.screenshot({ path: info.outputPath('combo-refresh-accepted.png') })
})

test('layout group selection awaits automatic placement and existing move acceptance', {
  annotation: { type: 'mock-rename-dispatch' },
}, async ({ page }, testInfo) => {
  await page.evaluate(() => {
    const app = window.__dinksterTest!.app
    const tab = app.activeTab()!
    app.dispatchTo(tab, { command: 'params.expose', params: { graphId: 'g0', nodeId: 'widgets', inputId: 'title' } })
    app.dispatchTo(tab, { command: 'app.layout.add', params: {
      item: { id: 'controls', kind: 'group', title: 'Controls', children: [] },
    } })
  })
  await selectView(page, 'App view')
  await enterArrange(page)
  await page.evaluate(() => {
    const app = window.__dinksterTest!.app as any
    const dispatch = app.dispatchTo.bind(app)
    ;(window as any).__parentPending = []
    app.dispatchTo = (tab: any, invocation: any) => new Promise((resolve, reject) => {
      ;(window as any).__parentPending.push((result: string) => {
        if (result === 'throw') reject(new Error('Group transport failed for test'))
        else resolve(result === 'accept' ? dispatch(tab, invocation) : {
          ok: false, diagnostics: [{ severity: 'error', origin: 'command', code: 'command.retention.refused', message: 'Group edit refused for test' }],
        })
      })
    })
  })
  const parent = page.getByTestId('app-view-row').getByTestId('app-layout-parent')
  const notice = page.getByTestId('app-layout-gesture-error')
  const count = () => page.evaluate(() => (window as any).__parentPending.length)
  const settle = (index: number, result: string) => page.evaluate(({ index, result }) => (window as any).__parentPending[index](result), { index, result })
  const items = () => page.evaluate(() => (window.__dinksterTest!.app.activeTab()!.store.doc.ext?.['dinkster.appLayout'] as any).desktop.items)
  const children = async () => (await items()).find((item: any) => item.id === 'controls').children
  await expect(parent).toHaveText('Top level')
  await page.screenshot({ path: testInfo.outputPath('group-default.png') })
  await parent.click()
  await page.getByRole('option', { name: 'Controls', exact: true }).click()
  await expect(parent).toHaveAttribute('aria-expanded', 'true')
  await expect(parent).toHaveAttribute('aria-busy', 'true')
  await expect(parent).toHaveText('Top level')
  await page.getByRole('option', { name: 'Controls', exact: true }).dispatchEvent('click')
  expect(await count()).toBe(1)
  expect(await children()).toEqual([])
  expect(await items()).toHaveLength(1)
  await page.screenshot({ path: testInfo.outputPath('group-pending.png') })
  await settle(0, 'refuse')
  await expect(notice).toHaveText('Group edit refused for test')
  await expect(parent).toHaveAttribute('aria-busy', 'false')
  await expect(parent).toHaveAttribute('aria-expanded', 'true')
  await expect(page.getByRole('option', { name: 'Controls', exact: true })).toHaveClass(/active/)
  expect(await children()).toEqual([])
  expect(await items()).toHaveLength(1)
  await page.screenshot({ path: testInfo.outputPath('group-refused.png') })
  await page.setViewportSize({ width: 390, height: 844 })
  await parent.press('Escape')
  await page.getByRole('button', { name: /^Toggle right rail/ }).click()
  await parent.click()
  await parent.press('ArrowDown')
  await expect(notice).toBeInViewport()
  await page.screenshot({ path: testInfo.outputPath('group-refused-narrow.png') })
  await parent.press('Enter')
  await settle(1, 'accept')
  await expect(parent).toHaveText('Controls')
  await expect(parent).toHaveAttribute('aria-expanded', 'false')
  await expect(notice).toHaveCount(0)
  expect(await children()).toHaveLength(1)
  const placement = (await children())[0]
  expect(await items()).toEqual(expect.arrayContaining([expect.objectContaining({ id: placement, kind: 'control', ref: { graphId: 'g0', nodeId: 'widgets', inputId: 'title' } })]))
  await page.screenshot({ path: testInfo.outputPath('group-accepted.png') })
  await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.undo())
  await expect(parent).toHaveText('Top level')
  expect(await items()).toHaveLength(1)
  await parent.click()
  await page.getByRole('option', { name: 'Controls', exact: true }).click()
  await parent.press('Escape')
  await parent.click()
  await settle(2, 'refuse')
  await expect(notice).toHaveCount(0)
  await expect(parent).toHaveAttribute('aria-expanded', 'true')
  await page.getByRole('option', { name: 'Controls', exact: true }).click()
  await settle(3, 'accept')
  await expect(parent).toHaveText('Controls')
  await parent.click()
  await page.getByRole('option', { name: 'Top level', exact: true }).click()
  await expect(parent).toHaveText('Controls')
  await settle(4, 'refuse')
  await expect(notice).toHaveText('Group edit refused for test')
  await expect(parent).toHaveText('Controls')
  expect(await children()).toHaveLength(1)
  await page.screenshot({ path: testInfo.outputPath('group-move-refused.png') })
  await parent.press('Enter')
  await settle(5, 'accept')
  await expect(parent).toHaveText('Top level')
  expect(await children()).toEqual([])
  expect(await items()).toHaveLength(2)
  await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.undo())
  await expect(parent).toHaveText('Controls')
  await parent.click()
  await page.getByRole('option', { name: 'Top level', exact: true }).click()
  await settle(6, 'throw')
  await expect(notice).toHaveText('Group transport failed for test')
  await expect(parent).toHaveAttribute('aria-busy', 'false')
  await expect(parent).toHaveText('Controls')
})

test('layout gestures await acceptance before focus and stored placement changes', {
  annotation: { type: 'mock-rename-dispatch' },
}, async ({ page }, testInfo) => {
  await page.evaluate(() => {
    const app = window.__dinksterTest!.app
    for (const inputId of ['title', 'enabled']) app.dispatchTo(app.activeTab()!, {
      command: 'params.expose', params: { graphId: 'g0', nodeId: 'widgets', inputId },
    })
    for (const [id, inputId, x] of [['title-placement', 'title', 0], ['toggle-placement', 'enabled', 6]] as const) {
      app.dispatchTo(app.activeTab()!, { command: 'app.layout.add', params: {
        item: { id, kind: 'control', ref: { graphId: 'g0', nodeId: 'widgets', inputId }, x, y: 0, w: 6, h: 3 },
      } })
    }
  })
  await selectView(page, 'App view')
  await enterArrange(page)
  await page.evaluate(() => {
    const app = window.__dinksterTest!.app as any
    const dispatch = app.dispatchTo.bind(app)
    ;(window as any).__layoutPending = []
    app.dispatchTo = (tab: any, invocation: any) => new Promise((resolve, reject) => {
      ;(window as any).__layoutPending.push((result: string) => {
        if (result === 'throw') reject(new Error('Layout transport failed for test'))
        else resolve(result === 'accept' ? dispatch(tab, invocation) : {
          ok: false, diagnostics: [{ severity: 'error', origin: 'command', code: 'command.retention.refused', message: 'Layout edit refused for test' }],
        })
      })
    })
  })
  const count = () => page.evaluate(() => (window as any).__layoutPending.length)
  const settle = (index: number, result: string) => page.evaluate(({ index, result }) => (window as any).__layoutPending[index](result), { index, result })
  const grid = page.locator('[data-app-grid-id="title-placement"]')
  const notice = page.getByTestId('app-layout-gesture-error')
  const toggle = page.getByTestId('app-view-arrange-toggle')
  await page.screenshot({ path: testInfo.outputPath('layout-default.png') })
  await grid.focus()
  await grid.press('ArrowRight')
  await expect(grid).toHaveAttribute('aria-busy', 'true')
  await expect(grid).toHaveAttribute('data-grid-x', '0')
  await grid.press('ArrowRight')
  expect(await count()).toBe(1)
  await toggle.focus()
  await page.screenshot({ path: testInfo.outputPath('grid-pending.png') })
  await settle(0, 'refuse')
  await expect(notice).toHaveText('Layout edit refused for test')
  await expect(toggle).toBeFocused()
  await expect(grid).toHaveAttribute('data-grid-x', '0')
  await page.screenshot({ path: testInfo.outputPath('grid-refused.png') })
  await grid.press('ArrowRight')
  await toggle.focus()
  await settle(1, 'accept')
  await expect(grid).toHaveAttribute('data-grid-x', '1')
  await expect(grid).toBeFocused()
  await expect(notice).toHaveCount(0)
  await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.undo())
  await expect(grid).toHaveAttribute('data-grid-x', '0')

  const resize = grid.getByTestId('app-layout-grid-resize-bottom')
  const box = await resize.boundingBox()
  if (box === null) throw new Error('Grid resize geometry unavailable')
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 + 76)
  await page.mouse.up()
  await expect(grid).toHaveAttribute('aria-busy', 'true')
  await expect(grid).toHaveAttribute('data-grid-h', '3')
  await settle(2, 'accept')
  await expect(grid).toHaveAttribute('data-grid-h', '4')

  await page.getByTestId('app-layout-breakpoint-mobile').click()
  const mobile = page.locator('[data-mobile-id="title-placement"]')
  const order = () => page.getByTestId('app-layout-mobile-placement').evaluateAll((items) => items.map((item) => item.getAttribute('data-mobile-id')))
  await mobile.press('ArrowDown')
  await expect(mobile).toHaveAttribute('aria-busy', 'true')
  await expect(mobile.getByTestId('app-layout-mobile-down')).toBeDisabled()
  await mobile.press('ArrowDown')
  expect(await count()).toBe(4)
  expect(await order()).toEqual(['title-placement', 'toggle-placement'])
  await toggle.focus()
  await page.screenshot({ path: testInfo.outputPath('mobile-pending.png') })
  await settle(3, 'refuse')
  await expect(notice).toHaveText('Layout edit refused for test')
  await expect(toggle).toBeFocused()
  expect(await order()).toEqual(['title-placement', 'toggle-placement'])
  await page.setViewportSize({ width: 390, height: 844 })
  await page.getByRole('button', { name: /^Toggle right rail/ }).click()
  await expect(notice).toBeInViewport()
  await page.screenshot({ path: testInfo.outputPath('mobile-refused-narrow.png') })
  await mobile.getByTestId('app-layout-mobile-down').click()
  await settle(4, 'accept')
  await expect.poll(order).toEqual(['toggle-placement', 'title-placement'])
  await page.screenshot({ path: testInfo.outputPath('mobile-accepted.png') })
  await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.undo())
  await expect.poll(order).toEqual(['title-placement', 'toggle-placement'])
  await mobile.getByTestId('app-layout-mobile-down').click()
  await settle(5, 'throw')
  await expect(notice).toHaveText('Layout transport failed for test')
  await expect(mobile).toHaveAttribute('aria-busy', 'false')

  await mobile.press('ArrowDown')
  await page.getByTestId('app-layout-breakpoint-desktop').click()
  await page.getByTestId('app-layout-breakpoint-mobile').click()
  await mobile.press('ArrowDown')
  await settle(6, 'refuse')
  await expect(mobile).toHaveAttribute('aria-busy', 'true')
  await expect(notice).toHaveCount(0)
  await toggle.focus()
  await settle(7, 'accept')
  await expect.poll(order).toEqual(['toggle-placement', 'title-placement'])
  await expect(mobile).toBeFocused()
  await mobile.press('ArrowUp')
  await page.getByTestId('app-layout-breakpoint-desktop').click()
  await settle(8, 'accept')
  await expect(page.getByTestId('app-layout-breakpoint-desktop')).toBeFocused()
  await expect(notice).toHaveCount(0)
})

test('boolean and combo controls wait for final command acceptance', {
  annotation: { type: 'mock-rename-dispatch' },
}, async ({ page }, testInfo) => {
  await page.evaluate(() => {
    const app = window.__dinksterTest!.app
    for (const inputId of ['enabled', 'choice']) app.dispatchTo(app.activeTab()!, {
      command: 'params.expose', params: { graphId: 'g0', nodeId: 'widgets', inputId },
    })
  })
  await selectView(page, 'App view')
  await page.evaluate(() => {
    const app = window.__dinksterTest!.app as any
    const dispatch = app.dispatchTo.bind(app)
    ;(window as any).__choicePending = []
    app.dispatchTo = (tab: any, invocation: any) => new Promise((resolve) => {
      ;(window as any).__choicePending.push((accepted: boolean) => resolve(accepted ? dispatch(tab, invocation) : {
        ok: false, diagnostics: [{ severity: 'error', origin: 'command', code: 'command.retention.refused', message: 'Choice edit refused for test' }],
      }))
    })
  })
  const toggle = page.getByTestId('app-view-boolean')
  const combo = page.getByTestId('app-view-combo')
  const count = () => page.evaluate(() => (window as any).__choicePending.length)
  const settle = (index: number, accepted: boolean) => page.evaluate(({ index, accepted }) => (window as any).__choicePending[index](accepted), { index, accepted })
  await expect(toggle).toHaveAttribute('aria-checked', 'false')
  await expect(combo).toHaveText('alpha')
  await page.screenshot({ path: testInfo.outputPath('choice-default.png') })
  await toggle.click()
  await expect(toggle).toBeDisabled()
  await expect(toggle).toHaveAttribute('aria-checked', 'false')
  await toggle.dispatchEvent('click')
  expect(await count()).toBe(1)
  expect((await activeDoc(page)).graphs.g0!.nodes.widgets!.values.enabled).toBeUndefined()
  await page.screenshot({ path: testInfo.outputPath('boolean-pending.png') })
  await settle(0, false)
  await expect(toggle).toBeEnabled()
  await expect(toggle).toHaveAttribute('aria-checked', 'false')
  await expect(page.getByTestId('app-view-error')).toHaveText('Choice edit refused for test')
  await page.screenshot({ path: testInfo.outputPath('boolean-refused.png') })
  await toggle.click()
  await settle(1, true)
  await expect(toggle).toHaveAttribute('aria-checked', 'true')
  await expect(toggle).toBeEnabled()
  await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.undo())
  await expect(toggle).toHaveAttribute('aria-checked', 'false')
  await combo.click()
  await page.getByRole('option', { name: 'beta', exact: true }).click()
  await expect(combo).toHaveAttribute('aria-expanded', 'true')
  await expect(combo).toHaveAttribute('aria-busy', 'true')
  await expect(combo).toHaveText('alpha')
  await combo.press('Enter')
  await page.getByRole('option', { name: 'gamma', exact: true }).dispatchEvent('click')
  expect(await count()).toBe(3)
  await page.screenshot({ path: testInfo.outputPath('combo-pending.png') })
  await settle(2, false)
  await expect(combo).toHaveAttribute('aria-busy', 'false')
  await expect(combo).toHaveAttribute('aria-expanded', 'true')
  await expect(page.getByRole('option', { name: 'beta', exact: true })).toHaveClass(/active/)
  await expect(page.getByTestId('app-view-error')).toHaveText('Choice edit refused for test')
  await expect.poll(async () => {
    const notice = await page.getByTestId('app-view-error').boundingBox()
    const trigger = await combo.boundingBox()
    return notice !== null && trigger !== null && notice.y + notice.height <= trigger.y
  }).toBe(true)
  expect((await activeDoc(page)).graphs.g0!.nodes.widgets!.values.choice).toBeUndefined()
  await page.screenshot({ path: testInfo.outputPath('combo-refused.png') })
  await page.setViewportSize({ width: 390, height: 844 })
  await combo.press('Escape')
  await page.getByRole('button', { name: /^Toggle right rail/ }).click()
  await combo.click()
  await combo.press('ArrowDown')
  await expect(page.getByTestId('app-view-error')).toBeInViewport()
  await page.screenshot({ path: testInfo.outputPath('combo-refused-narrow.png') })
  await combo.press('Enter')
  await settle(3, true)
  await expect(combo).toHaveText('beta')
  await expect(combo).toHaveAttribute('aria-expanded', 'false')
  await expect(page.getByTestId('app-view-error')).toHaveCount(0)
  expect((await activeDoc(page)).graphs.g0!.nodes.widgets!.values.choice).toBe('beta')
  await page.screenshot({ path: testInfo.outputPath('choice-accepted.png') })
  await combo.click()
  await page.getByRole('option', { name: 'gamma', exact: true }).click()
  await combo.press('Escape')
  await combo.click()
  await page.getByRole('option', { name: 'alpha', exact: true }).click()
  await settle(4, false)
  await expect(combo).toHaveAttribute('aria-busy', 'true')
  await expect(page.getByTestId('app-view-error')).toHaveCount(0)
  await settle(5, true)
  await expect(combo).toHaveText('alpha')
  await expect(combo).toHaveAttribute('aria-expanded', 'false')
  await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.undo())
  await expect(combo).toHaveText('beta')
})

test('inline number drafts await typed and stepped command acceptance', {
  annotation: { type: 'mock-rename-dispatch' },
}, async ({ page }, testInfo) => {
  await page.evaluate(() => {
    const app = window.__dinksterTest!.app
    app.dispatchTo(app.activeTab()!, { command: 'params.expose', params: { graphId: 'g0', nodeId: 'widgets', inputId: 'count' } })
  })
  await selectView(page, 'App view')
  await page.evaluate(() => {
    const app = window.__dinksterTest!.app as any
    const dispatch = app.dispatchTo.bind(app)
    ;(window as any).__numberPending = []
    app.dispatchTo = (tab: any, invocation: any) => new Promise((resolve) => {
      ;(window as any).__numberPending.push((accepted: boolean) => resolve(accepted ? dispatch(tab, invocation) : {
        ok: false, diagnostics: [{ severity: 'error', origin: 'command', code: 'command.retention.refused', message: 'Numeric edit refused for test' }],
      }))
    })
  })
  const field = page.getByTestId('app-view-number')
  const increase = page.getByRole('button', { name: 'Increase value', exact: true })
  const count = () => page.evaluate(() => (window as any).__numberPending.length)
  const settle = (index: number, accepted: boolean) => page.evaluate(({ index, accepted }) => (window as any).__numberPending[index](accepted), { index, accepted })
  await expect(field).toHaveValue('5')
  await page.screenshot({ path: testInfo.outputPath('number-default.png') })
  await field.fill(' 17 ')
  await field.press('Enter')
  await expect(field).toHaveAttribute('readonly', '')
  await expect(increase).toBeDisabled()
  await field.press('Enter')
  await field.press('ArrowUp')
  expect(await count()).toBe(1)
  expect((await activeDoc(page)).graphs.g0!.nodes.widgets!.values.count).toBeUndefined()
  await page.screenshot({ path: testInfo.outputPath('number-pending.png') })
  await settle(0, false)
  await expect(field).not.toHaveAttribute('readonly')
  await expect(field).toHaveValue(' 17 ')
  await expect(page.getByTestId('app-view-error')).toHaveText('Numeric edit refused for test')
  await page.screenshot({ path: testInfo.outputPath('number-refused.png') })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.getByRole('button', { name: /^Toggle right rail/ }).click()
  await expect(field).toBeInViewport()
  await expect(page.getByTestId('app-view-error')).toBeInViewport()
  await expect(field).toHaveValue(' 17 ')
  expect(await count()).toBe(1)
  await page.screenshot({ path: testInfo.outputPath('number-refused-narrow.png') })
  await page.setViewportSize({ width: 1440, height: 900 })
  await field.press('Enter')
  await settle(1, true)
  await expect(field).not.toHaveAttribute('readonly')
  expect((await activeDoc(page)).graphs.g0!.nodes.widgets!.values.count).toBe(17)
  await expect(page.getByTestId('app-view-error')).toHaveCount(0)
  await page.screenshot({ path: testInfo.outputPath('number-accepted.png') })
  await field.fill('17')
  await field.press('Enter')
  expect(await count()).toBe(2)
  await increase.click()
  await expect(field).toHaveValue('20')
  await settle(2, false)
  await expect(page.getByTestId('app-view-error')).toBeVisible()
  expect((await activeDoc(page)).graphs.g0!.nodes.widgets!.values.count).toBe(17)
  await field.press('Enter')
  await settle(3, true)
  await expect(field).not.toHaveAttribute('readonly')
  expect((await activeDoc(page)).graphs.g0!.nodes.widgets!.values.count).toBe(20)
  await field.fill('invalid')
  await field.press('Enter')
  await expect(page.getByTestId('app-view-error')).toBeVisible()
  expect(await count()).toBe(4)
  await field.press('Escape')
  await expect(field).toHaveValue('20')
  await expect(page.getByTestId('app-view-error')).toHaveCount(0)
  await field.fill('25')
  await field.press('Enter')
  await field.press('Escape')
  await field.fill('35')
  await settle(4, false)
  await expect(field).toHaveValue('35')
  await expect(page.getByTestId('app-view-error')).toHaveCount(0)
  await field.press('Escape')
  await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.undo())
  expect((await activeDoc(page)).graphs.g0!.nodes.widgets!.values.count).toBe(17)
})

test('inline text and list drafts retain refused edits until accepted', {
  annotation: { type: 'mock-rename-dispatch' },
}, async ({ page }, testInfo) => {
  await page.evaluate(() => {
    const app = window.__dinksterTest!.app as any
    const tab = app.activeTab()!
    const schema = app.registryForTab(tab).resolve('AppViewTest')
    app.registerSchemas([{ ...schema, items: [...schema.items, {
      kind: 'input', id: 'texts', optional: false,
      type: { kind: 'list', element: { kind: 'concrete', name: 'STRING' } },
      widget: { widgetType: 'LIST', options: {}, element: { widgetType: 'STRING', options: {} }, default: ['red', 'blue'] },
    }, {
      kind: 'input', id: 'notes', optional: false, type: { kind: 'concrete', name: 'STRING' },
      widget: { widgetType: 'STRING', options: { multiline: true }, default: 'Original notes' },
    }] }])
    for (const inputId of ['title', 'texts', 'notes']) {
      app.dispatchTo(tab, { command: 'params.expose', params: { graphId: 'g0', nodeId: 'widgets', inputId } })
    }
  })
  await selectView(page, 'App view')
  await page.evaluate(() => {
    const app = window.__dinksterTest!.app as any
    const dispatch = app.dispatchTo.bind(app)
    ;(window as any).__inlinePending = []
    app.dispatchTo = (tab: any, invocation: any) => new Promise((resolve, reject) => {
      ;(window as any).__inlinePending.push((result: string) => {
        if (result === 'error') reject(new Error('Inline transport refused for test'))
        else resolve(result === 'accept' ? dispatch(tab, invocation) : {
          ok: false, diagnostics: [{ severity: 'error', origin: 'command', code: 'command.retention.refused', message: 'Inline edit refused for test' }],
        })
      })
    })
  })
  const title = page.getByTestId('app-view-text').nth(0)
  const list = page.getByTestId('app-view-text').nth(1)
  const notes = page.getByTestId('app-view-text').nth(2)
  const drafts = ['  Exact title draft  ', '[ "red", "a,b", "line\\nnext" ]', 'Line one\n  Exact multiline draft']
  const count = () => page.evaluate(() => (window as any).__inlinePending.length)
  const settle = (index: number, result: string) => page.evaluate(({ index, result }) => (window as any).__inlinePending[index](result), { index, result })
  await expect(page.getByTestId('app-view')).toHaveAttribute('data-app-breakpoint', 'desktop')
  await page.screenshot({ path: testInfo.outputPath('inline-default.png') })
  const fields = [title, list, notes]
  for (let i = 0; i < fields.length; i++) {
    await fields[i]!.fill(drafts[i]!)
    await fields[i]!.press(i === 0 ? 'Enter' : 'Control+Enter')
    await expect(fields[i]!).toHaveAttribute('readonly', '')
    await fields[i]!.press(i === 0 ? 'Enter' : 'Control+Enter')
    expect(await count()).toBe(i + 1)
  }
  expect((await activeDoc(page)).graphs.g0!.nodes.widgets!.values).toEqual({})
  await page.screenshot({ path: testInfo.outputPath('inline-pending.png') })
  await settle(0, 'refuse')
  await settle(1, 'refuse')
  await settle(2, 'error')
  for (let i = 0; i < fields.length; i++) {
    await expect(fields[i]!).not.toHaveAttribute('readonly')
    await expect(fields[i]!).toHaveValue(drafts[i]!)
  }
  await expect(page.getByTestId('app-view-error')).toHaveCount(3)
  await page.screenshot({ path: testInfo.outputPath('inline-refused.png') })
  await expect(notes).toBeFocused()
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(notes).toHaveValue(drafts[2]!)
  await expect(page.getByTestId('app-view')).toHaveAttribute('data-app-breakpoint', 'desktop')
  await page.getByRole('button', { name: /^Toggle right rail/ }).click()
  await expect(title).toBeInViewport()
  await expect(notes).toBeInViewport()
  await page.screenshot({ path: testInfo.outputPath('inline-refused-narrow.png') })
  await page.getByTestId('app-view-error').last().scrollIntoViewIfNeeded()
  await expect(page.getByTestId('app-view-error').last()).toBeInViewport()
  await page.screenshot({ path: testInfo.outputPath('inline-refused-narrow-notes.png') })
  await page.setViewportSize({ width: 1440, height: 900 })
  expect(await count()).toBe(3)
  for (let step = 0; step < fields.length; step++) {
    const i = fields.length - 1 - step
    await expect(fields[i]!).toHaveValue(drafts[i]!)
    await fields[i]!.press(i === 0 ? 'Enter' : 'Control+Enter')
    expect(await count()).toBe(step + 4)
    await settle(step + 3, 'accept')
    await expect(fields[i]!).not.toHaveAttribute('readonly')
  }
  await expect(page.getByTestId('app-view-error')).toHaveCount(0)
  expect((await activeDoc(page)).graphs.g0!.nodes.widgets!.values).toEqual({
    title: drafts[0], texts: ['red', 'a,b', 'line\nnext'], notes: drafts[2],
  })
  await page.screenshot({ path: testInfo.outputPath('inline-accepted.png') })
  await title.press('Enter')
  expect(await count()).toBe(6)
  await list.fill('[false]')
  await list.press('Control+Enter')
  await expect(page.getByTestId('app-view-error')).toHaveCount(1)
  expect(await count()).toBe(6)
  await list.press('Escape')
  await expect(list).toHaveValue('["red","a,b","line\\nnext"]')
  await expect(page.getByTestId('app-view-error')).toHaveCount(0)
  await title.fill('Old pending title')
  await title.press('Enter')
  await title.press('Escape')
  await title.fill('New exact draft')
  await settle(6, 'refuse')
  await expect(title).toHaveValue('New exact draft')
  await expect(page.getByTestId('app-view-error')).toHaveCount(0)
  await title.press('Enter')
  await settle(7, 'accept')
  await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.undo())
  expect((await activeDoc(page)).graphs.g0!.nodes.widgets!.values.title).toBe(drafts[0])
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
  await page.screenshot({ path: testInfo.outputPath('text-style-default.png') })
  await page.getByRole('option', { name: 'Heading', exact: true }).click()
  await expect(style).toContainText('Body')
  await expect(style).toHaveAttribute('aria-expanded', 'true')
  await expect(style).toHaveAttribute('aria-busy', 'true')
  await expect(bold).toBeDisabled()
  await style.press('Enter')
  expect(await page.evaluate(() => (window as any).__draftPending.length)).toBe(11)
  await page.screenshot({ path: testInfo.outputPath('text-style-pending.png') })
  await settle([10], false)
  await expect(style).toContainText('Body')
  await expect(style).toHaveAttribute('aria-expanded', 'true')
  await expect(style).toHaveAttribute('aria-invalid', 'true')
  await expect(page.getByRole('alert')).toHaveText('Authored edit refused for test')
  expect((await items()).find((item: any) => item.id === 'draft-text').role).toBe('body')
  await page.screenshot({ path: testInfo.outputPath('text-style-refused.png') })
  await page.setViewportSize({ width: 390, height: 1000 })
  await style.press('Escape')
  await page.getByRole('button', { name: /^Toggle right rail/ }).click()
  await style.click()
  await style.scrollIntoViewIfNeeded()
  await expect(page.getByRole('alert')).toBeInViewport()
  await page.screenshot({ path: testInfo.outputPath('text-style-refused-narrow.png') })
  await page.setViewportSize({ width: 1440, height: 1200 })
  await page.getByRole('option', { name: 'Heading', exact: true }).click()
  await settle([11], true)
  await expect(style).toContainText('Heading')
  await expect(style).toHaveAttribute('aria-expanded', 'false')
  await expect(style).toBeFocused()
  await expect(page.getByRole('alert')).toHaveCount(0)
  expect((await items()).find((item: any) => item.id === 'draft-text').role).toBe('heading')
  await page.screenshot({ path: testInfo.outputPath('text-style-accepted.png') })
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
  await page.getByTestId('app-view-arrange-toggle').click()
  await page.getByTestId('app-view-arrange-toggle').click()
  const dismissedIndex = await page.evaluate(() => (window as any).__draftPending.length)
  await style.click()
  await page.getByRole('option', { name: 'Caption', exact: true }).click()
  await expect(style).toHaveAttribute('aria-busy', 'true')
  await style.press('Escape')
  await expect(style).toHaveAttribute('aria-expanded', 'false')
  await style.click()
  await page.getByRole('option', { name: 'Caption', exact: true }).click()
  expect(await page.evaluate(() => (window as any).__draftPending.length)).toBe(dismissedIndex + 1)
  await settle([dismissedIndex], false)
  await expect(style).toHaveAttribute('aria-expanded', 'true')
  await expect(style).toHaveAttribute('aria-busy', 'false')
  await expect(page.getByRole('alert')).toHaveCount(0)
  await expect(style).toContainText('Heading')
  await page.screenshot({ path: testInfo.outputPath('text-style-dismissed.png') })
  await style.press('Escape')
  const staleIndex = await page.evaluate(() => (window as any).__draftPending.length)
  await style.click()
  await page.getByRole('option', { name: 'Caption', exact: true }).click()
  await page.getByTestId('app-view-arrange-toggle').click()
  await page.getByTestId('app-view-arrange-toggle').click()
  await bold.click()
  await expect(style).toBeDisabled()
  await settle([staleIndex], false)
  await expect(style).toBeDisabled()
  await expect(page.getByRole('alert')).toHaveCount(0)
  await settle([staleIndex + 1], true)
  await expect(style).toBeEnabled()
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

test('inline color drafts wait for final command acceptance', {
  annotation: { type: 'mock-rename-dispatch' },
}, async ({ page }, testInfo) => {
  await exposeViaMenu(page, 'color')
  await selectView(page, 'App view')
  await page.evaluate(() => {
    const app = window.__dinksterTest!.app as any
    const dispatch = app.dispatchTo.bind(app)
    ;(window as any).__colorPending = []
    app.dispatchTo = (tab: any, invocation: any) => new Promise((resolve) => {
      ;(window as any).__colorPending.push((accepted: boolean) => resolve(accepted ? dispatch(tab, invocation) : {
        ok: false, diagnostics: [{ severity: 'error', origin: 'command', code: 'command.retention.refused', message: 'Color edit refused for test' }],
      }))
    })
  })
  const settle = (index: number, accepted: boolean) => page.evaluate(({ index, accepted }) => (window as any).__colorPending[index](accepted), { index, accepted })
  const color = () => page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.doc.graphs.g0!.nodes.widgets!.values.color)
  await page.getByTestId('app-view-color').click()
  const popup = page.getByRole('dialog', { name: 'Choose color' })
  const hex = page.getByRole('textbox', { name: 'Hex color' })
  const apply = page.getByRole('button', { name: 'Apply color' })
  await page.screenshot({ path: testInfo.outputPath('color-default.png') })
  await hex.fill('#336699')
  await apply.click()
  await expect(popup).toHaveAttribute('aria-busy', 'true')
  await expect(hex).toHaveAttribute('readonly', '')
  await expect(apply).toBeDisabled()
  await hex.press('Enter')
  expect(await page.evaluate(() => (window as any).__colorPending.length)).toBe(1)
  expect(await color()).toBeUndefined()
  await page.screenshot({ path: testInfo.outputPath('color-pending.png') })
  await settle(0, false)
  await expect(popup.getByRole('alert')).toBeVisible()
  await expect(hex).toHaveValue('#336699')
  await expect(apply).toBeEnabled()
  await page.screenshot({ path: testInfo.outputPath('color-refused.png') })
  await page.setViewportSize({ width: 390, height: 844 })
  await expect.poll(async () => {
    const bounds = await popup.boundingBox()
    return bounds !== null && bounds.x >= 0 && bounds.x + bounds.width <= 390 && bounds.y + bounds.height <= 844
  }).toBe(true)
  await page.screenshot({ path: testInfo.outputPath('color-refused-narrow.png') })
  await page.setViewportSize({ width: 1440, height: 900 })
  await apply.click()
  await settle(1, true)
  await expect(popup).toHaveCount(0)
  expect(await color()).toBe('#336699')
  await page.screenshot({ path: testInfo.outputPath('color-accepted.png') })
  await page.keyboard.press('Control+z')
  expect(await color()).toBeUndefined()
  await page.getByTestId('app-view-color').click()
  await popup.getByRole('button', { name: 'Select #e74c3c', exact: true }).click()
  await expect(hex).toHaveValue('#e74c3c')
  await expect(popup).toHaveAttribute('aria-busy', 'true')
  await hex.press('Escape')
  await page.getByTestId('app-view-color').click()
  await hex.fill('#123456')
  await settle(2, false)
  await expect(hex).toHaveValue('#123456')
  await expect(popup.getByRole('alert')).toHaveCount(0)
  await expect(page.getByTestId('app-view-error')).toHaveCount(0)
  await apply.click()
  await settle(3, true)
  await expect(popup).toHaveCount(0)
  expect(await color()).toBe('#123456')
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
