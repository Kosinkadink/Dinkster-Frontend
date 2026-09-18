/**
 * Current raw-wire DynamicCombo coverage for comfy.ResizeImageMaskNode.
 *
 * This intercepts the captured wire-16 catalog entry under the current wire
 * number (the DynamicCombo grammar is unchanged) and never calls
 * registerSchemas.
 */
import { readFileSync } from 'node:fs'
import { expect, test, type Page } from '@playwright/test'

const resizeWireFixture = JSON.parse(readFileSync(
  new URL('../../core/fixtures/dinkster-resize-image-mask-wire16.json', import.meta.url),
  'utf8',
)) as Record<string, unknown>
const resizeWire = { ...resizeWireFixture, schemaVersion: 22 }

const nativeTable = {
  schemaVersion: 1,
  epoch: 1,
  dinkster: { version: 'resize-dynamiccombo-e2e', schemaWire: 22 },
  packs: { comfy: { displayName: 'ComfyUI' } },
  nodes: {
    'comfy.ResizeImageMaskNode': resizeWire,
    'test.ImageSource': {
      schemaVersion: 22,
      nodeType: 'test.ImageSource',
      displayName: 'Image Source',
      category: 'test',
      interface: [{ role: 'output', id: 'image', type: { kind: 'concrete', types: ['comfy.IMAGE'] } }],
      signature: 'image-source-e2e',
    },
  },
}

async function clickRow(page: Page, inputId: string): Promise<void> {
  const point = await page.evaluate((id) => {
    const renderer = window.__dinksterTest!.renderer!
    const nodeId = Object.values(window.__dinksterTest!.app.activeTab()!.store.doc.graphs.g0!.nodes)
      .find((candidate) => candidate.type === 'comfy.ResizeImageMaskNode')!.id
    const node = renderer.getScene().nodes.find((candidate) => candidate.id === nodeId)!
    const row = node.layout.rows.find((candidate) => candidate.kind === 'widget' && candidate.inputId === id)
    if (!row) throw new Error(`no widget row '${id}'`)
    const canvas = document.querySelector('[data-testid="graph-canvas"]')!.getBoundingClientRect()
    return {
      x: canvas.left + node.x + node.layout.width / 2,
      y: canvas.top + node.y + row.y + row.height / 2,
    }
  }, inputId)
  await page.mouse.click(point.x, point.y)
}

const rowIds = (page: Page): Promise<string[]> => page.evaluate(() => {
  const nodeId = Object.values(window.__dinksterTest!.app.activeTab()!.store.doc.graphs.g0!.nodes)
    .find((candidate) => candidate.type === 'comfy.ResizeImageMaskNode')!.id
  const node = window.__dinksterTest!.renderer!.getScene().nodes.find((candidate) => candidate.id === nodeId)!
  return node.layout.rows
    .flatMap((row) => row.kind === 'widget' ? [row.inputId] : [])
    .filter((id): id is string => typeof id === 'string')
})

const selected = (page: Page): Promise<string | undefined> => page.evaluate(() => {
  const node = Object.values(window.__dinksterTest!.app.activeTab()!.store.doc.graphs.g0!.nodes)
    .find((candidate) => candidate.type === 'comfy.ResizeImageMaskNode')!
  return node.dynamic?.resize_type?.selected
})

