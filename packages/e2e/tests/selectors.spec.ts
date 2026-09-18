/**
 * Selector suite: first-class N-to-1 branch controls on the canvas. Real
 * pointer input against the live app; document assertions go through the
 * __dinksterTest bridge. Proves the box is NOT a node (independent selection),
 * that moves/links/policy edits ride the normal command path, that every
 * candidate noodle stays visible, and that mixed branch types color their
 * own pins while the output stays wildcard.
 *
 * Fixture: s6 fixed 'Quality' (c7 'full' from n0, c8 via reroute r5 from n1,
 * output fanning out to n2+n3) and s9 random (c10 IMAGE from n0, c11 LATENT
 * from n4).
 */
import { readFileSync } from 'node:fs'
import { expect, test, type Page } from './fixtures.js'

const fixture = JSON.parse(
  readFileSync(new URL('../../core/fixtures/workflows/selector.json', import.meta.url), 'utf8'),
) as unknown

const xy = (p: { x: number; y: number }): [number, number] => [p.x, p.y]

/** Reset the viewport to identity so world coords == canvas CSS pixels. */
async function identityViewport(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.__dinksterTest!.renderer!.setViewport({ x: 0, y: 0, scale: 1 })
  })
}

/** Page coordinates of a feature of a selector box (identity viewport).
 * Badge geometry mirrors selectorBadgeRect(): 14px square, 6px inset. */
async function pointOnSelector(
  page: Page,
  id: string,
  part: 'body' | 'out' | 'badge' | { candidate: string },
): Promise<{ x: number; y: number }> {
  return page.evaluate(
    ({ id, part }) => {
      const r = window.__dinksterTest!.renderer!
      const vp = r.getViewport()
      const sel = r.getScene().selectors.find((s) => s.id === id)
      if (!sel) throw new Error(`no scene selector '${id}'`)
      const rect = document.querySelector('[data-testid=graph-canvas]')!.getBoundingClientRect()
      const toPage = (wx: number, wy: number) => ({
        x: rect.left + wx * vp.scale + vp.x,
        y: rect.top + wy * vp.scale + vp.y,
      })
      if (typeof part === 'object') {
        const c = sel.candidates.find((cand) => cand.id === part.candidate)
        if (!c) throw new Error(`no candidate '${part.candidate}' on '${id}'`)
        return toPage(sel.x, sel.y + c.y)
      }
      switch (part) {
        case 'out':
          return toPage(sel.x + sel.width, sel.y + sel.headerHeight / 2)
        case 'badge':
          return toPage(sel.x + sel.width - 6 - 14 / 2, sel.y + sel.headerHeight / 2)
        case 'body':
          // Left third of the header band: clear of the badge and both pin edges.
          return toPage(sel.x + sel.width / 3, sel.y + sel.headerHeight / 2)
      }
    },
    { id, part },
  )
}

/** Page coordinates of a node pin center (assumes identity viewport). */
async function pinPoint(page: Page, nodeId: string, portId: string, direction: 'in' | 'out'): Promise<{ x: number; y: number }> {
  return page.evaluate(
    ({ nodeId, portId, direction }) => {
      const r = window.__dinksterTest!.renderer!
      const vp = r.getViewport()
      const node = r.getScene().nodes.find((n) => n.id === nodeId)
      if (!node) throw new Error(`no scene node '${nodeId}'`)
      const pin = node.layout.pins.find((p) => p.portId === portId && p.direction === direction)
      if (!pin) throw new Error(`no pin '${direction}:${portId}' on '${nodeId}'`)
      const rect = document.querySelector('[data-testid=graph-canvas]')!.getBoundingClientRect()
      const wx = direction === 'in' ? node.x : node.x + node.layout.width
      return { x: rect.left + wx * vp.scale + vp.x, y: rect.top + (node.y + pin.y) * vp.scale + vp.y }
    },
    { nodeId, portId, direction },
  )
}

async function drag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }): Promise<void> {
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2)
  await page.mouse.move(to.x, to.y)
  await page.mouse.up()
}

const activeDoc = (page: Page) => page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.doc)

