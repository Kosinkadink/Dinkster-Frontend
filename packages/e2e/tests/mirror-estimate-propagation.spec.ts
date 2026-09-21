import { mkdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { Page } from '@playwright/test'
import { expect, test } from './fixtures.js'
import { evidencePath, evidenceGroupDir } from './evidence-output.js'

const adjustWire = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../core/test/fixtures/image_adjust_wire29.json', import.meta.url)), 'utf8'),
) as Record<string, unknown>
const filterWire = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../core/test/fixtures/image_filter_wire30.json', import.meta.url)), 'utf8'),
) as Record<string, unknown>

const imageA = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEklEQVR4nGP4z8DAAMIM/4EAAB/uBfsL2WiLAAAAAElFTkSuQmCC',
  'base64',
)
const imageB = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAAAgUlEQVR42u3YsRUAEBBEwWtCrFf1qUcgoQNibgLhBSb6b2P2sk6vtnF8r98HAAAAAAAAkBjg9w/e7gEAAAAAAIDMAEoQAAAAAAAAsAcoQQAAAAAAAMAeoAQBAAAAAAAAe4ASBAAAAAAAAOwBShAAAAAAAACwByhBAAAAAAAA4DuADXYIgobovTz/AAAAAElFTkSuQmCC',
  'base64',
)
const digestA = `blake3:${'ab'.repeat(32)}`
const digestB = `blake3:${'cd'.repeat(32)}`
const assetA = { digest: digestA, name: 'source-a.png', size: imageA.length, mediaType: 'image/png', virtualPath: 'source-a.png' }
const assetB = { digest: digestB, name: 'source-b.png', size: imageB.length, mediaType: 'image/png', virtualPath: 'source-b.png' }

const representedSourceWire = {
  schemaVersion: 1,
  nodeType: 'e2e.represented-source',
  displayName: 'Load Image',
  category: 'test',
  interface: [
    {
      role: 'input',
      id: 'image',
      required: true,
      type: { kind: 'asset', element: { kind: 'concrete', types: ['dinkster.image'] } },
      widget: { type: 'ASSET', accept: ['image/png'], kind: 'media/image' },
    },
    {
      role: 'output',
      id: 'image',
      type: { kind: 'concrete', types: ['dinkster.image'] },
      represents: { input: 'image', rendition: 'decoded-image' },
    },
  ],
}

const previewOf = (page: Page, nodeId: string) => page.evaluate((id) => {
  const preview = window.__dinksterTest!.renderer!.getNodePreviews()[id]
  return preview === undefined ? undefined : {
    state: preview.state ?? null,
    width: preview.width ?? null,
    height: preview.height ?? null,
  }
}, nodeId)

