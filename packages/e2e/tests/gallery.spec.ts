/**
 * Widget & Socket Gallery: one workflow that instantiates every widget kind
 * and every socket display variant (required/optional, MultiType 2/3/4-way,
 * Any, list<T>, list unions, nested lists, match-type variables) so display
 * regressions surface in ONE place and a full-canvas screenshot artifact is
 * produced for visual review on every run. The fixtures
 * (fixtures/gallery-schemas.json + fixtures/gallery-workflow.json) are the
 * frontend's half of the shared gallery contract; the backend's dev gallery
 * pack mirrors the same coverage for live end-to-end testing.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from './fixtures.js'

const fixtures = join(dirname(fileURLToPath(import.meta.url)), '../fixtures')
const schemas = JSON.parse(readFileSync(join(fixtures, 'gallery-schemas.json'), 'utf8')) as unknown[]
const workflow = JSON.parse(readFileSync(join(fixtures, 'gallery-workflow.json'), 'utf8')) as {
  graphs: { g0: { nodes: Record<string, unknown>; links: Record<string, unknown> } }
}

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await expect(page.getByTestId('status-bar')).toContainText(/\d+ node schemas/, { timeout: 15_000 })
  await page.evaluate(
    ({ schemas, workflow }) => {
      window.__dinksterTest!.app.registerSchemas(schemas as never)
      const diags = window.__dinksterTest!.app.openDocument(workflow, 'Widget & Socket Gallery')
      if (diags.length > 0) throw new Error(`gallery failed to open: ${JSON.stringify(diags)}`)
      window.__dinksterTest!.renderer!.setViewport({ x: 20, y: 20, scale: 0.85 })
    },
    { schemas, workflow },
  )
})

test('every gallery node resolves and lays out with zero problems', async ({ page }) => {
  const state = await page.evaluate(() => {
    const app = window.__dinksterTest!.app
    const scene = window.__dinksterTest!.renderer!.getScene()
    return {
      sceneNodeIds: scene.nodes.map((n) => n.id).sort(),
      unresolved: scene.nodes.filter((n) => n.layout.rows.length === 0 && n.layout.pins.length === 0).map((n) => n.id),
      problems: app.problems.get().map((p) => `${p.severity}:${p.code}`),
      links: Object.keys(app.activeTab()!.store.doc.graphs.g0!.links).length,
    }
  })
  expect(state.sceneNodeIds).toEqual(Object.keys(workflow.graphs.g0.nodes).sort())
  expect(state.unresolved).toEqual([])
  expect(state.problems.filter((p) => p.startsWith('error:'))).toEqual([])
  expect(state.links).toBe(Object.keys(workflow.graphs.g0.links).length)
})

test('gallery pins cover every socket display variant', async ({ page }) => {
  const pins = await page.evaluate(() => {
    const scene = window.__dinksterTest!.renderer!.getScene()
    const byNode: Record<string, {
      id: string
      kind: string
      optional: boolean
      matchVariable?: string
      inferred?: boolean
    }[]> = {}
    for (const node of scene.nodes) {
      byNode[node.id] = node.layout.pins.map((p) => ({
        id: p.portId,
        kind: p.type?.kind ?? 'missing',
        optional: p.optional === true,
        ...(p.matchVariable === undefined ? {} : { matchVariable: p.matchVariable }),
        ...(p.inferred === true ? { inferred: true } : {}),
      }))
    }
    return byNode
  })
  const socketsIn = pins['sockets_in']!
  expect(socketsIn.find((p) => p.id === 'union4')?.kind).toBe('union')
  expect(socketsIn.find((p) => p.id === 'any_in')?.kind).toBe('wildcard')
  expect(socketsIn.find((p) => p.id === 'opt_any')?.optional).toBe(true)
  const socketsList = pins['sockets_list']!
  expect(socketsList.find((p) => p.id === 'list_req')?.kind).toBe('list')
  expect(socketsList.find((p) => p.id === 'list_nested')?.kind).toBe('list')
  expect(socketsList.find((p) => p.id === 'list_union')?.kind).toBe('union')
  // Connected match-type pin solves to the traced concrete type; the
  // unconnected instance keeps the open variable display.
  expect(pins['sockets_var']!.find((p) => p.id === 'var_in')?.kind).toBe('concrete')
  expect(pins['sockets_var']!.find((p) => p.id === 'var_in')).toMatchObject({ matchVariable: 'T', inferred: true })
  expect(pins['sockets_var']!.find((p) => p.id === 'var_out')).toMatchObject({ matchVariable: 'T', inferred: true })
  expect(pins['sockets_var_open']!.find((p) => p.id === 'var_in')).toMatchObject({
    kind: 'variable',
    matchVariable: 'T',
  })
  expect(pins['sockets_var_open']!.find((p) => p.id === 'var_out')).toMatchObject({
    kind: 'variable',
    matchVariable: 'T',
  })
})

test('visual artifact: full gallery screenshot', async ({ page }, testInfo) => {
  // Not a pixel assertion - a stable, human-reviewable artifact. Attach it
  // so the report always carries the current gallery rendering.
  const path = testInfo.outputPath('gallery.png')
  await page.getByTestId('graph-canvas').screenshot({ path })
  await testInfo.attach('gallery', { path, contentType: 'image/png' })
})
