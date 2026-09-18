/**
 * frame-time budget on a real renderer: load a synthetic 1k+ node
 * workflow through the bridge, animate the viewport (pan + zoom, the
 * hottest read-only path), and measure rAF frame times. Runs twice: plain
 * chains, and the same graph with every link routed through a reroute
 * junction (double the segments + junction dots + upstream type tracing).
 *
 * Budgets are generous (CI machines are slow and headless): the point is
 * catching architectural regressions - per-frame relayout, O(n^2) paint,
 * culling breakage - not micro-optimizing.
 */
import { expect, test, type Page } from './fixtures.js'

const CHAINS = 60
const CHAIN_LENGTH = 20
const NODES = CHAINS * CHAIN_LENGTH

async function measureFrameBudget(page: Page, label: string, reroutes: boolean): Promise<void> {
  await page.goto('/')
  await expect(page.locator('.conn-status')).toHaveText('connected', { timeout: 15_000 })
  await expect(page.getByTestId('status-bar')).toContainText(/\d+ node schemas/, { timeout: 15_000 })

  // Load the synthetic workload as a new tab (full loadDocument pipeline).
  const opened = await page.evaluate(
    ({ chains, chainLength, reroutes }) => {
      const bridge = window.__dinksterTest!
      const json = bridge.syntheticWorkflow({ chains, chainLength, reroutes })
      const diagnostics = bridge.app.openDocument(json, 'Perf')
      return { diagnostics, tabs: bridge.app.tabs.get().length }
    },
    { chains: CHAINS, chainLength: CHAIN_LENGTH, reroutes },
  )
  expect(opened.diagnostics).toEqual([])
  expect(opened.tabs).toBe(3)
  await expect(page.getByTestId('tab-bar').locator('.tab', { hasText: 'Perf' })).toBeVisible()

  if (reroutes) {
    // Prove the workload actually renders junctions, not just extra links.
    const sceneReroutes = await page.evaluate(() => window.__dinksterTest!.renderer!.getScene().reroutes.length)
    expect(sceneReroutes).toBe(CHAINS * (CHAIN_LENGTH - 1))
  }

  // Animate the viewport for ~120 frames: pan across the graph while
  // oscillating zoom, so both culling and full-scene paints are exercised.
  const frames = await page.evaluate(async () => {
    const renderer = window.__dinksterTest!.renderer!
    renderer.fitToScene()
    const base = renderer.getViewport()
    const times: number[] = []
    let last = performance.now()
    for (let i = 0; i < 120; i++) {
      renderer.setViewport({
        x: base.x - i * 15,
        y: base.y - i * 5,
        scale: base.scale * (1 + 0.5 * Math.sin(i / 12)),
      })
      await new Promise<void>((r) =>
        requestAnimationFrame(() => {
          const now = performance.now()
          times.push(now - last)
          last = now
          r()
        }),
      )
    }
    return times
  })

  const sorted = [...frames].sort((a, b) => a - b)
  const avg = frames.reduce((a, b) => a + b, 0) / frames.length
  const p95 = sorted[Math.floor(sorted.length * 0.95)]!
  test.info().annotations.push({
    type: 'perf',
    description: `${label}: avg ${avg.toFixed(2)}ms, p95 ${p95.toFixed(2)}ms`,
  })
  expect(avg, `average frame ${avg.toFixed(2)}ms`).toBeLessThan(33)
  expect(p95, `p95 frame ${p95.toFixed(2)}ms`).toBeLessThan(100)
}

test(`pans and zooms a ${NODES}-node graph within frame budget`, async ({ page }) => {
  await measureFrameBudget(page, `${NODES} nodes`, false)
})

