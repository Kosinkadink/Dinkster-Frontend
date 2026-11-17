// Canvas frame time and input latency for comfy-vibe-station#1037.
// Usage: node scripts/canvas-performance/measure.mjs label=prod url=http://127.0.0.1:4173/ mode=gpu size=2560x1440 workloads=default7,trellis66,syn300,syn1200 cameras=read,fit out=.amp/in/frames.json uncapped=1
// Report only: frame targets are <4 ms through 300 nodes and <6.9 ms at 1200;
// pointer-to-redraw targets are the next frame and <2 ms page time through 300 nodes.
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  LANE,
  launch,
  waitForApp,
  loadWorkload,
  setCamera,
  installProbe,
  probeStart,
  probeStop,
  summarise,
  drive,
  canvasRect,
  centreNodeHeader,
  emptySpot,
  sleep,
} from './lib.mjs'

const opt = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const i = a.indexOf('=')
    return [a.slice(0, i), a.slice(i + 1)]
  }),
)
const [width, height] = (opt.size ?? '1920x1080').split('x').map(Number)
const config = {
  label: opt.label ?? 'run',
  url: opt.url,
  mode: opt.mode ?? 'gpu',
  hz: Number(opt.hz ?? 240),
  uncapped: opt.uncapped === '1',
  width,
  height,
}
const workloads = (opt.workloads ?? 'empty').split(',')
const cameras = (opt.cameras ?? 'read').split(',')
const interactions = (opt.interactions ?? 'hover,pan,zoom,drag').split(',')
const DURATION = Number(opt.duration ?? 2500)
const out = join(LANE, opt.out ?? `.amp/in/canvas-frames-${config.label}.json`)
mkdirSync(dirname(out), { recursive: true })

