/**
 * Browser regression for the growth row of a group whose member holds only
 * nested groups, driven through the PRODUCTION CanvasHost with real mouse
 * input.
 *
 * An offered member of such a group shows no pin or field (groups inside a
 * member the document does not store offer nothing), so the elaborator
 * emits a clickable growth row instead. These tests prove the full
 * production path: scene row -> real hit test -> interaction gesture ->
 * dynamic.materialize dispatch -> rerender -> undo, at BOTH nesting levels
 * (outer growth on a fresh node, inner growth after the outer member
 * persists).
 */
import { expect, test, type Page } from './fixtures.js'

const activeDoc = (page: Page) =>
  page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.doc)

/** Growth rows of node 'p': construct + frames + geometry for clicking. */
const growthRows = (page: Page) =>
  page.evaluate(() => {
    const node = window.__dinksterTest!.renderer!.getScene().nodes.find((n) => n.id === 'p')!
    return node.layout.rows
      .filter((r) => r.kind === 'growth')
      .map((r) => ({
        construct: r.construct!,
        label: r.label!,
        frames: r.frames!.map((f) => ({ construct: f.construct, members: [...f.members], seq: (f as { readonly seq?: number }).seq })),
      }))
  })

const inputPins = (page: Page) =>
  page.evaluate(() => {
    const node = window.__dinksterTest!.renderer!.getScene().nodes.find((n) => n.id === 'p')!
    return node.layout.pins
      .filter((pin) => pin.direction === 'in')
      .map((pin) => ({ portId: pin.portId, ghost: pin.ghost ?? false }))
  })

/** Screen-space center of node 'p''s growth row for `construct`. */
async function growthRowPoint(page: Page, construct: string): Promise<{ x: number; y: number }> {
  return page.evaluate((construct) => {
    const node = window.__dinksterTest!.renderer!.getScene().nodes.find((n) => n.id === 'p')!
    const row = node.layout.rows.find((r) => r.kind === 'growth' && r.construct === construct)
    if (!row) throw new Error(`no growth row '${construct}'`)
    const rect = document.querySelector('[data-testid=graph-canvas]')!.getBoundingClientRect()
    return {
      x: rect.left + node.x + node.layout.width / 2,
      y: rect.top + node.y + row.y + row.height / 2,
    }
  }, construct)
}

async function openGrowthWorkflow(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const IMAGE = { kind: 'concrete', name: 'IMAGE' }
    // Three nested groups: items > sub > leaf, every level min-0 and only
    // the innermost one holding an input ('leaf' members are inputs). A
    // fresh node therefore renders NO pins at all - only the outer growth
    // row.
    window.__dinksterTest!.app.registerSchemas([
      {
        type: 'GrowthNestTest',
        displayName: 'GrowthNestTest',
        category: 'test',
        source: 'v3',
        isOutputNode: false,
        body: [
          {
            kind: 'group',
            id: 'items',
            keys: { kind: 'numbered', prefix: 'item', start: 0, pad: 0 },
            grows: 'link',
            minMembers: 0,
            maxMembers: 3,
            member: [
              {
                kind: 'group',
                id: 'sub',
                keys: { kind: 'numbered', prefix: 'sub', start: 0, pad: 0 },
                grows: 'link',
                minMembers: 0,
                maxMembers: 3,
                member: [
                  {
                    kind: 'group',
                    id: 'leaf',
                    keys: { kind: 'numbered', prefix: 'leaf', start: 0, pad: 0 },
                    grows: 'link',
                    minMembers: 0,
                    maxMembers: 3,
                    value: { kind: 'input', id: 's', type: IMAGE, optional: true },
                  },
                ],
              },
            ],
          },
          { kind: 'output', id: 'out', type: IMAGE },
        ],
      },
    ] as never)
    await window.__dinksterTest!.app.openDocument({
      format: 'dinkster-workflow', formatVersion: 1, lineage: 'growth-e2e', root: 'g0',
      graphs: {
        g0: {
          id: 'g0', name: 'root',
          nodes: { p: { id: 'p', type: 'GrowthNestTest', values: {} } },
          links: {}, nets: {}, reroutes: {},
          nextOrdinal: 100,
        },
      },
      view: { graphs: { g0: { nodes: { p: { position: { x: 120, y: 80 } } } } } },
    } as never, 'Growth')
    window.__dinksterTest!.renderer!.setViewport({ x: 0, y: 0, scale: 1 })
  })
}

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await expect(page.getByTestId('status-bar')).toContainText(/\d+ node schemas/, { timeout: 15_000 })
  await openGrowthWorkflow(page)
})