// CanvasHost-sensitive path: document open -> first painted frame, and
// command dispatch -> repainted frame on the same large document. These
// exist to give before/after numbers for CanvasHost decomposition work;
// budgets are architectural backstops, not targets.
test(`opens a ${NODES}-node document and repaints after a command within budget`, async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('.conn-status')).toHaveText('connected', { timeout: 15_000 })
  await expect(page.getByTestId('status-bar')).toContainText(/\d+ node schemas/, { timeout: 15_000 })

  const timings = await page.evaluate(
    async ({ chains, chainLength }) => {
      const bridge = window.__dinksterTest!
      const paint = () =>
        new Promise<number>((r) => {
          const t = performance.now()
          requestAnimationFrame(() => requestAnimationFrame(() => r(performance.now() - t)))
        })

      const json = bridge.syntheticWorkflow({ chains, chainLength, reroutes: false })
      const openStart = performance.now()
      bridge.app.openDocument(json, 'PerfOpen')
      const openMs = performance.now() - openStart
      const openPaintMs = await paint()

      // New tabs promote asynchronously onto the shared document authority.
      // Measure the command path users edit through, not the replaced local store.
      let promoted = bridge.app.tabs.get().find((t) => t.title === 'PerfOpen')!
      const promotionDeadline = performance.now() + 5_000
      while (!('status' in promoted.store)) {
        if (performance.now() >= promotionDeadline) throw new Error('PerfOpen did not join the shared workspace')
        await new Promise<void>((resolve) => setTimeout(resolve, 10))
        promoted = bridge.app.tabs.get().find((t) => t.title === 'PerfOpen')!
      }

      // Dispatch 20 node.move commands (full command -> patch -> scene
      // rebuild -> paint loop), measuring dispatch and repaint separately.
      const tab = promoted
      const graphId = tab.store.doc.root
      const nodeIds = Object.keys(tab.store.doc.graphs[graphId]!.nodes).slice(0, 20)
      const app = bridge.app as typeof bridge.app & {
        compileTabCached: (candidate: typeof tab) => unknown
      }
      const originalCompileTabCached = app.compileTabCached
      let comparisonCompiles = 0
      app.compileTabCached = (candidate) => {
        comparisonCompiles += 1
        return originalCompileTabCached.call(app, candidate)
      }
      const dispatchMs: number[] = []
      const repaintMs: number[] = []
      try {
        for (const [i, nodeId] of nodeIds.entries()) {
          const t0 = performance.now()
          const out = tab.store.dispatch({
            command: 'node.move',
            params: { graphId, positions: { [nodeId]: { x: 40 * i, y: 25 * i + 7 } } },
          })
          dispatchMs.push(performance.now() - t0)
          if (!out.ok) throw new Error(`node.move rejected: ${JSON.stringify(out.diagnostics)}`)
          repaintMs.push(await paint())
        }
      } finally {
        app.compileTabCached = originalCompileTabCached
      }
      const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length
      return { openMs, openPaintMs, dispatchAvg: avg(dispatchMs), repaintAvg: avg(repaintMs), comparisonCompiles }
    },
    { chains: CHAINS, chainLength: CHAIN_LENGTH },
  )

  test.info().annotations.push({
    type: 'perf',
    description:
      `${NODES}-node open ${timings.openMs.toFixed(1)}ms, first paint ${timings.openPaintMs.toFixed(1)}ms, ` +
      `node.move dispatch avg ${timings.dispatchAvg.toFixed(2)}ms, repaint avg ${timings.repaintAvg.toFixed(2)}ms, ` +
      `comparison compiles ${timings.comparisonCompiles}`,
  })
  expect(timings.openMs, 'openDocument').toBeLessThan(2000)
  expect(timings.openPaintMs, 'first paint after open').toBeLessThan(1000)
  expect(timings.comparisonCompiles, 'comparison compiles without a bound execution artifact').toBe(0)
  expect(timings.dispatchAvg, 'node.move dispatch avg').toBeLessThan(50)
  expect(timings.repaintAvg, 'repaint after dispatch avg').toBeLessThan(100)
})

test(`pans and zooms a ${NODES}-node graph with a reroute on every link within frame budget`, async ({ page }) => {
  await measureFrameBudget(page, `${NODES} nodes + ${CHAINS * (CHAIN_LENGTH - 1)} reroutes`, true)
})