const results = []
for (const workload of workloads) {
  const { browser, page, cdp } = await launch(config)
  try {
    await waitForApp(page, config.url)
    const counts = await loadWorkload(page, workload)
    await installProbe(page)
    for (const camera of counts.bridge ? cameras : ['asis']) {
      const cam = counts.bridge ? await setCamera(page, camera) : {}
      const rect = await canvasRect(page)
      const cx = rect.x + rect.w / 2
      const cy = rect.y + rect.h / 2
      const run = async (name, body) => {
        if (!interactions.includes(name)) return
        if (counts.bridge) await setCamera(page, camera)
        await sleep(200)
        if (opt.trace === '1')
          await browser.startTracing(page, {
            categories: [
              'benchmark',
              'input',
              'cc',
              'viz',
              'gpu',
              'latencyInfo',
              'devtools.timeline',
              'toplevel',
            ],
          })
        await probeStart(page)
        const extra = (await body()) ?? {}
        await sleep(150)
        const rec = await probeStop(page)
        if (opt.trace === '1')
          writeFileSync(
            out.replace(/\.json$/, `.${workload}.${camera}.${name}.trace.json`),
            await browser.stopTracing(),
          )
        const row = {
          ...config,
          workload,
          camera,
          interaction: name,
          ...counts,
          ...cam,
          ...summarise(rec),
          ...extra,
        }
        results.push(row)
        console.log(
          `${config.label} ${config.mode}${config.uncapped ? ' uncapped' : ` ${config.hz}Hz`} ${workload}/${camera}/${name}: fps ${row.fps} frame p50 ${row.frameMs.p50} p95 ${row.frameMs.p95} max ${row.frameMs.max} | render p50 ${row.renderMs.p50 ?? '-'} p95 ${row.renderMs.p95 ?? '-'} | in->renderEnd p50 ${row.inputToRenderEndMs.p50 ?? '-'} p95 ${row.inputToRenderEndMs.p95 ?? '-'} | events/s ${row.inputEventsPerSec}`,
        )
      }

      // Nothing happens: is the page idle, and what does a frame cost when only the probe ticks?
      await run('idle', async () => {
        await sleep(1000)
      })

      // Pointer moves over the canvas with no button held.
      await run('hover', async () => {
        await drive(cdp, DURATION, (t) => ({
          type: 'mouseMoved',
          x: cx + 0.35 * rect.w * Math.sin(t / 400),
          y: cy + 0.3 * rect.h * Math.sin(t / 290),
          button: 'none',
          buttons: 0,
        }))
      })

      // Middle-button drag pans from anywhere.
      await run('pan', async () => {
        await cdp.send('Input.dispatchMouseEvent', {
          type: 'mouseMoved',
          x: cx,
          y: cy,
          button: 'none',
          buttons: 0,
        })
        const button = opt.panButton ?? 'middle'
        const buttons = button === 'middle' ? 4 : 1
        const from =
          button === 'middle' ? { x: cx, y: cy } : await emptySpot(page)
        await cdp.send('Input.dispatchMouseEvent', {
          type: 'mouseMoved',
          x: from.x,
          y: from.y,
          button: 'none',
          buttons: 0,
        })
        await cdp.send('Input.dispatchMouseEvent', {
          type: 'mousePressed',
          x: from.x,
          y: from.y,
          button,
          buttons,
          clickCount: 1,
        })
        await drive(cdp, DURATION, (t) => ({
          type: 'mouseMoved',
          x: from.x + 160 * Math.sin(t / 250),
          y: from.y + 110 * Math.sin(t / 180),
          button,
          buttons,
        }))
        await cdp.send('Input.dispatchMouseEvent', {
          type: 'mouseReleased',
          x: from.x,
          y: from.y,
          button,
          buttons: 0,
          clickCount: 1,
        })
      })

      // Wheel zoom about the pointer, alternating direction, 120 wheel events per second.
      await run('zoom', async () => {
        await cdp.send('Input.dispatchMouseEvent', {
          type: 'mouseMoved',
          x: cx,
          y: cy,
          button: 'none',
          buttons: 0,
        })
        // Capped runs: 120 wheel events a second, like a free-spinning wheel. Uncapped runs: 1000 small steps a second so every frame has work.
        const rate = config.uncapped ? 1000 : 120
        const step = config.uncapped ? 3 : 20
        await drive(
          cdp,
          DURATION,
          (t) => ({
            type: 'mouseWheel',
            x: cx,
            y: cy,
            deltaX: 0,
            deltaY: Math.floor(t / 400) % 2 === 0 ? -step : step,
            button: 'none',
            buttons: 0,
          }),
          rate,
        )
      })

      // Left-drag a node by its header, then release (the release commits a node.move command).
      if (counts.bridge && counts.nodes > 0) {
        await run('drag', async () => {
          // Earlier wheel input may still be draining; wait until the camera holds still.
          for (let k = 0, last = ''; k < 40; k++) {
            const now = JSON.stringify(
              await page.evaluate(() =>
                window.__dinksterTest.renderer.getViewport(),
              ),
            )
            if (now === last) break
            last = now
            await sleep(250)
          }
          await setCamera(page, camera)
          let header
          for (let attempt = 0; attempt < 6 && !header; attempt++) {
            const candidate = await centreNodeHeader(page, attempt)
            if (!candidate) break
            await cdp.send('Input.dispatchMouseEvent', {
              type: 'mouseMoved',
              x: candidate.x,
              y: candidate.y,
              button: 'none',
              buttons: 0,
            })
            await sleep(100)
            await cdp.send('Input.dispatchMouseEvent', {
              type: 'mousePressed',
              x: candidate.x,
              y: candidate.y,
              button: 'left',
              buttons: 1,
              clickCount: 1,
            })
            await cdp.send('Input.dispatchMouseEvent', {
              type: 'mouseMoved',
              x: candidate.x + 12,
              y: candidate.y + 9,
              button: 'left',
              buttons: 1,
            })
            await sleep(120)
            // Proceed only when the renderer is carrying this node: that is a node drag and nothing else.
            if (
              await page.evaluate(
                (id) =>
                  window.__dinksterTest.renderer
                    .getOverlay()
                    .dragOffsets?.has(id) === true,
                candidate.id,
              )
            )
              header = candidate
            else {
              await cdp.send('Input.dispatchMouseEvent', {
                type: 'mouseReleased',
                x: candidate.x + 12,
                y: candidate.y + 9,
                button: 'left',
                buttons: 0,
                clickCount: 1,
              })
              await page.keyboard.press('Escape')
              await sleep(200)
            }
          }
          if (!header) return { skipped: 'no node could be picked up' }
          await probeStart(page)
          await drive(cdp, DURATION, (t) => ({
            type: 'mouseMoved',
            x: header.x + 140 * Math.sin(t / 250),
            y: header.y + 90 * Math.sin(t / 180),
            button: 'left',
            buttons: 1,
          }))
          const end = { x: header.x + 60, y: header.y + 40 }
          await cdp.send('Input.dispatchMouseEvent', {
            type: 'mouseMoved',
            ...end,
            button: 'left',
            buttons: 1,
          })
          await sleep(60)
          // Release: time from the pointerup to the end of the first render that follows the commit.
          const release = page.evaluate(
            () =>
              new Promise((resolve) => {
                const P = window.__probe
                const before = P.renders.length
                window.addEventListener(
                  'pointerup',
                  (e) => {
                    const t0 = e.timeStamp
                    const handled = performance.now()
                    queueMicrotask(() => {
                      const sync = performance.now()
                      const wait = () => {
                        if (P.renders.length > before)
                          resolve({
                            queueMs: handled - t0,
                            handlerMs: sync - handled,
                            toRenderEndMs: P.renders[P.renders.length - 1] - t0,
                          })
                        else requestAnimationFrame(wait)
                      }
                      requestAnimationFrame(wait)
                    })
                  },
                  { capture: true, once: true },
                )
              }),
          )
          await cdp.send('Input.dispatchMouseEvent', {
            type: 'mouseReleased',
            ...end,
            button: 'left',
            buttons: 0,
            clickCount: 1,
          })
          const dropped = await Promise.race([
            release,
            sleep(3000).then(() => ({ timeout: true })),
          ])
          const moved = await page.evaluate(
            (id) =>
              window.__dinksterTest.renderer
                .getScene()
                .nodes.find((n) => n.id === id)?.x,
            header.id,
          )
          return {
            drop: dropped,
            draggedNode: header.id,
            nodeXBefore: header.worldX,
            nodeXAfter: moved,
            dragValid: moved !== header.worldX && dropped.timeout !== true,
          }
        })
      }
      // Ctrl-drag on empty canvas sweeps a selection marquee.
      await run('marquee', async () => {
        const spot = await emptySpot(page)
        await cdp.send('Input.dispatchMouseEvent', {
          type: 'mouseMoved',
          x: spot.x,
          y: spot.y,
          button: 'none',
          buttons: 0,
        })
        await cdp.send('Input.dispatchMouseEvent', {
          type: 'mousePressed',
          x: spot.x,
          y: spot.y,
          button: 'left',
          buttons: 1,
          clickCount: 1,
          modifiers: 2,
        })
        await drive(cdp, DURATION, (t) => ({
          type: 'mouseMoved',
          x: spot.x + 200 + 180 * Math.sin(t / 250),
          y: spot.y + 150 + 120 * Math.sin(t / 180),
          button: 'left',
          buttons: 1,
          modifiers: 2,
        }))
        await cdp.send('Input.dispatchMouseEvent', {
          type: 'mouseReleased',
          x: spot.x + 5,
          y: spot.y + 5,
          button: 'left',
          buttons: 0,
          clickCount: 1,
          modifiers: 2,
        })
        return { emptySpotClear: spot.clear }
      })
    }
  } catch (error) {
    console.log(
      `${config.label} ${workload}: FAILED ${String(error).slice(0, 300)}`,
    )
    results.push({ ...config, workload, error: String(error) })
  } finally {
    await browser.close()
  }
}
writeFileSync(out, JSON.stringify(results, null, 1))
console.log(`wrote ${out}`)