const rootGraph = async (page: Page) => (await activeDoc(page)).graphs['g0']!

const menuItem = (page: Page, id: string) => page.locator(`[data-item-id="${id}"]`)

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('.conn-status')).toHaveText('connected', { timeout: 15_000 })
  await expect(page.getByTestId('status-bar')).toContainText(/\d+ node schemas/, { timeout: 15_000 })
  const failures = await page.evaluate((json) => window.__dinksterTest!.app.openDocument(json, 'Selectors'), fixture)
  expect(failures).toEqual([])
  await page.waitForFunction(() => {
    const tab = window.__dinksterTest!.app.activeTab()
    return tab !== undefined && 'status' in tab.store &&
      (tab.store.status as { get(): string }).get() === 'live' &&
      tab.store.doc.lineage === 'lineage-sel'
  })
  await identityViewport(page)
})

test('fixture renders selectors as scene items, NOT nodes, with traced types and visible branch noodles', async ({ page }) => {
  const scene = await page.evaluate(() => {
    const s = window.__dinksterTest!.renderer!.getScene()
    return {
      nodeIds: s.nodes.map((n) => n.id).sort(),
      selectors: s.selectors,
      links: s.links.map((l) => ({ id: l.id, from: l.from, to: l.to })),
    }
  })
  // Selectors never leak into scene.nodes (they are not fake NodeData).
  expect(scene.nodeIds).toEqual(['n0', 'n1', 'n2', 'n3', 'n4'])
  expect(scene.selectors).toHaveLength(2)

  const s6 = scene.selectors.find((s) => s.id === 's6')!
  expect(s6.title).toBe('Quality')
  expect(s6.activeCandidate).toBe('c7')
  expect(s6.random).toBe(false)
  // Homogeneous IMAGE branches agree, so the output is concrete.
  expect(s6.typeName).toBe('IMAGE')
  expect(s6.candidates.map((c) => ({ label: c.label, typeName: c.typeName }))).toEqual([
    { label: 'full', typeName: 'IMAGE' },
    { label: '2', typeName: 'IMAGE' },
  ])

  const s9 = scene.selectors.find((s) => s.id === 's9')!
  expect(s9.random).toBe(true)
  // Mixed IMAGE/LATENT branches keep their own colors; the output stays open.
  expect(s9.typeName).toBeUndefined()
  expect(s9.candidates.map((c) => c.typeName)).toEqual(['IMAGE', 'LATENT'])

  // EVERY candidate noodle renders - unselected branches are visible too.
  expect(scene.links.find((l) => l.id === 'l12')?.to).toEqual({ kind: 'selector', selector: 's6', candidate: 'c7' })
  expect(scene.links.find((l) => l.id === 'l14')?.to).toEqual({ kind: 'selector', selector: 's6', candidate: 'c8' })
  expect(scene.links.find((l) => l.id === 'l18')?.to).toEqual({ kind: 'selector', selector: 's9', candidate: 'c11' })
  // The output fans out to both consumers from the same pin.
  expect(scene.links.find((l) => l.id === 'l15')?.from).toEqual({ kind: 'selector', selector: 's6' })
  expect(scene.links.find((l) => l.id === 'l16')?.from).toEqual({ kind: 'selector', selector: 's6' })
})

