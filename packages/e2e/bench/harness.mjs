/**
 * Shared benchmark harness: the methodology every bench script must agree on
 * (compare.mjs, feature-cost.mjs, compare-features.mjs). One camera
 * trajectory, one stats definition, one Dinkster loader, one ComfyUI
 * setting/measure path - so numbers from different scripts are comparable
 * and the scripts cannot drift apart.
 */
import { chromium } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), 'results')

/** Env-tunable workload/method config shared by all bench scripts. */
export function benchConfig() {
  return {
    dinksterUrl: process.env.DINKSTER_URL ?? 'http://127.0.0.1:5199',
    comfyUrl: process.env.COMFY_URL ?? 'http://127.0.0.1:8199',
    chains: Number(process.env.BENCH_CHAINS ?? 60),
    chainLength: Number(process.env.BENCH_CHAIN_LENGTH ?? 20),
    reps: Number(process.env.BENCH_REPS ?? 3),
    warmup: 30,
    frames: 120,
    viewport: { width: 1600, height: 900 },
  }
}

export function stats(frames) {
  const sorted = [...frames].sort((a, b) => a - b)
  const pick = (q) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))]
  return {
    avg: frames.reduce((a, b) => a + b, 0) / frames.length,
    p50: pick(0.5),
    p95: pick(0.95),
    p99: pick(0.99),
    max: sorted[sorted.length - 1],
    over33ms: frames.filter((f) => f > 33).length,
  }
}

export const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]

/**
 * Scenario predicate from BENCH_SCENARIOS (comma-separated names; unset =
 * everything), so slow targets only re-run what changed.
 */
export function scenarioFilter() {
  const raw = process.env.BENCH_SCENARIOS
  if (!raw) return () => true
  const wanted = new Set(raw.split(',').map((s) => s.trim()).filter(Boolean))
  return (scenario) => wanted.has(scenario.name)
}

export const STAT_KEYS = ['loadMs', 'avg', 'p50', 'p95', 'p99', 'max', 'over33ms']

export const medianOfReps = (reps) =>
  Object.fromEntries(STAT_KEYS.map((k) => [k, median(reps.map((r) => r[k]))]))

/**
 * In-page drive loop, shared math for every target. `apply(x, y, scale)` is
 * target-specific; returns measured frame deltas (warmup discarded).
 */
export const DRIVE_SNIPPET = `
  async function drive(fit, warmup, frames, apply) {
    const times = []
    let last = performance.now()
    for (let i = 0; i < warmup + frames; i++) {
      const scale = fit.scale * (1 + 0.5 * Math.sin(i / 12))
      apply(fit.x - i * 15, fit.y - i * 5, scale)
      await new Promise((r) =>
        requestAnimationFrame(() => {
          const now = performance.now()
          if (i >= warmup) times.push(now - last)
          last = now
          r()
        }),
      )
    }
    return times
  }
`

/** Fit-to-scene identical to Dinkster's renderer.fitToScene (margin 60, scale clamped 0.1..2). */
export const FIT_SNIPPET = `
  function fitViewport(bounds, vw, vh) {
    const margin = 60
    const bw = bounds.maxX - bounds.minX
    const bh = bounds.maxY - bounds.minY
    const scale = Math.min(2, Math.max(0.1, Math.min((vw - margin * 2) / bw, (vh - margin * 2) / bh)))
    return {
      x: (vw - bw * scale) / 2 - bounds.minX * scale,
      y: (vh - bh * scale) / 2 - bounds.minY * scale,
      scale,
    }
  }
`

/** Chromium with vsync uncapped so real frame cost is visible (not ~16.7ms). */
export async function launchBenchBrowser() {
  mkdirSync(OUT_DIR, { recursive: true })
  return chromium.launch({
    args: ['--disable-frame-rate-limit', '--disable-gpu-vsync', '--force-color-profile=srgb'],
  })
}

/**
 * Load a synthetic workload into Dinkster (openDocument through the test
 * bridge), fit, optionally screenshot, drive the camera, and return
 * { loadMs, frames, counts } where counts is the built scene's content.
 */
export async function benchDinkster(page, { url, chains, chainLength, flags = {}, warmup, frames, screenshotPath }) {
  await page.goto(url)
  await page.waitForFunction(() => window.__dinksterTest?.app !== undefined, { timeout: 30_000 })
  await page.waitForFunction(
    () => /\d+ node schemas/.test(document.querySelector('[data-testid=status-bar]')?.textContent ?? ''),
    { timeout: 30_000 },
  )

  const load = await page.evaluate(
    ({ chains, chainLength, flags }) => {
      const bridge = window.__dinksterTest
      const json = bridge.syntheticWorkflow({ chains, chainLength, ...flags })
      const t0 = performance.now()
      const diagnostics = bridge.app.openDocument(json, 'Bench')
      const loadMs = performance.now() - t0
      return { diagnostics, loadMs }
    },
    { chains, chainLength, flags },
  )
  if (load.diagnostics.length > 0) throw new Error(`dinkster load diagnostics: ${JSON.stringify(load.diagnostics)}`)

  await page.waitForFunction(() => window.__dinksterTest?.renderer !== undefined, { timeout: 10_000 })
  const counts = await page.evaluate(() => {
    const s = window.__dinksterTest.renderer.getScene()
    return {
      nodes: s.nodes.length,
      links: s.links.length,
      reroutes: s.reroutes.length,
      valueSources: s.valueSources.length,
      selectors: s.selectors.length,
      groups: s.groups.length,
    }
  })

  await page.evaluate(() => window.__dinksterTest.renderer.fitToScene())
  if (screenshotPath) {
    await page.waitForTimeout(300)
    await page.screenshot({ path: screenshotPath })
  }
  const measured = await page.evaluate(
    async ({ warmup, frames, driveSrc }) => {
      // eslint-disable-next-line no-eval
      eval(driveSrc)
      const renderer = window.__dinksterTest.renderer
      const fit = renderer.getViewport()
      return drive(fit, warmup, frames, (x, y, scale) => renderer.setViewport({ x, y, scale }))
    },
    { warmup, frames, driveSrc: DRIVE_SNIPPET },
  )
  return { loadMs: load.loadMs, frames: measured, counts }
}

