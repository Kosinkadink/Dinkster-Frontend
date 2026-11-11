/**
 * Browser regression for the nested-only Autogrow growth affordance,
 * driven through the PRODUCTION CanvasHost with real mouse input.
 *
 * A fresh node whose Autogrow template contains only min-0 nested
 * Autogrows emits no ghost pins (the single-ghost rule suppresses the
 * inner ghost tree beneath the outer ghost), so the elaborator emits a
 * clickable growth row instead. These tests prove the full production
 * path: scene row -> real hit test -> interaction gesture ->
 * dynamic.materialize dispatch -> rerender -> undo, at BOTH nesting
 * levels (outer growth on a fresh node, inner growth after the outer
 * member persists).
 */
import { expect, test, type Page } from './fixtures.js'

const activeDoc = (page: Page) =>
  page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.doc)

const nodeScene = (page: Page) =>
  page.evaluate(() => window.__dinksterTest!.renderer!.getScene().nodes.find((n) => n.id === 'p')!)

/** Growth rows of node 'p': construct + frames + geometry for clicking. */
const growthRows = (page: Page) =>
  page.evaluate(() => {
    const node = window.__dinksterTest!.renderer!.getScene().nodes.find((n) => n.id === 'p')!
    return node.layout.rows
      .filter((r) => r.kind === 'growth')
      .map((r) => ({
        construct: r.construct!,
        label: r.label!,
        frames: r.frames!.map((f) => ({ construct: f.construct, members: [...f.members] })),
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
  await page.evaluate(() => {
    const IMAGE = { kind: 'concrete', name: 'IMAGE' }
    // Three-level nested-only Autogrow: items > sub > leaf, every level
    // min-0 with no static slot until the innermost template ('s'). A fresh
    // node therefore renders NO pins at all - only the outer growth row.
    window.__dinksterTest!.app.registerSchemas([
      {
        type: 'GrowthNestTest',
        displayName: 'GrowthNestTest',
        category: 'test',
        source: 'v3',
        isOutputNode: false,
        items: [
          {
            kind: 'input',
            id: 'items',
            type: IMAGE,
            optional: true,
            dynamic: {
              kind: 'autogrow',
              template: [
                {
                  kind: 'input',
                  id: 'sub',
                  type: IMAGE,
                  optional: true,
                  dynamic: {
                    kind: 'autogrow',
                    template: [
                      {
                        kind: 'input',
                        id: 'leaf',
                        type: IMAGE,
                        optional: true,
                        dynamic: {
                          kind: 'autogrow',
                          template: [{ kind: 'input', id: 's', type: IMAGE, optional: true }],
                          naming: { kind: 'prefix', prefix: 'leaf', min: 0, max: 3 },
                        },
                      },
                    ],
                    naming: { kind: 'prefix', prefix: 'sub', min: 0, max: 3 },
                  },
                },
              ],
              naming: { kind: 'prefix', prefix: 'item', min: 0, max: 3 },
            },
          },
          { kind: 'output', id: 'out', type: IMAGE },
        ],
      },
    ] as never)
    window.__dinksterTest!.app.openDocument({
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

test('a fresh nested-only node offers only a growth row, with a clean Problems state', async ({ page }) => {
  expect(await inputPins(page)).toEqual([])
  expect(await growthRows(page)).toEqual([
    { construct: 'items', label: 'items', frames: [{ construct: 'items', members: ['m0'] }] },
  ])
  // The row occupies real body space (it must be clickable, not decorative).
  const node = await nodeScene(page)
  const row = node.layout.rows.find((r) => r.kind === 'growth')!
  expect(row.height).toBeGreaterThan(0)
  expect(row.y).toBeGreaterThanOrEqual(node.layout.headerHeight)
  await expect(page.getByTestId('problems-panel')).not.toContainText(/solve\.|compile\.|elab\./)
})

test('clicking the growth row materializes the member through production hit + dispatch; undo restores', async ({ page }) => {
  const point = await growthRowPoint(page, 'items')
  await page.mouse.click(point.x, point.y)

  // The outer member persisted through the REAL interaction path.
  let doc = await activeDoc(page)
  let dyn = doc.graphs.g0!.nodes.p!.dynamic
  expect(dyn?.items?.members).toEqual(['m0'])

  // Rerender: the outer offer moved to m1 and the persisted member's inner
  // nested-only family now offers ITS growth with cumulative frames.
  expect(await growthRows(page)).toEqual([
    {
      construct: 'items.sub',
      label: 'item0.sub',
      frames: [
        { construct: 'items', members: ['m0'] },
        { construct: 'items.sub', members: ['m0'] },
      ],
    },
    { construct: 'items', label: 'items', frames: [{ construct: 'items', members: ['m1'] }] },
  ])
  // Still no pins: sub's template is itself nested-only, and its ghost tree
  // is suppressed beneath the outer trailing ghost.
  expect(await inputPins(page)).toEqual([])

  // One undo step reverts the materialization and restores the fresh offer.
  // Member ids are never recycled (CO3: undo keeps the seq high-water mark,
  // core store.test.ts/dynamic-commands.test.ts), so the re-offered ghost
  // is m1 - the LABEL stays positional ('items'), so users see no change.
  await page.keyboard.press('Control+z')
  doc = await activeDoc(page)
  dyn = doc.graphs.g0!.nodes.p!.dynamic
  expect(dyn?.items?.members ?? []).toEqual([])
  expect(await growthRows(page)).toEqual([
    { construct: 'items', label: 'items', frames: [{ construct: 'items', members: ['m1'] }] },
  ])
  await expect(page.getByTestId('problems-panel')).not.toContainText(/solve\.|compile\.|elab\./)
})

test('inner growth rows click through the same path, and the leaf level finally ghosts a pin', async ({ page }) => {
  const outer = await growthRowPoint(page, 'items')
  await page.mouse.click(outer.x, outer.y)
  // Click the INNER growth row: two-level frames, one dispatch, one undo step.
  const inner = await growthRowPoint(page, 'items.sub')
  await page.mouse.click(inner.x, inner.y)

  const doc = await activeDoc(page)
  const node = doc.graphs.g0!.nodes.p! as {
    dynamic?: {
      items?: { members?: string[]; memberState?: Record<string, Record<string, { members?: string[] }>> }
    }
  }
  expect(node.dynamic?.items?.members).toEqual(['m0'])
  // Nested state persisted under the outer member's cursor (memberState.m0).
  expect(node.dynamic?.items?.memberState?.m0?.['items.sub']?.members).toEqual(['m0'])

  // The persisted sub member's leaf family ghosts normally now - the
  // affordance chain bottoms out in an ordinary connectable ghost pin.
  const pins = await inputPins(page)
  expect(pins.some((p) => p.portId.startsWith('items.sub.leaf.s') && p.ghost)).toBe(true)
  // Growth offers now: leaf level none (it renders pins), sub level next
  // member, outer next member.
  const rows = await growthRows(page)
  expect(rows.map((r) => r.construct).sort()).toEqual(['items', 'items.sub'])
  await expect(page.getByTestId('problems-panel')).not.toContainText(/solve\.|compile\.|elab\./)

  // Two independent undo steps unwind inner then outer.
  await page.keyboard.press('Control+z')
  let undone = await activeDoc(page)
  let dynNow = (undone.graphs.g0!.nodes.p! as { dynamic?: { items?: { members?: string[] } } }).dynamic
  expect(dynNow?.items?.members).toEqual(['m0'])
  await page.keyboard.press('Control+z')
  undone = await activeDoc(page)
  dynNow = (undone.graphs.g0!.nodes.p! as { dynamic?: { items?: { members?: string[] } } }).dynamic
  expect(dynNow?.items?.members ?? []).toEqual([])
  // CO3 high-water mark: m0 was minted and undone, so the fresh offer is m1.
  expect(await growthRows(page)).toEqual([
    { construct: 'items', label: 'items', frames: [{ construct: 'items', members: ['m1'] }] },
  ])
})
