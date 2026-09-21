import { mkdirSync } from 'node:fs'
import type { Page } from '@playwright/test'
import { expect, test } from './fixtures.js'
import { evidencePath, evidenceGroupDir } from './evidence-output.js'

const digest = `blake3:${'ab'.repeat(32)}`
const sourcePng = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEklEQVR4nGP4z8DAAMIM/4EAAB/uBfsL2WiLAAAAAElFTkSuQmCC',
  'base64',
)
const asset = {
  digest,
  name: 'preview-source.png',
  size: sourcePng.length,
  mediaType: 'image/png',
  virtualPath: '',
}

const loadImageWire31 = {
  schemaVersion: 1,
  nodeType: 'dinkster.load_image',
  displayName: 'Load Image',
  category: 'image',
  interface: [
    {
      role: 'input',
      id: 'image',
      required: true,
      type: { kind: 'asset', element: { kind: 'concrete', types: ['dinkster.image'] } },
      widget: { type: 'ASSET', accept: ['image/*'], kind: 'media/image', allowUpload: true },
      sourceFilename: { kind: 'media/image', category: 'input' },
    },
    {
      role: 'output',
      id: 'image',
      type: { kind: 'concrete', types: ['dinkster.image'] },
      represents: { input: 'image', rendition: 'decoded-image' },
    },
  ],
}

async function openImageEditor(page: Page): Promise<void> {
  const point = await page.evaluate(() => {
    const renderer = window.__dinksterTest!.renderer!
    const node = renderer.getScene().nodes.find((item) => item.id === 'loader')!
    const row = node.layout.rows.find((item) => item.kind === 'widget' && item.inputId === 'image')!
    const canvas = document.querySelector('[data-testid=graph-canvas]')!.getBoundingClientRect()
    const viewport = renderer.getViewport()
    return {
      x: canvas.left + viewport.x + (node.x + node.layout.width / 2) * viewport.scale,
      y: canvas.top + viewport.y + (node.y + row.y + row.height / 2) * viewport.scale,
    }
  })
  await page.mouse.click(point.x, point.y)
  await expect(page.getByTestId('asset-editor')).toBeVisible()
}

test('an uploaded selected asset estimates its represented output before execution', async ({ page }, testInfo) => {
  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(error.message))
  await page.route('/supervisor/status', (route) => route.fulfill({ status: 502, body: 'no supervisor' }))
  await page.route('/system_stats', (route) => route.fulfill({ json: { system: { os: 'e2e' }, devices: [] } }))
  await page.route('/api/diagnostics', (route) => route.fulfill({ json: {} }))
  await page.route('/api/mounts*', (route) => route.fulfill({ json: { mounts: [] } }))
  await page.route('/api/nodes*', (route) => route.fulfill({ json: {
    schemaVersion: 1,
    epoch: 1,
    dinkster: { version: 'represented-output-proof', schemaWire: 1 },
    nodes: { 'dinkster.load_image': loadImageWire31 },
  } }))
  await page.route('**/api/assets/**', async (route) => {
    const url = new URL(route.request().url())
    if (route.request().method() === 'POST' && url.pathname === '/api/assets/media') {
      expect(route.request().postDataBuffer()).toEqual(sourcePng)
      await route.fulfill({ status: 201, json: { asset, kind: 'media/image' } })
      return
    }
    await route.fulfill({ status: 200, contentType: 'image/png', body: sourcePng })
  })

  await page.goto('/')
  await expect.poll(() => page.evaluate(() => {
    const registry = window.__dinksterTest?.app.backends.get()[0]?.registry.get()
    return registry === undefined ? undefined : {
      schemas: [...registry.schemas.keys()],
      diagnostics: registry.diagnostics.map((diagnostic) => diagnostic.code),
    }
  })).toEqual({ schemas: ['dinkster.load_image'], diagnostics: [] })
  await page.evaluate(() => {
    const app = window.__dinksterTest!.app as unknown as {
      settings: { set(id: string, value: unknown): void }
      openDocument(document: unknown, title: string): void
    }
    app.settings.set('execution.mirrorPreviews', true)
    app.openDocument({
      format: 'dinkster-workflow',
      formatVersion: 1,
      lineage: 'represented-output-proof',
      root: 'g0',
      graphs: {
        g0: {
          id: 'g0',
          name: 'root',
          nodes: {
            loader: { id: 'loader', type: 'dinkster.load_image', values: { image: null } },
          },
          links: {},
          nets: {},
          reroutes: {},
          nextOrdinal: 2,
        },
      },
      view: { graphs: { g0: { nodes: { loader: { position: { x: 160, y: 140 } } } } } },
    }, 'Represented output estimate')
    window.__dinksterTest!.renderer!.setViewport({ x: 0, y: 0, scale: 1 })
  })

  expect(await page.evaluate(() => window.__dinksterTest!.renderer!.getNodePreviews()['loader'])).toBeUndefined()
  await openImageEditor(page)
  await page.getByTestId('asset-editor').locator('input[type=file]').setInputFiles({
    name: asset.name,
    mimeType: asset.mediaType,
    buffer: sourcePng,
  })
  await expect(page.getByTestId('asset-apply')).toBeEnabled()
  await page.getByTestId('asset-apply').click()
  await expect(page.getByTestId('asset-editor')).not.toBeVisible()

  const previewOf = () => page.evaluate(() => {
    const preview = window.__dinksterTest!.renderer!.getNodePreviews()['loader']
    return preview === undefined ? undefined : {
      state: preview.state ?? null,
      width: preview.width ?? null,
      height: preview.height ?? null,
    }
  })
  await expect.poll(previewOf).toEqual({ state: 'estimate', width: 2, height: 2 })
  expect(await page.evaluate(() =>
    window.__dinksterTest!.app.activeTab()!.store.doc.graphs.g0!.nodes.loader!.values.image)).toEqual(asset)

  await page.screenshot({ path: testInfo.outputPath('represented-output-estimate.png'), animations: 'disabled' })
  if (process.env['DINKSTER_CAPTURE_ISSUE_679'] === '1') {
    mkdirSync(evidenceGroupDir('issue-679'), { recursive: true })
    await page.screenshot({ path: `evidencePath('issue-679', 'represented-output-estimate.png')`, animations: 'disabled' })
  }

  await page.evaluate(() => {
    (window.__dinksterTest!.app as unknown as {
      settings: { set(id: string, value: unknown): void }
    }).settings.set('execution.mirrorPreviews', false)
  })
  await expect.poll(previewOf).toEqual({ state: null, width: 2, height: 2 })
  expect(pageErrors).toEqual([])
})