test('selector selection is independent of node selection; Delete cascades links; undo restores', async ({ page }) => {
  const canvas = page.getByTestId('graph-canvas')
  await page.mouse.click(...xy(await pointOnSelector(page, 's6', 'body')))
  await expect(canvas).toHaveAttribute('data-selector-selection', '1')
  // data-selection totals every selected citizen; the selector-specific
  // attribute pins that this one selected citizen is not a node.
  await expect(canvas).toHaveAttribute('data-selection', '1')

  // Selecting a node replaces the selector selection.
  const n0 = await page.evaluate(() => {
    const r = window.__dinksterTest!.renderer!
    const node = r.getScene().nodes.find((n) => n.id === 'n0')!
    const rect = document.querySelector('[data-testid=graph-canvas]')!.getBoundingClientRect()
    return { x: rect.left + node.x + node.layout.width / 2, y: rect.top + node.y + node.layout.headerHeight / 2 }
  })
  await page.mouse.click(n0.x, n0.y)
  await expect(canvas).toHaveAttribute('data-selection', '1')
  await expect(canvas).toHaveAttribute('data-selector-selection', '0')

  // Re-select the box and Delete: the selector AND every touching link go.
  await page.mouse.click(...xy(await pointOnSelector(page, 's6', 'body')))
  await expect(canvas).toHaveAttribute('data-selector-selection', '1')
  await page.keyboard.press('Delete')

  const g = await rootGraph(page)
  expect(g.selectors?.['s6']).toBeUndefined()
  expect(g.links['l12']).toBeUndefined() // branch feed
  expect(g.links['l14']).toBeUndefined() // reroute -> branch feed
  expect(g.links['l15']).toBeUndefined() // output fan-out
  expect(g.links['l16']).toBeUndefined()
  expect(g.links['l13']).toBeDefined() // n1 -> reroute survives (undriven junction)
  expect(g.reroutes['r5']).toBeDefined()
  expect(g.selectors?.['s9']).toBeDefined() // the other selector is untouched
  expect(g.links['l17']).toBeDefined()

  await page.keyboard.press('Control+z')
  const restored = await rootGraph(page)
  expect(restored.selectors?.['s6']?.title).toBe('Quality')
  expect(restored.links['l12']).toBeDefined()
  expect(restored.links['l15']).toBeDefined()
})

test('dragging the box commits ONE selector.move; undo/redo restore the position', async ({ page }) => {
  const start = await pointOnSelector(page, 's6', 'body')
  await drag(page, start, { x: start.x + 60, y: start.y + 40 })

  const moved = await activeDoc(page)
  expect(moved.view.graphs['g0']!.selectors!['s6']!.position).toEqual({ x: 500, y: 180 })

  await page.keyboard.press('Control+z')
  const undone = await activeDoc(page)
  expect(undone.view.graphs['g0']!.selectors!['s6']!.position).toEqual({ x: 440, y: 140 })

  await page.keyboard.press('Control+Shift+z')
  const redone = await activeDoc(page)
  expect(redone.view.graphs['g0']!.selectors!['s6']!.position).toEqual({ x: 500, y: 180 })
})

test('the policy badge opens the menu; fixed candidate and random commit selector.setPolicy', async ({ page }) => {
  await page.mouse.click(...xy(await pointOnSelector(page, 's6', 'badge')))
  await expect(menuItem(page, 'core.selector.policy.fixed.c8')).toBeVisible()
  await menuItem(page, 'core.selector.policy.fixed.c8').click()
  expect((await rootGraph(page)).selectors!['s6']!.policy).toEqual({ kind: 'fixed', candidate: 'c8' })

  await page.mouse.click(...xy(await pointOnSelector(page, 's6', 'badge')))
  await menuItem(page, 'core.selector.policy.random').click()
  expect((await rootGraph(page)).selectors!['s6']!.policy).toEqual({ kind: 'random' })

  // The scene reflects the policy: no active candidate under random.
  const sel = await page.evaluate(() => window.__dinksterTest!.renderer!.getScene().selectors.find((s) => s.id === 's6'))
  expect(sel!.random).toBe(true)
  expect(sel!.activeCandidate).toBeUndefined()
})

