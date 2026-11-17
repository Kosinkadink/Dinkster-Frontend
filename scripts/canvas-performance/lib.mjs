// Shared measurement helpers for the comfy-vibe-station#1037 audit. Read-only against the product:
// everything here drives a built app from outside and patches nothing on disk.
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { chromium, LANE, stats } from './pw.mjs'

export { LANE, stats }
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const X = process.env.AUDIT_DISPLAY

/** Point the private dummy X server at a refresh rate and a virtual screen size. */
export function setDisplay(hz, width, height) {
  if (!X)
    throw new Error(
      'Software mode requires AUDIT_DISPLAY naming your private DUMMY0 X server',
    )
  execFileSync(
    'xrandr',
    [
      '--output',
      'DUMMY0',
      '--mode',
      `1280x720_${hz}`,
      '--panning',
      `${width}x${height}`,
    ],
    { env: { ...process.env, DISPLAY: X } },
  )
}

/**
 * mode 'sw': software raster and compositing, vsync from the dummy display (the emulated refresh rate).
 * mode 'gpu': headless Chromium with Vulkan raster on the claimed RTX 4090. Headless has no display
 * rate to follow, so it runs uncapped (frame cost) or at its fixed 60 Hz.
 */
const CHROME_UI_HEIGHT = 87

export async function launch({ mode, hz, uncapped, width, height }) {
  const common = [
    '--force-device-scale-factor=1',
    '--force-color-profile=srgb',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
  ]
  if (mode === 'gpu') {
    // Headless shell: nothing is presented to an X server, so the GPU process is not held up by the dummy display.
    const args = [
      ...common,
      '--use-angle=vulkan',
      '--enable-features=Vulkan',
      '--ignore-gpu-blocklist',
      ...(uncapped
        ? ['--disable-frame-rate-limit', '--disable-gpu-vsync']
        : []),
    ]
    const browser = await chromium.launch({ headless: true, args })
    const context = await browser.newContext({
      viewport: { width, height },
      deviceScaleFactor: 1,
    })
    const page = await context.newPage()
    const cdp = await context.newCDPSession(page)
    return { browser, context, page, cdp }
  }
  // Headed on the dummy display; the window is taller by the browser's own toolbar so the page is width x height.
  setDisplay(uncapped ? 60 : hz, width, height + CHROME_UI_HEIGHT)
  const args = [
    ...common,
    '--window-position=0,0',
    `--window-size=${width},${height + CHROME_UI_HEIGHT}`,
    ...(uncapped ? ['--disable-frame-rate-limit', '--disable-gpu-vsync'] : []),
  ]
  const browser = await chromium.launch({
    headless: false,
    args,
    env: { ...process.env, DISPLAY: X },
  })
  const context = await browser.newContext({ viewport: null })
  const page = await context.newPage()
  const cdp = await context.newCDPSession(page)
  return { browser, context, page, cdp }
}

export async function waitForApp(page, url) {
  await page.goto(url)
  await page.waitForFunction(
    () =>
      /\d+ node schemas/.test(
        document.querySelector('[data-testid=status-bar]')?.textContent ?? '',
      ),
    { timeout: 60_000 },
  )
  await page.waitForSelector('canvas.graph-canvas')
  await sleep(1500)
}

const fixture = (rel) => readFileSync(join(LANE, rel), 'utf8')

