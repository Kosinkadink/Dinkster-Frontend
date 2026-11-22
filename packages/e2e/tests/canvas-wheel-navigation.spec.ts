import { mkdirSync } from 'node:fs'
import { expect, selectProductOption, nativeTest as test, waitForWorkspaceReady, type Page } from './fixtures.js'

const proofDir = process.env['DINKSTER_CANVAS_WHEEL_PROOF_DIR']
if (proofDir !== undefined) mkdirSync(proofDir, { recursive: true })

const viewport = (page: Page) =>
  page.evaluate(() => window.__dinksterTest!.renderer!.getViewport())

const setViewport = (page: Page, value: { x: number; y: number; scale: number }) =>
  page.evaluate((next) => window.__dinksterTest!.renderer!.setViewport(next), value)

const wheel = (
  page: Page,
  input: {
    screenX: number
    screenY: number
    deltaX: number
    deltaY: number
    deltaMode?: number
    ctrlKey?: boolean
  },
) => page.evaluate((value) => {
  const canvas = document.querySelector<HTMLCanvasElement>('[data-testid=graph-canvas]')!
  const rect = canvas.getBoundingClientRect()
  const event = new WheelEvent('wheel', {
    bubbles: true,
    cancelable: true,
    clientX: rect.left + value.screenX,
    clientY: rect.top + value.screenY,
    deltaX: value.deltaX,
    deltaY: value.deltaY,
    deltaMode: value.deltaMode ?? WheelEvent.DOM_DELTA_PIXEL,
    ctrlKey: value.ctrlKey ?? false,
  })
  canvas.dispatchEvent(event)
  return {
    prevented: event.defaultPrevented,
    screenX: event.clientX - rect.left,
    screenY: event.clientY - rect.top,
  }
}, input)

