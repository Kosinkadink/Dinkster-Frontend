import { expect, test, type Page } from './fixtures.js'

const concrete = (type: string) => ({ kind: 'concrete', types: [type] })
const combo = (id: string, options: readonly string[], value: string) => ({
  role: 'input',
  id,
  required: false,
  type: concrete('core.combo'),
  default: value,
  widget: { type: 'COMBO', options },
})
const number = (id: string, type: 'core.int' | 'core.float', value: number) => ({
  role: 'input',
  id,
  required: false,
  type: concrete(type),
  default: value,
  widget: { type: 'NUMBER', min: 0 },
})

const resizeInterface = [
  { role: 'input', id: 'image', required: true, type: concrete('dinkster.image') },
  combo('target', ['dimensions', 'width', 'height', 'longest', 'shortest', 'factor', 'total_pixels', 'multiple_of', 'match'], 'dimensions'),
  number('width', 'core.int', 512),
  number('height', 'core.int', 512),
  number('size', 'core.int', 512),
  number('factor', 'core.float', 1),
  number('megapixels', 'core.float', 1),
  number('multiple_of', 'core.int', 8),
  number('resolution_steps', 'core.int', 1),
  combo('mode', ['stretch', 'fit', 'fill', 'pad'], 'stretch'),
  combo('interpolation', ['nearest-exact', 'bilinear', 'area', 'bicubic', 'lanczos'], 'bilinear'),
  number('pad_value', 'core.float', 0),
  combo('compatibility', ['native', 'kjnodes_v1', 'kjnodes_v2', 'essentials'], 'native'),
  number('divisible_by', 'core.int', 0),
  combo('anchor', ['center', 'top', 'bottom', 'left', 'right'], 'center'),
  combo('condition', ['always', 'downscale_if_bigger', 'upscale_if_smaller', 'if_bigger_area', 'if_smaller_area'], 'always'),
  { role: 'output', id: 'image', type: concrete('dinkster.image') },
]

const widgetGroups = [
  { input: 'compatibility', values: ['kjnodes_v1', 'kjnodes_v2', 'essentials'], members: ['width', 'height'] },
  { input: 'target', values: ['dimensions'], members: ['width', 'height'], requires: [{ input: 'compatibility', values: ['native'] }] },
  { input: 'target', values: ['width'], members: ['width'], requires: [{ input: 'compatibility', values: ['native'] }] },
  { input: 'target', values: ['height'], members: ['height'], requires: [{ input: 'compatibility', values: ['native'] }] },
  { input: 'target', values: ['longest', 'shortest'], members: ['size'], requires: [{ input: 'compatibility', values: ['native'] }] },
  { input: 'target', values: ['factor'], members: ['factor'], requires: [{ input: 'compatibility', values: ['native'] }] },
  { input: 'target', values: ['total_pixels'], members: ['megapixels', 'resolution_steps'], requires: [{ input: 'compatibility', values: ['native'] }] },
  { input: 'target', values: ['multiple_of'], members: ['multiple_of'], requires: [{ input: 'compatibility', values: ['native'] }] },
  { input: 'mode', values: ['pad'], members: ['pad_value'], requires: [{ input: 'compatibility', values: ['native'] }] },
  { input: 'compatibility', values: ['kjnodes_v1', 'kjnodes_v2'], members: ['divisible_by', 'anchor'] },
  { input: 'compatibility', values: ['essentials'], members: ['divisible_by', 'condition'] },
]

async function widgetRows(page: Page): Promise<string[]> {
  return page.evaluate(() => window.__dinksterTest!.renderer!.getScene().nodes
    .find((node) => node.id === 'resize')!.layout.rows
    .filter((row) => row.kind === 'widget')
    .map((row) => row.inputId!))
}

