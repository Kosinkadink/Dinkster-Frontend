import { expect, openRailPanel, test, type Page } from './fixtures.js'

async function ready(page: Page, mockLegacyDiscovery = false): Promise<void> {
  if (mockLegacyDiscovery) {
    await page.route('/system_stats', (route) =>
      route.fulfill({ json: { system: { os: 'e2e' }, devices: [] } }),
    )
    await page.route('/object_info', (route) => route.fulfill({ json: {} }))
  }
  await page.goto('/')
  await expect(page.getByTestId('status-bar')).toContainText(/\d+ node schemas/, { timeout: 15_000 })
}

async function nodePoint(page: Page, index = 0): Promise<{ id: string; x: number; y: number }> {
  const point = await page.evaluate((index) => {
    const renderer = window.__dinksterTest!.renderer!
    const node = renderer.getScene().nodes[index]!
    const viewport = renderer.getViewport()
    const canvas = document.querySelector('[data-testid=graph-canvas]')!.getBoundingClientRect()
    const x = canvas.left + (node.x + node.layout.width / 2) * viewport.scale + viewport.x
    const y = canvas.top + (node.y + node.layout.headerHeight / 2) * viewport.scale + viewport.y
    // Fail loudly when an overlay (minimap, dock, toolbox) covers the click
    // point: a swallowed click silently leaves the selection empty and every
    // downstream assertion times out with no explanation.
    const covering = document.elementFromPoint(x, y)
    if (covering?.getAttribute('data-testid') !== 'graph-canvas') {
      throw new Error(`node ${node.id} header center (${x}, ${y}) is covered by ${covering?.tagName}[data-testid=${covering?.getAttribute('data-testid')}] instead of the graph canvas`)
    }
    return { id: node.id, x, y }
  }, index)
  return point
}

async function selectNode(page: Page, index = 0, modifiers: readonly ('Control' | 'Shift')[] = []): Promise<string> {
  const point = await nodePoint(page, index)
  for (const modifier of modifiers) await page.keyboard.down(modifier)
  await page.mouse.click(point.x, point.y)
  for (const modifier of [...modifiers].reverse()) await page.keyboard.up(modifier)
  return point.id
}

async function extractSelected(page: Page): Promise<void> {
  const before = await page.evaluate(() => Object.keys(window.__dinksterTest!.app.activeTab()!.store.doc.graphs).length)
  await page.keyboard.press('Control+Shift+E')
  await expect(page.getByTestId('subgraph-extract-prompt')).toHaveCount(0)
  await expect.poll(() => page.evaluate(() => Object.keys(window.__dinksterTest!.app.activeTab()!.store.doc.graphs).length)).toBe(before + 1)
}

const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined

function stripDynamicStateCursors(value: unknown): void {
  const state = record(value)
  if (!state) return
  delete state['seq']
  const memberState = record(state['memberState'])
  for (const scopeValue of Object.values(memberState ?? {})) {
    const scope = record(scopeValue)
    for (const nestedState of Object.values(scope ?? {})) stripDynamicStateCursors(nestedState)
  }
}

/** Remove only declared allocator cursor positions; all semantic and view data stays exact. */
function withoutAllocatorCursors(document: unknown): unknown {
  const normalized = structuredClone(document)
  const normalizedRecord = record(normalized)!
  const graphs = record(normalizedRecord['graphs'])!
  for (const graphValue of Object.values(graphs)) {
    const graph = record(graphValue)!
    delete graph['nextOrdinal']
    delete graph['actorCursors']
    const nodes = record(graph['nodes'])
    for (const nodeValue of Object.values(nodes ?? {})) {
      const dynamic = record(record(nodeValue)?.['dynamic'])
      for (const state of Object.values(dynamic ?? {})) stripDynamicStateCursors(state)
    }
  }
  delete normalizedRecord['surfaceSeq']
  const viewGraphs = record(record(normalizedRecord['view'])?.['graphs'])
  for (const graphView of Object.values(viewGraphs ?? {})) delete record(graphView)?.['groupSeq']
  return normalized
}

function expectRetainedGraphOrdinals(undone: unknown, highWater: unknown): void {
  const undoneGraphs = record(record(undone)?.['graphs'])!
  const highWaterGraphs = record(record(highWater)?.['graphs'])!
  for (const [graphId, graphValue] of Object.entries(undoneGraphs)) {
    const ordinal = record(graphValue)?.['nextOrdinal']
    const retained = record(highWaterGraphs[graphId])?.['nextOrdinal']
    expect(ordinal, `${graphId} nextOrdinal must retain its post-command high-water mark`)
      .toBe(retained)
  }
}