test('smooth wheel zoom accumulates input, yields to manual navigation and persists its toggle', async ({ page }, info) => {
  await page.route('**/api/nodes*', (route) => route.fulfill({ json: {
    schemaVersion: 1, epoch: 1, dinkster: { version: 'e2e', schemaWire: 1 }, packs: {}, nodes: {},
  } }))
  await page.route('/supervisor/**', (route) => route.fulfill({ status: 404 }))
  await page.routeWebSocket('**/api/events?*', () => {})
  await page.goto('/')
  await expect(page.getByTestId('status-bar')).toContainText('connected')
  await waitForWorkspaceReady(page)
  await page.clock.install()
  await page.clock.pauseAt(new Date(Date.now() + 100))
  const start = { x: 20, y: -10, scale: 1.25 }
  const point = { screenX: 320, screenY: 240 }
  expect(await page.evaluate(() => window.__dinksterTest!.app.settings.get('canvas.smoothWheelZoom'))).toBe(true)
  await setViewport(page, start)
  const anchor = await wheel(page, { ...point, deltaX: 0, deltaY: -120 })
  expect(await viewport(page)).toEqual(start)
  await page.clock.runFor(32)
  const middle = await viewport(page)
  expect(middle.scale).toBeGreaterThan(start.scale)
  expect(middle.scale).toBeLessThan(start.scale * Math.exp(120 * 0.0012))
  expect((anchor.screenX - middle.x) / middle.scale).toBeCloseTo((anchor.screenX - start.x) / start.scale, 10)
  expect((anchor.screenY - middle.y) / middle.scale).toBeCloseTo((anchor.screenY - start.y) / start.scale, 10)
  await page.screenshot({ path: info.outputPath('smooth-wheel-mid-glide.png') })
  await wheel(page, { ...point, deltaX: 0, deltaY: -80 })
  await page.clock.runFor(120)
  expect((await viewport(page)).scale).toBeCloseTo(start.scale * Math.exp(200 * 0.0012), 10)
  await wheel(page, { ...point, deltaX: 0, deltaY: 120 })
  await page.clock.runFor(120)
  expect((await viewport(page)).scale).toBeCloseTo(start.scale * Math.exp(80 * 0.0012), 10)
  await setViewport(page, start)
  let previousScale = start.scale
  for (let elapsed = 1; elapsed <= 200; elapsed++) {
    await wheel(page, { ...point, deltaX: 0, deltaY: -1 })
    await page.clock.runFor(1)
    if (elapsed % 16 === 0) {
      const current = await viewport(page)
      expect(current.scale).toBeGreaterThan(previousScale)
      expect((point.screenX - current.x) / current.scale).toBeCloseTo((point.screenX - start.x) / start.scale, 10)
      previousScale = current.scale
    }
  }
  await page.clock.runFor(116)
  expect((await viewport(page)).scale).toBeCloseTo(start.scale * Math.exp(200 * 0.0012), 10)
  await setViewport(page, start)
  await page.getByTestId('graph-canvas').evaluate((canvas) => (canvas as HTMLCanvasElement).focus())
  await page.keyboard.press('Shift+Digit1')
  await wheel(page, { ...point, deltaX: 0, deltaY: -120 })
  await page.clock.runFor(32)
  await page.keyboard.press('Digit1')
  await page.clock.runFor(350)
  const bookmark = await viewport(page)
  expect(bookmark.x).toBeCloseTo(start.x, 10)
  expect(bookmark.y).toBeCloseTo(start.y, 10)
  expect(bookmark.scale).toBeCloseTo(start.scale, 10)
  await wheel(page, { ...point, deltaX: 0, deltaY: -120 })
  await page.getByTestId('graph-canvas').dispatchEvent('pointerdown', { button: 1, buttons: 4, pointerId: 1, pointerType: 'mouse' })
  const interrupted = await viewport(page)
  await page.getByTestId('graph-canvas').dispatchEvent('pointerup', { button: 1, buttons: 0, pointerId: 1, pointerType: 'mouse' })
  await page.clock.runFor(120)
  expect(await viewport(page)).toEqual(interrupted)
  await wheel(page, { ...point, deltaX: 0, deltaY: -120 })
  await page.clock.runFor(32)
  const disabled = await viewport(page)
  await page.evaluate(() => window.__dinksterTest!.app.settings.set('canvas.smoothWheelZoom', false))
  await page.clock.runFor(120)
  expect(await viewport(page)).toEqual(disabled)
  await page.evaluate(() => window.__dinksterTest!.app.settings.set('canvas.smoothWheelZoom', true))
  await page.clock.resume()

  await page.getByTestId('settings-button').click()
  const dialog = page.getByRole('dialog', { name: 'Settings' })
  await dialog.locator('.settings-categories').getByRole('button', { name: 'Canvas', exact: true }).click()
  const toggle = dialog.locator('[data-setting-id="canvas.smoothWheelZoom"]').getByRole('checkbox')
  await expect(toggle).toBeChecked()
  await page.screenshot({ path: info.outputPath('smooth-wheel-on.png') })
  await toggle.uncheck()
  await expect(toggle).not.toBeChecked()
  await page.screenshot({ path: info.outputPath('smooth-wheel-off.png') })
  await dialog.getByRole('button', { name: 'Close settings' }).click()
  await setViewport(page, start)
  await wheel(page, { ...point, deltaX: 0, deltaY: -120 })
  expect((await viewport(page)).scale).toBeCloseTo(start.scale * Math.exp(120 * 0.0012), 10)
  await page.reload()
  await expect(page.getByTestId('graph-canvas')).toBeVisible()
  expect(await page.evaluate(() => window.__dinksterTest!.app.settings.get('canvas.smoothWheelZoom'))).toBe(false)
  await page.evaluate(() => window.__dinksterTest!.app.settings.set('canvas.smoothWheelZoom', true))
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await setViewport(page, start)
  await wheel(page, { ...point, deltaX: 0, deltaY: -120 })
  expect((await viewport(page)).scale).toBeCloseTo(start.scale * Math.exp(120 * 0.0012), 10)
})