/** Load a workload through the test bridge. Returns scene counts. */
export async function loadWorkload(page, name) {
  const hasBridge = await page.evaluate(
    () => window.__dinksterTest?.app !== undefined,
  )
  if (name !== 'empty') {
    if (!hasBridge) throw new Error('workload needs the test bridge')
    if (name.startsWith('syn')) {
      const nodes = Number(name.slice(3))
      const diagnostics = await page.evaluate(
        async ({ chains }) => {
          const b = window.__dinksterTest
          return await b.app.openDocument(
            b.syntheticWorkflow({ chains, chainLength: 20 }),
            'Audit',
          )
        },
        { chains: nodes / 20 },
      )
      if (diagnostics.length > 0)
        throw new Error(
          `diagnostics: ${JSON.stringify(diagnostics).slice(0, 400)}`,
        )
    } else if (name === 'gallery') {
      const ok = await page.evaluate(() =>
        window.__dinksterTest.app.openTemplate(
          'dinkster-nodes-dev',
          'dev-gallery',
          'Gallery',
          'audit',
        ),
      )
      if (!ok) throw new Error('template did not open')
    } else {
      const rel = {
        default7: 'packages/e2e/fixtures/comfyui-default-workflow.json',
        trellis66:
          'packages/core/fixtures/workflows/3d_pixal3d_trellis2_image_to_model.json',
      }[name]
      const ok = await page.evaluate(
        (source) =>
          window.__dinksterTest.app.importWorkflowFile({
            name: 'audit.json',
            text: async () => source,
          }),
        fixture(rel),
      )
      if (!ok) throw new Error(`import of ${name} failed`)
    }
    await sleep(1500)
    // An imported ComfyUI workflow may open the asset-resolution dialog; skip it like a user would.
    for (const name of ['Skip', 'Close']) {
      const button = page
        .getByRole('dialog')
        .getByRole('button', { name, exact: true })
      if ((await button.count()) > 0) {
        await button.first().click()
        await sleep(500)
        break
      }
    }
    if ((await page.getByRole('dialog').count()) > 0)
      throw new Error('a dialog is still open over the canvas')
  }
  if (!hasBridge) return { bridge: false }
  await page.waitForFunction(
    () => window.__dinksterTest?.renderer !== undefined,
  )
  return await page.evaluate(() => {
    const r = window.__dinksterTest.renderer
    const s = r.getScene()
    const c = document.querySelector('canvas.graph-canvas')
    return {
      bridge: true,
      nodes: s.nodes.length,
      links: s.links.length,
      reroutes: s.reroutes.length,
      groups: s.groups.length,
      canvasCss: [c.clientWidth, c.clientHeight],
      canvasPx: [c.width, c.height],
      dpr: devicePixelRatio,
      domNodes: document.querySelectorAll('*').length,
    }
  })
}

/** Camera presets: 'fit' shows the whole graph; 'read' is 100% zoom centred on the graph. */
export async function setCamera(page, preset) {
  await page.evaluate((preset) => {
    const r = window.__dinksterTest?.renderer
    if (!r) return
    r.fitToScene()
    if (preset === 'read') {
      const fit = r.getViewport()
      const c = document.querySelector('canvas.graph-canvas')
      const cx = (c.clientWidth / 2 - fit.x) / fit.scale
      const cy = (c.clientHeight / 2 - fit.y) / fit.scale
      r.setViewport({
        x: c.clientWidth / 2 - cx,
        y: c.clientHeight / 2 - cy,
        scale: 1,
      })
    }
  }, preset)
  await sleep(300)
  return await page.evaluate(() => {
    const r = window.__dinksterTest?.renderer
    return r ? { viewport: r.getViewport(), detail: r.getDetailLevel?.() } : {}
  })
}

