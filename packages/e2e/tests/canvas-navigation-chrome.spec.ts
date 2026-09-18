import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { TestInfo } from '@playwright/test'
import { expect, test, type Locator, type Page } from './fixtures.js'

const proofDir = process.env['DINKSTER_CANVAS_CHROME_PROOF_DIR']
if (proofDir !== undefined) mkdirSync(proofDir, { recursive: true })

const capture = async (page: Page, testInfo: TestInfo, name: string): Promise<void> => {
  if (proofDir === undefined) return
  await page.screenshot({
    path: join(proofDir, `${testInfo.project.name}-${name}.png`),
    animations: 'disabled',
  })
}

const expectContained = async (locator: Locator, width: number, height: number): Promise<void> => {
  const box = await locator.boundingBox()
  expect(box).not.toBeNull()
  expect(box!.x).toBeGreaterThanOrEqual(0)
  expect(box!.y).toBeGreaterThanOrEqual(0)
  expect(box!.x + box!.width).toBeLessThanOrEqual(width)
  expect(box!.y + box!.height).toBeLessThanOrEqual(height)
}

const expectSize = async (locator: Locator, width: number, height: number): Promise<void> => {
  const box = await locator.boundingBox()
  expect(box).not.toBeNull()
  expect(box!.width).toBeCloseTo(width, 1)
  expect(box!.height).toBeCloseTo(height, 1)
}

interface Box { x: number; y: number; width: number; height: number }

const expectNoOverlap = (first: Box, second: Box): void => {
  const separated =
    first.x >= second.x + second.width ||
    second.x >= first.x + first.width ||
    first.y >= second.y + second.height ||
    second.y >= first.y + first.height
  expect(separated).toBe(true)
}

const closeRightRail = async (page: Page): Promise<void> => {
  const railToggle = page.getByRole('button', { name: 'Toggle right rail' })
  if (await railToggle.getAttribute('aria-pressed') === 'true') await railToggle.click()
}

const clearTransientTooltip = async (page: Page): Promise<void> => {
  await page.getByTestId('graph-canvas').focus()
  await page.getByTestId('status-bar').hover({ position: { x: 2, y: 2 } })
  await expect(page.getByTestId('app-tooltip')).toHaveCount(0)
}

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await expect(page.getByTestId('status-bar')).toContainText(/\d+ node schemas/, { timeout: 15_000 })
})

test('navigation chrome remains semantic, contained, and document-neutral', async ({ page }, testInfo) => {
  const revision = await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.revision)
  const documentBefore = await page.evaluate(() => JSON.stringify(window.__dinksterTest!.app.activeTab()!.store.doc))

  for (const viewport of [
    { name: 'desktop', width: 1600, height: 950 },
    { name: 'narrow', width: 390, height: 844 },
  ]) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height })
    if (viewport.name === 'narrow') await closeRightRail(page)

    const cluster = page.locator('.canvas-corner-controls')
    const minimap = page.getByTestId('minimap')
    const settings = page.getByTestId('minimap-settings')
    const bar = page.locator('.canvas-corner-bar')
    const zoom = page.locator('.canvas-zoom-controls')
    await expect(minimap).toBeVisible()
    await expectContained(minimap, viewport.width, viewport.height)
    await expectContained(bar, viewport.width, viewport.height)
    if (viewport.name === 'desktop') {
      await expectSize(cluster, 260, 200)
      await expectSize(minimap, 260, 150)
    } else {
      const minimapBox = (await minimap.boundingBox())!
      expect(minimapBox.height).toBeCloseTo(122, 1)
    }
    // The corner bar sits fully below the minimap; nothing overlaps the map.
    {
      const [minimapBox, barBox] = await Promise.all([minimap.boundingBox(), bar.boundingBox()])
      expect(minimapBox!.y + minimapBox!.height + 6).toBeCloseTo(barBox!.y, 1)
      expect(minimapBox!.width).toBeCloseTo(barBox!.width, 1)
    }
    const zoomTargets = await zoom.locator('button').all()
    expect(zoomTargets).toHaveLength(4)
    for (const target of [settings, page.getByTestId('minimap-toggle'), ...zoomTargets]) {
      const box = await target.boundingBox()
      expect(box!.width).toBeGreaterThanOrEqual(36)
      expect(box!.height).toBeGreaterThanOrEqual(36)
    }
    await clearTransientTooltip(page)
    await capture(page, testInfo, `${viewport.name}-minimap`)

    await settings.click()
    const minimapMenu = page.locator('.minimap-menu')
    await expect(minimapMenu).toBeVisible()
    await expect(page.getByTestId('minimap-toggle-nodes')).toBeFocused()
    await expectContained(minimapMenu, viewport.width, viewport.height)
    // The popover never covers the minimap: beside the cluster on desktop,
    // above it on narrow screens. The bar stays visible either way.
    const [minimapBox, menuBox] = await Promise.all([minimap.boundingBox(), minimapMenu.boundingBox()])
    if (viewport.name === 'desktop') {
      expect(menuBox!.x + menuBox!.width).toBeLessThanOrEqual(minimapBox!.x)
    } else {
      expect(menuBox!.y + menuBox!.height).toBeLessThanOrEqual(minimapBox!.y)
    }
    await expect(zoom).toBeVisible()
    await clearTransientTooltip(page)
    await capture(page, testInfo, `${viewport.name}-minimap-settings`)
    await page.getByTestId('minimap-marker-toggle').scrollIntoViewIfNeeded()
    await expect(page.getByTestId('minimap-marker-toggle')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(settings).toBeFocused()

    const lens = page.getByTestId('lens-switcher')
    await lens.click()
    const lensMenu = page.locator('.canvas-view-control').last().locator('.lens-menu')
    await expect(lensMenu).toBeVisible()
    await expectContained(lensMenu, viewport.width, viewport.height)
    await clearTransientTooltip(page)
    await capture(page, testInfo, `${viewport.name}-lens-menu`)
    await lens.click()

    const toggle = page.getByTestId('minimap-toggle')
    await toggle.click()
    await expect(minimap).toBeHidden()
    await expect(toggle).toHaveAttribute('aria-pressed', 'false')
    await expectContained(bar, viewport.width, viewport.height)
    await page.keyboard.press('Escape')
    await clearTransientTooltip(page)
    await capture(page, testInfo, `${viewport.name}-minimap-hidden`)
    await toggle.click()
    await expect(minimap).toBeVisible()
  }

  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
  expect(await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.revision)).toBe(revision)
  expect(await page.evaluate(() => JSON.stringify(window.__dinksterTest!.app.activeTab()!.store.doc))).toBe(documentBefore)
})