// Preview-heavy hot path: every node carries a decoded image preview panel,
// making a graph where most nodes show imagery a realistic workload. The
// images decode through the SAME path the preview loader uses for asset
// bytes (concurrent HTMLImageElement.decode() from URLs), then install via
// renderer.setNodePreviews - deterministic, no backend execution of 1200
// jobs. Two records ride the annotation: cold decode throughput and the
// pan/zoom frame budget with all panels live. These numbers are the
// baseline for the LoD decision (docs/promises.md).
test(`pans and zooms a ${NODES}-node graph with a decoded preview on every node`, async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('.conn-status')).toHaveText('connected', { timeout: 15_000 })
  await expect(page.getByTestId('status-bar')).toContainText(/\d+ node schemas/, { timeout: 15_000 })

  await page.evaluate(
    ({ chains, chainLength }) => {
      const bridge = window.__dinksterTest!
      bridge.app.openDocument(bridge.syntheticWorkflow({ chains, chainLength, reroutes: false }), 'PerfPreviews')
    },
    { chains: CHAINS, chainLength: CHAIN_LENGTH },
  )
  await expect(page.getByTestId('tab-bar').locator('.tab', { hasText: 'PerfPreviews' })).toBeVisible()

  // Prepare 64 distinct 256x256 png blobs OUTSIDE the timer (generation is
  // test scaffolding, not the measured path), then time the loader's actual
  // decode: concurrent HTMLImageElement.decode() from URLs, exactly what
  // createPreviewLoader's decodeUrl does for /api/assets bytes.
  const decode = await page.evaluate(async () => {
    const DISTINCT = 64
    const SIZE = 256
    const urls: string[] = []
    for (let i = 0; i < DISTINCT; i++) {
      const canvas = new OffscreenCanvas(SIZE, SIZE)
      const g = canvas.getContext('2d')!
      const grad = g.createLinearGradient(0, 0, SIZE, SIZE)
      grad.addColorStop(0, `hsl(${(i * 47) % 360} 80% 55%)`)
      grad.addColorStop(1, `hsl(${(i * 47 + 120) % 360} 80% 35%)`)
      g.fillStyle = grad
      g.fillRect(0, 0, SIZE, SIZE)
      g.fillStyle = '#fff'
      g.font = '48px sans-serif'
      g.fillText(String(i), 24, 128)
      urls.push(URL.createObjectURL(await canvas.convertToBlob({ type: 'image/png' })))
    }
    const t0 = performance.now()
    const images = await Promise.all(
      urls.map((url) => {
        const img = new Image()
        img.src = url
        return img.decode().then(() => img)
      }),
    )
    const decodeMs = performance.now() - t0
    for (const url of urls) URL.revokeObjectURL(url)
    const renderer = window.__dinksterTest!.renderer!
    const previews: Record<string, { image: CanvasImageSource; width: number; height: number }> = {}
    for (const [i, node] of renderer.getScene().nodes.entries()) {
      const image = images[i % DISTINCT]!
      previews[node.id] = { image, width: image.naturalWidth, height: image.naturalHeight }
    }
    renderer.setNodePreviews(previews)
    return { decodeMs, panels: Object.keys(previews).length }
  })
  expect(decode.panels).toBe(NODES)

  const frames = await page.evaluate(async () => {
    const renderer = window.__dinksterTest!.renderer!
    renderer.fitToScene()
    const base = renderer.getViewport()
    const times: number[] = []
    let last = performance.now()
    for (let i = 0; i < 120; i++) {
      renderer.setViewport({
        x: base.x - i * 15,
        y: base.y - i * 5,
        scale: base.scale * (1 + 0.5 * Math.sin(i / 12)),
      })
      await new Promise<void>((r) =>
        requestAnimationFrame(() => {
          const now = performance.now()
          times.push(now - last)
          last = now
          r()
        }),
      )
    }
    return times
  })

  const sorted = [...frames].sort((a, b) => a - b)
  const avg = frames.reduce((a, b) => a + b, 0) / frames.length
  const p95 = sorted[Math.floor(sorted.length * 0.95)]!
  test.info().annotations.push({
    type: 'perf',
    description:
      `${NODES} nodes + ${decode.panels} previews: avg ${avg.toFixed(2)}ms, p95 ${p95.toFixed(2)}ms; ` +
      `cold decode (concurrent img.decode, 64 unique 256px) ${decode.decodeMs.toFixed(1)}ms total`,
  })
  expect(avg, `average frame ${avg.toFixed(2)}ms`).toBeLessThan(33)
  expect(p95, `p95 frame ${p95.toFixed(2)}ms`).toBeLessThan(100)
})
