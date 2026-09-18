import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { TestInfo } from '@playwright/test'
import { expect, test, type Page } from './fixtures.js'

const proofDir = process.env['DINKSTER_CANVAS_HIERARCHY_PROOF_DIR']
if (proofDir !== undefined) mkdirSync(proofDir, { recursive: true })

const capture = async (page: Page, testInfo: TestInfo, name: string): Promise<void> => {
  if (proofDir === undefined) return
  await page.getByTestId('graph-canvas').screenshot({
    path: join(proofDir, `${testInfo.project.name}-${name}.png`),
    animations: 'disabled',
  })
}

const settlePaint = async (page: Page): Promise<void> => {
  await page.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
  }))
}

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await expect(page.getByTestId('status-bar')).toContainText(/\d+ node schemas/, { timeout: 15_000 })
})

test('node, link, group, and state hierarchy remains legible at typed detail boundaries', async ({ page }, testInfo) => {
  const diagnostics = await page.evaluate(() => {
    const bridge = window.__dinksterTest!
    return bridge.app.openDocument(
      bridge.syntheticWorkflow({ chains: 2, chainLength: 4, reroutes: false }),
      'Hierarchy proof',
    )
  })
  expect(diagnostics).toEqual([])
  await expect(page.getByTestId('tab-bar').locator('.tab', { hasText: 'Hierarchy proof' })).toBeVisible()
  await settlePaint(page)

  const baseline = await page.evaluate(() => {
    const bridge = window.__dinksterTest!
    type Scene = ReturnType<NonNullable<typeof bridge.renderer>['getScene']>
    type ProofRenderer = NonNullable<typeof bridge.renderer> & {
      setScene(scene: Scene): void
      setNodeStates(states: Readonly<Record<string, { state: string; value?: number }>>): void
      setBadges(badges: Readonly<Record<string, readonly {
        id: string
        glyph: string
        variant?: 'label'
        interactive?: false
        color: string
      }[]>>): void
      setOverlay(overlay: object): void
      setInactiveNodes(nodes: ReadonlySet<string> | undefined): void
    }
    const renderer = bridge.renderer! as unknown as ProofRenderer
    const scene = renderer.getScene()
    const nodes = scene.nodes.slice(0, 8).map((node, index) => {
      const nodeData = (node as unknown as { node: object }).node
      return {
        ...node,
        x: 80 + (index % 4) * 290,
        y: 110 + Math.floor(index / 4) * 350,
        node: {
          ...nodeData,
          ...(index === 4 ? { mode: 'muted' as const } : {}),
          ...(index === 6 ? { mode: 'bypassed' as const } : {}),
        },
        layout: {
          ...node.layout,
          title: index === 3
            ? 'Long node title that remains bounded inside retained geometry'
            : `Synthetic node ${index + 1}`,
        },
      }
    })
    if (nodes.length !== 8) throw new Error(`hierarchy fixture needs 8 nodes, received ${nodes.length}`)

    const nodeById = new Map(nodes.map((node) => [node.id, node]))
    const links = scene.links.map((link, index) => {
      const from = link.from
      const to = link.to
      if (from.kind !== 'port' || to.kind !== 'port') {
        throw new Error(`hierarchy fixture link ${link.id} must connect node ports`)
      }
      const fromNode = nodeById.get(from.node)!
      const toNode = nodeById.get(to.node)!
      const fromPin = fromNode.layout.pins.find((pin) => pin.direction === 'out' && pin.portId === from.port)!
      const toPin = toNode.layout.pins.find((pin) => pin.direction === 'in' && pin.portId === to.port)!
      return {
        ...link,
        id: `hierarchy-link-${index}`,
        x1: fromNode.x + fromNode.layout.width,
        y1: fromNode.y + fromPin.y,
        x2: toNode.x,
        y2: toNode.y + toPin.y,
        typeName: 'IMAGE',
        ...(index === 1 ? { maybeAbsent: true as const } : {}),
        ...(index === 5 ? { mismatch: true as const } : {}),
      }
    })
    const reroutes = links.slice(0, 4).map((link, index) => ({
      id: `hierarchy-reroute-${index}`,
      x: (link.x1 + link.x2) / 2,
      y: (link.y1 + link.y2) / 2,
      typeName: 'IMAGE',
    }))
    const groups = [
      {
        id: 'hierarchy-group-ordinary',
        title: 'Image preparation and conditioning',
        x: 45,
        y: 55,
        width: 1110,
        height: 325,
        color: '#3f6595',
      },
      {
        id: 'hierarchy-group-long',
        title: 'Selected group with a deliberately long title that stays clipped to its retained frame',
        x: 45,
        y: 405,
        width: 1110,
        height: 325,
      },
    ]

    renderer.setScene({ ...scene, nodes, links, reroutes, groups })
    renderer.setNodeStates({
      [nodes[0]!.id]: { state: 'pending' },
      [nodes[1]!.id]: { state: 'running', value: 0.64 },
      [nodes[2]!.id]: { state: 'cached' },
      [nodes[3]!.id]: { state: 'done' },
      [nodes[4]!.id]: { state: 'skipped' },
      [nodes[5]!.id]: { state: 'error' },
      [nodes[6]!.id]: { state: 'done' },
      [nodes[7]!.id]: { state: 'done' },
    })
    renderer.setBadges({
      [nodes[4]!.id]: [{ id: 'core.mode.muted', glyph: 'Muted', variant: 'label', interactive: false, color: '#6b7280' }],
      [nodes[5]!.id]: [{ id: 'core.error', glyph: 'Error', variant: 'label', color: '#b3402f' }],
      [nodes[6]!.id]: [{ id: 'core.mode.bypassed', glyph: 'Bypassed', variant: 'label', interactive: false, color: '#7c5ca8' }],
      [nodes[7]!.id]: [{ id: 'core.problem.blocking-warning', glyph: '!', color: '#f4bf4f' }],
    })
    renderer.setOverlay({
      selection: new Set([nodes[1]!.id, nodes[5]!.id]),
      linkSelection: new Set([links[3]!.id]),
      rerouteSelection: new Set([reroutes[0]!.id]),
      groupSelection: new Set([groups[1]!.id]),
      bodyDropNode: nodes[7]!.id,
    })
    renderer.setInactiveNodes(new Set([nodes[7]!.id]))
    return {
      revision: bridge.app.activeTab()!.store.revision,
      document: JSON.stringify(bridge.app.activeTab()!.store.doc),
    }
  })

  const bitmaps: string[] = []
  const views = [
    { name: '1600-overview-049', width: 1600, height: 950, scale: 0.49, x: 110, y: 125 },
    { name: '1600-content-050', width: 1600, height: 950, scale: 0.5, x: 110, y: 125 },
    { name: '1600-controls-075', width: 1600, height: 950, scale: 0.75, x: 65, y: 100 },
    { name: '1366-overview-049', width: 1366, height: 768, scale: 0.49, x: 85, y: 95 },
    { name: '1366-content-050', width: 1366, height: 768, scale: 0.5, x: 85, y: 95 },
    { name: '1366-controls-075', width: 1366, height: 768, scale: 0.75, x: 65, y: 100 },
    { name: '390-overview-049', width: 390, height: 844, scale: 0.49, x: 35, y: 70 },
    { name: '390-content-050', width: 390, height: 844, scale: 0.5, x: 35, y: 70 },
    { name: '390-controls-075', width: 390, height: 844, scale: 0.75, x: 35, y: 70 },
  ]
  for (const view of views) {
    await page.setViewportSize({ width: view.width, height: view.height })
    if (view.width === 390) {
      const railToggle = page.getByRole('button', { name: 'Toggle right rail' })
      if (await railToggle.getAttribute('aria-pressed') === 'true') await railToggle.click()
    }
    await page.evaluate(({ x, y, scale }) => {
      window.__dinksterTest!.renderer!.setViewport({ x, y, scale })
    }, view)
    await settlePaint(page)
    expect(await page.evaluate(() => window.__dinksterTest!.renderer!.getViewport().scale)).toBe(view.scale)
    bitmaps.push(await page.getByTestId('graph-canvas').evaluate((canvas) => (canvas as HTMLCanvasElement).toDataURL()))
    await capture(page, testInfo, view.name)
  }

  expect(new Set(bitmaps).size).toBe(views.length)
  expect(await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.revision)).toBe(baseline.revision)
  expect(await page.evaluate(() => JSON.stringify(window.__dinksterTest!.app.activeTab()!.store.doc))).toBe(baseline.document)
})