test('the queue control shares the top row with the view controls without overlap', async ({ page }, testInfo) => {
  const queue = page.getByTestId('workflow-queue-control')
  const viewControls = page.locator('.canvas-view-controls')

  await page.setViewportSize({ width: 1600, height: 950 })
  await expect(queue).toBeVisible()
  const [wideQueue, wideControls] = await Promise.all([queue.boundingBox(), viewControls.boundingBox()])
  expect(wideQueue!.y).toBeCloseTo(wideControls!.y, 1)
  expect(wideQueue!.x).toBeGreaterThanOrEqual(wideControls!.x + wideControls!.width)
  await clearTransientTooltip(page)
  await capture(page, testInfo, 'desktop-queue-row')

  await page.setViewportSize({ width: 390, height: 844 })
  await closeRightRail(page)
  await expectContained(queue, 390, 844)
  const [narrowQueue, narrowControls] = await Promise.all([queue.boundingBox(), viewControls.boundingBox()])
  expectNoOverlap(narrowQueue!, narrowControls!)

  await page.getByTestId('lens-switcher').click()
  const lensMenu = page.locator('.canvas-view-control').last().locator('.lens-menu')
  await expect(lensMenu).toBeVisible()
  await expectContained(lensMenu, 390, 844)
  const menuBox = (await lensMenu.boundingBox())!
  const queueBox = (await queue.boundingBox())!
  // The open lens menu is a transient popover: it must never paint under or
  // interleave with the queue control. Wherever the two rectangles intersect,
  // the menu owns the pixels.
  const intersection = {
    left: Math.max(menuBox.x, queueBox.x),
    top: Math.max(menuBox.y, queueBox.y),
    right: Math.min(menuBox.x + menuBox.width, queueBox.x + queueBox.width),
    bottom: Math.min(menuBox.y + menuBox.height, queueBox.y + queueBox.height),
  }
  if (intersection.left < intersection.right && intersection.top < intersection.bottom) {
    const menuOwnsPoint = await page.evaluate(({ x, y }) => {
      return document.elementFromPoint(x, y)?.closest('.lens-menu') !== null
    }, { x: (intersection.left + intersection.right) / 2, y: (intersection.top + intersection.bottom) / 2 })
    expect(menuOwnsPoint).toBe(true)
  }
  await clearTransientTooltip(page)
  await capture(page, testInfo, 'narrow-queue-lens-menu')
  await page.keyboard.press('Escape')
})

test('the 520px breakpoint owns compact geometry and the popover moves above the cluster', async ({ page }) => {
  const revision = await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.revision)
  const documentBefore = await page.evaluate(() => JSON.stringify(window.__dinksterTest!.app.activeTab()!.store.doc))
  await closeRightRail(page)
  const cluster = page.locator('.canvas-corner-controls')
  const minimap = page.getByTestId('minimap')
  const zoom = page.locator('.canvas-zoom-controls')

  await page.setViewportSize({ width: 521, height: 844 })
  await expectSize(cluster, 260, 200)
  await expectSize(minimap, 260, 150)

  for (const width of [520, 390]) {
    await page.setViewportSize({ width, height: 844 })
    const minimapBox = (await minimap.boundingBox())!
    expect(minimapBox.height).toBeCloseTo(122, 1)
    const barBox = (await page.locator('.canvas-corner-bar').boundingBox())!
    expect(minimapBox.y + minimapBox.height).toBeLessThanOrEqual(barBox.y)
    expect(barBox.x + barBox.width).toBeLessThanOrEqual(width)
  }

  await page.getByTestId('minimap-settings').click()
  const menuBox = (await page.locator('.minimap-menu').boundingBox())!
  const minimapBox = (await minimap.boundingBox())!
  expect(menuBox.y + menuBox.height).toBeLessThanOrEqual(minimapBox.y)
  await expect(zoom).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('minimap-settings')).toBeFocused()

  const level = page.getByTestId('canvas-zoom-level')
  const scale = await page.evaluate(() => window.__dinksterTest!.renderer!.getViewport().scale)
  await expect(level).toHaveText(`${Math.round(scale * 100)}%`)
  await level.click()
  await expect(level).toHaveText('100%')
  expect(await page.evaluate(() => window.__dinksterTest!.renderer!.getViewport().scale)).toBe(1)
  expect(await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.revision)).toBe(revision)
  expect(await page.evaluate(() => JSON.stringify(window.__dinksterTest!.app.activeTab()!.store.doc))).toBe(documentBefore)
})