test('wire 27 resize groups change visible rows without dropping stored values', async ({ page }, testInfo) => {
  await page.route('/supervisor/status', (route) => route.fulfill({ status: 502, body: 'no supervisor' }))
  await page.route('/system_stats', (route) => route.fulfill({ json: { system: { os: 'e2e' }, devices: [] } }))
  await page.route('/api/diagnostics', (route) => route.fulfill({ json: {} }))
  await page.route('/api/nodes*', (route) => route.fulfill({ json: {
    schemaVersion: 1,
    epoch: 1,
    dinkster: { version: 'wire27-conditional-widgets', schemaWire: 27 },
    nodes: {
      'dinkster.image.resize': {
        schemaVersion: 27,
        nodeType: 'dinkster.image.resize',
        displayName: 'Resize Image',
        category: 'image/geometry',
        outputNode: false,
        signature: 'wire27-resize-proof',
        interface: resizeInterface,
        widgetGroups,
      },
    },
  } }))

  await page.goto('/')
  await expect.poll(() => page.evaluate(() =>
    window.__dinksterTest?.app.backends.get()[0]?.registry.get()?.schemas.size)).toBe(1)
  await page.evaluate(() => {
    window.__dinksterTest!.app.openDocument({
      format: 'dinkster-workflow',
      formatVersion: 1,
      lineage: 'wire27-resize-proof',
      root: 'g0',
      graphs: {
        g0: {
          id: 'g0',
          name: 'root',
          nodes: {
            resize: {
              id: 'resize',
              type: 'dinkster.image.resize',
              values: {
                target: 'dimensions',
                width: 640,
                height: 480,
                megapixels: 2.5,
                resolution_steps: 64,
                mode: 'stretch',
                interpolation: 'bilinear',
                compatibility: 'native',
              },
            },
          },
          links: {},
          nets: {},
          reroutes: {},
          nextOrdinal: 2,
        },
      },
      view: { graphs: { g0: { nodes: { resize: { position: { x: 160, y: 100 } } } } } },
    }, 'Conditional resize widgets')
    window.__dinksterTest!.renderer!.setViewport({ x: 0, y: 0, scale: 1 })
  })

  await expect.poll(() => widgetRows(page)).toEqual([
    'target', 'width', 'height', 'mode', 'interpolation', 'compatibility',
  ])
  await page.screenshot({ path: testInfo.outputPath('resize-dimensions.png'), animations: 'disabled' })

  await page.evaluate(() => {
    const store = window.__dinksterTest!.app.activeTab()!.store
    store.dispatch({
      command: 'node.setValue',
      params: { graphId: 'g0', nodeId: 'resize', inputId: 'target', value: 'total_pixels' },
    })
  })
  await expect.poll(() => widgetRows(page)).toEqual([
    'target', 'megapixels', 'resolution_steps', 'mode', 'interpolation', 'compatibility',
  ])
  await expect.poll(() => page.evaluate(() =>
    window.__dinksterTest!.app.activeTab()!.store.doc.graphs.g0!.nodes.resize!.values)).toMatchObject({
    target: 'total_pixels',
    width: 640,
    height: 480,
    megapixels: 2.5,
    resolution_steps: 64,
  })
  await page.screenshot({ path: testInfo.outputPath('resize-total-pixels.png'), animations: 'disabled' })

  await page.evaluate(() => {
    const store = window.__dinksterTest!.app.activeTab()!.store
    store.dispatch({
      command: 'node.setValue',
      params: { graphId: 'g0', nodeId: 'resize', inputId: 'target', value: 'match' },
    })
    store.dispatch({
      command: 'node.setValue',
      params: { graphId: 'g0', nodeId: 'resize', inputId: 'compatibility', value: 'essentials' },
    })
  })
  await expect.poll(() => widgetRows(page)).toEqual([
    'target', 'width', 'height', 'mode', 'interpolation', 'compatibility', 'divisible_by', 'condition',
  ])
  await page.screenshot({ path: testInfo.outputPath('resize-essentials.png'), animations: 'disabled' })
})
