import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { expect, test, type Page } from './fixtures.js'
import { evidencePath, evidenceGroupDir } from './evidence-output.js'

const objectInfo = JSON.parse(readFileSync(
  fileURLToPath(new URL('../../core/fixtures/object_info.json', import.meta.url)),
  'utf8',
)) as Record<string, unknown>

const activeDoc = (page: Page) => page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.doc)
const xy = (point: { x: number; y: number }): [number, number] => [point.x, point.y]

async function nodePoint(page: Page, nodeId: string, part: 'header' | 'body' | 'input' | 'output') {
  return page.evaluate(({ nodeId, part }) => {
    const renderer = window.__dinksterTest!.renderer!
    const viewport = renderer.getViewport()
    const node = renderer.getScene().nodes.find((candidate) => candidate.id === nodeId)
    if (!node) throw new Error(`No scene node '${nodeId}'`)
    const canvas = document.querySelector('[data-testid="graph-canvas"]')!.getBoundingClientRect()
    const worldX = part === 'input'
      ? node.x
      : part === 'output'
        ? node.x + node.layout.width
        : node.x + node.layout.width / 2
    const pin = part === 'input' || part === 'output'
      ? node.layout.pins.find((candidate) => candidate.direction === (part === 'input' ? 'in' : 'out'))
      : undefined
    const worldY = part === 'header'
      ? node.y + node.layout.headerHeight / 2
      : pin !== undefined
        ? node.y + pin.y
        : node.y + node.layout.headerHeight + (node.layout.height - node.layout.headerHeight) / 2
    return {
      x: canvas.left + worldX * viewport.scale + viewport.x,
      y: canvas.top + worldY * viewport.scale + viewport.y,
    }
  }, { nodeId, part })
}

async function toolboxPoint(page: Page, id: string) {
  return page.evaluate((buttonId) => {
    const renderer = window.__dinksterTest!.renderer!
    const button = renderer.getToolboxLayout()?.buttons.find((candidate) => candidate.button.id === buttonId)
    if (!button) throw new Error(`No toolbox button '${buttonId}'`)
    const viewport = renderer.getViewport()
    const canvas = document.querySelector('[data-testid="graph-canvas"]')!.getBoundingClientRect()
    return {
      x: canvas.left + (button.x + button.size / 2) * viewport.scale + viewport.x,
      y: canvas.top + (button.y + button.size / 2) * viewport.scale + viewport.y,
    }
  }, id)
}

async function drag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }) {
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2)
  await page.mouse.move(to.x, to.y)
  await page.mouse.up()
}

async function capture(page: Page, name: string, projectName: string, outputPath: string, attach: (path: string) => Promise<void>) {
  const image = await page.screenshot({ animations: 'disabled' })
  writeFileSync(outputPath, image)
  await attach(outputPath)
  if (process.env['DINKSTER_CAPTURE_ISSUE_387'] === '1') {
    mkdirSync(evidenceGroupDir('issue-387'), { recursive: true })
    writeFileSync(`evidencePath('issue-387', '${projectName}-${name}.png')`, image)
  }
}