test('canvas wheel policy preserves default zoom and adds persisted two-axis pan', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByTestId('graph-canvas')).toBeVisible()
  await expect(page.getByTestId('status-bar')).toContainText('connected')
  await waitForWorkspaceReady(page)
  const revision = await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.revision)
  const documentBefore = await page.evaluate(() => JSON.stringify(window.__dinksterTest!.app.activeTab()!.store.doc))
  const point = { screenX: 320, screenY: 240 }

  const zoomStart = { x: 20, y: -10, scale: 1.25 }
  await setViewport(page, zoomStart)
  const zoomPoint = await wheel(page, { ...point, deltaX: 90, deltaY: 120 })
  expect(zoomPoint.prevented).toBe(true)
  await expect.poll(async () => (await viewport(page)).scale).toBeCloseTo(zoomStart.scale * Math.exp(-120 * 0.0012), 10)
  const zoomed = await viewport(page)
  expect(zoomed.scale).toBeCloseTo(zoomStart.scale * Math.exp(-120 * 0.0012), 10)
  expect((zoomPoint.screenX - zoomed.x) / zoomed.scale).toBeCloseTo((zoomPoint.screenX - zoomStart.x) / zoomStart.scale, 10)
  expect((zoomPoint.screenY - zoomed.y) / zoomed.scale).toBeCloseTo((zoomPoint.screenY - zoomStart.y) / zoomStart.scale, 10)

  await page.getByTestId('settings-button').click()
  const dialog = page.getByRole('dialog', { name: 'Settings' })
  await dialog.locator('.settings-categories').getByRole('button', { name: 'Canvas', exact: true }).click()
  const row = dialog.locator('[data-setting-id="canvas.scrollBehavior"]')
  const control = row.getByRole('combobox')
  await expect(control).toHaveAttribute('data-selected-id', 'zoom')
  if (proofDir !== undefined) await page.screenshot({ path: `${proofDir}/01-default-zoom-setting.png`, animations: 'disabled' })
  await selectProductOption(page, control, 'pan')
  if (proofDir !== undefined) await page.screenshot({ path: `${proofDir}/02-selected-pan-setting.png`, animations: 'disabled' })
  await dialog.getByRole('button', { name: 'Close settings' }).click()

  const panStart = { x: 20, y: -10, scale: 1.25 }
  await setViewport(page, panStart)
  expect((await wheel(page, { ...point, deltaX: 40, deltaY: -60 })).prevented).toBe(true)
  expect(await viewport(page)).toEqual({ x: -20, y: 50, scale: 1.25 })
  await expect.poll(() => page.evaluate(() => localStorage.getItem('dinkster.settings'))).toContain('canvas.scrollBehavior')
  expect(await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.revision)).toBe(revision)
  expect(await page.evaluate(() => JSON.stringify(window.__dinksterTest!.app.activeTab()!.store.doc))).toBe(documentBefore)

  await page.reload()
  await expect(page.getByTestId('graph-canvas')).toBeVisible()
  await page.getByTestId('settings-button').click()
  const reloadedDialog = page.getByRole('dialog', { name: 'Settings' })
  await reloadedDialog.locator('.settings-categories').getByRole('button', { name: 'Canvas', exact: true }).click()
  await expect(reloadedDialog.locator('[data-setting-id="canvas.scrollBehavior"]').getByRole('combobox')).toHaveAttribute('data-selected-id', 'pan')
  await reloadedDialog.getByRole('button', { name: 'Close settings' }).click()
  const reloadedRevision = await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.revision)
  const reloadedDocument = await page.evaluate(() => JSON.stringify(window.__dinksterTest!.app.activeTab()!.store.doc))
  await setViewport(page, panStart)
  await wheel(page, { ...point, deltaX: 25, deltaY: 35 })
  expect(await viewport(page)).toEqual({ x: -5, y: -45, scale: 1.25 })

  await setViewport(page, panStart)
  await wheel(page, { ...point, deltaX: 2, deltaY: 3, deltaMode: 1 })
  expect(await viewport(page)).toEqual({ x: -12, y: -58, scale: 1.25 })

  const canvasSize = await page.getByTestId('graph-canvas').evaluate((canvas) => ({
    width: canvas.clientWidth,
    height: canvas.clientHeight,
  }))
  await setViewport(page, panStart)
  await wheel(page, { ...point, deltaX: 1, deltaY: -1, deltaMode: 2 })
  expect(await viewport(page)).toEqual({
    x: panStart.x - canvasSize.width,
    y: panStart.y + canvasSize.height,
    scale: panStart.scale,
  })

  await setViewport(page, zoomStart)
  const ctrlPoint = await wheel(page, { ...point, deltaX: 90, deltaY: 120, ctrlKey: true })
  await expect.poll(async () => (await viewport(page)).scale).toBeCloseTo(zoomStart.scale * Math.exp(-120 * 0.0012), 10)
  const ctrlZoomed = await viewport(page)
  expect(ctrlZoomed.scale).toBeCloseTo(zoomStart.scale * Math.exp(-120 * 0.0012), 10)
  expect((ctrlPoint.screenX - ctrlZoomed.x) / ctrlZoomed.scale).toBeCloseTo((ctrlPoint.screenX - zoomStart.x) / zoomStart.scale, 10)
  expect((ctrlPoint.screenY - ctrlZoomed.y) / ctrlZoomed.scale).toBeCloseTo((ctrlPoint.screenY - zoomStart.y) / zoomStart.scale, 10)
  expect(await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.revision)).toBe(reloadedRevision)
  expect(await page.evaluate(() => JSON.stringify(window.__dinksterTest!.app.activeTab()!.store.doc))).toBe(reloadedDocument)
})
