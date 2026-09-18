import { mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { Locator, Page } from '@playwright/test'
import { expect, test } from './fixtures.js'

const evidenceDir = fileURLToPath(new URL('../../../docs/evidence/issue-105/', import.meta.url))
type DockZone = 'left' | 'right' | 'bottom'
interface DockingTestApp {
  readonly dock: {
    effective(): {
      readonly zones: Readonly<Record<DockZone, { readonly sections: readonly { readonly tabs: readonly string[] }[] }>>
    }
    setOpen(zone: DockZone, open: boolean): void
  }
  readonly panels: {
    register(descriptor: unknown): () => void
    placementOf(id: string): string | undefined
  }
  readonly settings: {
    get<T>(id: string): T
    set(id: string, value: unknown): void
  }
}

const zoneTab = (page: Page, zone: DockZone, id: string): Locator =>
  page.getByTestId(`dock-zone-${zone}`).locator(`.product-tab[data-tab-id="${id}"]`)

const rightTab = (page: Page, id: string): Locator => zoneTab(page, 'right', id)

const center = async (locator: Locator): Promise<{ x: number; y: number }> => {
  const box = (await locator.boundingBox())!
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
}

const zoneOrder = (page: Page, zone: DockZone): Promise<readonly string[]> =>
  page.evaluate((id) => {
    const app = window.__dinksterTest!.app as unknown as DockingTestApp
    return app.dock.effective().zones[id].sections.flatMap((section) => section.tabs)
  }, zone)

async function registerDockingProof(page: Page): Promise<void> {
  await page.evaluate(() => {
    const app = window.__dinksterTest!.app as unknown as DockingTestApp
    app.panels.register({
      id: 'docking-proof',
      title: 'Docking proof',
      description: 'Panel used to prove drag docking',
      placement: 'rail',
      allowedPlacements: ['dock', 'rail', 'bottom', 'floating'],
      order: 5,
      toggleTestId: 'docking-proof-toggle',
      component: () => {
        const body = document.createElement('div')
        body.className = 'rail-section'
        body.dataset['testid'] = 'docking-proof-body'
        const heading = document.createElement('h2')
        heading.textContent = 'Docking proof content'
        const copy = document.createElement('p')
        copy.textContent = 'This panel moved from the right zone to the bottom zone.'
        body.append(heading, copy)
        return body
      },
    })
    app.settings.set('shell.layout.right.width', 420)
  })
  await expect(rightTab(page, 'docking-proof')).toBeVisible()
}

const capture = async (page: Page, name: string): Promise<void> => {
  if (process.env['DINKSTER_CAPTURE_ISSUE_105'] !== '1') return
  await page.screenshot({
    path: `${evidenceDir}/${name}.png`,
    fullPage: true,
    animations: 'disabled',
  })
}

const ghostEvidenceDir = fileURLToPath(new URL('../../../docs/evidence/issue-170/', import.meta.url))

const captureDragGhost = async (page: Page, name: string): Promise<void> => {
  if (process.env['DINKSTER_CAPTURE_ISSUE_170'] !== '1') return
  mkdirSync(ghostEvidenceDir, { recursive: true })
  await page.screenshot({ path: `${ghostEvidenceDir}/${name}.png`, animations: 'disabled' })
}

test.beforeAll(() => mkdirSync(evidenceDir, { recursive: true }))

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await expect(page.getByTestId('dock-zone-right')).toBeVisible()
})

test('sub-threshold panel movement remains a tab click', async ({ page }) => {
  const outputs = rightTab(page, 'outputs')
  const point = await center(outputs)
  const before = await zoneOrder(page, 'right')

  await page.mouse.move(point.x, point.y)
  await page.mouse.down()
  await page.mouse.move(point.x + 3, point.y)
  await page.mouse.up()

  await expect(outputs).toHaveAttribute('aria-selected', 'true')
  await expect(outputs).toBeFocused()
  await expect(page.getByTestId('panel-drag-layer')).not.toBeVisible()
  expect(await zoneOrder(page, 'right')).toEqual(before)
})