test('fresh ResizeImageMaskNode selects, round-trips, and submits effective wire values', async ({ page }) => {
  let submitted: Record<string, unknown> | undefined
  await page.route('/supervisor/status', (route) => route.fulfill({ status: 502, body: 'no supervisor' }))
  await page.route('/system_stats', (route) => route.fulfill({ json: { system: { os: 'e2e' }, devices: [] } }))
  await page.route('/api/nodes*', (route) => route.fulfill({ json: nativeTable }))
  await page.route('/api/assets', (route) => route.fulfill({ status: 404, json: { error: 'no library' } }))
  await page.route('/api/jobs', async (route) => {
    submitted = JSON.parse(route.request().postData() ?? '{}') as Record<string, unknown>
    await route.fulfill({
      status: 202,
      json: { clientId: submitted['clientId'], jobId: submitted['jobId'], state: 'queued' },
    })
  })

  await page.goto('/')
  await expect.poll(() => page.evaluate(() =>
    window.__dinksterTest?.app.backends.get()[0]?.registry.get()?.schemas.has('comfy.ResizeImageMaskNode') ?? false,
  )).toBe(true)
  await page.evaluate(() => {
    window.__dinksterTest!.app.openDocument({
      format: 'dinkster-workflow',
      formatVersion: 1,
      lineage: 'resize-dynamiccombo-e2e',
      root: 'g0',
      graphs: {
        g0: {
          id: 'g0',
          name: 'root',
          nodes: {
            source: {
              id: 'source',
              type: 'test.ImageSource',
              values: {},
            },
          },
          links: {},
          nets: {},
          reroutes: {},
          nextOrdinal: 2,
        },
      },
      view: { graphs: { g0: { nodes: {
        source: { position: { x: 40, y: 120 } },
      } } } },
    }, 'Resize DynamicCombo')
    window.__dinksterTest!.renderer!.setViewport({ x: 0, y: 0, scale: 1 })
  })

  await page.mouse.dblclick(700, 500)
  await page.getByTestId('palette-search').fill('Resize Image/Mask')
  await page.locator('[data-node-type="comfy.ResizeImageMaskNode"]').click()
  await page.mouse.click(700, 500)
  const resizeId = await page.evaluate(() => Object.values(
    window.__dinksterTest!.app.activeTab()!.store.doc.graphs.g0!.nodes,
  ).find((candidate) => candidate.type === 'comfy.ResizeImageMaskNode')!.id)
  expect(await selected(page)).toBe('scale dimensions')

  await page.evaluate(() => {
    const tab = window.__dinksterTest!.app.activeTab()!
    const resizeId = Object.values(tab.store.doc.graphs.g0!.nodes)
      .find((candidate) => candidate.type === 'comfy.ResizeImageMaskNode')!.id
    const outcome = tab.store.dispatch({
      command: 'batch',
      params: { invocations: [
        { command: 'link.connect', params: {
          graphId: 'g0',
          from: { node: 'source', port: 'image' },
          to: { node: resizeId, port: 'input' },
        } },
        ...Object.entries({
          'resize_type.width': 640,
          'resize_type.height': 480,
          'resize_type.crop': 'disabled',
        }).map(([inputId, value]) => ({
          command: 'node.setValue',
          params: { graphId: 'g0', nodeId: resizeId, inputId, value },
        })),
      ] },
    })
    if (!outcome.ok) throw new Error(`setup batch failed: ${JSON.stringify(outcome.diagnostics)}`)
  })
  await expect.poll(() => rowIds(page)).toEqual(expect.arrayContaining([
    'resize_type',
    'resize_type.width',
    'resize_type.height',
    'resize_type.crop',
    'scale_method',
  ]))

  // Pointer selection changes the explicit state seeded at node creation.
  await clickRow(page, 'resize_type')
  await page.getByTestId('combo-dropdown').getByRole('option', { name: 'scale by multiplier', exact: true }).click()
  expect(await selected(page)).toBe('scale by multiplier')
  expect(await rowIds(page)).toContain('resize_type.multiplier')

  // One undo restores the explicit first option seeded at creation.
  await page.keyboard.press('Control+z')
  expect(await selected(page)).toBe('scale dimensions')
  expect(await rowIds(page)).toContain('resize_type.width')

  // Keyboard selection follows the same command path.
  await clickRow(page, 'resize_type')
  let search = page.getByTestId('combo-search')
  await search.fill('scale by multiplier')
  await search.press('ArrowDown')
  await search.press('Enter')
  expect(await selected(page)).toBe('scale by multiplier')

  // Return to dimensions by pointer, then edit the ordinary static combo by keyboard.
  await clickRow(page, 'resize_type')
  await page.getByTestId('combo-dropdown').getByRole('option', { name: 'scale dimensions', exact: true }).click()
  await clickRow(page, 'scale_method')
  search = page.getByTestId('combo-search')
  await search.fill('bicubic')
  await search.press('ArrowDown')
  await search.press('Enter')

  // Export and reopen through the public app paths without synthesizing state.
  await page.evaluate(() => {
    const app = window.__dinksterTest!.app
    const exported = app.exportDocument(app.activeTab()!.id)!
    app.openDocument(JSON.parse(JSON.stringify(exported)), 'Resize Reopened')
  })
  await page.waitForFunction(() => {
    const tab = window.__dinksterTest!.app.activeTab()
    return tab !== undefined && 'status' in tab.store
  })
  expect(await selected(page)).toBe('scale dimensions')
  expect(await rowIds(page)).toContain('resize_type.width')

  await page.evaluate(async (nodeId) => {
    const app = window.__dinksterTest!.app
    const tab = app.activeTab()!
    await app.queueSelection(tab, [nodeId])
  }, resizeId)
  expect(submitted).toBeDefined()
  expect(submitted?.['targets']).toEqual([resizeId])
  const graph = submitted?.['graph'] as { nodes?: Record<string, unknown> } | undefined
  expect(graph?.nodes?.[resizeId]).toMatchObject({
    nodeType: 'comfy.ResizeImageMaskNode',
    inputs: {
      input: { $link: { node: 'source', output: 'image' } },
      scale_method: 'bicubic',
      'resize_type.width': 640,
      'resize_type.height': 480,
      'resize_type.crop': 'disabled',
    },
    slotVariants: { resize_type: 'scale dimensions' },
  })
})
