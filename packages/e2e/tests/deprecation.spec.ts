import { expect, openRailPanel, test, type Page } from './fixtures.js'

async function badgePoint(page: Page, nodeId: string): Promise<{ x: number; y: number }> {
  return page.evaluate((nodeId) => {
    const r = window.__dinksterTest!.renderer!
    const vp = r.getViewport()
    const node = r.getScene().nodes.find((n) => n.id === nodeId)
    if (!node) throw new Error(`no scene node '${nodeId}'`)
    const rect = document.querySelector('[data-testid=graph-canvas]')!.getBoundingClientRect()
    return {
      x: rect.left + (node.x + node.layout.width - 22 + 7) * vp.scale + vp.x,
      y: rect.top + (node.y + node.layout.headerHeight / 2) * vp.scale + vp.y,
    }
  }, nodeId)
}

test('review-mode native deprecation badges show guidance without an executable rule', async ({ page }, testInfo) => {
  await page.route('/api/nodes*', (route) => route.fulfill({ json: {
    schemaVersion: 1, epoch: 1, dinkster: { version: 'deprecation-fixture', schemaWire: 1 },
    nodes: {
      AuthoredNode: { deprecation: { message: 'Use CurrentNode for new workflows', since: '2.0', replacement: 'CurrentNode' }, interface: [] },
      CurrentNode: { interface: [] },
      NoSuccessor: { deprecation: { message: 'This node is deprecated' }, interface: [] },
    },
  } }))
  await page.goto('/')
  await expect(page.getByTestId('status-bar')).toContainText(/3 node schemas/, { timeout: 30_000 })
  await page.evaluate(() => window.__dinksterTest!.app.reviewReplacements.set(true))
  expect(await page.evaluate(() => window.__dinksterTest!.app.openDocument({
    nodes: [{ id: 1, type: 'AuthoredNode', pos: [120, 120] }, { id: 2, type: 'NoSuccessor', pos: [450, 120] }], links: [],
  }, 'Deprecation guidance'))).toEqual([])
  // The workspace handoff dismisses popovers attached to the local session.
  await expect.poll(() => page.evaluate(() => {
    const tab = window.__dinksterTest!.app.activeTab()
    return tab !== undefined && 'status' in tab.store
  })).toBe(true)
  await expect.poll(() => page.evaluate(() => window.__dinksterTest!.renderer!.getScene().nodes.length)).toBe(2)
  await page.evaluate(() => {
    window.__dinksterTest!.renderer!.setViewport({ x: 0, y: 0, scale: 1 })
  })
  for (const [id, text, filename] of [
    ['n1', "Successor: 'CurrentNode'", 'deprecation-successor.png'],
    ['n2', 'No successor is declared.', 'deprecation-no-successor.png'],
  ]) {
    await page.keyboard.press('Escape')
    const point = await badgePoint(page, id!)
    await page.mouse.click(point.x, point.y)
    const popover = page.getByTestId('badge-popover')
    await expect(popover).toBeVisible()
    await expect(popover).toContainText(text!)
    await expect(popover.getByRole('button')).toHaveCount(0)
    await popover.screenshot({ path: testInfo.outputPath(filename!) })
  }
  expect(await page.evaluate(() => {
    const doc = window.__dinksterTest!.app.activeTab()!.store.doc
    return Object.fromEntries(Object.values(doc.graphs[doc.root]!.nodes).map((n) => [n.id, n.type]))
  })).toEqual({ n1: 'AuthoredNode', n2: 'NoSuccessor' })
})

// Only the successor is served: historical nodes must migrate from stored data.
async function migrationCatalog(page: Page): Promise<void> {
  await page.route('/api/nodes*', (route) => route.fulfill({ json: {
    schemaVersion: 1, epoch: 1, dinkster: { version: 'migration-fixture', schemaWire: 1 },
    nodes: { Current: {
      interface: [
        { role: 'input', id: 'amount', type: { kind: 'concrete', types: ['INT'] }, default: 7 },
        { role: 'input', id: 'format', type: { kind: 'concrete', types: ['COMBO'] },
          widget: { type: 'COMBO', options: ['mp4_h264', 'webm_av1'] }, default: 'mp4_h264' },
      ],
      replacements: [{ from: 'Previous', cases: [{ to: 'Current', inputs: {
        amount: { kind: 'copy', input: 'oldAmount' }, format: { kind: 'copy', input: 'format' },
      } }] }],
    } },
  } }))
  await page.goto('/')
  await expect(page.getByTestId('status-bar')).toContainText('1 node schemas', { timeout: 30_000 })
}

