import { expect, test, type Page } from './fixtures.js'

async function drag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }): Promise<void> {
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2)
  await page.mouse.move(to.x, to.y)
  await page.mouse.up()
}

test('widget tap drag creates a tap-sourced link and undo removes it', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByTestId('status-bar')).toContainText(/\d+ node schemas/, { timeout: 15_000 })

  const points = await page.evaluate(() => {
    const bridge = window.__dinksterTest!
    bridge.app.registerSchemas([
      {
        type: 'TapWidget', displayName: 'Tap Widget', category: 'test', source: 'v3', isOutputNode: false,
        items: [{
          kind: 'input', id: 'amount', type: { kind: 'concrete', name: 'FLOAT' }, optional: true,
          widget: { widgetType: 'FLOAT', options: {}, default: 1 },
        }],
      },
      {
        type: 'TapSink', displayName: 'Tap Sink', category: 'test', source: 'v3', isOutputNode: false,
        items: [{ kind: 'input', id: 'value', type: { kind: 'concrete', name: 'FLOAT' }, optional: false }],
      },
    ])
    const failures = bridge.app.openDocument({
      format: 'dinkster-workflow', formatVersion: 1, lineage: 'widget-tap-e2e', root: 'g0',
      graphs: { g0: { id: 'g0', name: 'root', nodes: {
        source: { id: 'source', type: 'TapWidget', values: { amount: 2 } },
        sink: { id: 'sink', type: 'TapSink', values: {} },
      }, links: {}, nets: {}, reroutes: {}, nextOrdinal: 1 } },
      view: { graphs: { g0: { nodes: {
        source: { position: { x: 100, y: 160 } }, sink: { position: { x: 500, y: 160 } },
      } } } },
    }, 'Widget Tap')
    if (failures.length) throw new Error(`openDocument failed: ${JSON.stringify(failures)}`)

    const renderer = bridge.renderer!
    renderer.setViewport({ x: 0, y: 0, scale: 1 })
    const source = renderer.getScene().nodes.find((node) => node.id === 'source')!
    const sink = renderer.getScene().nodes.find((node) => node.id === 'sink')!
    const tap = source.layout.pins.find((pin) =>
      pin.portId === 'amount' && pin.direction === 'out' && (pin as { widgetTap?: true }).widgetTap === true)!
    const input = sink.layout.pins.find((pin) => pin.portId === 'value' && pin.direction === 'in')!
    const rect = document.querySelector('[data-testid=graph-canvas]')!.getBoundingClientRect()
    const point = (x: number, y: number) => ({ x: rect.left + x, y: rect.top + y })
    return {
      hover: point(source.x + source.layout.width / 2, source.y + source.layout.headerHeight + 4),
      tap: point(source.x + source.layout.width, source.y + tap.y),
      input: point(sink.x, sink.y + input.y),
    }
  })

  // Hovering the source reveals its otherwise hidden tap before pointerdown.
  await page.mouse.move(points.hover.x, points.hover.y)
  await drag(page, points.tap, points.input)

  const links = await page.evaluate(() =>
    Object.values(window.__dinksterTest!.app.activeTab()!.store.doc.graphs.g0!.links))
  expect(links).toHaveLength(1)
  expect(links[0]!.from).toEqual({ node: 'source', tap: 'amount' })
  expect(links[0]!.to).toEqual({ node: 'sink', port: 'value' })

  await page.keyboard.press('Control+z')
  expect(await page.evaluate(() =>
    Object.keys(window.__dinksterTest!.app.activeTab()!.store.doc.graphs.g0!.links))).toEqual([])
})