async function openProof(page: Page) {
  await page.evaluate(() => {
    const image = { kind: 'concrete', name: 'IMAGE' } as const
    window.__dinksterTest!.app.registerSchemas([
      {
        type: 'MinimizeSource', displayName: 'Image source', category: 'proof', source: 'v3', isOutputNode: false,
        items: [{ kind: 'output', id: 'image', type: image }],
      },
      {
        type: 'MinimizeTarget', displayName: 'Mix', category: 'proof', source: 'v3', isOutputNode: false,
        items: [
          { kind: 'input', id: 'image', displayName: 'Image', type: image, optional: false },
          { kind: 'input', id: 'strength', displayName: 'Strength', type: { kind: 'concrete', name: 'FLOAT' }, optional: false,
            widget: { widgetType: 'FLOAT', options: { min: 0, max: 1 }, default: 0.5 } },
          { kind: 'output', id: 'image', displayName: 'Image', type: image, preview: true },
        ],
      },
      {
        type: 'MinimizeSink', displayName: 'Image sink', category: 'proof', source: 'v3', isOutputNode: true,
        items: [{ kind: 'input', id: 'image', type: image, optional: false }],
      },
    ] as never)
    window.__dinksterTest!.app.openDocument({
      format: 'dinkster-workflow', formatVersion: 1, lineage: 'minimized-nodes-proof', root: 'g0',
      graphs: { g0: {
        id: 'g0', name: 'root',
        nodes: {
          source: { id: 'source', type: 'MinimizeSource', values: {} },
          replacement: { id: 'replacement', type: 'MinimizeSource', values: {} },
          target: { id: 'target', type: 'MinimizeTarget', values: { strength: 0.5 } },
          sink: { id: 'sink', type: 'MinimizeSink', values: {} },
        },
        links: {
          incoming: { id: 'incoming', from: { node: 'source', port: 'image' }, to: { node: 'target', port: 'image' } },
          outgoing: { id: 'outgoing', from: { node: 'target', port: 'image' }, to: { node: 'sink', port: 'image' } },
        },
        nets: {}, reroutes: {}, nextOrdinal: 5,
      } },
      view: { graphs: { g0: { nodes: {
        source: { position: { x: 100, y: 180 } },
        replacement: { position: { x: 100, y: 500 } },
        target: { position: { x: 520, y: 220 }, size: { width: 360, height: 240 } },
        sink: { position: { x: 850, y: 520 } },
      } } } },
    }, 'Minimized nodes proof')
    window.__dinksterTest!.renderer!.setViewport({ x: 0, y: 0, scale: 1 })
  })
  await expect.poll(() => page.evaluate(() =>
    window.__dinksterTest!.renderer!.getScene().nodes.find((node) => node.id === 'target')?.layout.width,
  )).toBe(360)
}

test.beforeEach(async ({ context, page }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  await page.route('/system_stats', (route) => route.fulfill({ json: { system: { os: 'e2e' }, devices: [] } }))
  await page.route('/object_info', (route) => route.fulfill({ json: objectInfo }))
  await page.routeWebSocket('/ws*', () => {})
  await page.goto('/')
  await expect(page.getByTestId('status-bar')).toContainText(/\d+ node schemas/, { timeout: 15_000 })
  if (await page.getByTestId('dock-zone-right').isVisible()) {
    await page.getByRole('button', { name: /^Toggle right rail/ }).click()
  }
})

