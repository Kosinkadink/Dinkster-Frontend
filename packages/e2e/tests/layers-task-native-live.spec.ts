/**
 * The user's task on the development pack's Feature: Layers node, on a live
 * engine: add layers by hand, close the section, put the node in a
 * subgraph and show the whole group on its face, put that in a second
 * subgraph and show it again, then add a layer and edit its field on the
 * outermost node and run it.
 */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { expect, nativeTest as test, subgraphMarkPoint, waitForWorkspaceReady, type Page } from './fixtures.js'

const NATIVE_BACKEND = process.env['DINKSTER_NATIVE_BACKEND'] ?? 'http://127.0.0.1:8765'
const proofDir = process.env['DINKSTER_LAYERS_PROOF_DIR']
if (proofDir) mkdirSync(proofDir, { recursive: true })

const activeDoc = (page: Page) =>
  page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.doc)

const graphIdOfView = (page: Page) =>
  page.evaluate(() => window.__dinksterTest!.renderer!.getScene().graphId)

async function shot(page: Page, name: string): Promise<void> {
  // An empty spot of the canvas: closes a field's hint so the shot shows the node.
  await page.mouse.click(700, 500)
  if (proofDir) await page.getByTestId('graph-canvas').screenshot({ path: join(proofDir, `${name}.png`) })
}

/** Rows of a scene node: kind, id and the shown value. */
const rowsOf = (page: Page, nodeId: string) =>
  page.evaluate((nodeId) => {
    type Row = { kind: string; inputId?: string; construct?: string; label?: string; derivedValue?: unknown; spec?: { default?: unknown } }
    const node = window.__dinksterTest!.renderer!.getScene().nodes.find((n) => n.id === nodeId)!
    const values = (node as unknown as { node: { values: Record<string, unknown> } }).node.values
    return (node.layout.rows as unknown as Row[]).map((row) => row.kind === 'widget'
      ? { kind: row.kind, key: row.inputId, value: row.derivedValue ?? values[row.inputId!] ?? row.spec?.default }
      : { kind: row.kind, key: row.construct ?? row.label })
  }, nodeId)

/** Page point at the middle of the first row of `nodeId` that `match` accepts. */
async function rowPoint(page: Page, nodeId: string, match: { kind: string; inputId?: string }): Promise<{ x: number; y: number }> {
  return page.evaluate(({ nodeId, match }) => {
    const r = window.__dinksterTest!.renderer!
    const node = r.getScene().nodes.find((n) => n.id === nodeId)!
    const row = node.layout.rows.find((item) => item.kind === match.kind &&
      (match.inputId === undefined || (item as { inputId?: string }).inputId === match.inputId))
    if (!row) throw new Error(`no ${match.kind} row ${match.inputId ?? ''} on ${nodeId}`)
    const rect = document.querySelector('[data-testid=graph-canvas]')!.getBoundingClientRect()
    const viewport = r.getViewport()
    return {
      x: rect.left + (node.x + node.layout.width / 2) * viewport.scale + viewport.x,
      y: rect.top + (node.y + row.y + row.height / 2) * viewport.scale + viewport.y,
    }
  }, { nodeId, match })
}

async function headerPoint(page: Page, nodeId: string): Promise<{ x: number; y: number }> {
  return page.evaluate((nodeId) => {
    const r = window.__dinksterTest!.renderer!
    const node = r.getScene().nodes.find((n) => n.id === nodeId)!
    const rect = document.querySelector('[data-testid=graph-canvas]')!.getBoundingClientRect()
    const viewport = r.getViewport()
    return {
      x: rect.left + (node.x + 40) * viewport.scale + viewport.x,
      y: rect.top + (node.y + node.layout.headerHeight / 2) * viewport.scale + viewport.y,
    }
  }, nodeId)
}

const onlyNodeId = (page: Page) =>
  page.evaluate(() => {
    const nodes = window.__dinksterTest!.renderer!.getScene().nodes
    if (nodes.length !== 1) throw new Error(`expected one node, found ${nodes.map((n) => n.id).join(', ')}`)
    return nodes[0]!.id
  })