test('right-zone tab drag previews from one geometry snapshot and persists on release', async ({ page }) => {
  const outputs = rightTab(page, 'outputs')
  const queue = rightTab(page, 'queue')
  const from = await center(outputs)
  const to = await center(queue)
  const storedBefore = await page.evaluate(() =>
    (window.__dinksterTest!.app as unknown as DockingTestApp).settings.get<string>('shell.dock.layout'))

  await page.evaluate(() => {
    const state = window as unknown as {
      __panelDragRectOriginal: typeof Element.prototype.getBoundingClientRect
      __panelDragRectPhase: boolean
      __panelDragRectReads: number
    }
    state.__panelDragRectOriginal = Element.prototype.getBoundingClientRect
    state.__panelDragRectPhase = false
    state.__panelDragRectReads = 0
    Element.prototype.getBoundingClientRect = function () {
      if (
        state.__panelDragRectPhase
        && this.matches('.body, .canvas-pane, .canvas-stage, .dock-zone, .product-tablist, .product-tab, .product-tabpanel, [data-testid="dock-zone-overflow-button"]')
      ) state.__panelDragRectReads += 1
      return state.__panelDragRectOriginal.call(this)
    }
  })

  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.evaluate(() => {
    ;(window as unknown as { __panelDragRectPhase: boolean }).__panelDragRectPhase = true
  })
  await page.mouse.move(to.x - 10, to.y, { steps: 3 })
  const moveReads = await page.evaluate(() => {
    const state = window as unknown as {
      __panelDragRectOriginal: typeof Element.prototype.getBoundingClientRect
      __panelDragRectPhase: boolean
      __panelDragRectReads: number
    }
    state.__panelDragRectPhase = false
    Element.prototype.getBoundingClientRect = state.__panelDragRectOriginal
    return state.__panelDragRectReads
  })

  expect(moveReads).toBe(0)
  await expect(page.getByTestId('panel-drag-target')).toHaveAttribute('data-kind', 'tab')
  await expect(page.getByTestId('panel-drag-target')).toHaveAttribute('data-zone', 'right')
  await expect(page.getByTestId('panel-drag-caret')).toBeVisible()
  expect(await page.evaluate(() =>
    (window.__dinksterTest!.app as unknown as DockingTestApp).settings.get<string>('shell.dock.layout'))).toBe(storedBefore)

  await page.mouse.up()
  await expect(outputs).toBeFocused()
  expect((await zoneOrder(page, 'right'))[0]).toBe('outputs')

  await page.reload()
  await expect(page.getByTestId('dock-zone-right')).toBeVisible()
  expect((await zoneOrder(page, 'right'))[0]).toBe('outputs')
})