test('toolbar, title, shortcut, context menu, save, and clipboard preserve minimized state', async ({ page }, testInfo) => {
  await openProof(page)
  await capture(page, 'expanded', testInfo.project.name, testInfo.outputPath('expanded.png'), async (path) => {
    await testInfo.attach('expanded nodes', { path, contentType: 'image/png' })
  })

  const header = await nodePoint(page, 'target', 'header')
  await page.mouse.click(header.x, header.y)
  await page.mouse.click(...xy(await toolboxPoint(page, 'core.mode')))
  await expect(page.getByTestId('context-menu')).toBeVisible()
  await expect(page.locator('[data-item-id="core.node.mode.active"]')).toBeVisible()
  await capture(page, 'mode-selector', testInfo.project.name, testInfo.outputPath('mode-selector.png'), async (path) => {
    await testInfo.attach('toolbar mode selector', { path, contentType: 'image/png' })
  })
  await page.locator('[data-item-id="core.node.mode.muted"]').click()
  await page.mouse.click(...xy(await toolboxPoint(page, 'core.minimize')))

  const minimized = await page.evaluate(() => {
    const renderer = window.__dinksterTest!.renderer!
    const scene = renderer.getScene()
    const node = scene.nodes.find((candidate) => candidate.id === 'target')!
    const incoming = scene.links.find((link) => link.id === 'incoming')!
    const outgoing = scene.links.find((link) => link.id === 'outgoing')!
    const image = document.createElement('canvas')
    image.width = 120
    image.height = 60
    const context = image.getContext('2d')!
    const gradient = context.createLinearGradient(0, 0, 120, 60)
    gradient.addColorStop(0, '#38bdf8')
    gradient.addColorStop(1, '#a855f7')
    context.fillStyle = gradient
    context.fillRect(0, 0, 120, 60)
    renderer.setNodePreviews({ target: { image, width: 120, height: 60, state: 'cached' } })
    return {
      layout: node.layout,
      incoming: { x: incoming.x2, y: incoming.y2 },
      outgoing: { x: outgoing.x1, y: outgoing.y1 },
      expectedInput: { x: node.x, y: node.y + node.layout.headerHeight / 2 },
      expectedOutput: { x: node.x + node.layout.width, y: node.y + node.layout.headerHeight / 2 },
    }
  })
  expect(minimized.layout).toMatchObject({ minimized: true, rows: [], preview: { compact: true } })
  expect(minimized.layout.width).toBeGreaterThanOrEqual(80)
  expect(minimized.layout.minWidth).toBeGreaterThanOrEqual(80)
  expect(minimized.incoming).toEqual(minimized.expectedInput)
  expect(minimized.outgoing).toEqual(minimized.expectedOutput)
  expect((await activeDoc(page)).view.graphs.g0!.nodes.target).toMatchObject({
    collapsed: true,
    size: { width: 360, height: 240 },
  })
  await capture(page, 'minimized-preview', testInfo.project.name, testInfo.outputPath('minimized-preview.png'), async (path) => {
    await testInfo.attach('minimized compact preview', { path, contentType: 'image/png' })
  })

  const minimizedHeader = await nodePoint(page, 'target', 'header')
  await page.mouse.click(minimizedHeader.x, minimizedHeader.y, { button: 'right' })
  await expect(page.locator('[data-item-id="core.node.minimize"]')).toContainText('Restore')
  await expect(page.locator('[data-item-id="core.node.minimize"]')).toContainText(/alt\+c/i)
  await page.locator('[data-item-id="core.node.minimize"]').click()
  expect((await activeDoc(page)).view.graphs.g0!.nodes.target!.collapsed).not.toBe(true)

  await page.mouse.dblclick(...xy(await nodePoint(page, 'target', 'body')))
  expect((await activeDoc(page)).view.graphs.g0!.nodes.target!.collapsed).not.toBe(true)
  await page.mouse.dblclick(...xy(await nodePoint(page, 'target', 'header')))
  expect((await activeDoc(page)).view.graphs.g0!.nodes.target!.collapsed).toBe(true)
  await page.keyboard.press('Control+z')
  expect((await activeDoc(page)).view.graphs.g0!.nodes.target!.collapsed).not.toBe(true)
  await page.keyboard.press('Control+Shift+z')
  expect((await activeDoc(page)).view.graphs.g0!.nodes.target!.collapsed).toBe(true)
  await page.keyboard.press('Control+z')
  expect((await activeDoc(page)).view.graphs.g0!.nodes.target!.collapsed).not.toBe(true)

  const batchRevision = await page.evaluate(() => {
    const controller = window.__dinksterTest!.controller!
    controller.setSelection(['source', 'target'])
    return window.__dinksterTest!.app.activeTab()!.store.revision
  })
  await page.keyboard.press('Alt+c')
  let doc = await activeDoc(page)
  expect(doc.view.graphs.g0!.nodes.source!.collapsed).toBe(true)
  expect(doc.view.graphs.g0!.nodes.target!.collapsed).toBe(true)
  expect(await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.revision)).toBe(batchRevision + 1)
  await page.keyboard.press('Alt+c')
  doc = await activeDoc(page)
  expect(doc.view.graphs.g0!.nodes.source!.collapsed).not.toBe(true)
  expect(doc.view.graphs.g0!.nodes.target!.collapsed).not.toBe(true)

  await page.evaluate(() => window.__dinksterTest!.controller!.setSelection(['target']))
  await page.keyboard.press('Alt+c')
  const reopened = await page.evaluate(() => {
    const app = window.__dinksterTest!.app
    const exported = app.exportDocument(app.activeTab()!.id)!
    const failures = app.openDocument(JSON.parse(JSON.stringify(exported)), 'Minimized nodes reopened')
    return { failures, view: app.activeTab()!.store.doc.view.graphs.g0!.nodes.target }
  })
  expect(reopened.failures).toEqual([])
  expect(reopened.view).toMatchObject({ collapsed: true, size: { width: 360, height: 240 } })
  await expect.poll(() => page.evaluate(() =>
    window.__dinksterTest!.renderer!.getScene().nodes.find((node) => node.id === 'target')?.layout.minimized,
  )).toBe(true)

  await page.evaluate(() => window.__dinksterTest!.controller!.setSelection(['target']))
  await page.keyboard.press('Control+c')
  await page.mouse.move(1120, 380)
  await page.keyboard.press('Control+v')
  await expect.poll(() => page.evaluate(() =>
    Object.keys(window.__dinksterTest!.app.activeTab()!.store.doc.graphs.g0!.nodes).length,
  )).toBe(5)
  const pasted = await page.evaluate(() => {
    const id = [...window.__dinksterTest!.controller!.getSelection()][0]!
    const tab = window.__dinksterTest!.app.activeTab()!
    return { id, view: tab.store.doc.view.graphs.g0!.nodes[id] }
  })
  expect(pasted.id).not.toBe('target')
  expect(pasted.view).toMatchObject({ collapsed: true, size: { width: 360, height: 240 } })
  await capture(page, 'persisted-copy', testInfo.project.name, testInfo.outputPath('persisted-copy.png'), async (path) => {
    await testInfo.attach('reopened and pasted minimized nodes', { path, contentType: 'image/png' })
  })
})

