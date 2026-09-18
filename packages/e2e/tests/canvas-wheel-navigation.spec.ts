import { mkdirSync } from 'node:fs'
import { expect, selectProductOption, test, type Page } from './fixtures.js'

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
  return event.defaultPrevented
}, input)

test('canvas wheel policy preserves default zoom and adds persisted two-axis pan', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByTestId('graph-canvas')).toBeVisible()
  const revision = await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.revision)
  const documentBefore = await page.evaluate(() => JSON.stringify(window.__dinksterTest!.app.activeTab()!.store.doc))
  const point = { screenX: 320, screenY: 240 }

  const zoomStart = { x: 20, y: -10, scale: 1.25 }
  await setViewport(page, zoomStart)
  expect(await wheel(page, { ...point, deltaX: 90, deltaY: 120 })).toBe(true)
  const zoomed = await viewport(page)
  expect(zoomed.scale).toBeCloseTo(zoomStart.scale * Math.exp(-120 * 0.0012), 10)
  expect((point.screenX - zoomed.x) / zoomed.scale).toBeCloseTo((point.screenX - zoomStart.x) / zoomStart.scale, 10)
  expect((point.screenY - zoomed.y) / zoomed.scale).toBeCloseTo((point.screenY - zoomStart.y) / zoomStart.scale, 10)

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
  expect(await wheel(page, { ...point, deltaX: 40, deltaY: -60 })).toBe(true)
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
  await wheel(page, { ...point, deltaX: 90, deltaY: 120, ctrlKey: true })
  const ctrlZoomed = await viewport(page)
  expect(ctrlZoomed.scale).toBeCloseTo(zoomStart.scale * Math.exp(-120 * 0.0012), 10)
  expect((point.screenX - ctrlZoomed.x) / ctrlZoomed.scale).toBeCloseTo((point.screenX - zoomStart.x) / zoomStart.scale, 10)
  expect((point.screenY - ctrlZoomed.y) / ctrlZoomed.scale).toBeCloseTo((point.screenY - zoomStart.y) / zoomStart.scale, 10)
  expect(await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.revision)).toBe(reloadedRevision)
  expect(await page.evaluate(() => JSON.stringify(window.__dinksterTest!.app.activeTab()!.store.doc))).toBe(reloadedDocument)
})
