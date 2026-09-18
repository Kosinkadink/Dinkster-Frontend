import { expect, test, type Page } from './fixtures.js'

type Edge = 'left' | 'right' | 'top' | 'bottom'

async function openFixture(page: Page): Promise<number> {
  await page.goto('/')
  await expect(page.getByTestId('status-bar')).toContainText(/\d+ node schemas/, { timeout: 15_000 })
  return page.evaluate(() => {
    const test = window.__dinksterTest!
    test.app.registerSchemas([{
      type: 'OutlineEdgeE2E', displayName: 'Outline Edge E2E', category: 'test', source: 'v3', isOutputNode: false,
      items: [],
    }])
    test.app.openDocument({
      format: 'dinkster-workflow', formatVersion: 1, lineage: 'outline-edge-e2e', root: 'root',
      graphs: { root: {
        id: 'root', name: 'Root',
        nodes: { edge: { id: 'edge', type: 'OutlineEdgeE2E', values: {} } },
        links: {}, nets: {}, reroutes: {}, nextOrdinal: 2,
      } },
      view: { graphs: { root: { nodes: { edge: { position: { x: 100, y: 100 } } } } } },
    }, 'Outline Edge E2E')
    return test.app.activeTab()!.store.revision
  })
}

async function selectNode(page: Page): Promise<void> {
  const point = await page.evaluate(() => {
    const renderer = window.__dinksterTest!.renderer!
    const canvas = document.querySelector<HTMLCanvasElement>('[data-testid=graph-canvas]')!
    const node = renderer.getScene().nodes.find((candidate) => candidate.id === 'edge')!
    const viewport = renderer.getViewport()
    const rect = canvas.getBoundingClientRect()
    return {
      x: rect.left + viewport.x + (node.x + node.layout.width / 2) * viewport.scale,
      y: rect.top + viewport.y + (node.y + node.layout.headerHeight / 2) * viewport.scale,
    }
  })
  await page.mouse.click(point.x, point.y)
  expect(await page.evaluate(() => window.__dinksterTest!.renderer!.getOverlay().selection?.has('edge'))).toBe(true)
}

async function putNodeAtEdge(page: Page, edge: Edge, scale: number): Promise<number> {
  return page.evaluate(({ edge, scale }) => {
    const test = window.__dinksterTest!
    const renderer = test.renderer!
    const canvas = document.querySelector<HTMLCanvasElement>('[data-testid=graph-canvas]')!
    const node = renderer.getScene().nodes.find((candidate) => candidate.id === 'edge')!
    const centeredX = (canvas.clientWidth - node.layout.width * scale) / 2 - node.x * scale
    const centeredY = (canvas.clientHeight - node.layout.height * scale) / 2 - node.y * scale
    renderer.setViewport({
      x: edge === 'left'
        ? -node.x * scale
        : edge === 'right'
          ? canvas.clientWidth - (node.x + node.layout.width) * scale
          : centeredX,
      y: edge === 'top'
        ? -node.y * scale
        : edge === 'bottom'
          ? canvas.clientHeight - (node.y + node.layout.height) * scale
          : centeredY,
      scale,
    })
    return test.app.activeTab()!.store.revision
  }, { edge, scale })
}

async function putNodeUnderOverlay(page: Page, edge: 'top' | 'bottom', selector: string): Promise<void> {
  await page.evaluate(({ edge, selector }) => {
    const renderer = window.__dinksterTest!.renderer!
    const canvas = document.querySelector<HTMLCanvasElement>('[data-testid=graph-canvas]')!
    const overlay = document.querySelector<HTMLElement>(selector)!
    const node = renderer.getScene().nodes.find((candidate) => candidate.id === 'edge')!
    const canvasRect = canvas.getBoundingClientRect()
    const overlayRect = overlay.getBoundingClientRect()
    const nodeCenterX = overlayRect.left + overlayRect.width / 2 - canvasRect.left
    renderer.setViewport({
      x: nodeCenterX - node.x - node.layout.width / 2,
      y: edge === 'top' ? -node.y : canvas.clientHeight - node.y - node.layout.height,
      scale: 1,
    })
  }, { edge, selector })
}