/** In-page recorder: frame timestamps, renderer.render() spans, input event delivery. */
export async function installProbe(page) {
  await page.evaluate(() => {
    if (window.__probe) return
    const P = (window.__probe = {
      on: false,
      frames: [],
      renders: [],
      inputs: [],
      minimap: [],
    })
    const tick = (ts) => {
      if (P.on) P.frames.push(ts, performance.now())
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
    for (const type of ['pointermove', 'pointerdown', 'pointerup', 'wheel']) {
      window.addEventListener(
        type,
        (e) => {
          if (P.on)
            P.inputs.push(
              e.timeStamp,
              performance.now(),
              type === 'pointermove'
                ? 0
                : type === 'wheel'
                  ? 1
                  : type === 'pointerdown'
                    ? 2
                    : 3,
            )
        },
        { capture: true, passive: true },
      )
    }
    const r = window.__dinksterTest?.renderer
    if (r && typeof r.render === 'function') {
      const original = r.render
      r.render = function patched() {
        const t0 = performance.now()
        try {
          return original.apply(this, arguments)
        } finally {
          if (P.on) P.renders.push(t0, performance.now())
        }
      }
    }
  })
}

export async function probeStart(page) {
  await page.evaluate(() => {
    const P = window.__probe
    P.frames.length = 0
    P.renders.length = 0
    P.inputs.length = 0
    P.on = true
  })
}

export async function probeStop(page) {
  return await page.evaluate(() => {
    const P = window.__probe
    P.on = false
    return {
      frames: P.frames.slice(),
      renders: P.renders.slice(),
      inputs: P.inputs.slice(),
    }
  })
}

/** Summarise one recording. Frame intervals drop the first frame; latency pairs each render with the newest input delivered before it. */
export function summarise(rec) {
  const frameTs = []
  for (let i = 0; i < rec.frames.length; i += 2) frameTs.push(rec.frames[i + 1])
  const intervals = frameTs.slice(1).map((t, i) => t - frameTs[i])
  const renders = []
  for (let i = 0; i < rec.renders.length; i += 2)
    renders.push([rec.renders[i], rec.renders[i + 1]])
  const inputs = []
  for (let i = 0; i < rec.inputs.length; i += 3)
    inputs.push([rec.inputs[i], rec.inputs[i + 1], rec.inputs[i + 2]])
  const moves = inputs.filter((e) => e[2] === 0 || e[2] === 1)
  const queue = moves.map((e) => e[1] - e[0])
  const toRenderEnd = []
  let j = 0
  for (const [start, end] of renders) {
    while (j + 1 < moves.length && moves[j + 1][1] <= start) j++
    if (moves[j] && moves[j][1] <= start) toRenderEnd.push(end - moves[j][0])
  }
  const span = frameTs.length > 1 ? frameTs[frameTs.length - 1] - frameTs[0] : 0
  const moveSpan =
    moves.length > 1 ? moves[moves.length - 1][1] - moves[0][1] : 0
  return {
    fps: span > 0 ? Math.round(((frameTs.length - 1) / span) * 10000) / 10 : 0,
    frameMs: stats(intervals),
    renderMs: stats(renders.map(([a, b]) => b - a)),
    rendersPerSec:
      span > 0 ? Math.round((renders.length / span) * 10000) / 10 : 0,
    inputEventsPerSec:
      moveSpan > 0
        ? Math.round(((moves.length - 1) / moveSpan) * 10000) / 10
        : 0,
    inputQueueMs: stats(queue),
    inputToRenderEndMs: stats(toRenderEnd),
  }
}

/** Inject pointer input at about 1 kHz without waiting for acknowledgements, like a high-polling mouse. */
export async function drive(cdp, durationMs, makeEvent, rateHz = 1000) {
  const start = performance.now()
  let sent = 0
  const pending = []
  await new Promise((resolve) => {
    const step = () => {
      const now = performance.now()
      const t = now - start
      if (t >= durationMs) return resolve()
      const due = Math.floor((t * rateHz) / 1000)
      if (due > sent) {
        sent = due
        const event = makeEvent(t)
        if (event)
          pending.push(
            cdp.send('Input.dispatchMouseEvent', event).catch(() => {}),
          )
      }
      setImmediate(step)
    }
    step()
  })
  await Promise.all(pending)
  return sent
}

export async function canvasRect(page) {
  return await page.evaluate(() => {
    const r = document
      .querySelector('canvas.graph-canvas')
      .getBoundingClientRect()
    return { x: r.left, y: r.top, w: r.width, h: r.height }
  })
}

/** Screen position of the header of the node nearest the canvas centre, or undefined. */
export async function centreNodeHeader(page, rank = 0) {
  return await page.evaluate((rank) => {
    const r = window.__dinksterTest?.renderer
    if (!r) return undefined
    const c = document
      .querySelector('canvas.graph-canvas')
      .getBoundingClientRect()
    const vp = r.getViewport()
    const found = []
    for (const n of r.getScene().nodes) {
      const sx = (n.x + n.layout.width / 2) * vp.scale + vp.x
      const sy =
        (n.y + Math.min(12, n.layout.headerHeight / 2)) * vp.scale + vp.y
      if (sx < 80 || sy < 80 || sx > c.width - 80 || sy > c.height - 80)
        continue
      found.push({
        d: Math.hypot(sx - c.width / 2, sy - c.height / 2),
        x: c.left + sx,
        y: c.top + sy,
        id: n.id,
        worldX: n.x,
      })
    }
    return found.sort((a, b) => a.d - b.d)[rank]
  }, rank)
}

/** Screen position inside the canvas that hits nothing (for an empty-canvas press). */
export async function emptySpot(page) {
  return await page.evaluate(() => {
    const r = window.__dinksterTest?.renderer
    const c = document
      .querySelector('canvas.graph-canvas')
      .getBoundingClientRect()
    if (!r) return { x: c.left + c.width / 2, y: c.top + c.height / 2 }
    const vp = r.getViewport()
    const s = r.getScene()
    const boxes = s.nodes.map((n) => [
      n.x * vp.scale + vp.x - 30,
      n.y * vp.scale + vp.y - 30,
      (n.x + n.layout.width) * vp.scale + vp.x + 30,
      (n.y + n.layout.height) * vp.scale + vp.y + 30,
    ])
    for (let k = 0; k < 4000; k++) {
      const x = 120 + ((k * 7919) % Math.max(1, Math.floor(c.width - 500)))
      const y = 120 + ((k * 104729) % Math.max(1, Math.floor(c.height - 360)))
      if (!boxes.some((b) => x > b[0] && x < b[2] && y > b[1] && y < b[3]))
        return { x: c.left + x, y: c.top + y, clear: true }
    }
    return { x: c.left + c.width / 2, y: c.top + c.height / 2, clear: false }
  })
}

export { chromium }