test('Add Branch appends a candidate; a fresh producer connects into it; Remove Branch deletes it', async ({ page }) => {
  await page.mouse.click(...xy(await pointOnSelector(page, 's6', 'body')), { button: 'right' })
  await expect(menuItem(page, 'core.selector.addCandidate')).toBeVisible()
  await menuItem(page, 'core.selector.addCandidate').click()

  const grown = (await rootGraph(page)).selectors!['s6']!
  expect(grown.candidates).toHaveLength(3)
  const newId = grown.candidates[2]!.id

  // The new branch renders an empty (wildcard) pin; n1's output accepts it.
  await drag(page, await pinPoint(page, 'n1', 'out0', 'out'), await pointOnSelector(page, 's6', { candidate: newId }))
  const g = await rootGraph(page)
  const feed = Object.values(g.links).find((l) => 'selector' in l.to && l.to.candidate === newId)
  expect(feed).toBeDefined()
  expect(feed!.from).toEqual({ node: 'n1', port: 'out0' })

  // Removing the branch cascades its feed link.
  await page.mouse.click(...xy(await pointOnSelector(page, 's6', 'body')), { button: 'right' })
  await menuItem(page, `core.selector.removeCandidate.${newId}`).click()
  const shrunk = await rootGraph(page)
  expect(shrunk.selectors!['s6']!.candidates).toHaveLength(2)
  expect(Object.values(shrunk.links).some((l) => 'selector' in l.to && l.to.candidate === newId)).toBe(false)
})

test('grabbing an occupied candidate pin rewires its feed to another branch; space detaches', async ({ page }) => {
  // Grow a free third branch to rewire into.
  await page.mouse.click(...xy(await pointOnSelector(page, 's6', 'body')), { button: 'right' })
  await menuItem(page, 'core.selector.addCandidate').click()
  const newId = (await rootGraph(page)).selectors!['s6']!.candidates[2]!.id

  // c7 is fed by n0.out0 (l12). Grabbing the branch pin grabs that link's
  // input end (the driver stays fixed); dropping on the free branch rewires.
  await drag(page, await pointOnSelector(page, 's6', { candidate: 'c7' }), await pointOnSelector(page, 's6', { candidate: newId }))
  const g = await rootGraph(page)
  expect(g.links['l12']!.from).toEqual({ node: 'n0', port: 'out0' })
  expect(g.links['l12']!.to).toEqual({ selector: 's6', candidate: newId })

  // Grabbing the rewired feed and dropping in empty space detaches it.
  await drag(page, await pointOnSelector(page, 's6', { candidate: newId }), { x: 900, y: 780 })
  const detached = await rootGraph(page)
  expect(detached.links['l12']).toBeUndefined()

  await page.keyboard.press('Control+z')
  const restored = await rootGraph(page)
  expect(restored.links['l12']!.to).toEqual({ selector: 's6', candidate: newId })
})

test('rename via the context menu prompt commits selector.setTitle', async ({ page }) => {
  await page.mouse.click(...xy(await pointOnSelector(page, 's6', 'body')), { button: 'right' })
  await expect(menuItem(page, 'core.selector.rename')).toBeVisible()
  await menuItem(page, 'core.selector.rename').click()

  const input = page.getByTestId('selector-prompt-input')
  await expect(input).toBeVisible()
  await expect(input).toHaveValue('Quality')
  await input.fill('Branch Picker')
  await page.keyboard.press('Enter')

  await expect(input).not.toBeVisible()
  await expect.poll(async () => (await rootGraph(page)).selectors!['s6']!.title).toBe('Branch Picker')
  const sel = await page.evaluate(() => window.__dinksterTest!.renderer!.getScene().selectors.find((s) => s.id === 's6'))
  expect(sel!.title).toBe('Branch Picker')

  // Escape dismisses without committing.
  await page.mouse.click(...xy(await pointOnSelector(page, 's6', 'body')), { button: 'right' })
  await menuItem(page, 'core.selector.rename').click()
  const cancelInput = page.getByTestId('selector-prompt-input')
  await expect(cancelInput).toBeVisible()
  await cancelInput.fill('nope')
  await page.keyboard.press('Escape')
  await expect(cancelInput).not.toBeVisible()
  expect((await rootGraph(page)).selectors!['s6']!.title).toBe('Branch Picker')
})

