/**
 * Two-finger touch navigation on the production canvas: pinch zooms about
 * the finger midpoint, a two-finger drag pans, and a second finger cancels
 * a one-finger touch gesture instead of leaving it live. Touch pointer
 * events are dispatched synthetically on the real canvas element, so these
 * cases prove the full listener wiring (capture fallback included), not a
 * hardware digitizer.
 */
import { expect, test, type Page } from './fixtures.js'

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await expect(page.getByTestId('status-bar')).toContainText(/\d+ node schemas/, { timeout: 15_000 })
  await page.evaluate(() => {
    window.__dinksterTest!.renderer!.setViewport({ x: 0, y: 0, scale: 1 })
  })
})

const viewport = (page: Page) =>
  page.evaluate(() => window.__dinksterTest!.renderer!.getViewport())

/** Dispatch a synthetic touch pointer event at canvas-relative coordinates. */
const touch = (
  page: Page,
  type: 'pointerdown' | 'pointermove' | 'pointerup' | 'pointercancel',
  pointerId: number,
  x: number,
  y: number,
  ctrlKey = false,
) =>
  page.evaluate(([type, pointerId, x, y, ctrlKey]) => {
    const canvas = document.querySelector('[data-testid=graph-canvas]')!
    const rect = canvas.getBoundingClientRect()
    canvas.dispatchEvent(new PointerEvent(type as string, {
      pointerId: pointerId as number,
      pointerType: 'touch',
      clientX: rect.left + (x as number),
      clientY: rect.top + (y as number),
      button: type === 'pointerdown' ? 0 : type === 'pointermove' ? -1 : 0,
      buttons: type === 'pointerdown' || type === 'pointermove' ? 1 : 0,
      ctrlKey: ctrlKey as boolean,
      bubbles: true,
      cancelable: true,
    }))
  }, [type, pointerId, x, y, ctrlKey] as const)

test('pinching apart zooms about the finger midpoint; the survivor finger is inert', async ({ page }) => {
  await touch(page, 'pointerdown', 51, 100, 100)
  await touch(page, 'pointerdown', 52, 200, 100)
  await touch(page, 'pointermove', 52, 300, 100)
  const zoomed = await viewport(page)
  expect(zoomed.scale).toBeCloseTo(2, 6)
  expect(zoomed.x).toBeCloseTo(-100, 6)
  expect(zoomed.y).toBeCloseTo(-100, 6)

  // Lifting one participant ends navigation: the remaining finger moves
  // nothing until a new second touch re-pairs.
  await touch(page, 'pointerup', 52, 300, 100)
  await touch(page, 'pointermove', 51, 180, 220)
  expect(await viewport(page)).toEqual(zoomed)
  await touch(page, 'pointerup', 51, 180, 220)
})

test('a two-finger drag pans without zooming', async ({ page }) => {
  await touch(page, 'pointerdown', 61, 100, 100)
  await touch(page, 'pointerdown', 62, 200, 100)
  // Real digitizers report one finger per event; the sequential per-finger
  // moves must compose into the exact pan.
  await touch(page, 'pointermove', 61, 140, 130)
  await touch(page, 'pointermove', 62, 240, 130)
  const panned = await viewport(page)
  expect(panned.scale).toBeCloseTo(1, 6)
  expect(panned.x).toBeCloseTo(40, 6)
  expect(panned.y).toBeCloseTo(30, 6)
  await touch(page, 'pointerup', 61, 140, 130)
  await touch(page, 'pointerup', 62, 240, 130)
})

test('a second finger cancels a one-finger touch marquee and starts navigation', async ({ page }) => {
  const marquee = () =>
    page.evaluate(() => (window.__dinksterTest!.renderer!.getOverlay() as {
      marquee?: { x1: number; y1: number; x2: number; y2: number }
    }).marquee)
  await touch(page, 'pointerdown', 71, 100, 100, true)
  await touch(page, 'pointermove', 71, 160, 160, true)
  expect(await marquee()).toBeDefined()

  await touch(page, 'pointerdown', 72, 250, 100)
  expect(await marquee()).toBeUndefined()
  await touch(page, 'pointermove', 72, 350, 100)
  const nav = await viewport(page)
  expect(nav.scale).not.toBeCloseTo(1, 6)
  await touch(page, 'pointerup', 71, 160, 160)
  await touch(page, 'pointerup', 72, 350, 100)
})
