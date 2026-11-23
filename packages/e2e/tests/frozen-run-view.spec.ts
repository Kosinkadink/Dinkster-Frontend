import { executionDetails, expect, nativeTest as test, selectProductOption, type Page } from './fixtures.js'

const pointOn = (page: Page, nodeId: string, part: 'header' | 'section' | 'widget' | 'input' | 'output') =>
  page.evaluate(({ nodeId, part }) => {
    const renderer = window.__dinksterTest!.renderer!, viewport = renderer.getViewport()
    const node = renderer.getScene().nodes.find((item) => item.id === nodeId)!
    const rect = document.querySelector('[data-testid="graph-canvas"]')!.getBoundingClientRect()
    let x = node.x + node.layout.width / 2, y = node.y + node.layout.headerHeight / 2
    if (part === 'section' || part === 'widget') {
      const row = node.layout.rows.find((item) => item.kind === part)!
      y = node.y + row.y + row.height / 2
    } else if (part === 'input' || part === 'output') {
      const pin = node.layout.pins.find((item) => !item.widgetTap && item.direction === (part === 'input' ? 'in' : 'out'))!
      x = node.x + (part === 'input' ? 0 : node.layout.width); y = node.y + pin.y
    }
    return { x: rect.left + x * viewport.scale + viewport.x, y: rect.top + y * viewport.scale + viewport.y }
  }, { nodeId, part })

const arrangement = (page: Page) => page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.doc.view.graphs.g0!.nodes.n0!)
const graph = (page: Page) => page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.doc.graphs.g0)
const identityViewport = (page: Page) => page.evaluate(() => window.__dinksterTest!.renderer!.setViewport({ x: 0, y: 0, scale: 1 }))
const frozenTab = (page: Page) => page.getByTestId('tab-bar').locator('.tab.frozen')
const openRun = async (page: Page) => {
  await page.getByTestId('execution-row').first().locator('.execution-open').click()
  await expect(page.getByTestId('frozen-banner')).toBeVisible()
  await identityViewport(page)
}