test('a dragged panel tab shows a cursor-following ghost with its title, icon, and refusal state', async ({ page }) => {
  await page.getByTestId('logs-toggle').click()
  const logs = zoneTab(page, 'bottom', 'logs')
  await expect(logs).toBeVisible()
  const from = await center(logs)
  const ghost = page.getByTestId('tab-drag-ghost')

  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  // Sub-threshold movement is still a click, so nothing follows the cursor.
  await page.mouse.move(from.x + 3, from.y)
  await expect(ghost).toHaveCount(0)

  // Within its own tab strip the target is allowed.
  await page.mouse.move(from.x + 80, from.y, { steps: 3 })
  await expect(ghost).toBeVisible()
  await expect(ghost.locator('.tab-drag-ghost-title')).toHaveText('Activity')
  await expect(ghost.locator('.tab-drag-ghost-icon svg')).toBeVisible()
  await expect(ghost).toHaveAttribute('data-refused', 'false')
  const box = (await ghost.boundingBox())!
  expect(box.x).toBeGreaterThan(from.x + 80)
  expect(box.y).toBeGreaterThan(from.y)
  await captureDragGhost(page, 'panel-tab-drag-ghost')

  // Cancel so the ghost capture drag never commits a tab move.
  await page.keyboard.press('Escape')
  await page.mouse.up()
  await expect(ghost).toHaveCount(0)

  // A panel restricted to the bottom zone refuses the right zone; the ghost
  // signals it with the same state as the target highlight.
  await page.evaluate(() => {
    const app = window.__dinksterTest!.app as unknown as DockingTestApp
    app.panels.register({
      id: 'refusal-proof',
      title: 'Refusal proof',
      placement: 'bottom',
      allowedPlacements: ['bottom'],
      order: 30,
      component: () => {
        const body = document.createElement('div')
        body.textContent = 'Refusal proof body'
        return body
      },
    })
  })
  const restricted = zoneTab(page, 'bottom', 'refusal-proof')
  await expect(restricted).toBeVisible()
  const start = await center(restricted)
  await page.mouse.move(start.x, start.y)
  await page.mouse.down()
  const rightBody = (await page.getByTestId('dock-zone-right').boundingBox())!
  await page.mouse.move(rightBody.x + rightBody.width / 2, rightBody.y + rightBody.height / 2, { steps: 3 })
  await expect(page.getByTestId('panel-drag-target')).toHaveAttribute('data-allowed', 'false')
  await expect(ghost).toHaveAttribute('data-refused', 'true')

  // A refused release changes nothing and removes the ghost.
  await page.mouse.up()
  await expect(ghost).toHaveCount(0)
  expect(await zoneOrder(page, 'bottom')).toContain('refusal-proof')
  expect(await zoneOrder(page, 'right')).not.toContain('refusal-proof')
})

test('the all-tabs overflow button appends after hidden tabs', async ({ page }) => {
  await page.getByTestId('rail-resize').focus()
  await page.keyboard.press('Home')
  const overflow = page.getByTestId('dock-zone-overflow-button')
  await expect(overflow).toBeVisible()

  const queue = rightTab(page, 'queue')
  const from = await center(queue)
  const to = await center(overflow)
  expect((await zoneOrder(page, 'right')).at(-1)).not.toBe('queue')

  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move(to.x, to.y, { steps: 4 })
  const target = page.getByTestId('panel-drag-target')
  await expect(target).toHaveAttribute('data-kind', 'zone')
  await expect(target).toHaveAttribute('data-zone', 'right')
  await expect(target).toHaveAttribute('data-allowed', 'true')
  await page.mouse.up()

  expect((await zoneOrder(page, 'right')).at(-1)).toBe('queue')
})

test('the hidden-tab tail of a strip appends without reading hidden tab boxes as slots', async ({ page }) => {
  await page.getByTestId('rail-resize').focus()
  await page.keyboard.press('Home')
  const host = page.getByTestId('dock-zone-right')
  const hiddenTabs = host.locator('.product-tab:disabled')
  await expect(hiddenTabs.first()).toBeAttached()
  expect(await hiddenTabs.count()).toBeGreaterThan(0)
  for (const tab of await hiddenTabs.all()) expect(await tab.boundingBox()).toBeNull()

  const queue = rightTab(page, 'queue')
  const from = await center(queue)
  const strip = (await host.locator('.product-tablist').boundingBox())!
  expect((await zoneOrder(page, 'right')).at(-1)).not.toBe('queue')

  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move(strip.x + strip.width - 2, strip.y + strip.height / 2, { steps: 4 })
  const target = page.getByTestId('panel-drag-target')
  await expect(target).toHaveAttribute('data-kind', 'tab')
  await expect(target).toHaveAttribute('data-zone', 'right')
  await page.mouse.up()

  expect((await zoneOrder(page, 'right')).at(-1)).toBe('queue')
})

test('release rolls back when the previewed zone disappears during a drag', async ({ page }) => {
  await registerDockingProof(page)
  await page.getByTestId('library-toggle').click()
  const source = rightTab(page, 'docking-proof')
  const from = await center(source)
  const leftBody = await center(page.getByTestId('library-overlay'))

  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move(leftBody.x, leftBody.y, { steps: 4 })
  await expect(page.getByTestId('panel-drag-target')).toHaveAttribute('data-zone', 'left')
  await page.evaluate(() => {
    const app = window.__dinksterTest!.app as unknown as DockingTestApp
    app.dock.setOpen('left', false)
  })
  await expect(page.getByTestId('dock-zone-left')).toHaveCount(0)
  await page.mouse.up()

  await expect(page.getByTestId('panel-drag-layer')).not.toBeVisible()
  expect(await zoneOrder(page, 'right')).toContain('docking-proof')
  expect(await zoneOrder(page, 'left')).not.toContain('docking-proof')
  await expect(rightTab(page, 'docking-proof')).toBeVisible()
})

