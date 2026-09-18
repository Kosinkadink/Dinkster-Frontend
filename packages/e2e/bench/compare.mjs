/**
 * Comparative renderer benchmark: Dinkster vs current ComfyUI frontend in both
 * renderer modes (stock LiteGraph canvas, and Nodes 2.0 / Vue nodes via the
 * `Comfy.VueNodes.Enabled` setting).
 *
 * Not part of the CI gate: needs a live ComfyUI backend serving the stock
 * frontend AND the Dinkster dev server. Run manually:
 *
 *   node packages/e2e/bench/compare.mjs            # full 1200-node run
 *   BENCH_CHAINS=3 BENCH_CHAIN_LENGTH=5 node ...   # quick smoke
 *
 * Methodology (kept deliberately identical across all three targets; the
 * shared parts live in harness.mjs):
 *  - same Chromium instance, viewport, and headless mode; vsync uncapped
 *    (--disable-frame-rate-limit --disable-gpu-vsync) so real frame cost is
 *    visible instead of everything reading ~16.7ms
 *  - same synthetic topology: EmptyImage -> ImageScaleBy... -> PreviewImage
 *    chains on the same world-space grid (320x260 pitch), loaded
 *    deterministically (Dinkster: openDocument; ComfyUI: app.loadApiJson +
 *    explicit node repositioning - no UI gestures)
 *  - same world-space camera trajectory: fit-to-scene, then per frame
 *    scale = fit * (1 + 0.5*sin(i/12)), translate -= (15,5) px/frame.
 *    Dinkster viewport is screen = world*scale + t; LiteGraph is
 *    (world + offset)*scale, so offset = t/scale. Pixel-identical view.
 *  - 30 warmup frames discarded, 120 measured, N repetitions with a fresh
 *    page load each, medians reported
 *  - node/link counts and renderer mode are asserted in-page, screenshots
 *    saved per scenario for eyeball verification
 *
 * Caveats: node pixel sizes differ per renderer (each uses its own sizing),
 * and headless GPU rasterization differs from desktop. Treat results as
 * architecture-level signal, not marketing numbers.
 */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  OUT_DIR,
  benchConfig,
  benchDinkster,
  comfyVersions,
  ensureVueNodesSetting,
  launchBenchBrowser,
  measureComfy,
  medianOfReps,
  restoreComfyDefaults,
  stats,
} from './harness.mjs'

const CFG = benchConfig()
const NODES = CFG.chains * CFG.chainLength
const LINKS = NODES - CFG.chains

/** Same grid the Dinkster synthetic generator uses (packages/core/src/format/synthetic.ts). */
const GRID = { x0: 80, y0: 80, colX: 320, rowY: 260 }

/** ComfyUI API-format prompt with the same topology + explicit positions per node id. */
function comfyApiPrompt() {
  const prompt = {}
  const positions = {}
  let id = 1
  for (let c = 0; c < CFG.chains; c++) {
    let prev
    for (let i = 0; i < CFG.chainLength; i++) {
      const nid = String(id++)
      if (i === 0) {
        prompt[nid] = {
          class_type: 'EmptyImage',
          inputs: { width: 64, height: 64, batch_size: 1, color: (c * 7919) % 0xffffff },
        }
      } else if (i === CFG.chainLength - 1) {
        prompt[nid] = { class_type: 'PreviewImage', inputs: { images: [prev, 0] } }
      } else {
        prompt[nid] = {
          class_type: 'ImageScaleBy',
          inputs: { upscale_method: 'nearest-exact', scale_by: 1.0, image: [prev, 0] },
        }
      }
      positions[nid] = [GRID.x0 + i * GRID.colX, GRID.y0 + c * GRID.rowY]
      prev = nid
    }
  }
  return { prompt, positions }
}

async function benchDinksterPlain(page, rep) {
  const r = await benchDinkster(page, {
    url: CFG.dinksterUrl,
    chains: CFG.chains,
    chainLength: CFG.chainLength,
    warmup: CFG.warmup,
    frames: CFG.frames,
    screenshotPath: rep === 0 ? join(OUT_DIR, 'dinkster.png') : undefined,
  })
  if (r.counts.nodes !== NODES || r.counts.links !== LINKS)
    throw new Error(`dinkster counts mismatch: ${JSON.stringify(r.counts)}`)
  return r
}