async function openMigration(page: Page, lineage: string): Promise<void> {
  expect(await page.evaluate((lineage) => window.__dinksterTest!.app.openDocument({
    format: 'dinkster-workflow', formatVersion: 1, lineage, root: 'g0',
    graphs: { g0: { id: 'g0', name: 'root', nextOrdinal: 2, nets: {}, reroutes: {},
      nodes: {
        first: { id: 'first', type: 'Previous', values: { oldAmount: 11 }, dynamic: { format: { selected: 'webm_av1' } } },
        second: { id: 'second', type: 'Previous', values: { oldAmount: 29, format: 'mp4_h264' } },
      },
      links: { lost: { id: 'lost', from: { node: 'first', port: 'discarded' }, to: { node: 'second', port: 'unmapped' } } },
    } },
    view: { graphs: { g0: { nodes: {
      first: { position: { x: 120, y: 120 } }, second: { position: { x: 450, y: 150 } },
    } } } },
  }, lineage), lineage)).toEqual([])
  await expect.poll(() => page.evaluate(() => {
    const tab = window.__dinksterTest!.app.activeTab()
    return tab !== undefined && 'status' in tab.store
  })).toBe(true)
  await expect.poll(() => page.evaluate(() => window.__dinksterTest!.renderer!.getScene().nodes.length)).toBe(2)
  await page.evaluate(() => window.__dinksterTest!.renderer!.setViewport({ x: 0, y: 0, scale: 1 }))
}

test('open-time lossy upgrades show one navigable notice and undo together', async ({ page }, testInfo) => {
  await migrationCatalog(page)
  await openMigration(page, 'automatic-migration')
  expect(await page.evaluate(() => {
    const graph = window.__dinksterTest!.app.activeTab()!.store.doc.graphs.g0!
    return { nodes: graph.nodes, links: graph.links }
  })).toEqual({ nodes: {
    first: { id: 'first', type: 'Current', values: { amount: 11, format: 'webm_av1' } },
    second: { id: 'second', type: 'Current', values: { amount: 29, format: 'mp4_h264' } },
  }, links: {} })
  expect(await page.evaluate(() => Object.values(window.__dinksterTest!.renderer!.getBadges())
    .flatMap((badges) => badges.map((badge) => badge.id)))).not.toContain('core.deprecated')
  await expect(page.getByTestId('badge-popover')).toHaveCount(0)
  await openRailPanel(page, 'Problems')
  const notice = page.getByTestId('migration-notice')
  await expect(notice).toHaveCount(1)
  await expect(notice).toContainText('Workflow upgraded')
  await expect(notice.locator('.problem')).toHaveCount(2)
  await expect(notice).toContainText('will be removed')
  await expect(notice.getByRole('button', { name: /Apply/ })).toHaveCount(0)
  await notice.getByRole('button', { name: 'first: Previous -> Current', exact: true }).click()
  await expect(page.getByTestId('graph-canvas')).toHaveAttribute('data-selection', '1')
  await expect.poll(() => page.evaluate(() => {
    const renderer = window.__dinksterTest!.renderer!
    const node = renderer.getScene().nodes.find((candidate) => candidate.id === 'first')!
    const viewport = renderer.getViewport()
    const canvas = document.querySelector('[data-testid=graph-canvas]')!.getBoundingClientRect()
    return Math.hypot(
      (node.x + node.layout.width / 2) * viewport.scale + viewport.x - canvas.width / 2,
      (node.y + node.layout.height / 2) * viewport.scale + viewport.y - canvas.height / 2,
    )
  })).toBeLessThan(2)
  await page.screenshot({ path: testInfo.outputPath('migration-notice.png') })
  await notice.getByRole('button', { name: 'Undo upgrades', exact: true }).click()
  await expect(notice).toHaveCount(0)
  expect(await page.evaluate(() => {
    const tab = window.__dinksterTest!.app.activeTab()!
    const graph = tab.store.doc.graphs.g0!
    return { types: Object.values(graph.nodes).map((node) => node.type), values: graph.nodes.first!.values,
      dynamic: graph.nodes.first!.dynamic, link: graph.links.lost, canUndo: tab.store.canUndo }
  })).toEqual({ types: ['Previous', 'Previous'], values: { oldAmount: 11 }, dynamic: { format: { selected: 'webm_av1' } },
    link: { id: 'lost', from: { node: 'first', port: 'discarded' }, to: { node: 'second', port: 'unmapped' } }, canUndo: false })
  // Undo must not introduce default-mode manual approval controls.
  expect(await page.evaluate(() => Object.values(window.__dinksterTest!.renderer!.getBadges())
    .flatMap((badges) => badges.map((badge) => badge.id)))).not.toContain('core.deprecated')
  await expect(page.getByTestId('badge-apply-replacement')).toHaveCount(0)
})

