/**
 * Widget visual audit: saves deterministic, clipped screenshots for compact
 * canvas rows and their expanded editor surfaces. Attachments are used
 * instead of golden pixels because Canvas2D text rasterization varies by OS;
 * controller chip/value non-overlap is pinned numerically in
 * canvas/test/controller-chip.test.ts.
 */
import { expect, test, type Locator, type Page } from './fixtures.js'

type WidgetId = 'seed' | 'amount' | 'title' | 'choice' | 'enabled' | 'color'

async function rowPoint(page: Page, inputId: WidgetId): Promise<{ x: number; y: number }> {
  return page.evaluate((inputId) => {
    const node = window.__dinksterTest!.renderer!.getScene().nodes.find((item) => item.id === 'visual-widgets')!
    const row = node.layout.rows.find((item) => item.kind === 'widget' && item.inputId === inputId)!
    const canvas = document.querySelector('[data-testid=graph-canvas]')!.getBoundingClientRect()
    const viewport = window.__dinksterTest!.renderer!.getViewport()
    return {
      x: canvas.left + (node.x + node.layout.width * (inputId === 'seed' ? 0.25 : 0.5)) * viewport.scale + viewport.x,
      y: canvas.top + (node.y + row.y + row.height / 2) * viewport.scale + viewport.y,
    }
  }, inputId)
}

async function attachRow(page: Page, inputId: WidgetId): Promise<void> {
  const clip = await page.evaluate((inputId) => {
    const node = window.__dinksterTest!.renderer!.getScene().nodes.find((item) => item.id === 'visual-widgets')!
    if (!node.layout.rows.some((item) => item.kind === 'widget' && item.inputId === inputId)) throw new Error(`missing ${inputId} row`)
    const canvas = document.querySelector('[data-testid=graph-canvas]')!.getBoundingClientRect()
    const viewport = window.__dinksterTest!.renderer!.getViewport()
    return {
      x: canvas.left + (node.x - 8) * viewport.scale + viewport.x,
      y: canvas.top + (node.y - 8) * viewport.scale + viewport.y,
      width: (node.layout.width + 16) * viewport.scale,
      height: (node.layout.height + 16) * viewport.scale,
    }
  }, inputId)
  await test.info().attach(`${inputId}-on-node`, {
    body: await page.screenshot({ clip, animations: 'disabled' }),
    contentType: 'image/png',
  })
}

async function attachEditor(page: Page, inputId: WidgetId, editor: Locator): Promise<void> {
  await expect(editor).toBeVisible()
  await test.info().attach(`${inputId}-expanded-editor`, {
    body: await editor.screenshot({ animations: 'disabled' }),
    contentType: 'image/png',
  })
}

async function open(page: Page, inputId: WidgetId): Promise<void> {
  const point = await rowPoint(page, inputId)
  await page.mouse.click(point.x, point.y)
}

test.beforeEach(async ({ page }) => {
  await page.route('/system_stats', (route) =>
    route.fulfill({ json: { system: { os: 'e2e' }, devices: [] } }),
  )
  await page.route('/object_info', (route) => route.fulfill({ json: {} }))
  await page.goto('/')
  await expect(page.getByTestId('status-bar')).toContainText(/\d+ node schemas/, { timeout: 15_000 })
  await page.addStyleTag({ content: '*, *::before, *::after { animation: none !important; transition: none !important; }' })
  await page.evaluate(() => {
    const widget = (
      id: string,
      widgetType: string,
      defaultValue: unknown,
      options: Record<string, unknown> = {},
      controller?: 'after_generate',
    ) => ({
      kind: 'input', id, type: { kind: 'concrete', name: widgetType === 'COMBO' ? 'core.combo' : widgetType }, optional: false,
      widget: { widgetType, options, default: defaultValue, ...(controller ? { controller } : {}) },
    })
    window.__dinksterTest!.app.registerSchemas([{
      type: 'WidgetVisualAudit', displayName: 'Widget Visual Audit', category: 'test', source: 'v3', isOutputNode: false,
      items: [
        widget('seed', 'INT', 123456789, { min: 0, max: 999999999, step: 1 }, 'after_generate'),
        widget('amount', 'FLOAT', 1.23456789, { min: 0, max: 10 }),
        widget('title', 'STRING', 'A deterministic compact string value'),
        widget('choice', 'COMBO', 'gamma-deterministic-option', { options: ['alpha', 'beta', 'gamma-deterministic-option'] }),
        widget('enabled', 'BOOLEAN', false),
        widget('color', 'COLOR', '#3366cc80'),
      ],
    }])
    window.__dinksterTest!.app.openDocument({
      format: 'dinkster-workflow', formatVersion: 1, lineage: 'widget-visual-audit', root: 'g0',
      graphs: { g0: { id: 'g0', name: 'root', nodes: {
        'visual-widgets': { id: 'visual-widgets', type: 'WidgetVisualAudit', values: {} },
      }, links: {}, nets: {}, reroutes: {}, nextOrdinal: 2 } },
      view: { graphs: { g0: { nodes: { 'visual-widgets': { position: { x: 180, y: 120 } } } } } },
    }, 'Widget Visual Audit')
    window.__dinksterTest!.renderer!.setViewport({ x: 0, y: 0, scale: 1 })
  })
  await expect.poll(() => page.evaluate(() =>
    window.__dinksterTest!.renderer!.getScene().nodes.find((item) => item.id === 'visual-widgets')?.layout.rows
      .filter((item) => item.kind === 'widget').length)).toBe(6)
})

