import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'

const proofDir = process.env['DINKSTER_NODE_HELP_PROOF_DIR']
if (proofDir !== undefined) mkdirSync(proofDir, { recursive: true })

const pageDigest = `sha256:${'1'.repeat(64)}`
const imageDigest = `sha256:${'2'.repeat(64)}`
const videoDigest = `sha256:${'3'.repeat(64)}`
const videoFixture = readFileSync(new URL('../fixtures/media-overlay/with_metadata.mp4', import.meta.url))

async function addNodeAndOpenContextMenu(page: Page, type: string): Promise<void> {
  await page.evaluate((nodeType) => {
    const tab = window.__dinksterTest!.app.activeTab()!
    const result = tab.store.dispatch({
      command: 'node.add',
      params: { graphId: tab.store.doc.root, type: nodeType, values: {}, position: { x: 80, y: 120 } },
    })
    if (!result.ok) throw new Error(`node.add refused: ${JSON.stringify(result.diagnostics)}`)
  }, type)
  await expect.poll(() => page.evaluate(() => window.__dinksterTest!.renderer!.getScene().nodes.length)).toBe(1)

  const point = await page.evaluate(() => {
    const renderer = window.__dinksterTest!.renderer!
    const node = renderer.getScene().nodes[0]!
    const viewport = renderer.getViewport()
    const canvas = document.querySelector('[data-testid="graph-canvas"]')!.getBoundingClientRect()
    return {
      x: canvas.left + (node.x + node.layout.width / 2) * viewport.scale + viewport.x,
      y: canvas.top + (node.y + node.layout.headerHeight / 2) * viewport.scale + viewport.y,
    }
  })
  await page.mouse.click(point.x, point.y, { button: 'right' })
}

async function addNodeAndOpenHelp(page: Page, type: string): Promise<void> {
  await addNodeAndOpenContextMenu(page, type)
  await page.locator('[data-item-id="core.node.help"]').click()
}

test('documented node context Help renders its immutable Markdown page', async ({ page }) => {
  await page.route('/supervisor/status', (route) =>
    route.fulfill({ status: 502, contentType: 'text/plain', body: 'no supervisor' }),
  )
  await page.route('/system_stats', (route) =>
    route.fulfill({ json: { system: { os: 'e2e' }, devices: [] } }),
  )
  await page.route('/api/nodes*', (route) => route.fulfill({ json: {
    schemaVersion: 1,
    epoch: 1,
    dinkster: { version: 'node-help-e2e', schemaWire: 1 },
    packs: { 'demo-pack': { displayName: 'Demo Pack' } },
    nodes: {
      'demo.add': {
        schemaVersion: 1, displayName: 'Add Values', description: 'Adds two values.',
        category: 'math', pack: 'demo-pack', signature: 'help-e2e', hasDocs: true, interface: [],
      },
      'demo.no_docs': {
        schemaVersion: 1, displayName: 'No Docs', description: 'Has no full help page.',
        category: 'math', pack: 'demo-pack', signature: 'no-help-e2e', interface: [],
      },
    },
  } }))
  await page.route('/api/docs?*', (route) => route.fulfill({ json: {
    docs: [{
      pack: 'demo-pack', kind: 'node', id: 'demo.add', defaultLocale: 'en',
      locales: {
        en: {
          title: 'Add Values', summary: 'Adds two values and explains the result.', schemaVersion: 1,
          digest: pageDigest,
          assets: {
            'assets/equation.svg': { digest: imageDigest, mediaType: 'image/svg+xml' },
            'assets/demo.mp4': { digest: videoDigest, mediaType: 'video/mp4' },
          },
        },
      },
    }],
  } }))
  await page.route(`**/api/packs/demo-pack/docs/pages/${encodeURIComponent(pageDigest)}`, (route) => route.fulfill({
    contentType: 'text/markdown',
    body: '# Usage\n\nAdd the two integer inputs.\n\n![Addition diagram](assets/equation.svg)\n\n```dinkster-media\nasset = "assets/demo.mp4"\nposter = "assets/equation.svg"\ncaption = "Adding two values"\n```',
  }))
  await page.route(`**/api/packs/demo-pack/docs/assets/${encodeURIComponent(imageDigest)}`, (route) => route.fulfill({
    contentType: 'image/svg+xml',
    body: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 90"><rect width="320" height="90" rx="12" fill="#202938"/><text x="160" y="55" text-anchor="middle" fill="#f4f7fb" font-size="28">a + b = sum</text></svg>',
  }))
  await page.route(`**/api/packs/demo-pack/docs/assets/${encodeURIComponent(videoDigest)}`, (route) => route.fulfill({
    contentType: 'video/mp4', body: videoFixture,
  }))

  await page.goto('/')
  await expect.poll(() => page.evaluate(() => window.__dinksterTest?.app.backends.get()[0]?.registry.get()?.schemas.size ?? 0)).toBe(2)
  await addNodeAndOpenContextMenu(page, 'demo.no_docs')
  await expect(page.locator('[data-item-id="core.node.help"]')).toHaveCount(0)
  await page.keyboard.press('Escape')
  await page.evaluate(() => {
    const tab = window.__dinksterTest!.app.activeTab()!
    const graphId = tab.store.doc.root
    tab.store.dispatch({
      command: 'graph.deleteItems',
      params: { graphId, nodeIds: Object.keys(tab.store.doc.graphs[graphId]!.nodes), linkIds: [] },
    })
  })
  await expect.poll(() => page.evaluate(() => window.__dinksterTest!.renderer!.getScene().nodes.length)).toBe(0)
  await addNodeAndOpenHelp(page, 'demo.add')

  const panel = page.getByTestId('node-help-panel')
  await expect(panel.getByRole('heading', { name: 'Add Values' })).toBeVisible()
  await expect(panel.locator('article')).toHaveAttribute('lang', 'en')
  await expect(panel.locator('.dinkster-markdown')).toContainText('Add the two integer inputs.')
  await expect(panel.getByRole('img', { name: 'Addition diagram' })).toBeVisible()
  await expect(panel.locator('video')).toHaveAttribute('controls', '')
  await expect.poll(async () => (await panel.locator('video').boundingBox())?.height ?? 0).toBeGreaterThan(150)
  await expect(panel.locator('figcaption')).toHaveText('Adding two values')
  await expect(panel.locator('script')).toHaveCount(0)

  if (proofDir !== undefined) {
    await panel.locator('video').hover()
    await panel.screenshot({ path: join(proofDir, 'node-help-panel.png'), animations: 'disabled' })
  }
})

test('live wire-42 backend serves descriptor metadata separately from the Markdown body', async ({ page }) => {
  test.skip(process.env['DINKSTER_E2E_USE_NATIVE'] !== '1', 'requires the local Dinkster wire-42 docs backend')
  await page.goto('/')
  await expect.poll(() => page.evaluate(() => {
    const backend = window.__dinksterTest?.app.backends.get()[0]
    return {
      protocol: backend?.protocol,
      documented: (backend?.registry.get()?.schemas.get('std.math.add_ints') as { hasDocs?: boolean } | undefined)?.hasDocs,
    }
  })).toEqual({ protocol: 'dinkster', documented: true })

  await addNodeAndOpenHelp(page, 'std.math.add_ints')
  const panel = page.getByTestId('node-help-panel')
  await expect(panel.getByRole('heading', { name: 'Add Integers', level: 1 })).toHaveCount(2)
  await expect(panel).toContainText('Connect integer values to a and b.')
  await expect(panel).not.toContainText('schema_version')
  await expect(panel).not.toContainText('+++')
})
