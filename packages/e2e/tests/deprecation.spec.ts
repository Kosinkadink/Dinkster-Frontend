import { expect, openRailPanel, nativeTest as test, waitForWorkspaceReady, type Page } from './fixtures.js'

async function badgePoint(page: Page, nodeId: string): Promise<{ x: number; y: number }> {
  return page.evaluate((nodeId) => {
    const r = window.__dinksterTest!.renderer!
    const vp = r.getViewport()
    const node = r.getScene().nodes.find((n) => n.id === nodeId)
    if (!node) throw new Error(`no scene node '${nodeId}'`)
    const tab = r.getNodeBadgeLayout(node).find((entry) => entry.badge.id === 'core.deprecated')
    if (!tab) throw new Error(`no deprecated tab on '${nodeId}'`)
    const rect = document.querySelector('[data-testid=graph-canvas]')!.getBoundingClientRect()
    return {
      x: rect.left + (tab.x + tab.width / 2) * vp.scale + vp.x,
      y: rect.top + (tab.y + tab.height / 2) * vp.scale + vp.y,
    }
  }, nodeId)
}

test('review-mode native deprecation badges show guidance without an executable rule', async ({ page }, testInfo) => {
  await page.route('/api/nodes*', (route) => route.fulfill({ json: {
    schemaVersion: 1, epoch: 1, dinkster: { version: 'deprecation-fixture', schemaWire: 2 },
    nodes: {
      AuthoredNode: { deprecation: { message: 'Use CurrentNode for new workflows', since: '2.0', replacement: 'CurrentNode' }, body: [] },
      CurrentNode: { body: [] },
      NoSuccessor: { deprecation: { message: 'This node is deprecated' }, body: [] },
    },
  } }))
  await page.goto('/')
  await waitForWorkspaceReady(page, 3)
  await page.evaluate(() => window.__dinksterTest!.app.settings.set('execution.reviewUpgrades', true))
  expect(await page.evaluate(async () => (await window.__dinksterTest!.app.openDocument({
    nodes: [{ id: 1, type: 'AuthoredNode', pos: [120, 120] }, { id: 2, type: 'NoSuccessor', pos: [450, 120] }], links: [],
  }, 'Deprecation guidance')))).toEqual([])
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
    schemaVersion: 1, epoch: 1, dinkster: { version: 'migration-fixture', schemaWire: 2 },
    nodes: { Current: {
      body: [
        { kind: 'input', id: 'amount', type: { kind: 'concrete', types: ['INT'] }, default: 7 },
        { kind: 'input', id: 'format', type: { kind: 'concrete', types: ['COMBO'] },
          widget: { type: 'COMBO', options: ['mp4_h264', 'webm_av1'] }, default: 'mp4_h264' },
      ],
      replacements: [{ from: 'Previous', cases: [{ to: 'Current', inputs: {
        amount: { kind: 'copy', input: 'oldAmount' }, format: { kind: 'copy', input: 'format' },
      } }] }],
    } },
  } }))
  await page.goto('/')
  await waitForWorkspaceReady(page, 1)
}

async function openMigration(page: Page, lineage: string): Promise<void> {
  expect(await page.evaluate(async (lineage) => (await window.__dinksterTest!.app.openDocument({
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
  }, lineage)), lineage)).toEqual([])
  await expect.poll(() => page.evaluate(() => {
    const tab = window.__dinksterTest!.app.activeTab()
    return tab !== undefined && 'status' in tab.store
  })).toBe(true)
  await expect.poll(() => page.evaluate(() => window.__dinksterTest!.renderer!.getScene().nodes.length)).toBe(2)
  await page.evaluate(() => window.__dinksterTest!.renderer!.setViewport({ x: 0, y: 0, scale: 1 }))
}

const noticeTitle = (page: Page) => page.getByTestId('fixes-notice').locator('.dinkster-fixes-title')