test('represented estimates propagate and recompute after connect and reconnect', async ({ page }, testInfo) => {
  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(error.message))
  await page.route('/supervisor/status', (route) => route.fulfill({ status: 502, body: 'no supervisor' }))
  await page.route('/system_stats', (route) => route.fulfill({ json: { system: { os: 'e2e' }, devices: [] } }))
  await page.route('/api/diagnostics', (route) => route.fulfill({ json: {} }))
  await page.route('**/api/assets/**', (route) => {
    const alternate = route.request().url().includes('cdcdcdcd')
    return route.fulfill({ contentType: 'image/png', body: alternate ? imageB : imageA })
  })
  await page.route('/api/nodes*', (route) => route.fulfill({ json: {
    schemaVersion: 1,
    epoch: 1,
    dinkster: { version: 'mirror-propagation-proof', schemaWire: 1 },
    nodes: {
      'e2e.represented-source': representedSourceWire,
      'dinkster.image.adjust': { ...adjustWire, schemaVersion: 1 },
      'dinkster.image.filter': { ...filterWire, schemaVersion: 1 },
    },
  } }))

  await page.goto('/')
  await expect.poll(() => page.evaluate(() =>
    window.__dinksterTest?.app.backends.get()[0]?.registry.get()?.schemas.size)).toBe(3)
  await page.evaluate(({ first, second }) => {
    window.__dinksterTest!.app.openDocument({
      format: 'dinkster-workflow',
      formatVersion: 1,
      lineage: 'mirror-propagation-proof',
      root: 'g0',
      graphs: {
        g0: {
          id: 'g0',
          name: 'root',
          nodes: {
            filter: {
              id: 'filter', type: 'dinkster.image.filter', values: {},
              dynamic: { operation: { selected: 'sharpen' } },
            },
            adjust: { id: 'adjust', type: 'dinkster.image.adjust', values: { operation: 'invert' } },
            sourceA: { id: 'sourceA', type: 'e2e.represented-source', values: { image: first } },
            sourceB: { id: 'sourceB', type: 'e2e.represented-source', values: { image: second } },
          },
          links: {
            chain: {
              id: 'chain',
              from: { node: 'adjust', port: 'image' },
              to: { node: 'filter', port: 'image' },
            },
          },
          nets: {},
          reroutes: {},
          valueSources: {},
          nextOrdinal: 10,
        },
      },
      view: { graphs: { g0: { nodes: {
        sourceA: { position: { x: 40, y: 40 } },
        sourceB: { position: { x: 40, y: 380 } },
        adjust: { position: { x: 430, y: 180 } },
        filter: { position: { x: 820, y: 180 } },
      } } } },
    } as never, 'Estimate propagation')
    window.__dinksterTest!.renderer!.setViewport({ x: 0, y: 0, scale: 0.85 })
  }, { first: assetA, second: assetB })

  await expect.poll(() => previewOf(page, 'sourceA')).toEqual({ state: 'estimate', width: 2, height: 2 })
  await expect.poll(() => previewOf(page, 'sourceB')).toEqual({ state: 'estimate', width: 64, height: 64 })
  expect(await previewOf(page, 'adjust')).toBeUndefined()
  expect(await previewOf(page, 'filter')).toBeUndefined()

  await page.evaluate(() => {
    const result = window.__dinksterTest!.app.activeTab()!.store.dispatch({
      command: 'link.connect',
      params: {
        graphId: 'g0',
        from: { node: 'sourceA', port: 'image' },
        to: { node: 'adjust', port: 'image' },
      },
    })
    if (!result.ok) throw new Error(JSON.stringify(result.diagnostics))
  })
  await expect.poll(() => previewOf(page, 'adjust')).toEqual({ state: 'estimate', width: 2, height: 2 })
  await expect.poll(() => previewOf(page, 'filter')).toEqual({ state: 'estimate', width: 2, height: 2 })

  await page.evaluate(() => {
    const store = window.__dinksterTest!.app.activeTab()!.store
    const linkId = Object.entries(store.doc.graphs['g0']!.links).find(([, link]) =>
      'node' in link.to && link.to.node === 'adjust' && link.to.port === 'image')?.[0]
    if (linkId === undefined) throw new Error('source link not found')
    const result = store.dispatch({
      command: 'link.rewireSource',
      params: {
        graphId: 'g0',
        linkIds: [linkId],
        from: { node: 'sourceB', port: 'image' },
      },
    })
    if (!result.ok) throw new Error(JSON.stringify(result.diagnostics))
  })
  await expect.poll(() => previewOf(page, 'adjust')).toEqual({ state: 'estimate', width: 64, height: 64 })
  await expect.poll(() => previewOf(page, 'filter')).toEqual({ state: 'estimate', width: 64, height: 64 })

  await page.screenshot({ path: testInfo.outputPath('mirror-estimate-propagation.png'), animations: 'disabled' })
  if (process.env['DINKSTER_CAPTURE_ISSUE_679'] === '1') {
    mkdirSync(evidenceGroupDir('issue-679'), { recursive: true })
    await page.screenshot({ path: evidencePath('issue-679', 'mirror-estimate-propagation.png'), animations: 'disabled' })
  }
  expect(pageErrors).toEqual([])
})