test('pointer capture failure immediately cleans up the drag session', async ({ page }) => {
  const source = rightTab(page, 'outputs')
  const destination = rightTab(page, 'queue')
  const from = await center(source)
  const to = await center(destination)
  const before = await zoneOrder(page, 'right')
  await page.evaluate(() => {
    const state = window as unknown as {
      __panelDragSetPointerCapture: typeof Element.prototype.setPointerCapture
    }
    state.__panelDragSetPointerCapture = Element.prototype.setPointerCapture
    Element.prototype.setPointerCapture = () => { throw new Error('capture unavailable') }
  })

  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move(to.x, to.y, { steps: 3 })
  await expect(page.getByTestId('panel-drag-layer')).not.toBeVisible()
  await expect(page.locator('body')).not.toHaveClass(/panel-drag-active/)
  await page.evaluate(() => {
    const state = window as unknown as {
      __panelDragSetPointerCapture: typeof Element.prototype.setPointerCapture
    }
    Element.prototype.setPointerCapture = state.__panelDragSetPointerCapture
  })
  await page.mouse.up()

  expect(await zoneOrder(page, 'right')).toEqual(before)
  await source.click()
  await expect(source).toHaveAttribute('aria-selected', 'true')
})

test('canvas drop floats with a pointer shield and sends no gesture to CanvasHost', async ({ page }) => {
  await registerDockingProof(page)
  const source = rightTab(page, 'docking-proof')
  const from = await center(source)
  const canvas = (await page.getByTestId('graph-canvas').boundingBox())!
  await page.evaluate(() => {
    const events: string[] = []
    ;(window as unknown as { __panelCanvasEvents: string[] }).__panelCanvasEvents = events
    const element = document.querySelector('[data-testid="graph-canvas"]')!
    for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'lostpointercapture']) {
      element.addEventListener(type, (event) => events.push(event.type))
    }
  })

  await page.mouse.move(from.x, from.y)
  await page.evaluate(() => {
    ;(window as unknown as { __panelCanvasEvents: string[] }).__panelCanvasEvents.length = 0
  })
  await page.mouse.down()
  await page.mouse.move(canvas.x + canvas.width / 2, canvas.y + canvas.height / 2, { steps: 4 })
  await expect(page.getByTestId('panel-drag-canvas-shield')).toBeVisible()
  await expect(page.getByTestId('panel-drag-target')).toHaveAttribute('data-kind', 'floating')
  await page.mouse.up()

  await expect(page.locator('[data-testid="floating-panel"][data-panel="docking-proof"]')).toBeVisible()
  expect(await page.evaluate(() =>
    (window as unknown as { __panelCanvasEvents: string[] }).__panelCanvasEvents)).toEqual([])
})