test('creates an empty subgraph from universal search and drills into it', async ({ page }) => {
  await ready(page, true)
  const rootControlsY = (await page.getByTestId('views-switcher').boundingBox())!.y
  await page.getByTestId('topbar-search').click()
  await page.getByTestId('universal-search-input').fill('> Create empty subgraph')
  await page.locator('[data-provider="core.commands"] [data-testid="search-result-row"]', { hasText: 'Create empty subgraph' }).click()
  await expect(page.getByTestId('graph-breadcrumb')).toBeVisible()
  const drilledControls = (await page.getByTestId('views-switcher').boundingBox())!
  const breadcrumb = (await page.getByTestId('graph-breadcrumb').boundingBox())!
  expect(drilledControls.y).toBe(rootControlsY)
  expect(breadcrumb.y).toBeGreaterThan(drilledControls.y)
  expect(await page.evaluate(() => Object.keys(window.__dinksterTest!.app.activeTab()!.store.doc.graphs).length)).toBeGreaterThan(1)
})

test('previews and removes root-unreachable subgraph definitions', async ({ page }, testInfo) => {
  await ready(page, true)
  await page.evaluate(() => {
    window.__dinksterTest!.app.openDocument({
      format: 'dinkster-workflow', formatVersion: 1, lineage: 'subgraph-cleanup-e2e', root: 'root',
      graphs: {
        root: {
          id: 'root', name: 'Root',
          nodes: {
            used: { id: 'used', type: '#used', values: {} },
            usedSecond: { id: 'usedSecond', type: '#usedSecond', values: {} },
            usedThird: { id: 'usedThird', type: '#usedThird', values: {} },
          },
          links: {}, nets: {}, reroutes: {}, nextOrdinal: 4,
        },
        used: { id: 'used', name: 'Shared controls', nodes: {}, links: {}, nets: {}, reroutes: {}, nextOrdinal: 1 },
        usedSecond: { id: 'usedSecond', name: 'Shared detail', nodes: {}, links: {}, nets: {}, reroutes: {}, nextOrdinal: 1 },
        usedThird: { id: 'usedThird', name: 'Shared finish', nodes: {}, links: {}, nets: {}, reroutes: {}, nextOrdinal: 1 },
        orphanParent: {
          id: 'orphanParent', name: 'Old experiment',
          nodes: { nested: { id: 'nested', type: '#orphanChild', values: {} } },
          links: {}, nets: {}, reroutes: {}, nextOrdinal: 2,
        },
        orphanChild: {
          id: 'orphanChild', name: 'Old detail',
          nodes: {}, links: {}, nets: {}, reroutes: {}, nextOrdinal: 1,
        },
        orphanWithAnIntentionallyLongDefinitionIdentifierThatMustWrapWithoutClipping: {
          id: 'orphanWithAnIntentionallyLongDefinitionIdentifierThatMustWrapWithoutClipping',
          name: 'Archived experiment with an intentionally long name that must remain readable',
          nodes: {}, links: {}, nets: {}, reroutes: {}, nextOrdinal: 1,
        },
      },
      view: { graphs: {
        root: { nodes: {
          used: { position: { x: 120, y: 120 } },
          usedSecond: { position: { x: 360, y: 120 } },
          usedThird: { position: { x: 600, y: 120 } },
        } },
        used: { nodes: {} },
        usedSecond: { nodes: {} },
        usedThird: { nodes: {} },
        orphanParent: { nodes: { nested: { position: { x: 100, y: 100 } } } },
        orphanChild: { nodes: {} },
        orphanWithAnIntentionallyLongDefinitionIdentifierThatMustWrapWithoutClipping: { nodes: {} },
      } },
    }, 'Subgraph cleanup')
    const app = window.__dinksterTest!.app as any
    app.dock.setOpen('right', false)
    app.shell.statusBarVisible.set(false)
  })

  await page.getByTestId('topbar-search').click()
  await page.getByTestId('universal-search-input').fill('> Manage subgraph definitions')
  await page.locator('[data-provider="core.commands"] [data-testid="search-result-row"]', { hasText: 'Manage subgraph definitions' }).click()
  const dialog = page.locator('[data-modal="subgraph-definitions"]')
  await expect(dialog).toBeVisible()
  const unused = page.getByTestId('unused-subgraph-list')
  await expect(unused.locator('.subgraph-definition-row')).toHaveCount(3)
  await expect(unused).toHaveAttribute('aria-label', '3 unreachable subgraph definitions')
  await expect(unused).toHaveAttribute('aria-describedby', 'subgraph-unused-scroll-hint')
  await expect(dialog.locator('#subgraph-unused-scroll-hint')).toHaveText('3 definitions are in this cleanup set. Scroll to review every row.')
  await expect(unused).toHaveAttribute('tabindex', '0')
  expect(await unused.ariaSnapshot()).not.toContain('banner')
  await expect(dialog).toContainText('Old experiment')
  await expect(dialog).toContainText('Old detail')
  await expect(dialog).toContainText('orphanWithAnIntentionallyLongDefinitionIdentifierThatMustWrapWithoutClipping')
  await expect(dialog).toContainText('Retained definitions (3)')
  const orphan = dialog.locator('[data-definition-id="orphanParent"]')
  await expect(orphan.locator('[data-state="unreachable"]')).toHaveText('Unreachable')
  await expect(orphan.locator('.subgraph-definition-facts')).toContainText('Body nodes1')
  await expect(orphan.locator('[aria-label="Nested definitions used by Old experiment"]')).toContainText('Old detailorphanChild')
  const retainedSummary = dialog.locator('.subgraph-retained-definitions summary')
  await retainedSummary.focus()
  await page.keyboard.press('Enter')
  const retainedList = dialog.locator('[aria-label="3 retained subgraph definitions"]')
  const retainedRow = dialog.locator('[data-definition-id="usedThird"]')
  await expect(retainedList).toBeVisible()
  await expect(retainedList).toHaveAttribute('aria-describedby', 'subgraph-retained-scroll-hint')
  await expect(dialog.locator('#subgraph-retained-scroll-hint')).toHaveText('3 definitions are retained. Scroll to review every row.')
  await expect(dialog.locator('[data-definition-id="used"] [data-state="reachable"]')).toHaveText('Reachable')
  await page.setViewportSize({ width: 1600, height: 950 })
  expect(await retainedList.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true)
  await retainedRow.scrollIntoViewIfNeeded()
  const [dialogBounds, retainedBounds] = await Promise.all([dialog.boundingBox(), retainedRow.boundingBox()])
  expect(dialogBounds).not.toBeNull()
  expect(retainedBounds).not.toBeNull()
  expect(retainedBounds!.y).toBeGreaterThanOrEqual(dialogBounds!.y)
  expect(retainedBounds!.y + retainedBounds!.height).toBeLessThanOrEqual(dialogBounds!.y + dialogBounds!.height)
  await page.screenshot({ path: testInfo.outputPath('subgraph-cleanup-retained-expanded-1600x950.png') })
  await retainedSummary.click()
  await expect(retainedList).toBeHidden()
  await dialog.locator('.subgraph-definitions').evaluate((element) => { element.scrollTop = 0 })

  const viewports = [
    { name: 'wide', width: 1600, height: 950 },
    { name: 'standard', width: 1366, height: 768 },
    { name: 'narrow', width: 360, height: 640 },
    { name: 'zoom-200-reduced-motion', width: 800, height: 475 },
  ] as const
  for (const viewport of viewports) {
    await page.setViewportSize(viewport)
    await page.emulateMedia({ reducedMotion: viewport.name === 'zoom-200-reduced-motion' ? 'reduce' : 'no-preference' })
    const bounds = await dialog.boundingBox()
    expect(bounds).not.toBeNull()
    expect(bounds!.x).toBeGreaterThanOrEqual(0)
    expect(bounds!.y).toBeGreaterThanOrEqual(0)
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(viewport.width)
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(viewport.height)
    expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true)
    await page.screenshot({ path: testInfo.outputPath(`subgraph-cleanup-${viewport.name}.png`) })
  }
  await page.setViewportSize({ width: 1366, height: 768 })
  await unused.focus()
  await expect(unused).toBeFocused()
  expect(await unused.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true)
  expect(await unused.evaluate((element) => getComputedStyle(element).touchAction)).toBe('pan-y')
  const selectedId = await page.evaluate(() => {
    const code = document.querySelector('[data-definition-id="orphanParent"] code')!
    const range = document.createRange()
    range.selectNodeContents(code)
    const selection = document.getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
    return selection.toString()
  })
  expect(selectedId).toBe('orphanParent')
  await page.screenshot({ path: testInfo.outputPath('subgraph-cleanup-selection-focus-1366x768.png') })

  const longDefinition = unused.locator('[data-definition-id="orphanWithAnIntentionallyLongDefinitionIdentifierThatMustWrapWithoutClipping"]')
  for (const viewport of [{ width: 1366, height: 768 }, { width: 360, height: 640 }]) {
    await page.setViewportSize(viewport)
    await unused.evaluate((element) => { element.scrollTop = element.scrollHeight })
    const [listBounds, rowBounds] = await Promise.all([unused.boundingBox(), longDefinition.boundingBox()])
    expect(listBounds).not.toBeNull()
    expect(rowBounds).not.toBeNull()
    expect(rowBounds!.y + rowBounds!.height).toBeGreaterThan(listBounds!.y)
    expect(rowBounds!.y + rowBounds!.height).toBeLessThanOrEqual(listBounds!.y + listBounds!.height)
    await page.screenshot({ path: testInfo.outputPath(`subgraph-cleanup-overflow-tail-${viewport.width}x${viewport.height}.png`) })
  }

  await page.getByTestId('confirm-subgraph-cleanup').click()
  await expect(dialog).toHaveCount(0)
  expect(await page.evaluate(() => Object.keys(window.__dinksterTest!.app.activeTab()!.store.doc.graphs).sort()))
    .toEqual(['root', 'used', 'usedSecond', 'usedThird'])
  await page.keyboard.press('Control+Z')
  expect(await page.evaluate(() => Object.keys(window.__dinksterTest!.app.activeTab()!.store.doc.graphs).sort()))
    .toEqual([
      'orphanChild',
      'orphanParent',
      'orphanWithAnIntentionallyLongDefinitionIdentifierThatMustWrapWithoutClipping',
      'root',
      'used',
      'usedSecond',
      'usedThird',
    ])
  await page.keyboard.press('Control+Shift+Z')

  await page.getByTestId('topbar-search').click()
  await page.getByTestId('universal-search-input').fill('> Manage subgraph definitions')
  await page.locator('[data-provider="core.commands"] [data-testid="search-result-row"]', { hasText: 'Manage subgraph definitions' }).click()
  const emptyDialog = page.locator('[data-modal="subgraph-definitions"]')
  await expect(emptyDialog.locator('[data-state="empty"] strong')).toHaveText('No unused definitions')
  await expect(emptyDialog).toContainText('Every subgraph definition is reachable')
  await page.evaluate(() => {
    const app = window.__dinksterTest!.app as any
    app.transientStatus.set(undefined)
    app.shell.statusBarVisible.set(false)
  })
  await page.setViewportSize({ width: 1366, height: 768 })
  await page.screenshot({ path: testInfo.outputPath('subgraph-cleanup-empty-1366x768.png') })
  await page.setViewportSize({ width: 360, height: 640 })
  await page.screenshot({ path: testInfo.outputPath('subgraph-cleanup-empty-360x640.png') })
})