test('INT controller row and expanded editor visual audit', async ({ page }) => {
  await attachRow(page, 'seed')
  await open(page, 'seed')
  const editor = page.getByTestId('widget-editor')
  await expect(editor.locator('input')).toHaveValue('123456789')
  await attachEditor(page, 'seed', editor)
})

test('FLOAT row and expanded editor visual audit', async ({ page }) => {
  await attachRow(page, 'amount')
  await open(page, 'amount')
  const editor = page.getByTestId('widget-editor')
  await expect(editor.locator('input')).toHaveValue('1.23456789')
  await attachEditor(page, 'amount', editor)
})

test('STRING row and expanded editor visual audit', async ({ page }) => {
  await attachRow(page, 'title')
  await open(page, 'title')
  await attachEditor(page, 'title', page.getByTestId('widget-editor'))
})

test.describe('single-line STRING device-pixel layout', () => {
  test.use({ deviceScaleFactor: 2 })

  test('CLIP Text Encode keeps a long single-line text value in its own zone', async ({ page }) => {
  const long = 'beautiful scenery nature glass bottle landscape, '.repeat(40)
  await page.evaluate((value) => {
    const string = { kind: 'concrete', name: 'STRING' }
    window.__dinksterTest!.app.registerSchemas([{
      type: 'CLIPTextEncodeLayoutProof',
      displayName: 'CLIP Text Encode',
      category: 'test',
      source: 'v3',
      isOutputNode: false,
      items: [
        {
          kind: 'input', id: 'text', type: string, optional: false,
          widget: { widgetType: 'STRING', options: {}, default: '' },
        },
        { kind: 'input', id: 'clip', type: { kind: 'concrete', name: 'CLIP' }, optional: true },
        { kind: 'output', id: 'conditioning', type: { kind: 'concrete', name: 'CONDITIONING' } },
      ],
    }])
    window.__dinksterTest!.app.openDocument({
      format: 'dinkster-workflow', formatVersion: 1, lineage: 'clip-text-layout-proof', root: 'g0',
      graphs: { g0: { id: 'g0', name: 'root', nodes: {
        clip: { id: 'clip', type: 'CLIPTextEncodeLayoutProof', values: { text: value } },
      }, links: {}, nets: {}, reroutes: {}, nextOrdinal: 2 } },
      view: { graphs: { g0: { nodes: {
        clip: { position: { x: 180, y: 120 }, size: { width: 448, height: 180 } },
      } } } },
    }, 'CLIP Text Encode Layout Proof')
    window.__dinksterTest!.renderer!.setViewport({ x: 0, y: 0, scale: 1 })
  }, long)

  await expect.poll(() => page.evaluate(() => window.__dinksterTest!.renderer!.getScene().nodes
    .find((node) => node.id === 'clip')?.layout.width)).toBe(448)

  const before = await page.evaluate(() => {
    const app = window.__dinksterTest!.app
    const compiled = app.compileTab(app.activeTab()!)
    if (!compiled?.ok) throw new Error('CLIP Text Encode layout fixture did not compile')
    const artifact = compiled.artifact as unknown as { prompt: unknown; semanticHash: string }
    return { prompt: artifact.prompt, semanticHash: artifact.semanticHash }
  })
  expect(JSON.stringify(before.prompt)).toContain(long)

  for (const [width, scale] of [[300, 0.75], [448, 1], [720, 1.5]] as const) {
    const proof = await page.evaluate(({ width, scale }) => {
      const test = window.__dinksterTest!
      const tab = test.app.activeTab()!
      const node = test.renderer!.getScene().nodes.find((item) => item.id === 'clip')!
      tab.store.dispatch({
        command: 'view.setNodeSize',
        params: { graphId: tab.store.doc.root, nodeId: 'clip', size: { width, height: node.layout.height } },
      })
      test.renderer!.setViewport({ x: 0, y: 0, scale })

      const calls: Array<{ text: string; x: number; align: CanvasTextAlign }> = []
      const prototype = CanvasRenderingContext2D.prototype
      const original = prototype.fillText
      prototype.fillText = function (text, x, y, maxWidth) {
        calls.push({ text, x, align: this.textAlign })
        if (maxWidth === undefined) return original.call(this, text, x, y)
        return original.call(this, text, x, y, maxWidth)
      }
      try {
        ;(test.renderer! as unknown as { renderNow(): void }).renderNow()
      } finally {
        prototype.fillText = original
      }

      const paintedNode = test.renderer!.getScene().nodes.find((item) => item.id === 'clip')!
      const row = paintedNode.layout.rows.find((item) => item.kind === 'widget' && item.inputId === 'text')!
      const canvas = document.querySelector('[data-testid=graph-canvas]')!.getBoundingClientRect()
      const viewport = test.renderer!.getViewport()
      return {
        calls,
        devicePixelRatio: window.devicePixelRatio,
        rowHeight: row.height,
        nodeWidth: paintedNode.layout.width,
        clip: {
          x: canvas.left + (paintedNode.x - 8) * viewport.scale + viewport.x,
          y: canvas.top + (paintedNode.y - 8) * viewport.scale + viewport.y,
          width: (paintedNode.layout.width + 16) * viewport.scale,
          height: (paintedNode.layout.height + 16) * viewport.scale,
        },
      }
    }, { width, scale })

    expect(proof.devicePixelRatio).toBe(2)
    expect(proof.nodeWidth).toBe(width)
    expect(proof.rowHeight).toBeLessThan(60)
    expect(proof.calls.some((call) => call.text === 'text' && call.align === 'left')).toBe(true)
    expect(proof.calls.some((call) => call.text.startsWith('beautiful') && call.text.endsWith('...') && call.align === 'right')).toBe(true)
    await test.info().attach(`clip-text-${width}px-zoom-${scale}`, {
      body: await page.screenshot({ clip: proof.clip, animations: 'disabled', scale: 'device' }),
      contentType: 'image/png',
    })
  }

  const exported = await page.evaluate(() => {
    const app = window.__dinksterTest!.app
    const tab = app.activeTab()!
    const document = app.exportDocument(tab.id)
    app.openDocument(document, 'CLIP Text Encode Reopened')
    return document
  })
  expect((exported as { graphs: { g0: { nodes: { clip: { values: { text: string } } } } } })
    .graphs.g0.nodes.clip.values.text).toBe(long)
  await expect.poll(() => page.evaluate(() => window.__dinksterTest!.app.activeTab()!
    .store.doc.graphs.g0!.nodes.clip!.values.text)).toBe(long)
  const after = await page.evaluate(() => {
    const app = window.__dinksterTest!.app
    const compiled = app.compileTab(app.activeTab()!)
    if (!compiled?.ok) throw new Error('reopened CLIP Text Encode layout fixture did not compile')
    const artifact = compiled.artifact as unknown as { prompt: unknown; semanticHash: string }
    return { prompt: artifact.prompt, semanticHash: artifact.semanticHash }
  })
  expect(after).toEqual(before)

  const rowPoint = await page.evaluate(() => {
    const test = window.__dinksterTest!
    const node = test.renderer!.getScene().nodes.find((item) => item.id === 'clip')!
    const row = node.layout.rows.find((item) => item.kind === 'widget' && item.inputId === 'text')!
    const canvas = document.querySelector('[data-testid=graph-canvas]')!.getBoundingClientRect()
    const viewport = test.renderer!.getViewport()
    return {
      x: canvas.left + (node.x + node.layout.width / 2) * viewport.scale + viewport.x,
      y: canvas.top + (node.y + row.y + row.height / 2) * viewport.scale + viewport.y,
    }
  })
  await page.mouse.move(rowPoint.x, rowPoint.y)
  await page.mouse.click(rowPoint.x, rowPoint.y)
  const editor = page.getByTestId('widget-editor')
  await expect(editor.locator('input')).toHaveValue(long)
  const editorBox = await editor.boundingBox()
  expect(editorBox).not.toBeNull()
  expect(editorBox!.x).toBeGreaterThanOrEqual(0)
  expect(editorBox!.x + editorBox!.width).toBeLessThanOrEqual(1440)
  await page.keyboard.press('Escape')
  await expect(editor).toHaveCount(0)
  await expect.poll(() => page.evaluate(() => window.__dinksterTest!.app.activeTab()!
    .store.doc.graphs.g0!.nodes.clip!.values.text)).toBe(long)
  })
})

test('COMBO row and expanded editor visual audit', async ({ page }) => {
  await attachRow(page, 'choice')
  await open(page, 'choice')
  await attachEditor(page, 'choice', page.getByTestId('combo-dropdown'))
})

test('BOOLEAN inline toggle visual audit', async ({ page }) => {
  await attachRow(page, 'enabled')
  await open(page, 'enabled')
  await expect.poll(() => page.evaluate(() =>
    window.__dinksterTest!.app.activeTab()!.store.doc.graphs.g0!.nodes['visual-widgets']!.values.enabled)).toBe(true)
  await attachRow(page, 'enabled')
  await expect(page.getByTestId('widget-editor')).toHaveCount(0)
})

test('COLOR row and expanded editor visual audit', async ({ page }) => {
  await attachRow(page, 'color')
  await open(page, 'color')
  await attachEditor(page, 'color', page.getByTestId('color-editor'))
})