test('hidden bottom target reveals, commits once, and completes a cross-zone move', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 })
  await registerDockingProof(page)
  await page.getByTestId('rail-resize').focus()
  await page.keyboard.press('End')
  await page.evaluate(() => {
    const app = window.__dinksterTest!.app as unknown as DockingTestApp
    const settings = app.settings
    const original = settings.set.bind(settings)
    ;(window as unknown as { __dockLayoutWrites: number }).__dockLayoutWrites = 0
    settings.set = (id, value) => {
      if (id === 'shell.dock.layout') {
        ;(window as unknown as { __dockLayoutWrites: number }).__dockLayoutWrites += 1
      }
      original(id, value)
    }
  })
  const source = rightTab(page, 'docking-proof')
  const from = await center(source)
  const viewport = page.viewportSize()!

  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move(from.x + 8, from.y)
  const ghost = page.getByTestId('panel-drag-ghost-bottom')
  await expect(ghost).toBeVisible()
  expect((await ghost.boundingBox())!.height).toBeLessThanOrEqual(6)
  await capture(page, 'hidden-zone-ghost-bar')

  await page.mouse.move(viewport.width / 2, viewport.height - 2, { steps: 4 })
  const target = page.getByTestId('panel-drag-target')
  await expect(target).toHaveAttribute('data-kind', 'edge')
  await expect(target).toHaveAttribute('data-zone', 'bottom')
  await expect(target).toHaveAttribute('data-allowed', 'true')
  expect((await target.boundingBox())!.height).toBeGreaterThan(100)
  await capture(page, 'drag-preview-overlay')
  await page.mouse.up()

  expect(await page.evaluate(() =>
    (window as unknown as { __dockLayoutWrites: number }).__dockLayoutWrites)).toBe(1)
  expect(await page.evaluate(() =>
    (window.__dinksterTest!.app as unknown as DockingTestApp).panels.placementOf('docking-proof'))).toBe('bottom')
  expect(await zoneOrder(page, 'bottom')).toContain('docking-proof')
  expect(await zoneOrder(page, 'right')).not.toContain('docking-proof')
  await expect(rightTab(page, 'docking-proof')).toHaveCount(0)

  await expect(page.getByTestId('bottom-panel')).toHaveAttribute('data-active-panel', 'docking-proof')
  await expect(page.getByTestId('docking-proof-body')).toBeVisible()
  await page.getByTestId('rail-toggle').click()
  await expect(page.getByTestId('dock-zone-right')).toHaveCount(0)
  await page.mouse.move(viewport.width / 2, 24)
  await page.waitForTimeout(500)
  await capture(page, 'completed-cross-zone-move')
})

test('left and bottom tab strips start durable cross-zone drags', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 })
  await page.getByTestId('library-toggle').click()
  await page.getByTestId('logs-toggle').click()
  const bottomLogs = zoneTab(page, 'bottom', 'logs')
  const fromBottom = await center(bottomLogs)
  const leftBody = await center(page.getByTestId('library-overlay'))

  await page.mouse.move(fromBottom.x, fromBottom.y)
  await page.mouse.down()
  await page.mouse.move(leftBody.x, leftBody.y, { steps: 4 })
  await expect(page.getByTestId('panel-drag-target')).toHaveAttribute('data-kind', 'zone')
  await expect(page.getByTestId('panel-drag-target')).toHaveAttribute('data-zone', 'left')
  await expect(page.getByTestId('panel-drag-target')).toHaveAttribute('data-allowed', 'true')
  await page.mouse.up()

  expect(await zoneOrder(page, 'left')).toContain('logs')
  expect(await zoneOrder(page, 'bottom')).not.toContain('logs')
  await expect(zoneTab(page, 'left', 'logs')).toBeVisible()

  await page.reload()
  await expect(page.getByTestId('dock-zone-left')).toBeVisible()
  expect(await zoneOrder(page, 'left')).toContain('logs')
  expect(await zoneOrder(page, 'bottom')).not.toContain('logs')
  const leftLogs = zoneTab(page, 'left', 'logs')
  await expect(leftLogs).toBeVisible()
  await page.getByTestId('dock-resize').focus()
  await page.keyboard.press('End')
  await expect(leftLogs).toBeInViewport()
  const fromLeft = await center(leftLogs)
  const viewport = page.viewportSize()!

  await page.mouse.move(fromLeft.x, fromLeft.y)
  await page.mouse.down()
  await page.mouse.move(viewport.width / 2, viewport.height - 2, { steps: 4 })
  await expect(page.getByTestId('panel-drag-target')).toHaveAttribute('data-kind', 'edge')
  await expect(page.getByTestId('panel-drag-target')).toHaveAttribute('data-zone', 'bottom')
  await expect(page.getByTestId('panel-drag-target')).toHaveAttribute('data-allowed', 'true')
  await page.mouse.up()

  expect(await zoneOrder(page, 'bottom')).toContain('logs')
  expect(await zoneOrder(page, 'left')).not.toContain('logs')
  await expect(zoneTab(page, 'bottom', 'logs')).toBeVisible()

  await page.reload()
  await expect(page.getByTestId('dock-zone-bottom')).toBeVisible()
  expect(await zoneOrder(page, 'bottom')).toContain('logs')
  expect(await zoneOrder(page, 'left')).not.toContain('logs')
  await expect(zoneTab(page, 'bottom', 'logs')).toBeVisible()
})