test('open-time lossy upgrades show one notice on the canvas that navigates and undoes together', async ({ page }, testInfo) => {
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
  const notice = page.getByTestId('fixes-notice')
  await expect(noticeTitle(page)).toHaveText('2 things were adjusted')
  // The notice is in the canvas's bottom right corner.
  expect(await page.evaluate(() => {
    const canvas = document.querySelector('[data-testid=graph-canvas]')!.getBoundingClientRect()
    const line = document.querySelector('[data-testid=fixes-notice] .dinkster-fixes-line')!.getBoundingClientRect()
    return line.right <= canvas.right && line.right > canvas.right - 40 && line.bottom > canvas.top + canvas.height / 2
  })).toBe(true)
  await openRailPanel(page, 'Problems')
  await expect(page.getByTestId('problems-panel')).not.toContainText('Workflow upgraded')
  await expect(page.getByTestId('problems-panel')).not.toContainText('Upgraded on open')
  await notice.getByRole('button', { name: 'Review', exact: true }).click()
  const rows = notice.locator('.dinkster-fixes-review-row')
  await expect(rows).toHaveCount(2)
  await expect(notice).toContainText('replaced older node')
  await expect(notice).toContainText('will be removed')
  await rows.first().click()
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
  await page.screenshot({ path: testInfo.outputPath('fixes-notice-review.png') })
  await page.keyboard.press('Escape')
  await notice.getByRole('button', { name: 'Undo', exact: true }).click()
  await expect(noticeTitle(page)).toHaveText('Adjustments undone')
  expect(await page.evaluate(() => {
    const tab = window.__dinksterTest!.app.activeTab()!
    const graph = tab.store.doc.graphs.g0!
    return { types: Object.values(graph.nodes).map((node) => node.type), values: graph.nodes.first!.values,
      dynamic: graph.nodes.first!.dynamic, link: graph.links.lost }
  })).toEqual({ types: ['Previous', 'Previous'], values: { oldAmount: 11 }, dynamic: { format: { selected: 'webm_av1' } },
    link: { id: 'lost', from: { node: 'first', port: 'discarded' }, to: { node: 'second', port: 'unmapped' } } })
  // Undo must not introduce default-mode manual approval controls.
  expect(await page.evaluate(() => Object.values(window.__dinksterTest!.renderer!.getBadges())
    .flatMap((badges) => badges.map((badge) => badge.id)))).not.toContain('core.deprecated')
  await expect(page.getByTestId('badge-apply-replacement')).toHaveCount(0)
  await notice.getByRole('button', { name: 'Redo adjustments', exact: true }).click()
  await expect(noticeTitle(page)).toHaveText('2 things were adjusted')
  expect(await page.evaluate(() => Object.values(window.__dinksterTest!.app.activeTab()!.store.doc.graphs.g0!.nodes).map((node) => node.type)))
    .toEqual(['Current', 'Current'])
})

test('twelve changes on open are grouped in Review and one Undo takes all twelve back', async ({ page }, testInfo) => {
  await migrationCatalog(page)
  expect(await page.evaluate(async () => (await window.__dinksterTest!.app.openDocument({
    format: 'dinkster-workflow', formatVersion: 1, lineage: 'twelve-migrations', root: 'g0',
    graphs: { g0: { id: 'g0', name: 'root', nextOrdinal: 13, nets: {}, reroutes: {}, links: {},
      nodes: Object.fromEntries(Array.from({ length: 12 }, (_, index) => [`n${index + 1}`,
        { id: `n${index + 1}`, type: 'Previous', title: `Old node ${index + 1}`, values: { oldAmount: index } }])),
    } },
    view: { graphs: { g0: { nodes: Object.fromEntries(Array.from({ length: 12 }, (_, index) => [`n${index + 1}`,
      { position: { x: 60 + (index % 4) * 260, y: 60 + Math.floor(index / 4) * 160 } }])) } } },
  }, 'Twelve migrations')))).toEqual([])
  const notice = page.getByTestId('fixes-notice')
  await expect(noticeTitle(page)).toHaveText('12 things were adjusted')
  await notice.getByRole('button', { name: 'Review', exact: true }).click()
  await expect(notice.locator('.dinkster-fixes-review-kind')).toHaveText(['Nodes replaced by newer ones (12)'])
  await expect(notice.locator('.dinkster-fixes-review-row')).toHaveCount(12)
  await notice.locator('.dinkster-fixes-review-row').nth(5).click()
  await expect(page.getByTestId('graph-canvas')).toHaveAttribute('data-selection', '1')
  await page.screenshot({ path: testInfo.outputPath('fixes-notice-twelve.png') })
  const undoDepth = () => page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.historySnapshot().undo.length)
  const before = await undoDepth()
  await notice.getByRole('button', { name: 'Undo', exact: true }).click()
  const types = () => page.evaluate(() => Object.values(window.__dinksterTest!.app.activeTab()!.store.doc.graphs.g0!.nodes).map((node) => node.type))
  expect(await types()).toEqual(Array(12).fill('Previous'))
  expect(await undoDepth()).toBe(before + 1)
  await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.undo())
  expect(await types()).toEqual(Array(12).fill('Current'))
})

