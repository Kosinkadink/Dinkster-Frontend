// Clicking into a number, text or seed row moves nothing drawn in it: the
// label, the value, a seed's mode icon and the steppers stay on the pixels
// the canvas drew them on, at normal size and zoomed in. Only the outline
// and the cursor appear.
import { expect, test, waitForStartupOwnership, type Page } from './fixtures.js'

type Clip = { x: number; y: number; width: number; height: number }
/** One run of ink along the row, such as a word or an icon: its centre of ink. */
type Mark = { x: number; y: number }

test.beforeEach(async ({ page }) => {
  await page.route('/system_stats', (route) => route.fulfill({ json: { system: { os: 'e2e' }, devices: [] } }))
  await page.route('/object_info', (route) => route.fulfill({ json: {} }))
  await page.goto('/')
  await expect(page.getByTestId('status-bar')).toContainText(/\d+ node schemas/, { timeout: 15_000 })
  await waitForStartupOwnership(page)
  await page.evaluate(async () => {
    const app = window.__dinksterTest!.app
    app.registerSchemas([{
      type: 'StillFieldProof',
      displayName: 'Still field proof',
      category: 'proof',
      source: 'v3',
      isOutputNode: false,
      items: [
        { kind: 'input', id: 'steps', type: { kind: 'concrete', name: 'INT' }, optional: false,
          widget: { widgetType: 'INT', options: { min: 1, max: 10000 }, default: 20 } },
        { kind: 'input', id: 'filename_prefix', type: { kind: 'concrete', name: 'STRING' }, optional: false,
          widget: { widgetType: 'STRING', options: {}, default: 'Dinkster' } },
        { kind: 'input', id: 'seed', type: { kind: 'concrete', name: 'INT' }, optional: false,
          widget: { widgetType: 'INT', options: { min: 0, max: 9007199254740991 }, default: 42,
            controller: 'after_generate', controllerInitial: 'fixed' } },
      ],
    }])
    await app.openDocument({
      format: 'dinkster-workflow',
      formatVersion: 1,
      lineage: 'still-field-proof',
      root: 'g0',
      graphs: { g0: {
        id: 'g0', name: 'root',
        nodes: { proof: { id: 'proof', type: 'StillFieldProof', values: { steps: 20, filename_prefix: 'Dinkster', seed: 42 }, controllers: { seed: 'fixed' } } },
        links: {}, nets: {}, reroutes: {}, nextOrdinal: 2,
      } },
      view: { graphs: { g0: { nodes: { proof: { position: { x: 24, y: 40 } } } } } },
    }, 'Still field proof')
  })
  await page.waitForFunction(() => {
    const tab = window.__dinksterTest!.app.activeTab()
    return tab?.store.doc.lineage === 'still-field-proof' &&
      'status' in tab.store && (tab.store.status as { get(): string }).get() === 'live'
  })
  // A backend without some starter nodes reports them once; that notice is not under test.
  const close = page.getByRole('button', { name: 'Close', exact: true })
  if (await close.isVisible()) await close.click()
  // The cursor is not under test.
  await page.addStyleTag({ content: 'input { caret-color: transparent !important; }' })
})

/** The row's box on screen at a zoom, inset past the open field's outline. */
async function rowClip(page: Page, key: string, scale: number): Promise<Clip> {
  return page.evaluate(([key, scale]) => {
    const renderer = window.__dinksterTest!.renderer!
    renderer.setViewport({ x: 0, y: 0, scale })
    ;(renderer as unknown as { renderNow(): void }).renderNow()
    const node = renderer.getScene().nodes.find((item) => item.id === 'proof')!
    const row = node.layout.rows.find((item) => item.kind === 'widget' && item.inputId === key)! as
      { inset: number; y: number; width?: number; height: number }
    const canvas = document.querySelector('[data-testid=graph-canvas]')!.getBoundingClientRect()
    const inset = 3 * scale
    return {
      x: canvas.left + (node.x + row.inset) * scale + inset,
      y: canvas.top + (node.y + row.y) * scale + inset,
      width: (row.width ?? node.layout.width - row.inset * 2) * scale - inset * 2,
      height: row.height * scale - inset * 2,
    }
  }, [key, scale] as const)
}

/** The runs of ink across the clip, left to right, each by its centre of ink. */
async function marks(page: Page, clip: Clip): Promise<Mark[]> {
  const png = await page.screenshot({ clip })
  return page.evaluate(async (base64) => {
    const bitmap = await createImageBitmap(await (await fetch(`data:image/png;base64,${base64}`)).blob())
    const context = new OffscreenCanvas(bitmap.width, bitmap.height).getContext('2d')!
    context.drawImage(bitmap, 0, 0)
    const { data, width, height } = context.getImageData(0, 0, bitmap.width, bitmap.height)
    const light = Array.from({ length: width * height }, (_, index) =>
      0.299 * data[index * 4]! + 0.587 * data[index * 4 + 1]! + 0.114 * data[index * 4 + 2]!)
    const background = [...light].sort((a, b) => a - b)[Math.floor(light.length / 2)]!
    const ink = (x: number, y: number) => Math.abs(light[y * width + x]! - background)
    const inked = (x: number) => { for (let y = 0; y < height; y++) if (ink(x, y) > 60) return true; return false }
    const found: { x: number; y: number }[] = []
    let x = 0
    while (x < width) {
      if (!inked(x)) { x++; continue }
      // A run ends after five columns without ink, so a word stays one run.
      let end = x
      for (let next = x; next < width && next - end <= 5; next++) if (inked(next)) end = next
      let weight = 0, sumX = 0, sumY = 0
      for (let column = x; column <= end; column++) {
        for (let y = 0; y < height; y++) {
          const amount = ink(column, y)
          if (amount > 20) { weight += amount; sumX += amount * column; sumY += amount * y }
        }
      }
      found.push({ x: sumX / weight, y: sumY / weight })
      x = end + 1
    }
    return found
  }, png.toString('base64'))
}

for (const scale of [1, 1.5, 2]) {
  test(`clicking into a number, text or seed row moves nothing in it at ${scale * 100} percent`, async ({ page }) => {
    for (const key of ['steps', 'filename_prefix', 'seed']) {
      const clip = await rowClip(page, key, scale)
      await page.mouse.move(1, 1)
      const closed = await marks(page, clip)
      expect(closed.length, `${key}: label and value are found`).toBeGreaterThanOrEqual(2)

      await page.mouse.click(clip.x + clip.width * 0.3, clip.y + clip.height / 2)
      const input = page.getByTestId('widget-editor').locator('input')
      await expect(input).toBeFocused()
      // A number opens selected; the selection's colour is not under test.
      await input.evaluate((element: HTMLInputElement) => element.setSelectionRange(element.value.length, element.value.length))
      await page.mouse.move(1, 1)
      const open = await marks(page, clip)

      expect(open.length, `${key}: the same runs of ink`).toBe(closed.length)
      // Canvas and page draw the same glyphs a little differently; a moved
      // glyph shifts its centre by a whole pixel.
      for (const [index, mark] of open.entries()) {
        expect(Math.abs(mark.x - closed[index]!.x), `${key}: run ${index} across`).toBeLessThan(0.75)
        expect(Math.abs(mark.y - closed[index]!.y), `${key}: run ${index} down`).toBeLessThan(0.75)
      }
      await input.press('Escape')
      await page.keyboard.press('Escape')
    }
  })
}