test('extract commits immediately with deterministic collision-safe names and undoable selection', async ({ page }) => {
  await ready(page, true)
  await page.evaluate(() => {
    const test = window.__dinksterTest!
    test.app.registerSchemas([{
      type: 'SubgraphLifecycleE2E', displayName: 'Subgraph Lifecycle', category: 'test', source: 'v3', isOutputNode: false,
      items: [],
    }])
    test.app.openDocument({
      format: 'dinkster-workflow', formatVersion: 1, lineage: 'subgraph-lifecycle-e2e', root: 'root',
      graphs: { root: {
        id: 'root', name: 'Root',
        nodes: {
          first: { id: 'first', type: 'SubgraphLifecycleE2E', values: {} },
          second: { id: 'second', type: 'SubgraphLifecycleE2E', values: {} },
        },
        links: {}, nets: {}, reroutes: {}, nextOrdinal: 10,
      } },
      view: { graphs: { root: { nodes: {
        first: { position: { x: 100, y: 100 } },
        second: { position: { x: 420, y: 100 } },
      } } } },
    }, 'Subgraph Lifecycle')
    test.renderer!.setViewport({ x: 0, y: 0, scale: 1 })
  })
  await expect.poll(() => page.evaluate(() => window.__dinksterTest!.renderer!.getScene().nodes.length)).toBe(2)

  await selectNode(page, 0)
  await extractSelected(page)
  await expect(page.getByTestId('graph-canvas')).toBeFocused()
  expect(await page.evaluate(() => Object.values(window.__dinksterTest!.app.activeTab()!.store.doc.graphs)
    .map((graph) => (graph as unknown as { name: string }).name).sort())).toEqual(['New Subgraph', 'Root'])
  const firstSelection = await page.evaluate(() => (window.__dinksterTest!.app as any).canvasBridge.get().selectedNodes())
  expect(firstSelection).toHaveLength(1)

  const remainingIndex = await page.evaluate(() => {
    const test = window.__dinksterTest!
    const tab = test.app.activeTab()!
    const root = tab.store.doc.graphs[tab.store.doc.root]!
    return test.renderer!.getScene().nodes.findIndex((node) => root.nodes[node.id]!.type === 'SubgraphLifecycleE2E')
  })
  await selectNode(page, remainingIndex)
  await extractSelected(page)
  expect(await page.evaluate(() => Object.values(window.__dinksterTest!.app.activeTab()!.store.doc.graphs)
    .map((graph) => (graph as unknown as { name: string }).name).sort())).toEqual(['New Subgraph', 'New Subgraph 2', 'Root'])
  await expect(page.getByTestId('subgraph-extract-prompt')).toHaveCount(0)

  await page.keyboard.press('Control+Z')
  expect(await page.evaluate(() => Object.values(window.__dinksterTest!.app.activeTab()!.store.doc.graphs)
    .map((graph) => (graph as unknown as { name: string }).name).sort())).toEqual(['New Subgraph', 'Root'])
  await page.keyboard.press('Control+Shift+Z')
  expect(await page.evaluate(() => Object.values(window.__dinksterTest!.app.activeTab()!.store.doc.graphs)
    .map((graph) => (graph as unknown as { name: string }).name).sort())).toEqual(['New Subgraph', 'New Subgraph 2', 'Root'])
})

