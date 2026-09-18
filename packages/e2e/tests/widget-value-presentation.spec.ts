// Raw @playwright/test, not the shared fixture: this spec needs same-origin
// native discovery to reach the real /api/nodes proxy so the app loads the
// live dinkster.load_checkpoint schema. The shared fixture would pin that
// probe to 502.
import { expect, test, type Page } from '@playwright/test'
import { skipWithoutNativeCatalog } from './fixtures.js'

async function paintNode(page: Page, width?: number): Promise<{
  calls: string[]
  nodeWidth: number
  clip: { x: number; y: number; width: number; height: number }
}> {
  return page.evaluate((nodeWidth) => {
    const test = window.__dinksterTest!
    const tab = test.app.activeTab()!
    if (nodeWidth !== undefined) {
      test.app.activeTab()!.store.dispatch({
        command: 'view.setNodeSize',
        params: { graphId: tab.store.doc.root, nodeId: 'loader', size: { width: nodeWidth, height: 100 } },
      })
    }
    const calls: string[] = []
    const original = CanvasRenderingContext2D.prototype.fillText
    CanvasRenderingContext2D.prototype.fillText = function (text, x, y, maxWidth) {
      calls.push(text)
      if (maxWidth === undefined) return original.call(this, text, x, y)
      return original.call(this, text, x, y, maxWidth)
    }
    try {
      ;(test.renderer! as unknown as { renderNow(): void }).renderNow()
    } finally {
      CanvasRenderingContext2D.prototype.fillText = original
    }
    const node = test.renderer!.getScene().nodes.find((candidate) => candidate.id === 'loader')!
    const canvas = document.querySelector('[data-testid=graph-canvas]')!.getBoundingClientRect()
    const viewport = test.renderer!.getViewport()
    return {
      calls,
      nodeWidth: node.layout.width,
      clip: {
        x: canvas.left + (node.x - 8) * viewport.scale + viewport.x,
        y: canvas.top + (node.y - 8) * viewport.scale + viewport.y,
        width: (node.layout.width + 16) * viewport.scale,
        height: (node.layout.height + 16) * viewport.scale,
      },
    }
  }, width)
}

test.beforeEach(async ({ page, request }, testInfo) => {
  await skipWithoutNativeCatalog(request, testInfo)
  await page.route('/system_stats', (route) => void route.fulfill({ json: { system: { os: 'e2e' }, devices: [] } }))
  await page.route('/object_info', (route) => void route.fulfill({ json: {} }))
  await page.goto('/')
  await expect(page.getByTestId('status-bar')).toContainText('connected', { timeout: 15_000 })
  await page.evaluate(() => {
    window.__dinksterTest!.app.openDocument({
      format: 'dinkster-workflow', formatVersion: 1, lineage: 'widget-value-presentation', root: 'g0',
      graphs: { g0: {
        id: 'g0', name: 'root',
        nodes: { loader: { id: 'loader', type: 'dinkster.load_checkpoint', values: {} } },
        links: {}, nets: {}, reroutes: {}, nextOrdinal: 1,
      } },
      view: { graphs: { g0: { nodes: { loader: { position: { x: 100, y: 100 } } } } } },
    }, 'Widget Value Presentation')
    window.__dinksterTest!.renderer!.setViewport({ x: 0, y: 0, scale: 1 })
  })
  await expect.poll(() => page.evaluate(() => {
    const node = window.__dinksterTest!.renderer!.getScene().nodes.find((candidate) => candidate.id === 'loader')
    return node?.layout.rows.some((row) => row.kind === 'widget' && row.inputId === 'checkpoint') ?? false
  })).toBe(true)
})

test('ASSET values preserve the placeholder before the label and ellipsize long names', async ({ page }) => {
  const natural = await paintNode(page)
  expect(natural.calls).toContain('no asset')
  await test.info().attach('asset-placeholder-default-width', {
    body: await page.screenshot({ clip: natural.clip, animations: 'disabled' }),
    contentType: 'image/png',
  })

  const narrow = await paintNode(page, 140)
  expect(narrow.nodeWidth).toBe(140)
  expect(narrow.calls).toContain('no asset')
  expect(narrow.calls).not.toContain('no...')
  await test.info().attach('asset-placeholder-narrow-width', {
    body: await page.screenshot({ clip: narrow.clip, animations: 'disabled' }),
    contentType: 'image/png',
  })

  const longName = 'this-is-a-very-long-checkpoint-name-that-must-ellipsize.safetensors'
  await page.evaluate((name) => {
    const tab = window.__dinksterTest!.app.activeTab()!
    tab.store.dispatch({
      command: 'node.setValue',
      params: {
        graphId: tab.store.doc.root,
        nodeId: 'loader',
        inputId: 'checkpoint',
        value: {
          digest: `blake3:${'0'.repeat(64)}`,
          name,
          size: 1,
          mediaType: 'application/octet-stream',
          virtualPath: `checkpoints/${name}`,
        },
      },
    })
  }, longName)
  const populated = await paintNode(page, 140)
  expect(populated.nodeWidth).toBe(140)
  expect(populated.calls).not.toContain(longName)
  expect(populated.calls.some((call) => call.startsWith('this-') && call.endsWith('...'))).toBe(true)
  await test.info().attach('asset-long-value-narrow-width', {
    body: await page.screenshot({ clip: populated.clip, animations: 'disabled' }),
    contentType: 'image/png',
  })
})