test('migration notices dismiss, clear on save or close, and never persist', async ({ page }) => {
  await migrationCatalog(page)
  await openMigration(page, 'dismiss-migration')
  await openRailPanel(page, 'Problems')
  const notice = page.getByTestId('migration-notice')
  await notice.getByRole('button', { name: 'Dismiss', exact: true }).click()
  await expect(notice).toHaveCount(0)
  await openMigration(page, 'save-migration')
  await expect(notice).toHaveCount(1)
  let uploaded = ''
  await page.route('**/api/assets', async (route) => {
    uploaded = route.request().postData() ?? ''
    await route.fulfill({ json: { digest: 'blake3:' + '1'.repeat(64) } })
  })
  await page.route('**/api/library', async (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>
    await route.fulfill({ json: { ...body, id: 'saved-migration', revision: 1, created: 1, modified: 1 } })
  })
  await page.keyboard.press('Control+s')
  await expect(notice).toHaveCount(0)
  expect(JSON.parse(uploaded).graphs.g0.nodes.first).toEqual({
    id: 'first', type: 'Current', values: { amount: 11, format: 'webm_av1' },
  })
  expect(uploaded).not.toContain('replace.applied')
  expect(uploaded).not.toContain('will be removed')
  expect(await page.evaluate((saved) => window.__dinksterTest!.app.openDocument(JSON.parse(saved), 'Saved migration'), uploaded)).toEqual([])
  await expect(notice).toHaveCount(0)
  await openMigration(page, 'close-migration')
  await expect(notice).toHaveCount(1)
  await page.evaluate(() => {
    const app = window.__dinksterTest!.app
    app.closeTab(app.activeTab()!.id)
  })
  await expect(notice).toHaveCount(0)
  expect(await page.evaluate(() => window.__dinksterTest!.app.migrationNotices.get().size)).toBe(0)
})

test('only opt-in review holds a lossy migration for badge Apply', async ({ page }, testInfo) => {
  await migrationCatalog(page)
  await page.evaluate(() => window.__dinksterTest!.app.reviewReplacements.set(true))
  await openMigration(page, 'review-migration')
  expect(await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.doc.graphs.g0!.nodes.first!.type)).toBe('Previous')
  await expect(page.getByTestId('migration-notice')).toHaveCount(0)
  const point = await badgePoint(page, 'first')
  await page.mouse.click(point.x, point.y)
  const popover = page.getByTestId('badge-popover')
  await expect(popover).toBeVisible()
  await expect(popover).toContainText('will be removed')
  const apply = popover.getByRole('button', { name: 'Apply Replacement', exact: true })
  await expect(apply).toBeEnabled()
  await page.screenshot({ path: testInfo.outputPath('migration-review.png') })
  await apply.click()
  await expect(popover).toHaveCount(0)
  expect(await page.evaluate(() => {
    const graph = window.__dinksterTest!.app.activeTab()!.store.doc.graphs.g0!
    return { first: graph.nodes.first, secondType: graph.nodes.second!.type, links: graph.links }
  })).toEqual({ first: { id: 'first', type: 'Current', values: { amount: 11, format: 'webm_av1' } },
    secondType: 'Previous', links: {} })
  await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.undo())
  expect(await page.evaluate(() => {
    const tab = window.__dinksterTest!.app.activeTab()!
    return { type: tab.store.doc.graphs.g0!.nodes.first!.type, linkCount: Object.keys(tab.store.doc.graphs.g0!.links).length, canUndo: tab.store.canUndo }
  })).toEqual({ type: 'Previous', linkCount: 1, canUndo: false })
})
