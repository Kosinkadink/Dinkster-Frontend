import { mkdir } from 'node:fs/promises'
import { expect, test, type Page } from '@playwright/test'

const PROOF_DIR = '/tmp/audit-ae-proof'
const RANGE_FILL = 'rgba(120, 174, 229, 0.18)'
const advertisedWires: string[] = []

const numberInput = (id: string, display?: string, displayName?: string) => ({
  role: 'input', id, required: true,
  type: { kind: 'concrete', types: ['core.float'] },
  ...(displayName === undefined ? {} : { displayName }),
  widget: {
    type: 'NUMBER', min: 0, max: 100, step: 1,
    ...(display === undefined ? {} : { display }),
  },
})

const catalog = {
  schemaVersion: 1,
  epoch: 1,
  dinkster: { version: 'audit-number-display-proof', schemaWire: 1 },
  nodes: {
    'test.number_display': {
      schemaVersion: 1,
      displayName: 'NUMBER display wire 18',
      category: 'test',
      interface: [
        numberInput('declared_slider', 'slider', 'Declared slider with a deliberately very long label'),
        numberInput('bounded_ordinary'),
        numberInput('explicit_number', 'number'),
        numberInput('knob_fallback', 'knob'),
        numberInput('gradient_fallback', 'gradientslider'),
      ],
    },
  },
}

async function rangePaint(page: Page) {
  return page.evaluate(({ rangeFill }) => {
    const renderer = window.__dinksterTest!.renderer! as unknown as { renderNow(): void; getScene(): any }
    const node = renderer.getScene().nodes.find((candidate: any) => candidate.id === 'numbers')!
    const rows = Object.fromEntries(node.layout.rows
      .filter((row: any) => row.kind === 'widget')
      .map((row: any) => [row.inputId, row]))
    const events: Array<Record<string, unknown>> = []
    let serial = 0
    let path: Record<string, number> | undefined
    let clip: Record<string, number> | undefined
    const prototype = CanvasRenderingContext2D.prototype
    const original = {
      beginPath: prototype.beginPath,
      roundRect: prototype.roundRect,
      clip: prototype.clip,
      fillRect: prototype.fillRect,
      fillText: prototype.fillText,
    }
    prototype.beginPath = function () {
      path = undefined
      return original.beginPath.call(this)
    }
    prototype.roundRect = function (x, y, width, height, radii) {
      path = { x, y, width, height, radius: typeof radii === 'number' ? radii : -1 }
      return original.roundRect.call(this, x, y, width, height, radii)
    }
    prototype.clip = function (this: CanvasRenderingContext2D, ...args: unknown[]) {
      clip = path === undefined ? undefined : { ...path }
      return (original.clip as (...values: unknown[]) => void).apply(this, args)
    } as CanvasRenderingContext2D['clip']
    prototype.fillRect = function (x, y, width, height) {
      if (String(this.fillStyle) === rangeFill) {
        events.push({ kind: 'fill', serial: serial++, x, y, width, height, clip })
      }
      return original.fillRect.call(this, x, y, width, height)
    }
    prototype.fillText = function (text, x, y, maxWidth) {
      events.push({ kind: 'text', serial: serial++, text, x, y })
      return maxWidth === undefined
        ? original.fillText.call(this, text, x, y)
        : original.fillText.call(this, text, x, y, maxWidth)
    }
    try {
      renderer.renderNow()
    } finally {
      prototype.beginPath = original.beginPath
      prototype.roundRect = original.roundRect
      prototype.clip = original.clip
      prototype.fillRect = original.fillRect
      prototype.fillText = original.fillText
    }
    const row = rows.declared_slider
    return {
      events,
      expectedChrome: {
        x: node.x + row.inset,
        y: node.y + row.y + 2,
        width: node.layout.width - row.inset * 2,
        height: row.height - 4,
        radius: 4,
      },
      displays: Object.fromEntries(Object.entries(rows).map(([id, value]) =>
        [id, (value as any).spec.options.display ?? null])),
    }
  }, { rangeFill: RANGE_FILL })
}

