import { mkdir } from 'node:fs/promises'
import { expect, test, type Page } from './fixtures.js'

const proofDir = '/tmp/audit-g-trailing-proof'

test.beforeEach(async ({ page }) => {
  await page.route('/system_stats', (route) =>
    route.fulfill({ json: { system: { os: 'e2e' }, devices: [] } }),
  )
  await page.route('/object_info', (route) => route.fulfill({ json: {} }))
  await page.goto('/')
  await expect(page.getByTestId('queue-button')).toBeEnabled({ timeout: 15_000 })
  await page.evaluate(() => {
    const numeric = (id: string, controller = false) => ({
      kind: 'input', id, type: { kind: 'concrete', name: 'INT' }, optional: false,
      widget: {
        widgetType: 'INT', options: { min: 0, max: 100, step: 1 }, default: 7,
        ...(controller ? { controller: 'after_generate' } : {}),
      },
    })
    const test = window.__dinksterTest!
    test.app.registerSchemas([{
      type: 'TrailingActionsE2E', displayName: 'Trailing actions', category: 'test', source: 'v3', isOutputNode: false,
      items: [
        numeric('seed', true),
        numeric('steps'),
        {
          kind: 'input', id: 'sampler', type: { kind: 'concrete', name: 'core.combo' }, optional: false,
          widget: { widgetType: 'COMBO', options: { options: ['a-very-long-sampler-option', 'euler'] }, default: 'a-very-long-sampler-option' },
        },
      ],
    }])
    test.app.openDocument({
      format: 'dinkster-workflow', formatVersion: 1, lineage: 'trailing-actions', root: 'g0',
      graphs: { g0: { id: 'g0', name: 'root', nodes: {
        n0: {
          id: 'n0', type: 'TrailingActionsE2E',
          values: { seed: 7, steps: 20, sampler: 'a-very-long-sampler-option' },
          controllers: { seed: 'fixed' },
        },
      }, links: {}, nets: {}, reroutes: {}, nextOrdinal: 2 } },
      view: { graphs: { g0: { nodes: { n0: { position: { x: 100, y: 100 }, size: { width: 220, height: 116 } } } } } },
    }, 'Trailing actions')
    test.renderer!.setViewport({ x: 20, y: 10, scale: 1 })
  })
  await expect.poll(() => page.evaluate(() => window.__dinksterTest!.renderer!.getScene().nodes
    .find((node) => node.id === 'n0')?.layout.rows.filter((row) => row.kind === 'widget').length)).toBe(3)
})

async function assertGeometry(page: Page) {
  return page.evaluate(() => {
    const renderer = window.__dinksterTest!.renderer! as unknown as { renderNow(): void; getScene(): any }
    const node = renderer.getScene().nodes.find((candidate: any) => candidate.id === 'n0')!
    const rows = Object.fromEntries(node.layout.rows.filter((row: any) => row.kind === 'widget').map((row: any) => [row.inputId, row]))
    const paths: Array<Array<{ x: number; y: number }>> = []
    const fills: Array<{ x: number; y: number; width: number; height: number }> = []
    const texts: Array<{ text: string; x: number; y: number; align: CanvasTextAlign }> = []
    let current: Array<{ x: number; y: number }> = []
    const prototype = CanvasRenderingContext2D.prototype
    const original = {
      beginPath: prototype.beginPath,
      moveTo: prototype.moveTo,
      lineTo: prototype.lineTo,
      stroke: prototype.stroke,
      fillRect: prototype.fillRect,
      fillText: prototype.fillText,
    }
    prototype.beginPath = function () { current = []; return original.beginPath.call(this) }
    prototype.moveTo = function (x, y) { current.push({ x, y }); return original.moveTo.call(this, x, y) }
    prototype.lineTo = function (x, y) { current.push({ x, y }); return original.lineTo.call(this, x, y) }
    prototype.stroke = function () {
      if (current.length > 0) paths.push([...current])
      return (original.stroke as () => void).call(this)
    }
    prototype.fillRect = function (x, y, width, height) {
      fills.push({ x, y, width, height })
      return original.fillRect.call(this, x, y, width, height)
    }
    prototype.fillText = function (text, x, y, maxWidth) {
      texts.push({ text, x, y, align: this.textAlign })
      return maxWidth === undefined
        ? original.fillText.call(this, text, x, y)
        : original.fillText.call(this, text, x, y, maxWidth)
    }
    try {
      renderer.renderNow()
    } finally {
      prototype.beginPath = original.beginPath
      prototype.moveTo = original.moveTo
      prototype.lineTo = original.lineTo
      prototype.stroke = original.stroke
      prototype.fillRect = original.fillRect
      prototype.fillText = original.fillText
    }
    const geometry = (row: any) => {
      const left = node.x + row.inset
      const right = node.x + node.layout.width - row.inset
      const middle = node.y + row.y + row.height / 2
      return { left, right, middle }
    }
    const seed = geometry(rows.seed)
    const steps = geometry(rows.steps)
    const sampler = geometry(rows.sampler)
    const chips = fills.filter((fill) => fill.y === node.y + rows.seed.y + 4 && fill.width === 16 && fill.height === 16)
    const pluses = paths.filter((path) => path.length === 4 && path[0]?.y === steps.middle && path[1]?.y === steps.middle)
    const carets = paths.filter((path) => path.length === 3 && path[0]?.y === sampler.middle - 2)
    const samplerValues = texts.filter((text) => text.y === sampler.middle && text.align === 'right')
    return { seed, steps, sampler, chip: chips[0]!, plus: pluses[0]!, caret: carets[0]!, valueText: samplerValues[0]!, counts: { chips: chips.length, pluses: pluses.length, carets: carets.length, samplerValues: samplerValues.length }, width: node.layout.width }
  })
}