test('extracts an Int widget-output fan-out and flattens it back to exact taps', async ({ page }, testInfo) => {
  await ready(page, true)
  await page.evaluate(() => {
    const test = window.__dinksterTest!
    test.app.registerSchemas([{
      type: 'LifecycleInt', displayName: 'Int', category: 'test', source: 'v3', isOutputNode: false,
      items: [{
        kind: 'input', id: 'value', displayName: 'Value',
        type: { kind: 'concrete', name: 'INT' }, optional: false,
        widget: { widgetType: 'core.int', options: {}, default: 0 },
      }],
    }, {
      type: 'LifecycleMathExpression', displayName: 'Math Expression', category: 'test', source: 'v3', isOutputNode: false,
      items: [
        { kind: 'input', id: 'a', displayName: 'A', type: { kind: 'concrete', name: 'INT' }, optional: false },
        { kind: 'input', id: 'b', displayName: 'B', type: { kind: 'concrete', name: 'INT' }, optional: false },
      ],
    }])
    test.app.openDocument({
      format: 'dinkster-workflow', formatVersion: 1, lineage: 'widget-output-extract-e2e', root: 'root',
      graphs: { root: {
        id: 'root', name: 'Root',
        nodes: {
          integer: { id: 'integer', type: 'LifecycleInt', values: { value: 7 } },
          first: { id: 'first', type: 'LifecycleMathExpression', values: {} },
          second: { id: 'second', type: 'LifecycleMathExpression', values: {} },
        },
        links: {
          firstTap: { id: 'firstTap', from: { node: 'integer', tap: 'value' }, to: { node: 'first', port: 'a' } },
          secondTap: { id: 'secondTap', from: { node: 'integer', tap: 'value' }, to: { node: 'second', port: 'b' } },
        },
        nets: {}, reroutes: {}, nextOrdinal: 20,
      } },
      view: { graphs: { root: { nodes: {
        integer: { position: { x: 120, y: 180 } },
        first: { position: { x: 460, y: 100 } },
        second: { position: { x: 460, y: 320 } },
      } } } },
    }, 'Widget output extraction')
    test.renderer!.setViewport({ x: 0, y: 0, scale: 1 })
  })
  await expect.poll(() => page.evaluate(() => window.__dinksterTest!.renderer!.getScene().nodes.length)).toBe(3)

  const integerIndex = await page.evaluate(() =>
    window.__dinksterTest!.renderer!.getScene().nodes.findIndex((node) => node.id === 'integer'),
  )
  await selectNode(page, integerIndex)
  await page.getByTestId('graph-canvas').screenshot({ path: testInfo.outputPath('widget-output-before-extraction.png') })
  await extractSelected(page)

  const extracted = await page.evaluate(() => {
    const tab = window.__dinksterTest!.app.activeTab()!
    const root = tab.store.doc.graphs.root!
    const occurrence = Object.values(root.nodes).find((node) => node.type.startsWith('#'))!
    const body = tab.store.doc.graphs[occurrence.type.slice(1)]! as unknown as {
      nodes: Record<string, unknown>
      boundary?: { outputs: readonly unknown[] }
    }
    return {
      occurrence: occurrence.id,
      bodyNodes: Object.keys(body.nodes),
      outputs: body.boundary?.outputs,
      links: root.links,
    }
  })
  expect(extracted.bodyNodes).toHaveLength(1)
  expect(extracted.outputs).toEqual([{
    id: 'value', binds: { kind: 'widgetTap', node: extracted.bodyNodes[0], tap: 'value' },
  }])
  expect(extracted.links).toEqual({
    firstTap: { id: 'firstTap', from: { node: extracted.occurrence, port: 'value' }, to: { node: 'first', port: 'a' } },
    secondTap: { id: 'secondTap', from: { node: extracted.occurrence, port: 'value' }, to: { node: 'second', port: 'b' } },
  })
  await expect(page.getByTestId('problems-panel')).not.toContainText('subgraph.extract.structuralOutputUnsupported')
  await page.getByTestId('graph-canvas').screenshot({ path: testInfo.outputPath('widget-output-after-extraction.png') })

  await page.keyboard.press('Control+Z')
  await expect.poll(() => page.evaluate(() => Object.keys(window.__dinksterTest!.app.activeTab()!.store.doc.graphs.root!.nodes).includes('integer'))).toBe(true)
  await page.keyboard.press('Control+Shift+Z')
  await expect.poll(() => page.evaluate((id) => Object.hasOwn(window.__dinksterTest!.app.activeTab()!.store.doc.graphs.root!.nodes, id), extracted.occurrence)).toBe(true)
  const occurrenceIndex = await page.evaluate(
    (id) => window.__dinksterTest!.renderer!.getScene().nodes.findIndex((node) => node.id === id),
    extracted.occurrence,
  )
  await selectNode(page, occurrenceIndex)
  await page.keyboard.press('Control+Shift+F')
  await expect.poll(() => page.evaluate((id) => Object.hasOwn(window.__dinksterTest!.app.activeTab()!.store.doc.graphs.root!.nodes, id), extracted.occurrence)).toBe(false)
  const flattened = await page.evaluate(() => {
    const root = window.__dinksterTest!.app.activeTab()!.store.doc.graphs.root!
    return {
      intNodes: Object.values(root.nodes).filter((node) => node.type === 'LifecycleInt').map((node) => node.id),
      sources: Object.values(root.links).map((link) => link.from),
    }
  })
  expect(flattened.intNodes).toHaveLength(1)
  expect(flattened.sources).toEqual([
    { node: flattened.intNodes[0], tap: 'value' },
    { node: flattened.intNodes[0], tap: 'value' },
  ])
})

