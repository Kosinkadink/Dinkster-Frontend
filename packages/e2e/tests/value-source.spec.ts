/**
 * Value-source suite: the declared-spec-first literal producer replacing the
 * legacy frontend PrimitiveNode. Real pointer input against the live app;
 * document assertions go through the __dinksterTest bridge. Proves the pill is
 * NOT a node (independent selection), that its links/moves/edits ride the
 * normal command path, that spec pin/unpin never resets the value, that the
 * raw JSON fallback cannot corrupt state, and that frozen tabs stay read-only.
 */
import { readFileSync } from 'node:fs'
import { expect, test, type Page } from './fixtures.js'

const fixture = JSON.parse(
  readFileSync(new URL('../../core/fixtures/workflows/value-source.json', import.meta.url), 'utf8'),
) as unknown

const xy = (p: { x: number; y: number }): [number, number] => [p.x, p.y]

/** Reset the viewport to identity so world coords == canvas CSS pixels. */
async function identityViewport(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.__dinksterTest!.renderer!.setViewport({ x: 0, y: 0, scale: 1 })
  })
}

/** Page coordinates of a feature of the value-source pill (identity viewport).
 * Badge geometry mirrors valueSourceBadgeRect(): 14px square, 6px inset. */
async function pointOnSource(page: Page, id: string, part: 'body' | 'pin' | 'badge'): Promise<{ x: number; y: number }> {
  return page.evaluate(
    ({ id, part }) => {
      const r = window.__dinksterTest!.renderer!
      const vp = r.getViewport()
      const vs = r.getScene().valueSources.find((v) => v.id === id)
      if (!vs) throw new Error(`no scene value source '${id}'`)
      const rect = document.querySelector('[data-testid=graph-canvas]')!.getBoundingClientRect()
      const toPage = (wx: number, wy: number) => ({
        x: rect.left + wx * vp.scale + vp.x,
        y: rect.top + wy * vp.scale + vp.y,
      })
      const cy = vs.y + vs.height / 2
      switch (part) {
        case 'pin':
          return toPage(vs.x + vs.width, cy)
        case 'badge':
          return toPage(vs.x + vs.width - 6 - 14 / 2, cy)
        case 'body':
          // Left third: clear of both the badge and the output pin.
          return toPage(vs.x + 14, cy)
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
  const failures = await page.evaluate((json) => window.__dinksterTest!.app.openDocument(json, 'Values'), fixture)
  expect(failures).toEqual([])
  await identityViewport(page)
  await page.waitForFunction(() => {
    const tab = window.__dinksterTest!.app.activeTab()
    return tab !== undefined && 'status' in tab.store
  })
})

test('fixture renders the pill as a value source, NOT a node, with a derived INT spec', async ({ page }) => {
  const scene = await page.evaluate(() => {
    const s = window.__dinksterTest!.renderer!.getScene()
    return {
      nodeIds: s.nodes.map((n) => n.id).sort(),
      valueSources: s.valueSources,
      linkFroms: s.links.map((l) => ({ id: l.id, from: l.from })),
    }
  })
  // The source never leaks into scene.nodes (it is not a fake NodeData).
  expect(scene.nodeIds).toEqual(['n0', 'n1'])
  expect(scene.valueSources).toHaveLength(1)
  const vs = scene.valueSources[0]!
  expect(vs.id).toBe('v2')
  expect(vs.valueText).toBe('128')
  // Both consumers (width, height) are INT widgets: derivation unifies them.
  expect(vs.specState).toBe('derived')
  expect(vs.conflict).toBe(false)
  expect(vs.typeName).toBe('INT')
  // Direct link and the reroute leg both originate at the source.
  expect(scene.linkFroms.find((l) => l.id === 'l4')?.from).toEqual({ kind: 'valueSource', valueSource: 'v2' })
  expect(scene.linkFroms.find((l) => l.id === 'l5')?.from).toEqual({ kind: 'valueSource', valueSource: 'v2' })
})

test('pill selection is independent of node selection; empty click clears both', async ({ page }) => {
  const canvas = page.getByTestId('graph-canvas')
  await page.mouse.click(...xy(await pointOnSource(page, 'v2', 'body')))
  await expect(canvas).toHaveAttribute('data-value-source-selection', '1')
  // data-selection totals every selected citizen; the source-specific
  // attribute pins that this one selected citizen is not a node.
  await expect(canvas).toHaveAttribute('data-selection', '1')

  // Selecting a node replaces the source selection.
  const n0 = await page.evaluate(() => {
    const r = window.__dinksterTest!.renderer!
    const node = r.getScene().nodes.find((n) => n.id === 'n0')!
    const rect = document.querySelector('[data-testid=graph-canvas]')!.getBoundingClientRect()
    return { x: rect.left + node.x + node.layout.width / 2, y: rect.top + node.y + node.layout.headerHeight / 2 }
  })
  await page.mouse.click(n0.x, n0.y)
  await expect(canvas).toHaveAttribute('data-selection', '1')
  await expect(canvas).toHaveAttribute('data-value-source-selection', '0')

  await page.mouse.click(...xy(await pointOnSource(page, 'v2', 'body')))
  await expect(canvas).toHaveAttribute('data-value-source-selection', '1')
  await page.mouse.click(700, 750) // empty world space, clear of the minimap
  await expect(canvas).toHaveAttribute('data-value-source-selection', '0')
})

test('dragging the pill commits ONE valueSource.move; undo restores the position', async ({ page }) => {
  const start = await pointOnSource(page, 'v2', 'body')
  await drag(page, start, { x: start.x + 60, y: start.y + 40 })

  const moved = await activeDoc(page)
  expect(moved.view.graphs['g0']!.valueSources!['v2']!.position).toEqual({ x: 140, y: 180 })

  await page.keyboard.press('Control+z')
  const undone = await activeDoc(page)
  expect(undone.view.graphs['g0']!.valueSources!['v2']!.position).toEqual({ x: 80, y: 140 })

  await page.keyboard.press('Control+Shift+z')
  const redone = await activeDoc(page)
  expect(redone.view.graphs['g0']!.valueSources!['v2']!.position).toEqual({ x: 140, y: 180 })
})

test('link drag from the source output lands on a free INT input', async ({ page }) => {
  const from = await pointOnSource(page, 'v2', 'pin')
  const to = await pinPoint(page, 'n0', 'batch_size', 'in')
  await drag(page, from, to)

  const g = await rootGraph(page)
  const entry = Object.entries(g.links).find(
    ([, l]) => 'valueSource' in l.from && 'node' in l.to && l.to.port === 'batch_size',
  )
  expect(entry).toBeDefined()
  const [linkId, link] = entry!
  expect(link.from).toEqual({ valueSource: 'v2' })
  expect(link.to).toEqual({ node: 'n0', port: 'batch_size' })

  // The new fan-out leg renders from the source pin.
  const sceneLink = await page.evaluate(
    (id) => window.__dinksterTest!.renderer!.getScene().links.find((l) => l.id === id)?.from,
    linkId,
  )
  expect(sceneLink).toEqual({ kind: 'valueSource', valueSource: 'v2' })
})

test('dragging backward from a free input accepts the source pin as the producer', async ({ page }) => {
  const from = await pinPoint(page, 'n0', 'color', 'in')
  const to = await pointOnSource(page, 'v2', 'pin')
  await drag(page, from, to)

  const g = await rootGraph(page)
  const link = Object.values(g.links).find((l) => 'node' in l.to && l.to.port === 'color')
  expect(link).toBeDefined()
  expect(link!.from).toEqual({ valueSource: 'v2' })
})

test('clicking the pill opens the effective-spec editor; Enter commits valueSource.setValue', async ({ page }) => {
  const body = await pointOnSource(page, 'v2', 'body')
  await page.mouse.click(body.x, body.y)

  const editor = page.getByTestId('widget-editor')
  await expect(editor).toBeVisible()
  // The derived INT spec drives the editor kind: single-line numeric input.
  await expect(editor).toHaveAttribute('data-editor-target', 'valueSource')
  await expect(editor).toHaveAttribute('data-editor-mode', 'INT')
  const input = editor.locator('input')
  await expect(input).toHaveValue('128')
  await input.fill('300')
  await page.keyboard.press('Enter')

  await expect(editor).not.toBeVisible()
  const g = await rootGraph(page)
  expect(g.valueSources!['v2']!.value).toBe(300)

  // Escape closes without committing.
  const updatedBody = await pointOnSource(page, 'v2', 'body')
  await page.mouse.click(updatedBody.x, updatedBody.y)
  await expect(editor).toBeVisible()
  await expect(editor.locator('input')).toBeFocused()
  await page.keyboard.press('Control+a')
  await page.keyboard.type('999')
  await page.keyboard.press('Escape')
  await expect(editor).not.toBeVisible()
  const unchanged = await rootGraph(page)
  expect(unchanged.valueSources!['v2']!.value).toBe(300)
})

test('badge popover reports the derived spec; pin declares it, unpin re-derives - value untouched', async ({ page }) => {
  const badge = await pointOnSource(page, 'v2', 'badge')
  await page.mouse.click(badge.x, badge.y)

  const popover = page.getByTestId('value-source-popover')
  await expect(popover).toBeVisible()
  await expect(page.getByTestId('value-source-spec-state')).toHaveAttribute('data-state', 'derived')
  await expect(page.getByTestId('value-source-spec-state')).toContainText('INT')
  await expect(page.getByTestId('value-source-spec-state')).toContainText('drives 2 inputs')

  await page.getByTestId('value-source-pin-spec').click()
  const pinned = await rootGraph(page)
  expect(pinned.valueSources!['v2']!.spec?.widgetType).toBe('INT')
  expect(pinned.valueSources!['v2']!.value).toBe(128) // pinning NEVER resets the value

  // Re-open: the badge now reports a declared spec and offers unpin.
  await page.mouse.click(badge.x, badge.y)
  await expect(page.getByTestId('value-source-spec-state')).toHaveAttribute('data-state', 'declared')
  await page.getByTestId('value-source-unpin-spec').click()
  const unpinned = await rootGraph(page)
  expect(unpinned.valueSources!['v2']!.spec).toBeUndefined()
  expect(unpinned.valueSources!['v2']!.value).toBe(128)
})

test('context-menu delete removes the source and cascades its links; undo restores both', async ({ page }) => {
  await page.mouse.click(...xy(await pointOnSource(page, 'v2', 'body')), { button: 'right' })
  await expect(menuItem(page, 'core.valueSource.delete')).toBeVisible()
  await menuItem(page, 'core.valueSource.delete').click()

  const g = await rootGraph(page)
  expect(g.valueSources?.['v2']).toBeUndefined()
  expect(g.links['l4']).toBeUndefined() // direct leg
  expect(g.links['l5']).toBeUndefined() // reroute leg
  expect(g.links['l6']).toBeDefined() // reroute -> height survives (undriven junction)
  expect(g.reroutes['r3']).toBeDefined()
  expect(g.links['l7']).toBeDefined() // unrelated image link untouched

  await page.keyboard.press('Control+z')
  const restored = await rootGraph(page)
  expect(restored.valueSources?.['v2']?.value).toBe(128)
  expect(restored.links['l4']).toBeDefined()
  expect(restored.links['l5']).toBeDefined()
})

test('canvas menu adds a raw null source; its editor is the JSON fallback and rejects bad JSON', async ({ page }) => {
  // Empty world space clear of the shell controls and corner minimap.
  await page.mouse.click(650, 500, { button: 'right' })
  await expect(menuItem(page, 'core.canvas.addValueSource')).toBeVisible()
  await menuItem(page, 'core.canvas.addValueSource').click()

  const g = await rootGraph(page)
  const added = Object.values(g.valueSources ?? {}).find((v) => v.id !== 'v2')
  expect(added).toBeDefined()
  expect(added!.value).toBeNull()

  const scene = await page.evaluate(() =>
    window.__dinksterTest!.renderer!.getScene().valueSources.map((v) => ({ id: v.id, specState: v.specState })),
  )
  expect(scene.find((v) => v.id === added!.id)?.specState).toBe('raw')

  // No consumers, no declared spec: the raw JSON fallback is mandatory (P2).
  await page.mouse.click(...xy(await pointOnSource(page, added!.id, 'body')))
  const editor = page.getByTestId('widget-editor')
  await expect(editor).toBeVisible()
  await expect(editor).toHaveAttribute('data-editor-mode', 'raw')
  const area = editor.locator('textarea')
  await expect(area).toHaveValue('null')

  // Invalid JSON never commits: the stored value survives and the editor stays
  // open so the typo can be corrected.
  await area.fill('{oops')
  await page.keyboard.press('Control+Enter')
  await expect(editor).toBeVisible()
  expect(Object.values((await rootGraph(page)).valueSources!).find((v) => v.id === added!.id)!.value).toBeNull()

  // Valid JSON commits through valueSource.setValue.
  await area.fill('{"a": [1, 2]}')
  await page.keyboard.press('Control+Enter')
  expect(Object.values((await rootGraph(page)).valueSources!).find((v) => v.id === added!.id)!.value).toEqual({
    a: [1, 2],
  })
})

test('frozen execution tabs are read-only: no pill editor, no pin/unpin', async ({ page }) => {
  await expect(page.getByTestId('queue-button')).toBeEnabled({ timeout: 15_000 })
  await page.getByTestId('queue-button').click()
  const row = page.getByTestId('execution-row').first()
  await expect(row).toBeVisible({ timeout: 10_000 })
  await expect(row.locator('.execution-status')).toHaveText('Completed', { timeout: 30_000 })

  await row.locator('.execution-open').click()
  await expect(page.getByTestId('frozen-banner')).toBeVisible()
  await identityViewport(page)

  // The frozen snapshot renders the pill, but activation opens no editor.
  const body = await pointOnSource(page, 'v2', 'body')
  await page.mouse.click(body.x, body.y)
  await expect(page.getByTestId('widget-editor')).not.toBeVisible()

  // The badge popover still informs, but offers no mutation.
  const badge = await pointOnSource(page, 'v2', 'badge')
  await page.mouse.click(badge.x, badge.y)
  await expect(page.getByTestId('value-source-popover')).toBeVisible()
  await expect(page.getByTestId('value-source-pin-spec')).not.toBeVisible()
  await expect(page.getByTestId('value-source-unpin-spec')).not.toBeVisible()

  // The frozen document still carries the compile-time value.
  const frozen = await rootGraph(page)
  expect(frozen.valueSources!['v2']!.value).toBe(128)
})