/** Scale 1, with the shown graph's nodes starting at canvas point (160, 120). */
async function identityViewport(page: Page): Promise<void> {
  await page.evaluate(() => {
    const r = window.__dinksterTest!.renderer!
    const nodes = r.getScene().nodes
    const left = Math.min(...nodes.map((n) => n.x))
    const top = Math.min(...nodes.map((n) => n.y))
    r.setViewport({ x: 160 - left, y: 120 - top, scale: 1 })
  })
}

async function editField(page: Page, nodeId: string, inputId: string, value: string): Promise<void> {
  await page.getByTestId('graph-canvas').focus()
  const point = await rowPoint(page, nodeId, { kind: 'widget', inputId })
  await page.mouse.click(point.x, point.y)
  const editor = page.getByTestId('widget-editor').locator('input')
  await expect(editor).toBeVisible()
  await editor.fill(value)
  await editor.press('Enter')
}

/** Put the only node of the shown graph in a new subgraph; return the subgraph node's id. */
async function extractOnlyNode(page: Page): Promise<string> {
  const id = await onlyNodeId(page)
  const header = await headerPoint(page, id)
  await page.mouse.click(header.x, header.y)
  const before = Object.keys((await activeDoc(page)).graphs).length
  await page.keyboard.press('Control+Shift+E')
  await expect.poll(async () => Object.keys((await activeDoc(page)).graphs).length).toBe(before + 1)
  return onlyNodeId(page)
}

async function showGroupOnFace(page: Page, nodeId: string, inputId: string): Promise<void> {
  const point = await rowPoint(page, nodeId, { kind: 'widget', inputId })
  await page.mouse.click(point.x, point.y, { button: 'right' })
  const item = page.locator('[data-item-id^="core.boundary.showWhole."]').filter({ hasText: 'Show Layers on subgraph node' })
  await expect(item).toHaveCount(1)
  if (proofDir) await page.screenshot({ path: join(proofDir, `menu-${nodeId}.png`) })
  await item.click()
}

async function enter(page: Page, nodeId: string): Promise<void> {
  const before = await graphIdOfView(page)
  const mark = await subgraphMarkPoint(page, nodeId)
  await page.mouse.dblclick(mark.x, mark.y)
  await expect.poll(() => graphIdOfView(page)).not.toBe(before)
  await identityViewport(page)
}

async function leaveToRoot(page: Page): Promise<void> {
  const root = (await activeDoc(page)).root
  await page.getByTestId('graph-breadcrumb').getByRole('button').first().click()
  await expect.poll(() => graphIdOfView(page)).toBe(root)
  await identityViewport(page)
}

test.beforeEach(async ({ page }) => {
  const response = await fetch(`${NATIVE_BACKEND}/api/nodes`, { signal: AbortSignal.timeout(2_000) })
  expect(response.ok).toBe(true)
  const nodes = (await response.json() as { nodes: Record<string, unknown> }).nodes
  expect(nodes, 'the engine must serve the development pack').toHaveProperty(['dev.features.layers'])
  await page.addInitScript(() => {
    localStorage.setItem('dinkster.settings', JSON.stringify({ v: 1, values: { 'dinkster.theme': 'dark' } }))
  })
  await page.goto('/')
  await expect.poll(() => page.evaluate(() =>
    window.__dinksterTest?.app.backends.get()[0]?.registry.get()?.schemas.has('dev.features.layers') ?? false,
  ), { timeout: 15_000 }).toBe(true)
  await waitForWorkspaceReady(page)
})

