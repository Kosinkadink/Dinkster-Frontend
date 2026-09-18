import type { TestInfo } from '@playwright/test'
import { expect, test, type Page } from './fixtures.js'

interface PointerProbeEntry {
  readonly type: string
  readonly target: string
  readonly pointerId: number
  readonly buttons: number
  readonly activeElement: string
  readonly visibleOverlays: readonly string[]
  defaultPrevented: boolean
  canvasCapture: boolean
}

declare global {
  interface Window {
    __issue69PointerProbe?: PointerProbeEntry[]
    __dinksterPointerTrace?: {
      clear(): void
      dump(): readonly unknown[]
    }
  }
}

const blankWorkflow = {
  format: 'dinkster-workflow' as const,
  formatVersion: 1 as const,
  lineage: 'canvas-shell-handoff',
  root: 'g0',
  graphs: {
    g0: {
      id: 'g0',
      name: 'root',
      nodes: {},
      links: {},
      nets: {},
      reroutes: {},
      nextOrdinal: 1,
    },
  },
  view: { graphs: { g0: { nodes: {} } } },
}

async function installPointerProbe(page: Page): Promise<void> {
  await page.addInitScript(() => {
    localStorage.setItem('dinkster.pointerTrace', '1')
    window.__issue69PointerProbe = []
    const label = (element: Element | null): string => {
      if (element === null) return 'none'
      const testId = element.getAttribute('data-testid')
      return testId === null ? element.tagName.toLowerCase() : `${element.tagName.toLowerCase()}[${testId}]`
    }
    for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'lostpointercapture']) {
      window.addEventListener(type, (rawEvent) => {
        const event = rawEvent as PointerEvent
        const canvas = document.querySelector<HTMLCanvasElement>('[data-testid="graph-canvas"]')
        const entry: PointerProbeEntry = {
          type,
          target: label(event.target instanceof Element ? event.target : null),
          pointerId: event.pointerId,
          buttons: event.buttons,
          activeElement: label(document.activeElement),
          visibleOverlays: Array.from(document.querySelectorAll<HTMLElement>(
            '[data-testid="canvas-popover-backdrop"], [data-testid="modal-surface"], [data-testid="widget-editor"], [role="menu"]',
          )).filter((element) => element.getClientRects().length > 0).map(label),
          defaultPrevented: false,
          canvasCapture: false,
        }
        window.__issue69PointerProbe!.push(entry)
        queueMicrotask(() => {
          entry.defaultPrevented = event.defaultPrevented
          entry.canvasCapture = canvas?.hasPointerCapture(event.pointerId) ?? false
        })
      }, true)
    }
  })
}

async function openBlankCanvas(page: Page): Promise<void> {
  await page.route('/system_stats', (route) => route.fulfill({ json: { system: { os: 'e2e' }, devices: [] } }))
  await page.route('/object_info', (route) => route.fulfill({ json: {} }))
  await page.goto('/')
  await expect(page.getByTestId('status-bar')).toContainText('0 node schemas', { timeout: 15_000 })
  expect(await page.evaluate((workflow) => window.__dinksterTest!.app.openDocument(workflow, 'Canvas handoff'), blankWorkflow)).toEqual([])
  await expect.poll(() => page.evaluate(() => window.__dinksterTest!.renderer?.getScene().graphId)).toBe('g0')
  await page.evaluate(() => window.__dinksterTest!.renderer!.setViewport({ x: 0, y: 0, scale: 1 }))
}

async function dragEmptyCanvas(page: Page): Promise<void> {
  const canvas = (await page.getByTestId('graph-canvas').boundingBox())!
  const start = { x: canvas.x + canvas.width * 0.45, y: canvas.y + canvas.height * 0.6 }
  await page.mouse.move(start.x, start.y)
  await page.mouse.down()
  await page.mouse.move(start.x + 80, start.y + 40, { steps: 5 })
  await page.mouse.up()
}