test('extracts a mixed node and selected group snapshot, then supports undo and redo', async ({ page }) => {
  await ready(page)
  const first = await selectNode(page)
  await page.evaluate((nodeId) => {
    const tab = window.__dinksterTest!.app.activeTab()!
    const view = tab.store.doc.view.graphs[tab.store.doc.root]!.nodes[nodeId]!
    const position = view.position ?? { x: 0, y: 0 }
    tab.store.dispatch({ command: 'view.createGroup', params: { graphId: tab.store.doc.root, title: 'Current contents', bounds: { x: position.x - 30, y: position.y - 30, width: 260, height: 180 } } })
  }, first)
  const groupHeader = await page.evaluate(() => {
    const renderer = window.__dinksterTest!.renderer!
    const group = renderer.getScene().groups[0]!
    const viewport = renderer.getViewport()
    const canvas = document.querySelector('[data-testid=graph-canvas]')!.getBoundingClientRect()
    return { x: canvas.left + (group.x + group.width / 2) * viewport.scale + viewport.x, y: canvas.top + (group.y + 13) * viewport.scale + viewport.y }
  })
  await page.mouse.click(groupHeader.x, groupHeader.y)
  await selectNode(page, 1, ['Control'])
  const before = await page.evaluate(() => structuredClone(window.__dinksterTest!.app.activeTab()!.store.doc))
  await extractSelected(page)
  const after = await page.evaluate(() => structuredClone(window.__dinksterTest!.app.activeTab()!.store.doc))
  await page.keyboard.press('Control+Z')
  await expect.poll(async () => withoutAllocatorCursors(await page.evaluate(() => structuredClone(window.__dinksterTest!.app.activeTab()!.store.doc))))
    .toEqual(withoutAllocatorCursors(before))
  const undone = await page.evaluate(() => structuredClone(window.__dinksterTest!.app.activeTab()!.store.doc))
  expectRetainedGraphOrdinals(undone, after)
  await page.keyboard.press('Control+Shift+Z')
  await expect.poll(async () => withoutAllocatorCursors(await page.evaluate(() => structuredClone(window.__dinksterTest!.app.activeTab()!.store.doc))))
    .toEqual(withoutAllocatorCursors(after))
})

