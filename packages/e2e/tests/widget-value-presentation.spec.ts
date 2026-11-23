// Native discovery loads the live CheckpointLoaderSimple schema without
// seeded editing documents; ownership acknowledgments use the shared fixture.
import { expect, nativeTest as test, skipWithoutNativeCatalog, waitForWorkspaceReady, type Page } from './fixtures.js'

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
    const restore = [CanvasRenderingContext2D.prototype, OffscreenCanvasRenderingContext2D.prototype].map((prototype) => {
      const original = prototype.fillText
      prototype.fillText = function (text, x, y, maxWidth) {
        calls.push(text)
        if (maxWidth === undefined) return original.call(this, text, x, y)
        return original.call(this, text, x, y, maxWidth)
      }
      return () => { prototype.fillText = original }
    })
    try {
      const renderer = test.renderer! as unknown as { invalidate(): void; renderNow(): void }
      renderer.invalidate()
      renderer.renderNow()
    } finally {
      for (const reset of restore) reset()
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
  await page.goto('/')
  await expect(page.getByTestId('status-bar')).toContainText('connected', { timeout: 15_000 })
  await waitForWorkspaceReady(page)
  await page.evaluate(async () => {
    await window.__dinksterTest!.app.openDocument({
      format: 'dinkster-workflow', formatVersion: 1, lineage: 'widget-value-presentation', root: 'g0',
      graphs: { g0: {
        id: 'g0', name: 'root',
        nodes: { loader: { id: 'loader', type: 'CheckpointLoaderSimple', values: {} } },
        links: {}, nets: {}, reroutes: {}, nextOrdinal: 1,
      } },
      view: { graphs: { g0: { nodes: { loader: { position: { x: 100, y: 100 } } } } } },
    }, 'Widget Value Presentation')
    window.__dinksterTest!.renderer!.setViewport({ x: 0, y: 0, scale: 1 })
  })
  await waitForWorkspaceReady(page)
  await expect.poll(() => page.evaluate(() => {
    const node = window.__dinksterTest!.renderer!.getScene().nodes.find((candidate) => candidate.id === 'loader')
    return node?.layout.rows.some((row) => row.kind === 'widget' && row.inputId === 'ckpt_name') ?? false
  })).toBe(true)
})

test('ASSET values preserve the placeholder before the label and ellipsize long names', async ({ page }) => {
  const natural = await paintNode(page)
  // A checkpoint asks for a model when the catalog declares its kind, else for a file.
  const emptyText = /^Choose (model|file)$/
  expect(natural.calls.some((call) => emptyText.test(call))).toBe(true)
  await test.info().attach('asset-placeholder-default-width', {
    body: await page.screenshot({ clip: natural.clip, animations: 'disabled' }),
    contentType: 'image/png',
  })

  // Narrower than its label and value together, the row gives the empty
  // text its whole width before any of the label. At 160 px the field
  // between the opener's icon and chevron holds "Choose model" whole; at
  // 140 px it cannot.
  const narrow = await paintNode(page, 160)
  expect(narrow.nodeWidth).toBe(160)
  expect(narrow.calls.some((call) => emptyText.test(call))).toBe(true)
  expect(narrow.calls.some((call) => call.startsWith('Choose') && call.endsWith('...'))).toBe(false)
  await test.info().attach('asset-placeholder-narrow-width', {
    body: await page.screenshot({ clip: narrow.clip, animations: 'disabled' }),
    contentType: 'image/png',
  })

  const longName = 'this-is-a-very-long-checkpoint-name-that-must-ellipsize.safetensors'
  expect(await page.evaluate(async (name) => {
    const app = window.__dinksterTest!.app
    const tab = app.activeTab()!
    return (await app.dispatchTo(tab, {
      command: 'node.setValue',
      params: {
        graphId: tab.store.doc.root,
        nodeId: 'loader',
        inputId: 'ckpt_name',
        value: {
          digest: `blake3:${'0'.repeat(64)}`,
          name,
          size: 1,
          mediaType: 'application/octet-stream',
          virtualPath: `checkpoints/${name}`,
        },
      },
    })).ok
  }, longName)).toBe(true)
  const populated = await paintNode(page, 140)
  expect(populated.nodeWidth).toBe(140)
  expect(populated.calls).not.toContain(longName)
  expect(populated.calls.some((call) => call.startsWith('this-') && call.endsWith('...'))).toBe(true)
  await test.info().attach('asset-long-value-narrow-width', {
    body: await page.screenshot({ clip: populated.clip, animations: 'disabled' }),
    contentType: 'image/png',
  })
})