test('shared trailing actions keep source-backed clearance and edge alignment', async ({ page }) => {
  await mkdir(proofDir, { recursive: true })
  for (const scale of [0.75, 1, 1.5]) {
    await page.evaluate((nextScale) => window.__dinksterTest!.renderer!.setViewport({ x: 20, y: 10, scale: nextScale }), scale)
    const geometry = await assertGeometry(page)
    expect(geometry.counts).toEqual({ chips: 1, pluses: 1, carets: 1, samplerValues: 1 })
    expect(geometry.seed.right - 12 - (geometry.chip.x + geometry.chip.width)).toBe(6)
    expect(geometry.plus[0]!.x).toBe(geometry.steps.right - 9)
    expect(geometry.plus[1]!.x).toBe(geometry.steps.right - 3)
    expect(geometry.caret.map((point: { x: number }) => point.x)).toEqual([
      geometry.sampler.right - 9,
      geometry.sampler.right - 6,
      geometry.sampler.right - 3,
    ])
    expect(geometry.valueText.x).toBe(geometry.sampler.right - 14)
    expect(geometry.plus[0]!.x - (geometry.chip.x + geometry.chip.width)).toBe(9)
    await page.screenshot({ path: `${proofDir}/zoom-${scale}.png`, animations: 'disabled' })
  }

  await page.evaluate(() => {
    const test = window.__dinksterTest!
    const tab = test.app.activeTab()!
    const node = test.renderer!.getScene().nodes.find((candidate) => candidate.id === 'n0')!
    tab.store.dispatch({
      command: 'view.setNodeSize',
      params: { graphId: tab.store.doc.root, nodeId: 'n0', size: { width: 150, height: node.layout.height } },
    })
    test.renderer!.setViewport({ x: 20, y: 10, scale: 1 })
  })
  await expect.poll(() => page.evaluate(() => window.__dinksterTest!.renderer!.getScene().nodes
    .find((node) => node.id === 'n0')?.layout.width)).toBe(150)
  const narrow = await assertGeometry(page)
  expect(narrow.counts).toEqual({ chips: 1, pluses: 1, carets: 1, samplerValues: 1 })
  expect(narrow.seed.right - 12 - (narrow.chip.x + narrow.chip.width)).toBe(6)
  expect(narrow.plus[0]!.x - (narrow.chip.x + narrow.chip.width)).toBe(9)
  expect(narrow.caret[1]!.x).toBe(narrow.sampler.right - 6)
  expect(narrow.valueText.x).toBe(narrow.sampler.right - 14)
  await page.screenshot({ path: `${proofDir}/narrow.png`, animations: 'disabled' })
})