test.beforeEach(async ({ page }) => {
  await mkdir(PROOF_DIR, { recursive: true })
  advertisedWires.length = 0
  await page.route('**/supervisor/status', (route) =>
    route.fulfill({ status: 502, contentType: 'text/plain', body: 'isolated proof: no supervisor' }),
  )
  await page.route('**/api/nodes*', (route) => {
    advertisedWires.push(new URL(route.request().url()).searchParams.get('wire') ?? '')
    return route.fulfill({ json: catalog })
  })
  await page.route('**/system_stats', (route) =>
    route.fulfill({ json: { system: { os: 'e2e' }, devices: [] } }),
  )
  await page.goto('/')
  await expect.poll(() => page.evaluate(() =>
    window.__dinksterTest?.app.backends.get()[0]?.registry.get()?.schemas.size)).toBe(1)
  expect(advertisedWires.some((wire) => wire.split(',').includes('21'))).toBe(true)
  await page.evaluate(() => {
    window.__dinksterTest!.app.openDocument({
      format: 'dinkster-workflow', formatVersion: 1, lineage: 'wire18-number-display', root: 'g0',
      graphs: { g0: { id: 'g0', name: 'root', nodes: {
        numbers: {
          id: 'numbers', type: 'test.number_display', values: {
            declared_slider: 25,
            bounded_ordinary: 50,
            explicit_number: 50,
            knob_fallback: 50,
            gradient_fallback: 50,
          },
        },
      }, links: {}, nets: {}, reroutes: {}, nextOrdinal: 2 } },
      view: { graphs: { g0: { nodes: { numbers: {
        position: { x: 100, y: 100 }, size: { width: 360, height: 164 },
      } } } } },
    }, 'Wire 18 NUMBER display')
    window.__dinksterTest!.renderer!.setViewport({ x: 20, y: 10, scale: 1 })
  })
  await page.waitForFunction(() => {
    const tab = window.__dinksterTest!.app.activeTab()
    return tab !== undefined && 'status' in tab.store
  })
  await expect.poll(() => page.evaluate(() => window.__dinksterTest!.renderer!.getScene().nodes
    .find((node) => node.id === 'numbers')?.layout.rows.filter((row) => row.kind === 'widget').length)).toBe(5)
})

test('declared slider owns whole chrome while every fallback stays ordinary', async ({ page }) => {
  const initial = await rangePaint(page)
  expect(initial.displays).toEqual({
    declared_slider: 'slider',
    bounded_ordinary: null,
    explicit_number: 'number',
    knob_fallback: 'knob',
    gradient_fallback: 'gradientslider',
  })
  const fills = initial.events.filter((event) => event.kind === 'fill')
  expect(fills).toHaveLength(1)
  expect(fills[0]).toMatchObject({
    x: initial.expectedChrome.x,
    y: initial.expectedChrome.y,
    width: initial.expectedChrome.width * 0.25,
    height: initial.expectedChrome.height,
    clip: initial.expectedChrome,
  })
  const fillSerial = fills[0]!.serial as number
  expect(initial.events.find((event) => event.kind === 'text' && String(event.text).startsWith('25'))!.serial).toBeGreaterThan(fillSerial)
  expect(initial.events.find((event) => event.kind === 'text' && String(event.text).includes('Declared slider'))!.serial).toBeGreaterThan(fillSerial)

  for (const scale of [0.75, 1, 1.5]) {
    await page.evaluate((next) => window.__dinksterTest!.renderer!.setViewport({ x: 20, y: 10, scale: next }), scale)
    const painted = await rangePaint(page)
    expect(painted.events.filter((event) => event.kind === 'fill')).toHaveLength(1)
    await page.screenshot({ path: `${PROOF_DIR}/declared-slider-long-label-zoom-${scale}.png`, animations: 'disabled' })
  }
  await page.screenshot({ path: `${PROOF_DIR}/bounded-without-display-no-fill.png`, animations: 'disabled' })
  await page.screenshot({ path: `${PROOF_DIR}/number-knob-gradient-ordinary.png`, animations: 'disabled' })

  for (const [value, name, fraction] of [[1, 'near-min', 0.01], [99, 'near-max', 0.99]] as const) {
    await page.evaluate((next) => {
      const tab = window.__dinksterTest!.app.activeTab()!
      tab.store.dispatch({
        command: 'node.setValue',
        params: { graphId: 'g0', nodeId: 'numbers', inputId: 'declared_slider', value: next },
      })
    }, value)
    await expect.poll(() => page.evaluate(() => window.__dinksterTest!.app.activeTab()!
      .store.doc.graphs.g0!.nodes.numbers!.values.declared_slider)).toBe(value)
    const painted = await rangePaint(page)
    const fill = painted.events.find((event) => event.kind === 'fill')!
    expect(fill.x).toBe(painted.expectedChrome.x)
    expect(fill.width).toBeCloseTo(painted.expectedChrome.width * fraction, 8)
    expect(fill.height).toBe(painted.expectedChrome.height)
    await page.screenshot({ path: `${PROOF_DIR}/slider-${name}.png`, animations: 'disabled' })
  }
})