test('minimized aggregate proxies are not link sources and compact body drops still connect', async ({ page }) => {
  await openProof(page)
  await page.evaluate(() => window.__dinksterTest!.controller!.setSelection(['target']))
  await page.keyboard.press('Alt+c')

  await drag(page, await nodePoint(page, 'replacement', 'output'), await nodePoint(page, 'target', 'body'))
  let links = Object.values((await activeDoc(page)).graphs.g0!.links)
  expect(links).toHaveLength(2)
  expect(links.some((link) => 'node' in link.from && link.from.node === 'replacement' &&
    'node' in link.to && link.to.node === 'target' && link.to.port === 'image')).toBe(true)

  const proxy = await nodePoint(page, 'target', 'output')
  await page.mouse.move(proxy.x, proxy.y)
  await page.mouse.down()
  await page.mouse.move(proxy.x + 100, proxy.y - 70)
  expect(await page.evaluate(() => window.__dinksterTest!.renderer!.getOverlay().ghostLink)).toBeUndefined()
  await page.mouse.up()
  links = Object.values((await activeDoc(page)).graphs.g0!.links)
  expect(links).toHaveLength(2)
  await expect(page.getByTestId('node-palette')).not.toBeVisible()
})

test('ComfyUI flags.collapsed imports as minimized state and survives export and reopen', async ({ page }, testInfo) => {
  const result = await page.evaluate((json) => {
    const app = window.__dinksterTest!.app
    const failures = app.openDocument(json, 'Collapsed ComfyUI import')
    const tab = app.activeTab()!
    const exported = app.exportDocument(tab.id)!
    const reopenFailures = app.openDocument(JSON.parse(JSON.stringify(exported)), 'Collapsed import reopened')
    return { failures, reopenFailures, view: app.activeTab()!.store.doc.view.graphs.g0!.nodes }
  }, {
    nodes: [
      { id: 1, type: 'CLIPTextEncode', pos: [180, 160], flags: { collapsed: true }, widgets_values: ['minimized'] },
      { id: 2, type: 'CLIPTextEncode', pos: [540, 160], flags: { collapsed: false }, widgets_values: ['expanded'] },
      { id: 3, type: 'CLIPTextEncode', pos: [900, 160], flags: { collapsed: 'true' }, widgets_values: ['not exact'] },
    ],
    links: [], groups: [], version: 0.4,
  })
  expect(result.failures).toEqual([])
  expect(result.reopenFailures).toEqual([])
  expect(result.view.n1!.collapsed).toBe(true)
  expect(result.view.n2!.collapsed).toBeUndefined()
  expect(result.view.n3!.collapsed).toBeUndefined()
  await expect.poll(() => page.evaluate(() =>
    window.__dinksterTest!.renderer!.getScene().nodes.map((node) => node.layout.minimized === true),
  )).toEqual([true, false, false])
  await capture(page, 'comfyui-import', testInfo.project.name, testInfo.outputPath('comfyui-import.png'), async (path) => {
    await testInfo.attach('ComfyUI collapsed import', { path, contentType: 'image/png' })
  })
})