async function captureHandoffState(page: Page, testInfo: TestInfo) {
  const state = await page.evaluate(() => {
    const canvas = document.querySelector<HTMLCanvasElement>('[data-testid="graph-canvas"]')!
    const active = document.activeElement
    return {
      viewport: window.__dinksterTest!.renderer!.getViewport(),
      pointerTrace: window.__dinksterPointerTrace?.dump() ?? [],
      pointerProbe: window.__issue69PointerProbe ?? [],
      activeElement: active instanceof Element
        ? active.getAttribute('data-testid') ?? active.tagName.toLowerCase()
        : 'none',
      visibleOverlays: Array.from(document.querySelectorAll<HTMLElement>(
        '[data-testid="canvas-popover-backdrop"], [data-testid="modal-surface"], [data-testid="widget-editor"], [role="menu"]',
      )).filter((element) => element.getClientRects().length > 0).map((element) =>
        element.getAttribute('data-testid') ?? element.getAttribute('role') ?? element.tagName.toLowerCase(),
      ),
      captureOwners: (window.__issue69PointerProbe ?? [])
        .filter((entry) => entry.canvasCapture)
        .map((entry) => ({ type: entry.type, pointerId: entry.pointerId })),
      terminalEvents: (window.__issue69PointerProbe ?? [])
        .filter((entry) => entry.type === 'pointerup' || entry.type === 'pointercancel' || entry.type === 'lostpointercapture'),
      canvasFocused: document.activeElement === canvas,
    }
  })
  await testInfo.attach('canvas-shell-handoff.json', {
    body: Buffer.from(JSON.stringify(state, null, 2)),
    contentType: 'application/json',
  })
  return state
}

test('a shell lens menu hands its outside pointerdown to the Canvas gesture', async ({ page }, testInfo) => {
  await installPointerProbe(page)
  await openBlankCanvas(page)
  await page.getByTestId('lens-switcher').click()
  await expect(page.getByTestId('lens-switcher')).toHaveAttribute('aria-expanded', 'true')
  await page.evaluate(() => {
    window.__dinksterPointerTrace?.clear()
    window.__issue69PointerProbe = []
  })

  await dragEmptyCanvas(page)
  const state = await captureHandoffState(page, testInfo)

  await expect(page.getByTestId('lens-switcher')).toHaveAttribute('aria-expanded', 'false')
  await expect.poll(() => page.evaluate(() => window.__dinksterTest!.renderer!.getViewport())).toEqual({
    x: 80,
    y: 40,
    scale: 1,
  })
  expect(await page.evaluate(() => window.__dinksterPointerTrace?.dump())).toEqual(expect.arrayContaining([
    expect.objectContaining({ gestureKind: 'pan', event: 'start', reason: 'pointerdown' }),
    expect.objectContaining({ gestureKind: 'pan', event: 'commit', reason: 'pointerup' }),
  ]))
  expect(state.canvasFocused).toBe(true)
  expect(state.activeElement).toBe('graph-canvas')
  expect(state.visibleOverlays).toEqual([])
  const pointerDown = state.pointerProbe.find((entry) => entry.type === 'pointerdown')
  expect(pointerDown).toEqual(expect.objectContaining({
    target: 'canvas[graph-canvas]',
    defaultPrevented: false,
  }))
  const pointerId = pointerDown!.pointerId
  expect(state.captureOwners.length).toBeGreaterThan(0)
  expect(new Set(state.captureOwners.map((owner) => owner.pointerId))).toEqual(new Set([pointerId]))
  expect(state.terminalEvents).toEqual([
    expect.objectContaining({
      type: 'pointerup',
      target: 'canvas[graph-canvas]',
      pointerId,
      canvasCapture: true,
    }),
    expect.objectContaining({
      type: 'lostpointercapture',
      target: 'canvas[graph-canvas]',
      pointerId,
      canvasCapture: false,
    }),
  ])
})
