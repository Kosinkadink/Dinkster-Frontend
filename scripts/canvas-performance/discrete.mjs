// Click-type interactions for comfy-vibe-station#1037: time from the press to the frame that shows the result.
// Usage: node scripts/canvas-performance/discrete.mjs label=prod url=... mode=gpu uncapped=1 workload=trellis66 out=.amp/in/clicks.json
// Report only: first-frame targets are <8 ms through 300 nodes, <16 ms at 1200;
// menus, panels and rails target <16 ms. Three measured samples follow one warmup.
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  LANE,
  launch,
  waitForApp,
  loadWorkload,
  setCamera,
  installProbe,
  canvasRect,
  centreNodeHeader,
  emptySpot,
  sleep,
  stats,
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
const REPS = Number(opt.reps ?? 3)
const out = join(LANE, opt.out ?? `.amp/in/canvas-clicks-${config.label}.json`)
mkdirSync(dirname(out), { recursive: true })

const { browser, page, cdp } = await launch(config)
try {
  await waitForApp(page, config.url)
  const counts = await loadWorkload(page, opt.workload ?? 'default7')
  await installProbe(page)
  await setCamera(page, 'read')

  await page.evaluate(() => {
    const D = (window.__discrete = {
      armed: false,
      t0: 0,
      type: '',
      firstChange: 0,
      firstFrameEnd: 0,
      lastChange: 0,
      eventTiming: [],
    })
    const arm = (e) => {
      if (!D.armed) return
      D.armed = false
      D.t0 = e.timeStamp
      D.handlerStart = performance.now()
      D.type = e.type
      D.firstChange = 0
      D.firstFrameEnd = 0
      D.lastChange = 0
      D.watching = true
    }
    window.addEventListener('pointerdown', arm, { capture: true })
    window.addEventListener('wheel', arm, { capture: true, passive: true })
    window.addEventListener('keydown', arm, { capture: true })
    const changed = (fromRender) => {
      if (!D.watching) return
      const now = performance.now()
      D.lastChange = now
      // Count only the change the user is waiting for: the named element appearing, or a canvas repaint.
      const shown =
        D.selector === 'render'
          ? fromRender === true
          : document.querySelector(D.selector) !== null
      if (D.firstChange === 0 && shown) {
        D.firstChange = now
        // The frame that contains the first visible change ends after its rAF callbacks; one more rAF marks the frame after it.
        requestAnimationFrame(() => {
          Promise.resolve().then(() => {
            D.firstFrameEnd = performance.now()
          })
        })
      }
    }
    new MutationObserver(() => changed(false)).observe(
      document.documentElement,
      { childList: true, subtree: true, attributes: true, characterData: true },
    )
    const r = window.__dinksterTest?.renderer
    if (r) {
      const original = r.render
      r.render = function () {
        const v = original.apply(this, arguments)
        changed(true)
        return v
      }
    }
    new PerformanceObserver((list) => {
      for (const e of list.getEntries())
        D.eventTiming.push({
          name: e.name,
          start: e.startTime,
          duration: e.duration,
          processingStart: e.processingStart,
          processingEnd: e.processingEnd,
          interactionId: e.interactionId,
        })
    }).observe({ type: 'event', durationThreshold: 16, buffered: false })
  })

  const press = async (selector, x, y, button = 'left', clicks = 1) => {
    const buttons = button === 'left' ? 1 : 2
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x,
      y,
      button: 'none',
      buttons: 0,
    })
    await sleep(120)
    await page.evaluate((selector) => {
      window.__discrete.selector = selector
      window.__discrete.armed = true
    }, selector)
    for (let c = 1; c <= clicks; c++) {
      await cdp.send('Input.dispatchMouseEvent', {
        type: 'mousePressed',
        x,
        y,
        button,
        buttons,
        clickCount: c,
      })
      await cdp.send('Input.dispatchMouseEvent', {
        type: 'mouseReleased',
        x,
        y,
        button,
        buttons: 0,
        clickCount: c,
      })
    }
  }
  const read = async () => {
    await sleep(700)
    return await page.evaluate(() => {
      const D = window.__discrete
      D.watching = false
      const timing = D.eventTiming.filter(
        (e) => e.start >= D.t0 - 1 && e.start <= D.t0 + 400,
      )
      D.eventTiming.length = 0
      return {
        queueMs: D.handlerStart - D.t0,
        toFirstChangeMs: D.firstChange ? D.firstChange - D.t0 : null,
        toFirstFrameMs: D.firstFrameEnd ? D.firstFrameEnd - D.t0 : null,
        toSettledMs: D.lastChange ? D.lastChange - D.t0 : null,
        eventTimingMs: timing.length
          ? Math.max(...timing.map((e) => e.duration))
          : null,
      }
    })
  }
  const centre = async (locator) => {
    const b = await locator.first().boundingBox()
    if (!b) throw new Error('no box')
    return { x: b.x + b.width / 2, y: b.y + b.height / 2 }
  }
  const escape = async () => {
    await page.keyboard.press('Escape')
    await sleep(250)
  }

  const rect = await canvasRect(page)
  const scenarios = {
    // Select a node by clicking its header (canvas repaint, selection toolbox).
    'select node': async () => {
      const h = await centreNodeHeader(page)
      await press('render', h.x, h.y)
      return async () => {
        const e = await emptySpot(page)
        await cdp.send('Input.dispatchMouseEvent', {
          type: 'mousePressed',
          x: e.x,
          y: e.y,
          button: 'left',
          buttons: 1,
          clickCount: 1,
        })
        await cdp.send('Input.dispatchMouseEvent', {
          type: 'mouseReleased',
          x: e.x,
          y: e.y,
          button: 'left',
          buttons: 0,
          clickCount: 1,
        })
      }
    },
    // Right-click a node: context menu.
    'node context menu': async () => {
      const h = await centreNodeHeader(page)
      await press('[role=menu]', h.x, h.y, 'right')
      return escape
    },
    // Right-click empty canvas: context menu.
    'canvas context menu': async () => {
      const e = await emptySpot(page)
      await press('[role=menu]', e.x, e.y, 'right')
      return escape
    },
    // Double-click empty canvas: node search palette.
    'node palette (double-click)': async () => {
      const e = await emptySpot(page)
      await press('[data-testid=palette-backdrop]', e.x, e.y, 'left', 2)
      return escape
    },
    // Left rail: open and close the Library panel.
    'open Library panel': async () => {
      const p = await centre(page.getByRole('button', { name: /^Library/ }))
      await press('[data-testid=dock-panel]', p.x, p.y)
      return async () => {
        await page.mouse.click(p.x, p.y)
        await sleep(300)
      }
    },
    'open Assets panel': async () => {
      const p = await centre(page.getByRole('button', { name: /^Assets/ }))
      await press('[data-testid=dock-panel]', p.x, p.y)
      return async () => {
        await page.mouse.click(p.x, p.y)
        await sleep(300)
      }
    },
    // Top bar: the Dinkster menu.
    'open Dinkster menu': async () => {
      const p = await centre(page.getByTestId('dinkster-menu-button'))
      await press('[role=menu]', p.x, p.y)
      return escape
    },
    // Settings dialog.
    'open Settings': async () => {
      const p = await centre(page.getByTestId('settings-button'))
      await press('[data-testid=modal-surface]', p.x, p.y)
      return escape
    },
    // Right rail toggle (resizes the canvas).
    'toggle right rail': async () => {
      const p = await centre(
        page.getByRole('button', { name: /^Toggle right rail/ }),
      )
      await press('render', p.x, p.y)
      return async () => {
        await page.mouse.click(p.x, p.y)
        await sleep(300)
      }
    },
    // Graph toolbar dropdown.
    'open Queue menu': async () => {
      const p = await centre(page.getByRole('button', { name: /No jobs|jobs/ }))
      await press('.workflow-queue-popover', p.x, p.y)
      return escape
    },
  }

  const results = []
  for (const [name, body] of Object.entries(scenarios)) {
    if (opt.only && !opt.only.split(',').includes(name)) continue
    const samples = []
    let failure
    for (let i = 0; i < REPS + 1; i++) {
      try {
        const undo = await body()
        const sample = await read()
        if (i > 0)
          samples.push(sample) // first repetition warms caches and lazy chunks; reported separately
        else
          results.push({
            ...config,
            workload: opt.workload ?? 'default7',
            interaction: name,
            first: sample,
          })
        await undo()
        await sleep(200)
      } catch (error) {
        failure = String(error).slice(0, 160)
        break
      }
    }
    const col = (k) =>
      stats(
        samples.map((s) => s[k]).filter((v) => v !== null && v !== undefined),
      )
    const row = {
      ...config,
      ...counts,
      workload: opt.workload ?? 'default7',
      interaction: name,
      n: samples.length,
      failure,
      queueMs: col('queueMs'),
      toFirstChangeMs: col('toFirstChangeMs'),
      toFirstFrameMs: col('toFirstFrameMs'),
      toSettledMs: col('toSettledMs'),
      eventTimingMs: col('eventTimingMs'),
    }
    results.push(row)
    console.log(
      `${config.label} ${config.mode} ${config.uncapped ? 'uncapped' : config.hz + 'Hz'} ${row.workload} | ${name}: n ${row.n} first-frame p50 ${row.toFirstFrameMs.p50} max ${row.toFirstFrameMs.max} | settled p50 ${row.toSettledMs.p50} max ${row.toSettledMs.max} | EventTiming p50 ${row.eventTimingMs.p50 ?? '<16'} max ${row.eventTimingMs.max ?? '<16'} ${failure ?? ''}`,
    )
  }
  writeFileSync(out, JSON.stringify(results, null, 1))
} finally {
  await browser.close()
}
