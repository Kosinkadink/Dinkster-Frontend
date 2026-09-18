/**
 * Browser regression for occurrence-aware execution projection. One graph
 * definition is instantiated twice, so bare definition node ids cannot tell
 * the host which runtime state belongs in the current drilled-in view.
 */
import { expect, test, type Page } from './fixtures.js'

type ProjectedStates = Readonly<Record<string, { state: string; value?: number }>>

const projectedStates = (page: Page) =>
  page.evaluate(() => {
    // CanvasRenderer intentionally exposes only the setter today. Reading its
    // retained input proves the host projection without coupling this test to
    // pixels, colors, animation timing, or the drawing implementation.
    return (window.__dinksterTest!.renderer! as unknown as { nodeStates: ProjectedStates }).nodeStates
  })

async function drillInto(page: Page, nodeId: string): Promise<void> {
  const header = await page.evaluate((nodeId) => {
    const renderer = window.__dinksterTest!.renderer!
    const node = renderer.getScene().nodes.find((item) => item.id === nodeId)
    if (!node) throw new Error(`no scene node '${nodeId}'`)
    const rect = document.querySelector('[data-testid=graph-canvas]')!.getBoundingClientRect()
    return {
      x: rect.left + node.x + node.layout.width / 2,
      y: rect.top + node.y + node.layout.headerHeight / 2,
    }
  }, nodeId)
  await page.mouse.dblclick(header.x, header.y)
  await expect.poll(() => page.evaluate(() => window.__dinksterTest!.app.activeTab()!.graphStack.get().length)).toBe(2)
}

test('sibling subgraph occurrences project independently at root and when drilled in', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByTestId('status-bar')).toContainText(/\d+ node schemas/, { timeout: 15_000 })

  await page.evaluate(() => {
    const app = window.__dinksterTest!.app
    app.registerSchemas([{
      type: 'OccurrenceLeafE2E',
      displayName: 'Occurrence Leaf',
      category: 'test',
      source: 'v3',
      isOutputNode: false,
      items: [],
    }])
    const document = {
      format: 'dinkster-workflow',
      formatVersion: 1,
      lineage: 'occurrence-projection-e2e',
      root: 'root',
      graphs: {
        root: {
          id: 'root', name: 'root',
          nodes: {
            s1: { id: 's1', type: '#shared', values: {} },
            s2: { id: 's2', type: '#shared', values: {} },
          },
          links: {}, nets: {}, reroutes: {}, nextOrdinal: 10,
        },
        shared: {
          id: 'shared', name: 'shared',
          nodes: { inner: { id: 'inner', type: 'OccurrenceLeafE2E', values: {} } },
          links: {}, nets: {}, reroutes: {}, nextOrdinal: 10,
        },
      },
      view: { graphs: {
        root: { nodes: {
          s1: { position: { x: 120, y: 120 } },
          s2: { position: { x: 480, y: 120 } },
        } },
        shared: { nodes: { inner: { position: { x: 180, y: 140 } } } },
      } },
    }
    app.openDocument(document, 'Occurrence Projection E2E')
    window.__dinksterTest!.renderer!.setViewport({ x: 0, y: 0, scale: 1 })

    const ref = { connection: 'e2e', prompt: 'occurrence-projection' }
    const store = app.store as unknown as {
      register(execution: { connection: string; prompt: string }, artifact: unknown, now: number): void
      apply(event: unknown): void
    }
    // A retained compile artifact associates the synthetic execution with
    // this live tab. Empty provenance deliberately exercises the occurrence
    // parser fallback used for reconciled executions.
    store.register(ref, {
      prompt: {},
      scope: { kind: 'full' },
      snapshot: document,
      provenance: { toSource: {} },
    }, Date.now())
    store.apply({
      kind: 'nodeStates', execution: ref, timestamp: Date.now(),
      nodes: {
        's1.inner': { state: 'running', value: 0.25 },
        's2.inner': { state: 'running', value: 0.75 },
      },
    })
  })

  await expect.poll(() => projectedStates(page)).toEqual({
    s1: { state: 'running', value: 0.25 },
    s2: { state: 'running', value: 0.75 },
  })

  await drillInto(page, 's1')
  await expect.poll(() => projectedStates(page)).toEqual({
    inner: { state: 'running', value: 0.25 },
  })

  await page.getByTestId('graph-breadcrumb').locator('.crumb').first().click()
  await expect.poll(() => page.evaluate(() => window.__dinksterTest!.app.activeTab()!.graphStack.get().length)).toBe(1)
  await drillInto(page, 's2')
  await expect.poll(() => projectedStates(page)).toEqual({
    inner: { state: 'running', value: 0.75 },
  })
})