test('extract selects its occurrence and flatten shortcut selects the spliced body nodes', async ({ page }) => {
  await ready(page)
  await selectNode(page)
  const beforeExtractIds = await page.evaluate(() => {
    const tab = window.__dinksterTest!.app.activeTab()!
    return Object.keys(tab.store.doc.graphs[tab.store.doc.root]!.nodes)
  })
  await extractSelected(page)
  const createdOccurrence = await page.evaluate((before) => {
    const app = window.__dinksterTest!.app as any
    const tab = app.activeTab()
    const created = Object.keys(tab.store.doc.graphs[tab.store.doc.root].nodes).filter((id) => !before.includes(id))
    return { created, selected: app.canvasBridge.get().selectedNodes().sort() }
  }, beforeExtractIds)
  expect(createdOccurrence.created).toHaveLength(1)
  expect(createdOccurrence.selected).toEqual(createdOccurrence.created)
  const occurrence = await page.evaluate(() => {
    const tab = window.__dinksterTest!.app.activeTab()!
    const graph = tab.store.doc.graphs[tab.store.doc.root]!
    return window.__dinksterTest!.renderer!.getScene().nodes.find((node) => graph.nodes[node.id]!.type.startsWith('#'))!.id
  })
  const beforeFlattenIds = await page.evaluate(() => {
    const tab = window.__dinksterTest!.app.activeTab()!
    return Object.keys(tab.store.doc.graphs[tab.store.doc.root]!.nodes)
  })
  await page.keyboard.press('Control+Shift+F')
  await expect.poll(() => page.evaluate((id) => window.__dinksterTest!.app.activeTab()!.store.doc.graphs[window.__dinksterTest!.app.activeTab()!.store.doc.root]!.nodes[id], occurrence)).toBeUndefined()
  const selected = await page.evaluate(() => (window.__dinksterTest!.app as any).canvasBridge.get().selectedNodes().sort())
  const spliced = await page.evaluate((before) => {
    const tab = window.__dinksterTest!.app.activeTab()!
    return Object.keys(tab.store.doc.graphs[tab.store.doc.root]!.nodes).filter((id) => !before.includes(id)).sort()
  }, beforeFlattenIds)
  expect(selected).toEqual(spliced)
})