test('the notice dismisses to a status bar count that brings it back, clears on save or close, and never persists', async ({ page }, testInfo) => {
  await migrationCatalog(page)
  await openMigration(page, 'dismiss-migration')
  const notice = page.getByTestId('fixes-notice')
  const count = page.getByTestId('status-adjusted')
  await expect(count).toHaveCount(0)
  await notice.getByRole('button', { name: 'Dismiss', exact: true }).click()
  await expect(notice).toHaveCount(0)
  await expect(count).toHaveText('2 adjusted')
  await page.screenshot({ path: testInfo.outputPath('fixes-notice-count.png') })
  await count.getByRole('button').click()
  await expect(notice.locator('.dinkster-fixes-review')).toBeVisible()
  await openMigration(page, 'save-migration')
  await expect(notice).toHaveCount(1)
  // Each workflow tab has its own notice and count.
  await expect(count).toHaveCount(0)
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
  await expect(count).toHaveCount(0)
  expect(JSON.parse(uploaded).graphs.g0.nodes.first).toEqual({
    id: 'first', type: 'Current', values: { amount: 11, format: 'webm_av1' },
  })
  expect(uploaded).not.toContain('replaced older node')
  expect(uploaded).not.toContain('will be removed')
  expect(await page.evaluate(async (saved) => (await window.__dinksterTest!.app.openDocument(JSON.parse(saved), 'Saved migration')), uploaded)).toEqual([])
  await expect(notice).toHaveCount(0)
  await expect(count).toHaveCount(0)
  await openMigration(page, 'close-migration')
  await expect(notice).toHaveCount(1)
  const closed = await page.evaluate(() => {
    const app = window.__dinksterTest!.app
    const id = app.activeTab()!.id
    app.closeTab(id)
    return id
  })
  await expect(notice).toHaveCount(0)
  expect(await page.evaluate((id) => window.__dinksterTest!.app.adjustmentNotices.get().has(id), closed)).toBe(false)
})

test('deprecated resize imports its authored size and undoes from the notice', async ({ page }, testInfo) => {
  await page.route('/api/nodes*', (route) => route.fulfill({ json: {
    schemaVersion: 1, epoch: 1, dinkster: { version: 'resize-migration-fixture', schemaWire: 2 },
    nodes: { ImageScaleToMaxDimension: {
      displayName: 'Scale image to maximum dimension', category: 'image',
      body: [
        { kind: 'input', id: 'image', type: { kind: 'concrete', types: ['IMAGE'] } },
        { kind: 'input', id: 'largest_size', type: { kind: 'concrete', types: ['INT'] }, default: 512, widget: { type: 'INT' } },
        { kind: 'input', id: 'upscale_method', type: { kind: 'concrete', types: ['COMBO'] }, default: 'nearest-exact', widget: { type: 'COMBO', options: ['nearest-exact', 'lanczos'] } },
        { kind: 'output', id: 'IMAGE', type: { kind: 'concrete', types: ['IMAGE'] } },
      ],
      replacements: [{ from: 'ResizeImagesByLongerEdge', cases: [{ to: 'ImageScaleToMaxDimension',
        inputs: { image: { kind: 'copy', input: 'images' }, largest_size: { kind: 'copy', input: 'longer_edge' },
          upscale_method: { kind: 'constant', value: 'lanczos' } }, outputs: { IMAGE: 'images' },
      }] }],
    } },
  } }))
  await page.goto('/')
  await waitForWorkspaceReady(page, 1)
  expect(await page.evaluate(async () => (await window.__dinksterTest!.app.openDocument({
    nodes: [{ id: 1, type: 'ResizeImagesByLongerEdge', pos: [170, 140],
      properties: { ver: '0.5.1' }, widgets_values: [1536],
      inputs: [{ name: 'images' }, { name: 'longer_edge', widget: { name: 'longer_edge' } }],
      outputs: [{ name: 'images' }],
    }], links: [],
  }, 'Imported resize')))).toEqual([])
  await expect.poll(() => page.evaluate(() => window.__dinksterTest!.renderer!.getScene().nodes.map((node) => node.id)))
    .toEqual(['n1'])
  await page.evaluate(() => window.__dinksterTest!.renderer!.setViewport({ x: 0, y: 0, scale: 1 }))
  expect(await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.doc.graphs.g0!.nodes.n1!.values))
    .toEqual({ largest_size: 1536, upscale_method: 'lanczos' })
  const notice = page.getByTestId('fixes-notice')
  await notice.getByRole('button', { name: 'Review', exact: true }).click()
  await expect(notice).toContainText('Scale image to maximum dimension')
  await expect(notice).toContainText('replaced older node')
  await page.screenshot({ path: testInfo.outputPath('resize-import-migrated.png') })
  await notice.getByRole('button', { name: 'Undo', exact: true }).click()
  await expect(noticeTitle(page)).toHaveText('Adjustments undone')
  expect(await page.evaluate(() => {
    const tab = window.__dinksterTest!.app.activeTab()!
    return { type: tab.store.doc.graphs.g0!.nodes.n1!.type, values: tab.store.doc.graphs.g0!.nodes.n1!.values }
  })).toEqual({ type: 'ResizeImagesByLongerEdge', values: { longer_edge: 1536 } })
  await expect.poll(() => page.evaluate(() => window.__dinksterTest!.renderer!.getScene().nodes[0]?.unrecognized))
    .toBe(true)
  await page.screenshot({ path: testInfo.outputPath('resize-import-undone.png') })
})