/** Queue `nodeId` of the shown tab and return the submitted graph and the engine's job record. */
async function runNode(page: Page, request: import('@playwright/test').APIRequestContext, nodeId: string) {
  let submitted: { clientId: string; jobId: string; graph: { nodes: Record<string, { inputs: Record<string, unknown> }> } } | undefined
  const listener = (outgoing: import('@playwright/test').Request) => {
    if (outgoing.method() !== 'POST' || new URL(outgoing.url()).pathname !== '/api/jobs') return
    submitted = outgoing.postDataJSON() as typeof submitted
  }
  page.on('request', listener)
  const before = await page.evaluate(() => window.__dinksterTest!.app.store.executions.get().size)
  await page.evaluate(async (nodeId) => {
    const app = window.__dinksterTest!.app
    await app.queueSelection(app.activeTab()!, [nodeId])
  }, nodeId)
  await expect.poll(() => page.evaluate((before) => {
    const executions = [...window.__dinksterTest!.app.store.executions.get().values()]
    return executions.length > before ? executions.sort((a, b) => b.queuedAt - a.queuedAt)[0]?.status : undefined
  }, before), { timeout: 30_000 }).toBe('completed')
  page.off('request', listener)
  const job = await (await request.get(
    `${NATIVE_BACKEND}/api/jobs/${encodeURIComponent(submitted!.clientId)}/${encodeURIComponent(submitted!.jobId)}`,
  )).json() as { state: string; executed: string[]; skipped: unknown[]; outputs: Record<string, Record<string, { value: unknown }>> }
  return { submitted: submitted!, job }
}

test('the layers task: add, close, forward through two subgraphs, add and edit outside, run', async ({ page, request }) => {
  await page.evaluate(async () => {
    await window.__dinksterTest!.app.openDocument({
      format: 'dinkster-workflow', formatVersion: 1, lineage: 'layers-task-native-live', root: 'g0',
      graphs: { g0: {
        id: 'g0', name: 'root',
        nodes: { layers: { id: 'layers', type: 'dev.features.layers', values: {} } },
        links: {}, nets: {}, reroutes: {}, nextOrdinal: 2,
      } },
      view: { graphs: { g0: { nodes: { layers: { position: { x: 120, y: 80 } } } } } },
    } as never, 'Layers task')
  })
  await identityViewport(page)
  await shot(page, '01-fresh')

  // Add three layers by hand with the "Add layer" row.
  for (let i = 0; i < 3; i++) {
    const add = await rowPoint(page, 'layers', { kind: 'growth' })
    await page.mouse.click(add.x, add.y)
    await expect.poll(async () => (await activeDoc(page)).graphs['g0']!.nodes['layers']!.dynamic?.['layers']?.members).toHaveLength(i + 1)
  }
  expect((await activeDoc(page)).graphs['g0']!.nodes['layers']!.dynamic?.['layers']?.members).toEqual(['1', '2', '3'])
  await editField(page, 'layers', 'layers.1.name', 'base')
  await editField(page, 'layers', 'layers.2.name', 'mid')
  await editField(page, 'layers', 'layers.3.name', 'top')
  await editField(page, 'layers', 'layers.3.strength', '0.5')
  await shot(page, '02-three-layers')

  // Close the section, then open it again.
  const section = await rowPoint(page, 'layers', { kind: 'section' })
  await page.mouse.click(section.x, section.y)
  await expect.poll(async () => (await rowsOf(page, 'layers')).filter((row) => row.kind === 'widget').map((row) => row.key)).toEqual(['title'])
  await shot(page, '03-section-closed')
  await page.mouse.click(section.x, section.y)
  await expect.poll(async () => (await rowsOf(page, 'layers')).some((row) => row.key === 'layers.3.name')).toBe(true)

  // First level: the node in a subgraph, the whole group on its face.
  const inner = await extractOnlyNode(page)
  await enter(page, inner)
  await showGroupOnFace(page, await onlyNodeId(page), 'layers.1.name')
  await leaveToRoot(page)
  await shot(page, '04-inner-subgraph-node')

  // Second level: that subgraph node in another, the group shown again.
  const outer = await extractOnlyNode(page)
  await enter(page, outer)
  // The face shows only the layers stored on the subgraph node, none yet,
  // and the menu that shows a group opens from one of its fields: the inner
  // subgraph node first gets a layer of its own.
  expect((await rowsOf(page, inner)).map((row) => row.kind)).toEqual(['growth'])
  await shot(page, '05-inside-outer')
  const addInner = await rowPoint(page, inner, { kind: 'growth' })
  await page.mouse.click(addInner.x, addInner.y)
  await expect.poll(async () => (await rowsOf(page, inner)).filter((row) => row.kind === 'widget').map((row) => row.key)).toEqual(['layers.1.name', 'layers.1.strength'])
  await showGroupOnFace(page, inner, 'layers.1.name')
  await leaveToRoot(page)
  expect((await rowsOf(page, outer)).map((row) => row.kind)).toEqual(['growth'])
  await shot(page, '06-outer-subgraph-node')

  // On the outermost node: add a layer and edit its field.
  const add = await rowPoint(page, outer, { kind: 'growth' })
  await page.mouse.click(add.x, add.y)
  await expect.poll(async () => (await rowsOf(page, outer)).filter((row) => row.kind === 'widget').map((row) => row.key)).toEqual(['layers.1.name', 'layers.1.strength'])
  await editField(page, outer, 'layers.1.strength', '1.75')
  await editField(page, outer, 'layers.1.name', 'glaze')
  await shot(page, '07-outer-added-edited')
  const doc = await activeDoc(page)
  expect(doc.graphs[doc.root]!.nodes[outer]!.values).toEqual({ 'layers.1.name': 'glaze', 'layers.1.strength': 1.75 })

  // The run takes the layers in order: the definition's, the inner subgraph node's, then the outermost's.
  const { job } = await runNode(page, request, outer)
  expect(Object.values(job.outputs).map((outputs) => outputs['text']!.value))
    .toEqual(['Layers: base 1.00, mid 1.00, top 0.50, layer 1.00, glaze 1.75'])
})