test('supports nested drill-in after extraction', async ({ page }) => {
  await ready(page)
  await selectNode(page)
  await extractSelected(page)
  const outer = await nodePoint(page, await page.evaluate(() => window.__dinksterTest!.renderer!.getScene().nodes.findIndex((node) => {
    const tab = window.__dinksterTest!.app.activeTab()!
    return tab.store.doc.graphs[tab.store.doc.root]!.nodes[node.id]!.type.startsWith('#')
  })))
  await page.mouse.dblclick(outer.x, outer.y)
  await selectNode(page)
  await extractSelected(page)
  const nested = await nodePoint(page, await page.evaluate(() => {
    const tab = window.__dinksterTest!.app.activeTab()!
    const graphId = tab.graphStack.get().at(-1)!
    return window.__dinksterTest!.renderer!.getScene().nodes.findIndex((node) => tab.store.doc.graphs[graphId]!.nodes[node.id]!.type.startsWith('#'))
  }))
  await page.mouse.dblclick(nested.x, nested.y)
  await expect(page.getByTestId('graph-breadcrumb').getByRole('button')).toHaveCount(3)
})

test('flatten is one undoable and redoable operation', async ({ page }) => {
  await ready(page)
  await selectNode(page)
  await extractSelected(page)
  const extracted = await page.evaluate(() => structuredClone(window.__dinksterTest!.app.activeTab()!.store.doc))
  await page.keyboard.press('Control+Shift+F')
  const flattened = await page.evaluate(() => structuredClone(window.__dinksterTest!.app.activeTab()!.store.doc))
  await page.keyboard.press('Control+Z')
  await expect.poll(async () => withoutAllocatorCursors(await page.evaluate(() => structuredClone(window.__dinksterTest!.app.activeTab()!.store.doc))))
    .toEqual(withoutAllocatorCursors(extracted))
  const undone = await page.evaluate(() => structuredClone(window.__dinksterTest!.app.activeTab()!.store.doc))
  expectRetainedGraphOrdinals(undone, flattened)
  await page.keyboard.press('Control+Shift+Z')
  await expect.poll(async () => withoutAllocatorCursors(await page.evaluate(() => structuredClone(window.__dinksterTest!.app.activeTab()!.store.doc))))
    .toEqual(withoutAllocatorCursors(flattened))
})