async function benchComfy(page, vueNodes, rep) {
  await ensureVueNodesSetting(page, CFG.comfyUrl, vueNodes)
  // Let extension init / first layout settle before loading the workload.
  await page.waitForTimeout(2_000)

  const { prompt, positions } = comfyApiPrompt()
  const load = await page.evaluate(
    ({ prompt, positions }) => {
      const app = window.app
      const t0 = performance.now()
      app.loadApiJson(prompt, 'bench.json')
      for (const node of app.rootGraph.nodes) {
        const pos = positions[String(node.id)]
        if (pos) {
          node.pos[0] = pos[0]
          node.pos[1] = pos[1]
        }
      }
      app.canvas.setDirty(true, true)
      const loadMs = performance.now() - t0
      return { loadMs, nodes: app.rootGraph.nodes.length, links: app.rootGraph._links.size }
    },
    { prompt, positions },
  )
  if (load.nodes !== NODES) throw new Error(`comfy node count mismatch: ${JSON.stringify(load)}`)
  if (load.links !== LINKS) throw new Error(`comfy link count mismatch: ${JSON.stringify(load)}`)

  const frames = await measureComfy(page, {
    vueNodes,
    warmup: CFG.warmup,
    frames: CFG.frames,
    screenshotPath: rep === 0 ? join(OUT_DIR, vueNodes ? 'comfy-vuenodes.png' : 'comfy-litegraph.png') : undefined,
  })
  return { loadMs: load.loadMs, frames }
}

async function main() {
  const browser = await launchBenchBrowser()
  const versions = { browser: browser.version(), ...(await comfyVersions(CFG.comfyUrl)) }

  const scenarios = [
    { name: 'dinkster', run: (page, rep) => benchDinksterPlain(page, rep) },
    { name: 'comfy-litegraph', run: (page, rep) => benchComfy(page, false, rep) },
    { name: 'comfy-vuenodes', run: (page, rep) => benchComfy(page, true, rep) },
  ]

  const results = {}
  for (const scenario of scenarios) {
    const reps = []
    for (let rep = 0; rep < CFG.reps; rep++) {
      const page = await browser.newPage({ viewport: CFG.viewport })
      page.on('pageerror', (e) => console.error(`[${scenario.name}] pageerror: ${e.message.slice(0, 300)}`))
      try {
        const { loadMs, frames } = await scenario.run(page, rep)
        const s = stats(frames)
        reps.push({ loadMs, ...s })
        console.log(
          `${scenario.name} rep ${rep + 1}/${CFG.reps}: load ${loadMs.toFixed(0)}ms | ` +
            `avg ${s.avg.toFixed(2)} p50 ${s.p50.toFixed(2)} p95 ${s.p95.toFixed(2)} ` +
            `p99 ${s.p99.toFixed(2)} max ${s.max.toFixed(1)}ms | >33ms: ${s.over33ms}/${CFG.frames}`,
        )
      } finally {
        await page.close()
      }
    }
    results[scenario.name] = { reps, median: medianOfReps(reps) }
  }

  await restoreComfyDefaults(browser, CFG.comfyUrl, CFG.viewport)
  await browser.close()

  const report = {
    date: new Date().toISOString(),
    workload: { chains: CFG.chains, chainLength: CFG.chainLength, nodes: NODES, links: LINKS },
    method: {
      warmupFrames: CFG.warmup,
      measuredFrames: CFG.frames,
      reps: CFG.reps,
      viewport: CFG.viewport,
      vsync: 'uncapped',
    },
    versions,
    results,
  }
  const outFile = join(OUT_DIR, `compare-${NODES}nodes-${Date.now()}.json`)
  writeFileSync(outFile, JSON.stringify(report, null, 2))

  console.log(`\n=== ${NODES} nodes / ${LINKS} links, medians of ${CFG.reps} reps (vsync uncapped) ===`)
  console.log('| target | load (ms) | avg | p50 | p95 | p99 | max | frames >33ms |')
  console.log('|--------|-----------|-----|-----|-----|-----|-----|--------------|')
  for (const [name, r] of Object.entries(results)) {
    const m = r.median
    console.log(
      `| ${name} | ${m.loadMs.toFixed(0)} | ${m.avg.toFixed(2)} | ${m.p50.toFixed(2)} | ` +
        `${m.p95.toFixed(2)} | ${m.p99.toFixed(2)} | ${m.max.toFixed(1)} | ${m.over33ms}/${CFG.frames} |`,
    )
  }
  console.log(`\nwritten: ${outFile}`)
}

await main()