/** Flip the Nodes 2.0 renderer setting, reloading when it changes. */
export async function ensureVueNodesSetting(page, url, enabled) {
  await page.goto(url)
  await page.waitForFunction(
    () => window.app?.graph !== undefined && typeof window.app?.extensionManager?.setting?.get === 'function',
    { timeout: 60_000 },
  )
  const current = await page.evaluate(() => window.app.extensionManager.setting.get('Comfy.VueNodes.Enabled') ?? false)
  if (current !== enabled) {
    await page.evaluate((v) => window.app.extensionManager.setting.set('Comfy.VueNodes.Enabled', v), enabled)
    await page.waitForTimeout(500)
    await page.reload()
    await page.waitForFunction(
      () => window.app?.graph !== undefined && typeof window.app?.extensionManager?.setting?.get === 'function',
      { timeout: 60_000 },
    )
  }
  const now = await page.evaluate(() => window.app.extensionManager.setting.get('Comfy.VueNodes.Enabled') ?? false)
  if (now !== enabled) throw new Error(`failed to set Comfy.VueNodes.Enabled=${enabled}`)
  // Dismiss the workflow-templates dialog that opens on a fresh session.
  for (let i = 0; i < 3; i++) {
    if ((await page.locator('.p-dialog, [role=dialog]').count()) === 0) break
    await page.keyboard.press('Escape')
    await page.waitForTimeout(300)
  }
}

/**
 * After a workload is loaded into the ComfyUI frontend: assert renderer mode,
 * fit the camera exactly like Dinkster does, optionally screenshot, drive, and
 * return measured frames.
 */
export async function measureComfy(page, { vueNodes, warmup, frames, screenshotPath }) {
  if (vueNodes) {
    await page.waitForFunction(() => document.querySelectorAll('.lg-node[data-node-id]').length > 0, {
      timeout: 60_000,
    })
  } else {
    const vueCount = await page.evaluate(() => document.querySelectorAll('.lg-node[data-node-id]').length)
    if (vueCount !== 0) throw new Error(`expected LiteGraph mode but found ${vueCount} Vue nodes`)
  }

  const fit = await page.evaluate(
    ({ fitSrc }) => {
      // eslint-disable-next-line no-eval
      eval(fitSrc)
      const app = window.app
      const bounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity }
      for (const node of app.rootGraph.nodes) {
        bounds.minX = Math.min(bounds.minX, node.pos[0])
        bounds.minY = Math.min(bounds.minY, node.pos[1])
        bounds.maxX = Math.max(bounds.maxX, node.pos[0] + node.size[0])
        bounds.maxY = Math.max(bounds.maxY, node.pos[1] + node.size[1])
      }
      const canvasEl = app.canvas.canvas
      const f = fitViewport(bounds, canvasEl.clientWidth, canvasEl.clientHeight)
      const ds = app.canvas.ds
      ds.scale = f.scale
      ds.offset[0] = f.x / f.scale
      ds.offset[1] = f.y / f.scale
      app.canvas.setDirty(true, true)
      return f
    },
    { fitSrc: FIT_SNIPPET },
  )
  if (screenshotPath) {
    await page.waitForTimeout(500)
    await page.screenshot({ path: screenshotPath })
  }

  const result = await page.evaluate(
    async ({ warmup, frames, driveSrc, fit }) => {
      // eslint-disable-next-line no-eval
      eval(driveSrc)
      const app = window.app
      const ds = app.canvas.ds
      const times = await drive(fit, warmup, frames, (x, y, scale) => {
        ds.scale = scale
        ds.offset[0] = x / scale
        ds.offset[1] = y / scale
        app.canvas.setDirty(true, true)
      })
      const vueNodeCount = document.querySelectorAll('.lg-node[data-node-id]').length
      return { times, vueNodeCount }
    },
    { warmup, frames, driveSrc: DRIVE_SNIPPET, fit },
  )
  if (vueNodes && result.vueNodeCount === 0) throw new Error('Vue nodes disappeared during measurement')
  return result.times
}

/** Best-effort: leave the shared backend the way stock users expect it. */
export async function restoreComfyDefaults(browser, url, viewport) {
  const page = await browser.newPage({ viewport })
  try {
    await ensureVueNodesSetting(page, url, false)
  } catch {
    console.warn('could not restore Comfy.VueNodes.Enabled=false')
  } finally {
    await page.close()
  }
}

/** ComfyUI + frontend versions for the report header. */
export async function comfyVersions(comfyUrl) {
  try {
    const res = await fetch(`${comfyUrl}/system_stats`)
    const sys = await res.json()
    return { comfyui: sys.system?.comfyui_version, comfyFrontend: sys.system?.required_frontend_version }
  } catch {
    return {}
  }
}