test('a wire from a field whose option is no longer chosen gives nothing, and its receiving node is skipped', async ({ page, request }) => {
  await page.evaluate(async () => {
    await window.__dinksterTest!.app.openDocument({
      format: 'dinkster-workflow', formatVersion: 1, lineage: 'gives-nothing-native-live', root: 'g0',
      graphs: { g0: {
        id: 'g0', name: 'root',
        nodes: {
          opt: { id: 'opt', type: 'dev.features.option_fields', values: { 'mode.amount': 0.65 }, dynamic: { mode: { selected: 'fixed' } } },
          req: { id: 'req', type: 'dev.features.required_value', values: {} },
        },
        links: { l1: { id: 'l1', from: { node: 'opt', tap: 'mode.amount' }, to: { node: 'req', port: 'value' } } },
        nets: {}, reroutes: {}, nextOrdinal: 3,
      } },
      view: { graphs: { g0: { nodes: { opt: { position: { x: 120, y: 80 } }, req: { position: { x: 480, y: 80 } } } } } },
    } as never, 'Gives nothing')
  })
  await identityViewport(page)
  await shot(page, '11-amount-wired')

  // While "Fixed amount" is chosen the wire carries the field's value.
  const first = await runNode(page, request, 'req')
  // A field's output is its value, sent in place of the wire.
  expect(first.submitted.graph.nodes['req']!.inputs['value']).toBe(0.65)
  expect(first.job.outputs['req']!['text']!.value).toBe('value=0.65')

  // Choose "No amount": the amount row stays only for its wire, reads "wired", and the wire gives nothing.
  await page.getByTestId('graph-canvas').focus()
  const mode = await rowPoint(page, 'opt', { kind: 'widget', inputId: 'mode' })
  await page.mouse.click(mode.x, mode.y)
  const option = page.getByRole('option', { name: 'No amount', exact: true })
  await expect(option).toBeVisible()
  await option.click()
  await expect.poll(async () => (await activeDoc(page)).graphs['g0']!.nodes['opt']!.dynamic?.['mode']?.selected).toBe('none')
  await shot(page, '12-amount-not-chosen-wired')

  const second = await runNode(page, request, 'req')
  expect(second.submitted.graph.nodes['req']!.inputs['value']).toEqual({ $absent: { reason: expect.any(String) } })
  expect(second.job.executed).not.toContain('req')
  expect(second.job.skipped).toContain('req')
  await shot(page, '13-ran-skipped')
})