test('canvas menu adds a selector at the cursor; its wildcard output connects to a free input', async ({ page }) => {
  // Empty world space clear of the corner minimap (which owns bottom-right
  // pointer events): the added selector's out pin must stay clickable.
  await page.mouse.click(650, 780, { button: 'right' })
  await expect(menuItem(page, 'core.canvas.addSelector')).toBeVisible()
  await menuItem(page, 'core.canvas.addSelector').click()

  const g = await rootGraph(page)
  const added = Object.values(g.selectors ?? {}).find((s) => s.id !== 's6' && s.id !== 's9')
  expect(added).toBeDefined()
  // Fresh selectors start with two empty branches, fixed on the first.
  expect(added!.candidates).toHaveLength(2)
  expect(added!.policy).toEqual({ kind: 'fixed', candidate: added!.candidates[0]!.id })

  // Undriven branches leave the output wildcard: it accepts ANY free input.
  await drag(page, await pointOnSelector(page, added!.id, 'out'), await pinPoint(page, 'n4', 'width', 'in'))
  const linked = await rootGraph(page)
  const link = Object.values(linked.links).find((l) => 'selector' in l.from && l.from.selector === added!.id)
  expect(link).toBeDefined()
  expect(link!.to).toEqual({ node: 'n4', port: 'width' })

  // Undo unwinds each step: the link, then the selector itself.
  await page.keyboard.press('Control+z')
  await page.keyboard.press('Control+z')
  const undone = await rootGraph(page)
  expect(undone.selectors?.[added!.id]).toBeUndefined()
})

// ---------------------------------------------------------------------------
// Partial-execution scope + frozen execution resolution
// ---------------------------------------------------------------------------

/** Structured scope highlight snapshot from the renderer (or null). */
const scopeHighlight = (page: Page) =>
  page.evaluate(() => {
    const s = window.__dinksterTest!.renderer!.getScopeHighlight()
    if (!s) return null
    return {
      nodes: [...s.nodes].sort(),
      reroutes: [...s.reroutes].sort(),
      selectors: [...s.selectors].sort(),
      candidates: [...s.selectorCandidates].sort(),
      valueSources: [...s.valueSources].sort(),
    }
  })

const hoverQueueUpToHere = async (page: Page) => {
  const point = await page.evaluate(() => {
    const layout = window.__dinksterTest!.renderer!.getToolboxLayout()!
    const button = layout.buttons.find((entry) => entry.button.id === 'core.queueUpToHere')!
    const viewport = window.__dinksterTest!.renderer!.getViewport()
    const rect = document.querySelector<HTMLCanvasElement>('[data-testid="graph-canvas"]')!.getBoundingClientRect()
    return {
      x: rect.left + (button.x + button.size / 2) * viewport.scale + viewport.x,
      y: rect.top + (button.y + button.size / 2) * viewport.scale + viewport.y,
    }
  })
  await page.mouse.move(point.x, point.y)
}

test('partial-scope preview lights ONLY the chosen branch: selector, candidate, reroute membership', async ({ page }) => {
  // s6 is fixed on c7 (fed by n0); c8 is fed by n1 THROUGH reroute r5.
  await page.evaluate(() => window.__dinksterTest!.controller!.setSelection(['n2']))
  await hoverQueueUpToHere(page)
  await expect.poll(() => scopeHighlight(page)).toEqual({
    nodes: ['n0', 'n2'],
    reroutes: [],
    selectors: ['s6'],
    candidates: [JSON.stringify(['s6', 'c7'])],
    valueSources: [],
  })

  // Flip the fixed policy to c8: the closure follows the reroute-fed branch.
  await page.evaluate(() => window.__dinksterTest!.controller!.setSelection([]))
  await expect.poll(() => scopeHighlight(page)).toBeNull()
  await page.mouse.click(...xy(await pointOnSelector(page, 's6', 'badge')))
  await menuItem(page, 'core.selector.policy.fixed.c8').click()
  await page.evaluate(() => window.__dinksterTest!.controller!.setSelection(['n2']))
  await hoverQueueUpToHere(page)
  await expect.poll(() => scopeHighlight(page)).toEqual({
    nodes: ['n1', 'n2'],
    reroutes: ['r5'],
    selectors: ['s6'],
    candidates: [JSON.stringify(['s6', 'c8'])],
    valueSources: [],
  })

  // Random policy: the preview is a MAY-RUN superset - every branch lights.
  await page.evaluate(() => window.__dinksterTest!.controller!.setSelection([]))
  await page.mouse.click(...xy(await pointOnSelector(page, 's6', 'badge')))
  await menuItem(page, 'core.selector.policy.random').click()
  await page.evaluate(() => window.__dinksterTest!.controller!.setSelection(['n2']))
  await hoverQueueUpToHere(page)
  await expect.poll(() => scopeHighlight(page)).toEqual({
    nodes: ['n0', 'n1', 'n2'],
    reroutes: ['r5'],
    selectors: ['s6'],
    candidates: [JSON.stringify(['s6', 'c7']), JSON.stringify(['s6', 'c8'])].sort(),
    valueSources: [],
  })
})