test('region occurrence flatten refusal is displayed with its code and anchor', async ({ page }) => {
  await ready(page, true)
  await page.evaluate(() => {
    const test = window.__dinksterTest!
    test.app.registerSchemas([{
      type: 'RegionLifecycleE2E', displayName: 'Region lifecycle', category: 'test', source: 'v3', isOutputNode: false,
      items: [
        { kind: 'input', id: 'item', type: { kind: 'concrete', name: 'FLOAT' }, optional: true },
        { kind: 'output', id: 'result', type: { kind: 'concrete', name: 'FLOAT' }, list: false },
      ],
    }])
    test.app.openDocument({
      format: 'dinkster-workflow', formatVersion: 1, lineage: 'region-flatten-refusal', root: 'root',
      graphs: { root: {
        id: 'root', name: 'Root',
        nodes: { template: { id: 'template', type: 'RegionLifecycleE2E', values: {} } },
        links: {}, nets: {}, reroutes: {}, nextOrdinal: 2,
      } },
      view: { graphs: { root: { nodes: { template: { position: { x: 600, y: 100 } } } } } },
    }, 'Region flatten refusal')
    const tab = test.app.activeTab()!
    const root = tab.store.doc.root
    const template = Object.values(tab.store.doc.graphs[root]!.nodes)[0]!
    const imported = tab.store.dispatch({
      command: 'subgraph.import',
      params: {
        graphs: {
          regionBody: {
            id: 'regionBody',
            name: 'Region Body',
            nodes: { n0: { id: 'n0', type: template.type, values: {} } },
            links: {}, nets: {}, reroutes: {}, valueSources: {}, selectors: {},
            boundary: {
              inputs: [{ id: 'item', binds: { kind: 'port', node: 'n0', port: 'item' } }],
              outputs: [{ id: 'result', binds: { kind: 'port', node: 'n0', port: 'result' } }],
            },
            nextOrdinal: 1,
          },
        },
        view: { regionBody: { nodes: { n0: { position: { x: 100, y: 100 } } } } },
      },
    })
    if (!imported.ok) throw new Error(`subgraph.import refused: ${JSON.stringify(imported.diagnostics)}`)
    // Place the occurrence so its header center projects into the lower-left
    // quadrant of the visible canvas: a fixed world position can land under
    // the bottom-right minimap overlay (which swallows the selection click
    // and pans the viewport instead) or on the fitted template node at the
    // canvas center. 70/14 are half the minimum node width/header height.
    const viewport = window.__dinksterTest!.renderer!.getViewport()
    const canvas = document.querySelector('[data-testid=graph-canvas]')!.getBoundingClientRect()
    const position = {
      x: (canvas.width * 0.25 - viewport.x) / viewport.scale - 70,
      y: (canvas.height * 0.75 - viewport.y) / viewport.scale - 14,
    }
    const added = tab.store.dispatch({
      command: 'node.add',
      params: {
        graphId: root,
        type: '#regionBody',
        values: { item: [] },
        position,
        region: { kind: 'map', elementPorts: ['item'] },
      },
    })
    if (!added.ok) throw new Error(`node.add refused: ${JSON.stringify(added.diagnostics)}`)
  })
  const target = await page.evaluate(() => {
    const tab = window.__dinksterTest!.app.activeTab()!
    const graph = tab.store.doc.graphs[tab.store.doc.root]!
    const index = window.__dinksterTest!.renderer!.getScene().nodes.findIndex((node) => (graph.nodes[node.id] as any).region !== undefined)
    return { index, id: window.__dinksterTest!.renderer!.getScene().nodes[index]!.id }
  })
  await selectNode(page, target.index)
  const flattenButton = await page.evaluate(() => window.__dinksterTest!.renderer!.getToolboxLayout()!.buttons
    .find((entry) => entry.button.id === 'core.flattenSubgraph')!.button)
  expect(flattenButton.disabled).toBe(true)
  expect(flattenButton.reason).toContain('occurrence shell mode or region contract cannot be flattened')
  await page.keyboard.press('Control+Shift+F')
  await openRailPanel(page, 'Problems')
  const problems = page.getByTestId('problems-panel')
  await expect(problems).toContainText('subgraph.flatten.regionUnsupported')
  await expect(problems).toContainText('occurrence shell mode or region contract cannot be flattened')
  const interimIndex = await page.evaluate((regionId) => window.__dinksterTest!.renderer!.getScene().nodes.findIndex((node) => node.id !== regionId), target.id)
  const interimId = await selectNode(page, interimIndex)
  expect(await page.evaluate(() => (window.__dinksterTest!.app as any).canvasBridge.get().selectedNodes())).toEqual([interimId])
  const regionProblem = problems.locator('.problem[data-activatable=true]', { hasText: 'subgraph.flatten.regionUnsupported' })
  await regionProblem.locator('summary').click()
  await regionProblem.getByRole('button', { name: 'Show on canvas' }).click()
  await expect.poll(() => page.evaluate(() => (window.__dinksterTest!.app as any).canvasBridge.get().selectedNodes())).toEqual([target.id])
})