test('only opt-in review holds a lossy migration for badge Apply', async ({ page }, testInfo) => {
  await page.route(/\/api\//, (route) => route.fulfill({ status: 503, json: {} }))
  await page.routeWebSocket('**/api/events?*', () => {})
  await migrationCatalog(page)
  await page.evaluate(() => window.__dinksterTest!.app.settings.set('execution.reviewUpgrades', true))
  await openMigration(page, 'review-migration')
  expect(await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.doc.graphs.g0!.nodes.first!.type)).toBe('Previous')
  await expect(page.getByTestId('fixes-notice')).toHaveCount(0)
  const point = await badgePoint(page, 'first')
  await page.mouse.click(point.x, point.y)
  const popover = page.getByTestId('badge-popover')
  await expect(popover).toBeVisible()
  await expect(popover).toContainText('will be removed')
  const apply = popover.getByRole('button', { name: 'Apply replacement', exact: true })
  await expect(apply).toBeEnabled()
  await page.screenshot({ path: testInfo.outputPath('migration-review.png') })
  await page.evaluate(() => {
    const app = window.__dinksterTest!.app as any
    const dispatch = app.dispatchTo.bind(app)
    ;(window as any).__replacementCalls = 0
    app.dispatchTo = (tab: any, invocation: any) => new Promise((resolve) => {
      ;(window as any).__replacementCalls++
      ;(window as any).__completeReplacement = (accepted: boolean) => resolve(accepted
        ? dispatch(tab, invocation) : { ok: false, diagnostics: [] })
    })
  })
  await apply.click()
  await page.evaluate(async () => {
    ;(window.__dinksterTest!.app as any).backendsTick.update((value: number) => value + 1)
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
  })
  await apply.click()
  expect(await page.evaluate(() => (window as any).__replacementCalls)).toBe(1)
  expect(await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.doc.graphs.g0!.nodes.first!.type)).toBe('Previous')
  await expect(popover).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('migration-review-pending.png') })
  await page.evaluate(() => (window as any).__completeReplacement(false))
  await expect(popover).toBeVisible()
  expect(await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.doc.graphs.g0!.nodes.first!.type)).toBe('Previous')
  await page.screenshot({ path: testInfo.outputPath('migration-review-refused.png') })
  await apply.click()
  expect(await page.evaluate(() => (window as any).__replacementCalls)).toBe(2)
  await page.evaluate(() => (window as any).__completeReplacement(true))
  await expect(popover).toHaveCount(0)
  expect(await page.evaluate(() => {
    const graph = window.__dinksterTest!.app.activeTab()!.store.doc.graphs.g0!
    return { first: graph.nodes.first, secondType: graph.nodes.second!.type, links: graph.links }
  })).toEqual({ first: { id: 'first', type: 'Current', values: { amount: 11, format: 'webm_av1' } },
    secondType: 'Previous', links: {} })
  await page.screenshot({ path: testInfo.outputPath('migration-review-accepted.png') })
  await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.undo())
  expect(await page.evaluate(() => {
    const tab = window.__dinksterTest!.app.activeTab()!
    return { type: tab.store.doc.graphs.g0!.nodes.first!.type, linkCount: Object.keys(tab.store.doc.graphs.g0!.links).length, canUndo: tab.store.canUndo }
  })).toEqual({ type: 'Previous', linkCount: 1, canUndo: false })

  const firstPoint = await badgePoint(page, 'first')
  await page.mouse.click(firstPoint.x, firstPoint.y)
  await expect(popover).toContainText('Deprecated: Previous')
  await apply.click()
  await page.keyboard.press('Escape')
  const secondPoint = await badgePoint(page, 'second')
  await page.mouse.click(secondPoint.x, secondPoint.y)
  await expect(popover).toBeVisible()
  await page.evaluate(() => (window as any).__completeReplacement(false))
  await expect(popover).toBeVisible()
  expect(await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.doc.graphs.g0!.nodes.second!.type)).toBe('Previous')
  await apply.click()
  expect(await page.evaluate(() => (window as any).__replacementCalls)).toBe(4)
  await page.evaluate(() => (window as any).__completeReplacement(false))
  await expect(popover).toBeVisible()
})