test.beforeEach(async ({ page }) => {
  await page.route(/\/api\//, (route) => route.fulfill({ status: 503, json: {} }))
  await page.route('**/api/nodes*', (route) => route.fulfill({ json: {
    schemaVersion: 1, epoch: 1, dinkster: { version: 'frozen-view', schemaWire: 1 }, nodes: {},
  } }))
  await page.route('**/api/history?*', (route) => route.fulfill({ json: { records: [
    { runId: 'frozen-retained-run', jobRef: 'frozen-retained-run', scope: 'local', clientId: 'frozen-client',
      jobId: 'frozen-portrait-run', state: 'completed', priority: 0, submittedAt: 1, finishedAt: 2, executed: 2, cached: 0, skipped: 0 },
    { runId: 'remote-retained-run', jobRef: 'remote-retained-run', scope: 'local', clientId: 'another-client',
      jobId: 'remote-portrait-run', state: 'completed', priority: 0, submittedAt: 3, finishedAt: 4, executed: 1, cached: 0, skipped: 0 },
  ] } }))
  await page.routeWebSocket('**/api/events?*', () => {})
  await page.goto('/')
  await expect.poll(() => page.evaluate(() => window.__dinksterTest?.app.backends.get()[0]?.registry.get() !== undefined)).toBe(true)
  await page.evaluate(async () => {
    const app = window.__dinksterTest!.app
    app.registerSchemas([
      { type: 'ImageSettings', displayName: 'Image settings', category: 'test', source: 'v3', isOutputNode: false, items: [
        { kind: 'section', id: 'settings', displayName: 'Settings' },
        { kind: 'input', id: 'width', type: { kind: 'concrete', name: 'INT' }, optional: false, section: 'settings',
          widget: { widgetType: 'INT', options: { min: 1, max: 4096 }, default: 512 } },
        { kind: 'output', id: 'image', type: { kind: 'concrete', name: 'IMAGE' } },
      ] },
      { type: 'ImageOutput', displayName: 'Image output', category: 'test', source: 'v3', isOutputNode: true, items: [
        { kind: 'input', id: 'image', type: { kind: 'concrete', name: 'IMAGE' }, optional: false },
      ] },
    ])
    await app.openDocument({ format: 'dinkster-workflow', formatVersion: 1, lineage: 'frozen-portrait', root: 'g0',
      graphs: { g0: { id: 'g0', name: 'Root', nodes: {
        n0: { id: 'n0', type: 'ImageSettings', values: { width: 512 } },
        n1: { id: 'n1', type: 'ImageOutput', values: {} },
        n2: { id: 'n2', type: 'ImageSettings', title: 'Unused image settings', values: { width: 1024 } },
      }, links: { l0: { id: 'l0', from: { node: 'n0', port: 'image' }, to: { node: 'n1', port: 'image' } } },
      nets: {}, reroutes: {}, nextOrdinal: 3 } },
      view: { graphs: { g0: { nodes: {
        n0: { position: { x: 100, y: 150 } }, n1: { position: { x: 450, y: 190 } }, n2: { position: { x: 100, y: 390 } },
      } } } },
    }, 'Portrait')
    const tab = app.activeTab()!, result = app.compileTab(tab)
    if (!result?.ok) throw new Error(`Compile failed: ${JSON.stringify(result)}`)
    app.registerRun(tab, { connection: result.artifact.connection, prompt: 'frozen-portrait-run' }, result.artifact)
  })
  await expect(page.getByTestId('execution-row')).toHaveCount(1)
})

test('frozen layout is temporary, edits are refused, and copies keep the arrangement', async ({ page }, info) => {
  await page.evaluate(() => {
    const app = window.__dinksterTest!.app, run = [...app.store.executions.get().values()][0]!
    app.store.apply({ kind: 'completed', execution: run.ref, timestamp: Date.now() })
  })
  await openRun(page)
  await expect(frozenTab(page).locator('svg.lucide-snowflake')).toBeVisible()
  await expect(page.getByTestId('queue-button')).toBeDisabled()
  const originalGraph = await graph(page)
  await expect.poll(() => page.evaluate(() => [...window.__dinksterTest!.renderer!.getInactiveNodes() ?? []])).toEqual(['n2'])
  await page.screenshot({ path: info.outputPath('frozen-idle.png') })

  const header = await pointOn(page, 'n0', 'header')
  await page.mouse.move(header.x, header.y)
  await page.mouse.down()
  await page.mouse.move(header.x + 70, header.y + 40, { steps: 5 })
  await page.mouse.up()
  await expect.poll(() => arrangement(page)).toMatchObject({ position: { x: 170, y: 190 } })
  const section = await pointOn(page, 'n0', 'section')
  await page.mouse.click(section.x, section.y)
  await expect.poll(() => arrangement(page)).toMatchObject({ sections: { settings: { collapsed: true } } })
  await page.mouse.click(section.x, section.y)
  await expect.poll(() => arrangement(page)).toMatchObject({ sections: { settings: { collapsed: false } } })
  expect(await graph(page)).toEqual(originalGraph)

  const widget = await pointOn(page, 'n0', 'widget')
  await page.mouse.move(widget.x, widget.y)
  expect(await page.evaluate(() => window.__dinksterTest!.renderer!.getOverlay().hoveredWidget)).toBeUndefined()
  await page.clock.install()
  await page.clock.pauseAt(new Date(Date.now() + 100))
  await page.mouse.click(widget.x, widget.y)
  const toast = page.getByTestId('gesture-refusal-toast')
  await expect(toast).toHaveText('Frozen. Open as copy to edit.')
  await expect(page.getByTestId('widget-editor')).not.toBeVisible()
  await page.screenshot({ path: info.outputPath('frozen-toast.png') })
  await toast.getByRole('button', { name: 'Dismiss refusal message' }).click()
  await expect(toast).toBeHidden()
  await page.clock.resume()

  const output = await pointOn(page, 'n2', 'output'), input = await pointOn(page, 'n1', 'input')
  await page.mouse.move(output.x, output.y)
  expect(await page.evaluate(() => window.__dinksterTest!.renderer!.getOverlay().hoveredPin)).toBeUndefined()
  await page.mouse.down()
  await page.mouse.move(input.x, input.y, { steps: 5 })
  await page.mouse.up()
  await expect(toast).toHaveText('Frozen. Open as copy to edit.')
  expect(await graph(page)).toEqual(originalGraph)
  await page.keyboard.press('Delete')
  expect(await graph(page)).toEqual(originalGraph)

  const arranged = await arrangement(page)
  const copyHeader = await pointOn(page, 'n0', 'header')
  await page.mouse.click(copyHeader.x, copyHeader.y)
  const viewport = await page.evaluate(() => window.__dinksterTest!.renderer!.getViewport())
  const tabCount = await page.getByTestId('tab-bar').getByRole('tab').count()
  await page.getByTestId('frozen-open-copy').click()
  await expect(page.getByTestId('frozen-banner')).not.toBeVisible()
  await expect(page.getByRole('tab', { name: /^Portrait copy,/ })).toBeVisible()
  expect(await arrangement(page)).toEqual(arranged)
  await expect(frozenTab(page)).toHaveCount(0)
  await expect(page.getByTestId('tab-bar').getByRole('tab')).toHaveCount(tabCount)
  expect(await page.evaluate(() => window.__dinksterTest!.renderer!.getViewport())).toEqual(viewport)
  expect(await page.evaluate(() => [...window.__dinksterTest!.controller!.getSelection()])).toEqual(['n0'])
  await expect.poll(() => page.evaluate(() => [...window.__dinksterTest!.renderer!.getInactiveNodes() ?? []])).toEqual([])
  await identityViewport(page)
  const copiedWidget = await pointOn(page, 'n0', 'widget')
  await page.mouse.click(copiedWidget.x, copiedWidget.y)
  const editor = page.getByTestId('widget-editor').locator('input').first()
  await expect(editor).toBeVisible()
  await editor.fill('768')
  await editor.press('Enter')
  expect((await graph(page))!.nodes.n0!.values.width).toBe(768)
  await page.screenshot({ path: info.outputPath('frozen-open-as-copy.png') })

  await page.getByTestId('tab-bar').getByRole('tab', { name: /^Portrait,/ }).click()
  await openRun(page)
  await expect.poll(() => arrangement(page)).toEqual({ position: { x: 100, y: 150 } })
  await page.evaluate(() => {
    window.__dinksterTest!.renderer!.setViewport({ x: 83, y: 41, scale: 0.8 })
    window.__dinksterTest!.controller!.setSelection(['n2'])
  })
  await page.getByTestId('tab-bar').getByRole('tab', { name: /^Portrait copy,/ }).click()
  await expect.poll(() => page.evaluate(() => window.__dinksterTest!.renderer!.getViewport())).toEqual({ x: 0, y: 0, scale: 1 })
  expect(await page.evaluate(() => [...window.__dinksterTest!.controller!.getSelection()])).not.toContain('n2')
  await page.getByTestId('tab-bar').getByRole('tab', { name: /^Portrait,/ }).click()
  await openRun(page)
  await page.getByTestId('frozen-open-copy').click()
  await expect(page.getByRole('tab', { name: /^Portrait copy 2,/ })).toBeVisible()
  await page.getByTestId('tab-bar').getByRole('tab', { name: /^Portrait,/ }).click()
  await openRun(page)
  await expect.poll(() => arrangement(page)).toEqual({ position: { x: 100, y: 150 } })
  expect(await graph(page)).toEqual(originalGraph)
  await expect(frozenTab(page).locator('.tab-dirty')).toHaveCount(0)
})

test('run rows expose one snowflake and retained runs keep their snapshot availability', async ({ page }, info) => {
  const row = page.getByTestId('execution-row').first()
  await expect(row.locator('.runs-row-heading .execution-open')).toBeEnabled()
  const details = await executionDetails(row)
  await expect(details.locator('.execution-open')).toHaveCount(0)
  await expect(row.locator('.execution-open')).toHaveCount(1)
  await page.evaluate(() => {
    const app = window.__dinksterTest!.app, tab = app.activeTab()!, result = app.compileTab(tab)
    if (!result?.ok) throw new Error('Compile failed')
    const ref = [...app.store.executions.get().values()][0]!.ref
    app.store.register(ref, result.artifact, 0, { jobRef: 'frozen-retained-run' })
    app.store.apply({ kind: 'completed', execution: ref, timestamp: 2 })
  })
  await selectProductOption(page, page.getByTestId('runs-scope'), 'all')
  const stored = page.locator('.runs-stored-row').filter({ hasText: 'frozen-portrait-run' })
  const remote = page.locator('.runs-stored-row').filter({ hasText: 'remote-portrait-run' })
  await expect(stored.locator('.execution-open')).toHaveCount(1)
  await expect(remote).toBeVisible()
  await expect(remote.locator('.execution-open')).toHaveCount(0)
  await page.screenshot({ path: info.outputPath('frozen-stored-row.png') })
  await stored.locator('.execution-open').click()
  await expect(page.getByTestId('frozen-banner')).toBeVisible()
  await expect(frozenTab(page)).toHaveCount(1)
})

test('queued and running jobs open frozen and follow only their submitted snapshot', async ({ page }, info) => {
  await openRun(page)
  await expect(page.getByTestId('frozen-banner')).toContainText('Queued.')
  await expect.poll(() => page.evaluate(() => [...window.__dinksterTest!.renderer!.getInactiveNodes() ?? []])).toEqual(['n2'])
  await page.screenshot({ path: info.outputPath('frozen-queued.png') })
  await page.getByTestId('frozen-go-live').click()
  await identityViewport(page)
  const widget = await pointOn(page, 'n0', 'widget')
  await page.mouse.click(widget.x, widget.y)
  const editor = page.getByTestId('widget-editor').locator('input').first()
  await editor.fill('256')
  await editor.press('Enter')
  await page.evaluate(() => {
    const app = window.__dinksterTest!.app, run = [...app.store.executions.get().values()][0]!
    app.store.apply({ kind: 'started', execution: run.ref, timestamp: Date.now() })
    app.store.apply({ kind: 'nodeStates', execution: run.ref, timestamp: Date.now(),
      nodes: { n0: { state: 'running', value: 0.42 } },
    })
  })
  await openRun(page)
  await expect(page.getByTestId('frozen-banner')).toContainText('Running 21%. Live changed.')
  expect((await graph(page))!.nodes.n0!.values.width).toBe(512)
  // The next scheduled node is not dimmed just because it has not started.
  await expect.poll(() => page.evaluate(() => [...window.__dinksterTest!.renderer!.getInactiveNodes() ?? []])).toEqual(['n2'])
  await page.screenshot({ path: info.outputPath('frozen-running.png') })
})