async function coveredOutlineSlices(page: Page, edge: Edge): Promise<number> {
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
  return page.evaluate((edge) => {
    const renderer = window.__dinksterTest!.renderer!
    const canvas = document.querySelector<HTMLCanvasElement>('[data-testid=graph-canvas]')!
    const node = renderer.getScene().nodes.find((candidate) => candidate.id === 'edge')!
    const viewport = renderer.getViewport()
    const x = viewport.x + node.x * viewport.scale
    const y = viewport.y + node.y * viewport.scale
    const width = node.layout.width * viewport.scale
    const height = node.layout.height * viewport.scale
    const sx = canvas.width / canvas.clientWidth
    const sy = canvas.height / canvas.clientHeight
    const band = 7
    const cssRect = edge === 'left'
      ? { x: 0, y: y + 7, width: band, height: height - 14 }
      : edge === 'right'
        ? { x: canvas.clientWidth - band, y: y + 7, width: band, height: height - 14 }
        : edge === 'top'
          ? { x: x + 7, y: 0, width: width - 14, height: band }
          : { x: x + 7, y: canvas.clientHeight - band, width: width - 14, height: band }
    const px = Math.max(0, Math.floor(cssRect.x * sx))
    const py = Math.max(0, Math.floor(cssRect.y * sy))
    const pw = Math.max(1, Math.min(canvas.width - px, Math.ceil(cssRect.width * sx)))
    const ph = Math.max(1, Math.min(canvas.height - py, Math.ceil(cssRect.height * sy)))
    const image = canvas.getContext('2d')!.getImageData(px, py, pw, ph)
    const longitudinalLength = edge === 'left' || edge === 'right' ? ph : pw
    const slices = 5
    let covered = 0
    for (let slice = 0; slice < slices; slice++) {
      const start = Math.floor(longitudinalLength * slice / slices)
      const end = Math.max(start + 1, Math.floor(longitudinalLength * (slice + 1) / slices))
      let bright = false
      for (let longitudinal = start; longitudinal < end && !bright; longitudinal++) {
        const crossLength = edge === 'left' || edge === 'right' ? pw : ph
        for (let cross = 0; cross < crossLength; cross++) {
          const imageX = edge === 'left' || edge === 'right' ? cross : longitudinal
          const imageY = edge === 'left' || edge === 'right' ? longitudinal : cross
          const offset = (imageY * image.width + imageX) * 4
          if (
            image.data[offset]! > 230 &&
            image.data[offset + 1]! > 230 &&
            image.data[offset + 2]! > 230 &&
            image.data[offset + 3]! > 0
          ) {
            bright = true
            break
          }
        }
      }
      if (bright) covered++
    }
    return covered
  }, edge)
}

test('selected outline clips naturally at every viewport edge across DPR and zoom', async ({ browser }) => {
  for (const deviceScaleFactor of [1, 1.25, 1.5, 2]) {
    const context = await browser.newContext({ deviceScaleFactor, viewport: { width: 1440, height: 900 } })
    const page = await context.newPage()
    const revision = await openFixture(page)
    expect(await page.evaluate(() => window.devicePixelRatio)).toBe(deviceScaleFactor)
    await putNodeAtEdge(page, 'left', 0.75)
    expect(await coveredOutlineSlices(page, 'left')).toBe(0)
    await page.evaluate(() => window.__dinksterTest!.renderer!.fitToScene())
    await selectNode(page)

    for (const scale of [0.75, 1.75]) {
      for (const edge of ['left', 'right', 'top', 'bottom'] as const) {
        expect(await putNodeAtEdge(page, edge, scale)).toBe(revision)
        expect(await coveredOutlineSlices(page, edge), `DPR ${deviceScaleFactor}, zoom ${scale}, ${edge}`).toBe(0)
        expect(await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.revision)).toBe(revision)
      }
    }

    const chrome = await page.evaluate(() => {
      const rect = (selector: string) => {
        const value = document.querySelector<HTMLElement>(selector)!.getBoundingClientRect()
        return { left: value.left, right: value.right, top: value.top, bottom: value.bottom }
      }
      return {
        canvas: rect('[data-testid=graph-canvas]'),
        leftRail: rect('.left-sidebar'),
        rightRail: rect('.rail'),
        tabs: rect('.tab-strip'),
        status: rect('[data-testid=status-bar]'),
      }
    })
    expect(chrome.leftRail.right).toBeLessThanOrEqual(chrome.canvas.left)
    expect(chrome.rightRail.left).toBeGreaterThanOrEqual(chrome.canvas.right)
    expect(chrome.tabs.bottom).toBeLessThanOrEqual(chrome.canvas.top)
    expect(chrome.status.top).toBeGreaterThanOrEqual(chrome.canvas.bottom)

    await putNodeUnderOverlay(page, 'top', '.workflow-queue-control')
    expect(await coveredOutlineSlices(page, 'top')).toBe(0)
    expect(await page.locator('.workflow-queue-control').evaluate((control) => {
      const rect = control.getBoundingClientRect()
      return document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)?.closest('.workflow-queue-control') === control
    })).toBe(true)
    await putNodeUnderOverlay(page, 'bottom', '[data-testid=minimap]')
    expect(await coveredOutlineSlices(page, 'bottom')).toBe(0)
    expect(await page.locator('[data-testid=minimap]').evaluate((minimap) => {
      const rect = minimap.getBoundingClientRect()
      return document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2) === minimap
    })).toBe(true)
    expect(await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.revision)).toBe(revision)

    await context.close()
  }
})