test('illegal, Escape, capture-loss, scroll, and resize endings always roll back', async ({ page }) => {
  // Register a rail-only panel: the built-in panels all accept the bottom
  // zone, so proving the illegal-drop rollback needs a restricted one.
  await page.evaluate(() => {
    const app = window.__dinksterTest!.app as unknown as DockingTestApp
    app.panels.register({
      id: 'rollback-proof',
      title: 'Rollback proof',
      placement: 'rail',
      allowedPlacements: ['rail'],
      order: 30,
      component: () => {
        const body = document.createElement('div')
        body.textContent = 'Rollback proof body'
        return body
      },
    })
    // Widen the rail so the added tab is not clipped into the all-tabs menu.
    app.settings.set('shell.layout.right.width', 420)
  })
  const queue = rightTab(page, 'queue')
  const outputs = rightTab(page, 'outputs')
  const railOnly = rightTab(page, 'rollback-proof')
  await expect(railOnly).toBeVisible()
  const from = await center(railOnly)
  const other = await center(outputs)
  const viewport = page.viewportSize()!
  const before = await zoneOrder(page, 'right')
  await outputs.click()
  await expect(outputs).toHaveAttribute('aria-selected', 'true')

  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move(viewport.width / 2, viewport.height - 2, { steps: 3 })
  await expect(page.getByTestId('panel-drag-target')).toHaveAttribute('data-allowed', 'false')
  expect(await railOnly.evaluate((element) => getComputedStyle(element).cursor)).toBe('not-allowed')
  await page.mouse.up()
  expect(await zoneOrder(page, 'right')).toEqual(before)
  await expect(outputs).toHaveAttribute('aria-selected', 'true')
  expect(await page.evaluate(() =>
    (window.__dinksterTest!.app as unknown as DockingTestApp).panels.placementOf('rollback-proof'))).toBe('rail')

  const rollbackWith = async (invalidate: () => Promise<void>): Promise<void> => {
    const point = await center(queue)
    await page.mouse.move(point.x, point.y)
    await page.mouse.down()
    await page.mouse.move(other.x + 8, other.y, { steps: 2 })
    await expect(page.getByTestId('panel-drag-layer')).toBeVisible()
    await invalidate()
    await expect(page.getByTestId('panel-drag-layer')).not.toBeVisible()
    await page.mouse.up()
    expect(await zoneOrder(page, 'right')).toEqual(before)
    await expect(outputs).toHaveAttribute('aria-selected', 'true')
  }

  await rollbackWith(() => page.keyboard.press('Escape'))
  await rollbackWith(() => page.evaluate(() => { window.dispatchEvent(new Event('scroll')) }))
  await rollbackWith(() => page.evaluate(() => { window.dispatchEvent(new Event('resize')) }))

  const point = await center(queue)
  await page.mouse.move(point.x, point.y)
  await page.mouse.down()
  await page.mouse.move(other.x + 8, other.y, { steps: 2 })
  const pointerId = await queue.evaluate((element) => {
    for (let id = 1; id < 32; id += 1) if (element.hasPointerCapture(id)) return id
    return undefined
  })
  expect(pointerId).toBeDefined()
  await queue.evaluate((element, id) => element.releasePointerCapture(id!), pointerId)
  await page.mouse.move(other.x + 9, other.y)
  await expect(page.getByTestId('panel-drag-layer')).not.toBeVisible()
  await page.mouse.up()
  expect(await zoneOrder(page, 'right')).toEqual(before)
  await expect(outputs).toHaveAttribute('aria-selected', 'true')
})
