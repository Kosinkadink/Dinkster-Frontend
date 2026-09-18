import { expect, test } from './fixtures.js'

test('a selected tall node keeps its outline aligned past the viewport edge', async ({ page }, testInfo) => {
  await page.goto('/')
  await expect.poll(() => page.evaluate(() => window.__dinksterTest !== undefined)).toBe(true)

  await page.evaluate(() => {
    const items = Array.from({ length: 36 }, (_, index) => ({
      kind: 'input' as const,
      id: `value_${index}`,
      type: { kind: 'concrete' as const, name: 'FLOAT' },
      optional: false,
      widget: { widgetType: 'FLOAT' as const, options: { min: 0, max: 1 }, default: index / 36 },
    }))
    window.__dinksterTest!.app.registerSchemas([{
      type: 'TallSelectionProof',
      displayName: 'Tall selected node',
      category: 'test',
      source: 'v3',
      isOutputNode: false,
      items: [
        { kind: 'input', id: 'image', type: { kind: 'concrete', name: 'IMAGE' }, optional: false },
        ...items,
        { kind: 'output', id: 'result', type: { kind: 'concrete', name: 'IMAGE' } },
      ],
    }])
    window.__dinksterTest!.app.openDocument({
      format: 'dinkster-workflow',
      formatVersion: 1,
      lineage: 'selection-outline-proof',
      root: 'g0',
      graphs: {
        g0: {
          id: 'g0',
          name: 'Selection outline proof',
          nodes: {
            tall: {
              id: 'tall',
              type: 'TallSelectionProof',
              values: Object.fromEntries(items.map((item, index) => [item.id, index / 36])),
            },
          },
          links: {},
          nets: {},
          reroutes: {},
          nextOrdinal: 2,
        },
      },
      view: { graphs: { g0: { nodes: { tall: { position: { x: 260, y: 45 } } } } } },
    }, 'Selection outline proof')
  })

  await expect.poll(() => page.evaluate(() =>
    window.__dinksterTest!.renderer!.getScene().nodes.find((node) => node.id === 'tall')?.layout.height ?? 0,
  )).toBeGreaterThan(850)

  await page.evaluate(() => {
    window.__dinksterTest!.renderer!.setViewport({ x: 0, y: 0, scale: 1 })
    window.__dinksterTest!.controller!.setSelection(['tall'])
  })
  await expect(page.getByTestId('graph-canvas')).toHaveAttribute('data-selection', '1')

  const canvas = page.getByTestId('graph-canvas')
  const geometry = await page.evaluate(() => {
    const node = window.__dinksterTest!.renderer!.getScene().nodes.find((candidate) => candidate.id === 'tall')!
    const rect = document.querySelector('[data-testid=graph-canvas]')!.getBoundingClientRect()
    return { nodeBottom: node.y + node.layout.height, viewportBottom: rect.height }
  })
  expect(geometry.nodeBottom).toBeGreaterThan(geometry.viewportBottom)

  const screenshotPath = process.env['SELECTION_OUTLINE_SHOT'] ?? testInfo.outputPath('selection-outline.png')
  await canvas.screenshot({ path: screenshotPath })
})