test('a frozen view shows the EXACT recorded selector resolution; the badge popover is read-only', async ({ page }) => {
  // Queue the fixture (s6 fixed c7, s9 random) and wait for completion.
  await expect(page.getByTestId('queue-button')).toBeEnabled({ timeout: 15_000 })
  await page.getByTestId('queue-button').click()
  const row = page.getByTestId('execution-row').first()
  await expect(row).toBeVisible({ timeout: 10_000 })
  await expect(row.locator('.execution-status')).toHaveText('Completed', { timeout: 30_000 })

  // The artifact recorded BOTH policies' outcomes.
  const choices = await page.evaluate(() => {
    const execs = [...window.__dinksterTest!.app.store.executions.get().values()]
    const latest = execs.sort((a, b) => b.queuedAt - a.queuedAt)[0]!
    return [...(latest.artifact?.choices ?? [])]
  })
  const fixedChoice = choices.find((c) => c.selector === 's6')!
  const randomChoice = choices.find((c) => c.selector === 's9')!
  expect(fixedChoice).toMatchObject({ policy: 'fixed', candidate: 'c7' })
  expect(randomChoice.policy).toBe('random')
  expect(['c10', 'c11']).toContain(randomChoice.candidate)

  // The LIVE tab never shows execution resolutions (its policy badge already
  // tells the truth about the NEXT run).
  expect(
    await page.evaluate(() => window.__dinksterTest!.renderer!.getSelectorResolutions() ?? null),
  ).toBeNull()

  // Open the frozen view: the renderer receives the recorded resolutions.
  await row.locator('.execution-open').click()
  await expect(page.getByTestId('frozen-banner')).toBeVisible()
  await expect
    .poll(() =>
      page.evaluate(() => {
        const m = window.__dinksterTest!.renderer!.getSelectorResolutions()
        return m ? Object.fromEntries(m) : null
      }),
    )
    .toEqual({ s6: 'c7', s9: randomChoice.candidate })

  // Badge click on the RANDOM selector opens the read-only resolution
  // popover, showing the exact branch this execution took.
  await identityViewport(page)
  await page.mouse.click(...xy(await pointOnSelector(page, 's9', 'badge')))
  const popover = page.getByTestId('selector-exec-popover')
  await expect(popover).toBeVisible()
  const line = popover.getByTestId('selector-exec-choice')
  await expect(line).toHaveAttribute('data-policy', 'random')
  await expect(line).toHaveAttribute('data-candidate', randomChoice.candidate)
  await expect(line).toContainText('Random pick')
  // No policy menu on a frozen tab: the document is not editable.
  await expect(page.getByTestId('context-menu')).not.toBeVisible()

  // The FIXED selector's popover names its titled candidate.
  await page.mouse.click(...xy(await pointOnSelector(page, 's6', 'badge')))
  await expect(popover).toBeVisible()
  await expect(popover).toContainText('Selector: Quality')
  await expect(popover.getByTestId('selector-exec-choice')).toContainText('Fixed pick: full')

  // Back on the live tab the badge opens the normal policy menu again.
  await page.getByTestId('frozen-go-live').click()
  await identityViewport(page)
  await page.mouse.click(...xy(await pointOnSelector(page, 's6', 'badge')))
  await expect(menuItem(page, 'core.selector.policy.random')).toBeVisible()
  await expect(page.getByTestId('selector-exec-popover')).not.toBeVisible()
})