test('clicking the growth row materializes the member through production hit + dispatch; undo restores', async ({ page }) => {
  expect(await growthRows(page)).toEqual([
    { construct: 'items', label: 'items', frames: [{ construct: 'items', members: ['item0'], seq: 1 }] },
  ])
  const point = await growthRowPoint(page, 'items')
  await page.mouse.click(point.x, point.y)

  // The outer member persisted through the REAL interaction path.
  let doc = await activeDoc(page)
  let dyn = doc.graphs.g0!.nodes.p!.dynamic
  expect(dyn?.items).toEqual({ members: ['item0'], seq: 1 })

  // Rerender: the stored member's inner group offers ITS growth. The outer
  // group offers no spare member: a link-grown group offers one only once
  // every stored member is in use, and item0 holds no value or wire yet.
  expect(await growthRows(page)).toEqual([
    {
      construct: 'items.item0.sub',
      label: 'sub',
      frames: [{ construct: 'items.item0.sub', members: ['sub0'], seq: 1 }],
    },
  ])
  // Still no pins: the offered sub member's leaf group offers nothing.
  expect(await inputPins(page)).toEqual([])

  // One undo step reverts the materialization and restores the fresh offer.
  // Member keys are never reused (undo keeps the seq high-water mark, core
  // dynamic-commands.test.ts), so the re-offered member is item1.
  await page.keyboard.press('Control+z')
  doc = await activeDoc(page)
  dyn = doc.graphs.g0!.nodes.p!.dynamic
  expect(dyn?.items?.members ?? []).toEqual([])
  expect(await growthRows(page)).toEqual([
    { construct: 'items', label: 'items', frames: [{ construct: 'items', members: ['item1'], seq: 2 }] },
  ])
  await expect(page.getByTestId('problems-panel')).not.toContainText(/solve\.|compile\.|elab\./)
})

test('inner growth rows click through the same path, and the leaf level finally ghosts a pin', async ({ page }) => {
  const outer = await growthRowPoint(page, 'items')
  await page.mouse.click(outer.x, outer.y)
  // Click the INNER growth row: one dispatch, one undo step.
  const inner = await growthRowPoint(page, 'items.item0.sub')
  await page.mouse.click(inner.x, inner.y)

  const doc = await activeDoc(page)
  const dynamic = doc.graphs.g0!.nodes.p!.dynamic
  expect(dynamic?.items?.members).toEqual(['item0'])
  // A nested group's state is its own top-level entry under its flattened id.
  expect(dynamic?.['items.item0.sub']?.members).toEqual(['sub0'])

  // The stored sub member's leaf group ghosts normally now - the affordance
  // chain bottoms out in an ordinary connectable ghost pin.
  expect(await inputPins(page)).toEqual([{ portId: 'items.item0.sub.sub0.leaf.leaf0', ghost: true }])
  // No growth row is left: the ghost pin is the leaf group's offer, and
  // neither outer group offers a spare member while its member is unused.
  expect(await growthRows(page)).toEqual([])
  await expect(page.getByTestId('problems-panel')).not.toContainText(/solve\.|compile\.|elab\./)

  // Two independent undo steps unwind inner then outer.
  await page.keyboard.press('Control+z')
  let undone = (await activeDoc(page)).graphs.g0!.nodes.p!.dynamic
  expect(undone?.items?.members).toEqual(['item0'])
  expect(undone?.['items.item0.sub']?.members ?? []).toEqual([])
  await page.keyboard.press('Control+z')
  undone = (await activeDoc(page)).graphs.g0!.nodes.p!.dynamic
  expect(undone?.items?.members ?? []).toEqual([])
  // Seq high-water mark: item0 was made and undone, so the fresh offer is item1.
  expect(await growthRows(page)).toEqual([
    { construct: 'items', label: 'items', frames: [{ construct: 'items', members: ['item1'], seq: 2 }] },
  ])
})
